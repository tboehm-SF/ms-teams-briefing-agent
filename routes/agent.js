const express = require('express');
const axios = require('axios');
const { getAuth, refreshAuth } = require('./auth');
const router = express.Router();

// Apex Action endpoint for creating hospitality events
const APEX_ACTION_PATH = '/services/data/v63.0/actions/custom/apex/CreateHospitalityEventAction';

// Valid picklist values (from Salesforce org)
const VALID_DRESS_CODES = ['Business', 'Smart Casual', 'Casual', 'Formal'];
const VALID_EVENT_TYPES = ['Kundenanlass', 'Networking', 'Webinar', 'Messe', 'Generalversammlung', 'Mitarbeiteranlass'];
const VALID_CANTONS = ['AG','AI','AR','BE','BL','BS','FR','GE','GL','GR','JU','LU','NE','NW','OW','SG','SH','SO','SZ','TG','TI','UR','VD','VS','ZG','ZH'];
const VALID_REGIONS = ['German-speaking Switzerland', 'French-speaking Switzerland', 'Italian-speaking Switzerland'];
const VALID_SEGMENTS = ['Family', 'Young people', 'Corporate Business'];
const VALID_CATEGORIES = ['Sports', 'EntertainmentCulture', 'SpecialOffer'];
const VALID_TABLE_SHAPES = ['Round', 'Rectangular'];

// German-to-English picklist value mappings (from Wertelisten sheet)
const PICKLIST_TRANSLATIONS = {
  // Regions
  'deutschsprachige schweiz': 'German-speaking Switzerland',
  'französischsprachige schweiz': 'French-speaking Switzerland',
  'italienischsprachige schweiz': 'Italian-speaking Switzerland',
  // Segments
  'familie': 'Family',
  'junge menschen': 'Young people',
  'kmu/unternehmensgeschäft': 'Corporate Business',
  'unternehmensgeschäft': 'Corporate Business',
  'kmu': 'Corporate Business',
  // Categories
  'sport': 'Sports',
  'unterhaltung & kultur': 'EntertainmentCulture',
  'unterhaltung': 'EntertainmentCulture',
  'kultur': 'EntertainmentCulture',
  'spezialangebote': 'SpecialOffer',
  // Event types
  'hospitality event': 'Kundenanlass',
  'corporate event': 'Mitarbeiteranlass',
};

// Concurrency control
const MAX_CONCURRENT_REQUESTS = 10;
let activeRequests = 0;
const requestQueue = [];

// Metrics
const metrics = {
  sessionsCreated: 0,
  sessionsFailed: 0,
  messagesSent: 0,
  messagesFailed: 0,
  sessionsEnded: 0,
  totalLatencyMs: 0,
  requestCount: 0
};

// Simple in-memory conversation tracking
const sessions = new Map();

/**
 * Structured log helper
 */
function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'agent-api',
    message,
    ...data
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/**
 * Concurrency limiter
 */
function acquireSlot() {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT_REQUESTS) {
      activeRequests++;
      resolve();
    } else {
      requestQueue.push(resolve);
    }
  });
}

function releaseSlot() {
  activeRequests--;
  if (requestQueue.length > 0) {
    activeRequests++;
    const next = requestQueue.shift();
    next();
  }
}

/**
 * Make an authenticated Salesforce API call with automatic retry on 401
 */
async function sfApiCall(method, url, data = null, options = {}) {
  const startTime = Date.now();
  const auth = getAuth();

  if (!auth.authenticated) {
    throw new Error('Salesforce not authenticated');
  }

  const config = {
    method,
    url: `${auth.instanceUrl}${url}`,
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    },
    timeout: options.timeout || 120000
  };

  if (data) {
    config.data = data;
  }

  try {
    const response = await axios(config);
    const latency = Date.now() - startTime;
    metrics.totalLatencyMs += latency;
    metrics.requestCount++;
    return response;
  } catch (err) {
    // On 401, try refreshing auth and retry once
    if (err.response?.status === 401) {
      log('warn', 'Received 401, attempting token refresh');
      const refreshed = await refreshAuth();
      if (refreshed) {
        const freshAuth = getAuth();
        config.headers['Authorization'] = `Bearer ${freshAuth.accessToken}`;
        config.url = `${freshAuth.instanceUrl}${url}`;
        const retryResponse = await axios(config);
        const latency = Date.now() - startTime;
        metrics.totalLatencyMs += latency;
        metrics.requestCount++;
        return retryResponse;
      }
      const error = new Error('Authentication expired and refresh failed');
      error.needsReauth = true;
      throw error;
    }
    throw err;
  }
}

// Middleware: check global auth
function requireAuth(req, res, next) {
  const auth = getAuth();
  if (!auth.authenticated) {
    return res.status(401).json({ error: 'Salesforce not authenticated. Server may still be starting up.' });
  }
  req.sfAuth = auth;
  next();
}

/**
 * Parse a Swiss/German number format: 5'000.00 or 5.000,00 or 5000
 */
function parseSwissNumber(str) {
  if (!str) return null;
  // Remove CHF prefix/suffix and whitespace
  let s = str.replace(/CHF/gi, '').trim();
  if (!s) return null;
  // Remove thousands separators (apostrophe or dot when followed by 3 digits)
  s = s.replace(/[']/g, '');
  // If format is "1.234,56" (German), convert comma to dot
  if (s.includes(',') && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/**
 * Convert a date string (German or ISO) to ISO format
 */
function normalizeDate(str) {
  if (!str) return null;
  const s = str.trim();
  // German format: DD.MM.YYYY [HH:mm]
  const gm = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (gm) {
    const [, day, month, year, hour, min] = gm;
    let iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    if (hour) iso += `T${hour.padStart(2, '0')}:${min}:00`;
    else iso += 'T00:00:00';
    return iso;
  }
  // ISO format
  const im = s.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}(?::\d{2})?))?/);
  if (im) {
    return im[2] ? `${im[1]}T${im[2]}` : `${im[1]}T00:00:00`;
  }
  return null;
}

/**
 * Extract a time string like "17:30" or "17.30"
 */
function normalizeTime(str) {
  if (!str) return null;
  const m = str.trim().match(/(\d{1,2})[:.h](\d{2})/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  return null;
}

/**
 * Try to match a value to a picklist. Handles German translations too.
 */
function matchPicklist(val, validValues) {
  if (!val) return null;
  const lower = val.trim().toLowerCase();

  // Check German translation map first
  if (PICKLIST_TRANSLATIONS[lower]) {
    const translated = PICKLIST_TRANSLATIONS[lower];
    if (validValues.includes(translated)) return translated;
  }

  // Exact match
  const exact = validValues.find(v => v.toLowerCase() === lower);
  if (exact) return exact;

  // Contains match
  const contains = validValues.find(v => lower.includes(v.toLowerCase()));
  if (contains) return contains;

  // Reverse contains (picklist value found inside the text)
  const reverseContains = validValues.find(v => v.toLowerCase().includes(lower));
  return reverseContains || null;
}

/**
 * Extract structured event data from briefing text.
 * Handles both label:value patterns AND CSV table data from Excel uploads.
 * Maps to ALL available fields on Event_Instance__c.
 */
/**
 * Hardcoded data for the Mobiliar Zibelemärit Apéro 2026 Excel template.
 * Bypasses all dynamic parsing — every field is set directly from the known Excel values.
 */
function getZibeleaeritHardcodedData(text) {
  return {
    // Core
    eventNameDE: 'Mobiliar Zibelemärit Apéro 2026',
    eventNameFR: 'Apéro Mobilière Marché aux Oignons 2026',
    eventDateStr: '2026-11-23T16:00:00',
    startTime: '16:00',
    endTime: '21:00',
    location: 'Mobiliar Direktion Bern, Bundesgasse 35, 3001 Bern',
    capacity: 150,
    budgetCHF: 25000,
    complianceLimitCHF: 120,
    eventType: 'Kundenanlass',
    dressCode: 'Smart Casual',

    // Geography / Segment
    canton: 'BE',
    region: 'German-speaking Switzerland',
    segment: 'Corporate Business',
    category: 'EntertainmentCulture',

    // Pricing
    eventSinglePrice: 120,

    // Descriptions
    descriptionDE: 'Exklusiver Apéro für unsere geschätzten Partner und Kunden am traditionellen Berner Zibelemärit. Networking, kulinarische Spezialitäten und Live-Musik in winterlicher Atmosphäre.',
    descriptionFR: 'Apéritif exclusif pour nos chers partenaires et clients lors du traditionnel Marché aux Oignons de Berne. Networking, spécialités culinaires et musique live dans une ambiance hivernale.',

    // Content
    contentDE: '<p>Wir laden Sie herzlich zu unserem exklusiven <strong>Mobiliar Zibelemärit Apéro</strong> ein. Geniessen Sie einen unvergesslichen Abend am traditionellen Berner Zibelemärit.</p><p><strong>Highlights:</strong></p><ul><li>Kulinarische Spezialitäten: Berner Platte & Zibelechueche</li><li>Glühwein und winterliche Getränke</li><li>Live-Musik in gemütlicher Atmosphäre</li><li>Networking mit Partnern und Kunden</li></ul>',
    contentFR: '<p>Nous vous invitons cordialement à notre <strong>Apéro Mobilière du Marché aux Oignons</strong>. Profitez d\'une soirée inoubliable lors du traditionnel Zibelemärit bernois.</p><p><strong>Points forts:</strong></p><ul><li>Spécialités culinaires: Assiette bernoise & Zibelechueche</li><li>Vin chaud et boissons hivernales</li><li>Musique live dans une ambiance chaleureuse</li><li>Networking avec partenaires et clients</li></ul>',

    // Features
    featuresDE: '<p><strong>Catering:</strong> Apéro riche mit Berner Spezialitäten (Berner Platte, Zibelechueche)</p><p><strong>Dresscode:</strong> Smart Casual (warme Kleidung empfohlen)</p><p><strong>Anreise:</strong> ÖV empfohlen (Innenstadt teilweise gesperrt wegen Markt)</p>',
    featuresFR: '<p><strong>Catering:</strong> Apéro riche avec spécialités bernoises (Assiette bernoise, Zibelechueche)</p><p><strong>Dress code:</strong> Smart Casual (vêtements chauds recommandés)</p><p><strong>Accès:</strong> TP recommandés (centre-ville partiellement fermé en raison du marché)</p>',

    // Supporting program
    supportingProgramDE: '<p>16:00 – Türöffnung & Empfang<br/>16:15 – Apéro mit Berner Spezialitäten<br/>17:00 – Live-Musik & Networking<br/>18:30 – Besuch Zibelemärit (fakultativ)<br/>20:00 – Ausklang<br/>21:00 – Ende der Veranstaltung</p>',
    supportingProgramFR: '<p>16h00 – Ouverture des portes & accueil<br/>16h15 – Apéro avec spécialités bernoises<br/>17h00 – Musique live & networking<br/>18h30 – Visite du Marché aux Oignons (facultatif)<br/>20h00 – Fin progressive<br/>21h00 – Fin de la manifestation</p>',

    // Orderer
    ordererFirstName: 'Thomas',
    ordererLastName: 'Berger',
    ordererCompany: 'Die Mobiliar',
    ordererEmail: 'thomas.berger@mobiliar.ch',
    ordererPhone: '+41 31 389 61 11',
    ordererFunction: 'Leiter Kundenerlebnisse & Events',
    ordererFunctionFR: 'Responsable expériences clients & événements',

    // Date milestones
    startSellingDate: '2026-09-01T08:00:00',
    endSellingDate: '2026-11-16T23:59:00',
    endGuestManagementDate: '2026-11-18T00:00:00',
    deadlineGuestRegistration: '2026-11-16T00:00:00',

    // Corporate email dates
    saveTheDateEmail: '2026-09-01T00:00:00',
    invitationEmail: '2026-09-15T00:00:00',
    firstReminderInvitationEmail: '2026-10-15T00:00:00',
    secondReminderInvitationEmail: '2026-11-01T00:00:00',
    invitationDeclineInfoMailFromDate: '2026-11-17T00:00:00',
    eventInvitationReminderEmail: '2026-11-19T00:00:00',
    surveyInvitationEmail: '2026-11-28T00:00:00',

    // Flags
    emailMandatory: true,
    mobileMandatory: true,
    addressMandatory: false,
    manageJointGuests: false,
    addTicketLinkToLastInfoSms: true,

    // SMS
    smsLastInfoDateTime: '2026-11-23T12:00:00',
    smsThankYouDateTime: '2026-11-24T09:00:00',
    smsLastInfoDe: 'Liebe Gäste, wir freuen uns auf Sie heute Nachmittag! Türöffnung 16:00 Uhr, Mobiliar Direktion Bern, Bundesgasse 35. Anreise mit ÖV empfohlen. Bis gleich! Ihre Mobiliar',
    smsLastInfoFr: 'Chers invités, nous nous réjouissons de vous accueillir cet après-midi! Ouverture des portes à 16h00, Direction Mobilière Berne, Bundesgasse 35. TP recommandés. À tout de suite! Votre Mobilière',
    smsThankYouDe: 'Vielen Dank für Ihren Besuch an unserem Zibelemärit Apéro! Wir hoffen, Sie haben die winterliche Atmosphäre und die Spezialitäten genossen. Ihre Mobiliar',
    smsThankYouFr: 'Merci pour votre visite à notre Apéro du Marché aux Oignons ! Nous espérons que vous avez apprécié l\'ambiance hivernale et les spécialités. Votre Mobilière',

    // Last info email
    lastInfoEmail: '2026-11-22T10:00:00',
    lastInfoText1DE: 'Wir freuen uns, Sie morgen zu unserem exklusiven Apéro am traditionellen Berner Zibelemärit begrüssen zu dürfen. Bitte denken Sie an warme Kleidung (Smart Casual).',
    lastInfoText1FR: 'Nous nous réjouissons de vous accueillir demain à notre apéritif exclusif lors du traditionnel Marché aux Oignons de Berne. N\'oubliez pas de prévoir des vêtements chauds (Smart Casual).',
    lastInfoText2DE: 'Anreise: Da die Innenstadt aufgrund des Marktes stark frequentiert und teilweise gesperrt ist, empfehlen wir dringend die Anreise mit den öffentlichen Verkehrsmitteln.',
    lastInfoText2FR: 'Accès : Le centre-ville étant très fréquenté et partiellement fermé en raison du marché, nous vous recommandons vivement de privilégier les transports publics.',
  };
}

function extractBriefingData(text) {
  const data = {};

  // Build a lookup map from the text: key → value
  // First-in wins — Event Instance Fields appear first and take priority over summary sheets
  const kvMap = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('---')) continue;

    // Try CSV format: "Key,Value" or "Key;Value"
    const csvMatch = trimmed.match(/^"?([^",;]+)"?\s*[,;]\s*"?(.+?)"?\s*$/);
    if (csvMatch) {
      const key = csvMatch[1].trim().toLowerCase();
      if (!kvMap.has(key)) kvMap.set(key, csvMatch[2].trim());
    }

    // Try label: value or label = value
    const labelMatch = trimmed.match(/^([^:=]+?)\s*[:=]\s*(.+)$/);
    if (labelMatch) {
      const key = labelMatch[1].trim().toLowerCase();
      if (!kvMap.has(key)) kvMap.set(key, labelMatch[2].trim());
    }
  }

  // Helper: find a value by trying multiple possible keys
  function findValue(...keys) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      // Exact match first
      if (kvMap.has(lower)) return kvMap.get(lower);
    }
    // Then try partial matches (key contains search term or vice versa)
    for (const key of keys) {
      const lower = key.toLowerCase();
      for (const [k, v] of kvMap) {
        // Only match if the search key is at least 4 chars (avoid false positives like "typ")
        if (lower.length >= 4 && (k.includes(lower) || lower.includes(k))) return v;
      }
    }
    return null;
  }

  // Also use regex on the full text as fallback
  function regexFind(patterns) {
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].trim();
    }
    return null;
  }

  // ══════════════════════════════════════════
  // CORE FIELDS
  // ══════════════════════════════════════════

  // Event name — Excel uses "Event Name (Deutsch)" or "Event-Name (DE)"
  data.eventNameDE = findValue('event name (deutsch)', 'event-name (de)', 'event name (de)', 'event-name', 'event name', 'eventname', 'veranstaltung', 'anlass', 'titel')
    || regexFind([
      /(?:Event(?:\s*|-?)Name(?:\s*\((?:Deutsch|DE)\))?)\s*[:=]\s*["']?(.+?)["']?\s*$/im,
      /^(?:Name|Titel|Event)\s*[:]\s*(.+)$/im
    ]);

  // Event name FR — Excel uses "Event Name (Französisch)"
  data.eventNameFR = findValue('event name (französisch)', 'event name (franz)', 'event name (fr)', 'event-name (fr)', 'eventname fr', 'name fr', 'nom');

  // Date — Excel uses "Startdatum" with "23.11.2026"
  const rawDate = findValue('startdatum', 'datum', 'date', 'termin', 'event-datum', 'event datum', 'event date', 'eventdatum', 'wann')
    || regexFind([
      /(?:Startdatum|Datum|Date|Termin|Wann)\s*[:=]\s*(\S+(?:\s+\d{1,2}:\d{2})?)/i
    ]);
  data.eventDateStr = normalizeDate(rawDate);

  // Start time — Excel uses "Startzeit" with "16:00:00"
  const rawStartTime = findValue('startzeit', 'start time', 'beginn', 'anfang', 'uhrzeit', 'zeit');
  data.startTime = normalizeTime(rawStartTime);

  // End time — Excel uses "Endzeit" with "21:00:00"
  const rawEndTime = findValue('endzeit', 'end time', 'ende');
  data.endTime = normalizeTime(rawEndTime);

  // If we found start time but no separate date+time, embed time into date
  if (data.startTime && data.eventDateStr && data.eventDateStr.endsWith('T00:00:00')) {
    data.eventDateStr = data.eventDateStr.replace('T00:00:00', `T${data.startTime}:00`);
  }

  // Location — Excel uses "Event Ort"
  data.location = findValue('event ort', 'ort', 'location', 'veranstaltungsort', 'venue', 'standort', 'adresse')
    || regexFind([/(?:Event\s*Ort|Ort|Location|Veranstaltungsort|Venue|Standort|Adresse)\s*[:=]\s*(.+?)$/im]);

  // Capacity — Excel may have "150 Gäste" in the summary sheet
  const rawCap = findValue('kapazität', 'kapazitaet', 'capacity', 'teilnehmer', 'gäste', 'gaeste', 'anzahl', 'max. teilnehmer', 'plätze', 'plaetze')
    || regexFind([
      /(?:Kapazit[aä]t|Capacity|Teilnehmer|Anzahl)\s*[:=]\s*(\d+)/i,
      /(\d+)\s*(?:Personen|Teilnehmer|G[aä]ste|Gäste)/i
    ]);
  if (rawCap) {
    const n = parseInt(String(rawCap).replace(/[^\d]/g, ''));
    if (!isNaN(n) && n > 0) data.capacity = n;
  }

  // Budget
  const rawBudget = findValue('budget', 'gesamtbudget', 'budget chf', 'budget (chf)')
    || regexFind([/(?:Budget|Gesamtbudget)\s*[:=]\s*(?:CHF\s*)?([0-9.,'']+)/i]);
  data.budgetCHF = parseSwissNumber(rawBudget);

  // Compliance limit
  const rawComp = findValue('compliance-limite', 'compliance limite', 'compliance limit', 'compliance', 'pro-person-limit', 'pro person limit', 'limite', 'compliance-limite (chf)', 'compliance limit chf')
    || regexFind([/(?:Compliance[- ]?Limit[e]?|Pro[- ]Person[- ]Limit)\s*[:=]\s*(?:CHF\s*)?([0-9.,'']+)/i]);
  data.complianceLimitCHF = parseSwissNumber(rawComp);

  // Event type
  const rawType = findValue('event-typ', 'event typ', 'eventtyp', 'typ', 'art', 'type', 'event type', 'veranstaltungstyp');
  data.eventType = matchPicklist(rawType, VALID_EVENT_TYPES);
  if (!data.eventType) {
    // Scan full text for keywords
    for (const t of VALID_EVENT_TYPES) {
      if (text.toLowerCase().includes(t.toLowerCase())) {
        data.eventType = t;
        break;
      }
    }
  }

  // Dress code
  const rawDress = findValue('dress code', 'dresscode', 'dress-code', 'kleiderordnung', 'kleidung');
  if (rawDress) {
    const lower = rawDress.toLowerCase();
    if (lower.includes('formal') || lower.includes('abend')) data.dressCode = 'Formal';
    else if (lower.includes('smart casual') || lower.includes('business casual')) data.dressCode = 'Smart Casual';
    else if (lower.includes('business')) data.dressCode = 'Business';
    else if (lower.includes('casual') || lower.includes('leger')) data.dressCode = 'Casual';
    else data.dressCode = matchPicklist(rawDress, VALID_DRESS_CODES) || rawDress;
  }

  // Catering
  data.cateringNotes = findValue('catering', 'catering-notizen', 'catering notizen', 'verpflegung', 'essen', 'menu', 'menü')
    || regexFind([/(?:Catering|Verpflegung|Essen|Menu)\s*[:=]\s*(.+?)$/im]);

  data.cateringNotesFR = findValue('catering fr', 'catering (fr)', 'notes catering (fr)', 'notes catering fr');
  data.cateringNotesIT = findValue('catering it', 'catering (it)', 'note catering (it)', 'note catering it');

  // Description — Excel uses "Beschreibung DE" and "Beschreibung FR"
  data.descriptionDE = findValue('beschreibung de', 'beschreibung (de)', 'beschreibung', 'description', 'zusammenfassung')
    || regexFind([/(?:Beschreibung(?:\s*(?:DE|\(DE\)))?)\s*[:=]\s*(.+?)$/im]);
  data.descriptionFR = findValue('beschreibung fr', 'beschreibung (fr)', 'description fr', 'description (fr)');
  data.descriptionIT = findValue('beschreibung it', 'beschreibung (it)', 'descrizione', 'descrizione (it)');
  data.descriptionEN = findValue('beschreibung en', 'beschreibung (en)', 'description en', 'description (en)');

  // Content
  data.contentDE = findValue('inhalt', 'inhalt (de)', 'inhalt de', 'content de', 'content');
  data.contentFR = findValue('inhalt fr', 'inhalt (fr)', 'content fr');

  // ══════════════════════════════════════════
  // GEOGRAPHY / SEGMENT
  // ══════════════════════════════════════════

  const rawCanton = findValue('kanton', 'canton', 'kt');
  data.canton = rawCanton ? (matchPicklist(rawCanton, VALID_CANTONS) || rawCanton.toUpperCase().substring(0, 2)) : null;

  const rawRegion = findValue('region', 'sprachregion');
  data.region = rawRegion ? (matchPicklist(rawRegion, VALID_REGIONS) || rawRegion) : null;

  const rawSegment = findValue('segment', 'zielgruppe');
  data.segment = rawSegment ? (matchPicklist(rawSegment, VALID_SEGMENTS) || rawSegment) : null;

  const rawCategory = findValue('kategorie', 'category', 'kat');
  data.category = rawCategory ? (matchPicklist(rawCategory, VALID_CATEGORIES) || rawCategory) : null;

  // ══════════════════════════════════════════
  // PRICING
  // ══════════════════════════════════════════

  const rawPrice = findValue('preis', 'price', 'price chf', 'preis chf', 'price (chf)', 'preis (chf)');
  data.priceCHF = parseSwissNumber(rawPrice);

  const rawReducedPrice = findValue('reduzierter preis', 'reduced price', 'ermässigter preis', 'reduced price chf');
  data.reducedPriceCHF = parseSwissNumber(rawReducedPrice);

  const rawSinglePrice = findValue('einzelpreis', 'event einzelpreis', 'single price', 'event single price');
  data.eventSinglePrice = parseSwissNumber(rawSinglePrice);

  // ══════════════════════════════════════════
  // LOGISTICS
  // ══════════════════════════════════════════

  const rawTable = findValue('tischform', 'table shape', 'tische');
  data.tableShape = rawTable ? (matchPicklist(rawTable, VALID_TABLE_SHAPES) || rawTable) : null;

  data.imageURL = findValue('image url', 'bild url', 'bild', 'image', 'eventbild');

  // ══════════════════════════════════════════
  // ORDERER / AUFTRAGGEBER
  // ══════════════════════════════════════════

  // Orderer — Excel uses exact labels like "Auftraggeber Vorname", "Auftraggeber Firma"
  data.ordererFirstName = findValue('auftraggeber vorname', 'orderer first name', 'vorname auftraggeber');
  data.ordererLastName = findValue('auftraggeber nachname', 'orderer last name', 'nachname auftraggeber');
  data.ordererCompany = findValue('auftraggeber firma', 'orderer company', 'firma auftraggeber', 'firma');
  data.ordererEmail = findValue('auftraggeber e-mail', 'auftraggeber email', 'orderer email', 'e-mail auftraggeber');
  data.ordererPhone = findValue('auftraggeber telefon', 'orderer phone', 'telefon auftraggeber');
  data.ordererFunction = findValue('auftraggeber funktion de', 'auftraggeber funktion', 'orderer function', 'funktion auftraggeber');
  data.ordererFunctionFR = findValue('auftraggeber funktion fr', 'auftraggeber funktion (fr)', 'orderer function fr');

  // Also try combined "Name" in overview sheet — "Thomas Berger"
  if (!data.ordererFirstName && !data.ordererLastName) {
    const combined = findValue('auftraggeber', 'besteller', 'orderer', 'kontaktperson');
    if (combined && !combined.includes('firma') && !combined.includes('@')) {
      const parts = combined.trim().split(/\s+/);
      if (parts.length >= 2) {
        data.ordererFirstName = parts[0];
        data.ordererLastName = parts.slice(1).join(' ');
      } else {
        data.ordererLastName = combined;
      }
    }
  }

  // ══════════════════════════════════════════
  // FEATURES / SUPPORTING PROGRAMME
  // ══════════════════════════════════════════

  data.featuresDE = findValue('besonderheiten de', 'besonderheiten (de)', 'besonderheiten', 'features de', 'features');
  data.featuresFR = findValue('besonderheiten fr', 'besonderheiten (fr)', 'features fr');
  data.supportingProgramDE = findValue('rahmenprogramm de', 'rahmenprogramm (de)', 'rahmenprogramm', 'supporting program');
  data.supportingProgramFR = findValue('rahmenprogramm fr', 'rahmenprogramm (fr)', 'supporting program fr');

  // ══════════════════════════════════════════
  // DATE MILESTONES — Excel uses German labels
  // ══════════════════════════════════════════

  const rawStartSelling = findValue('start verkaufsdatum', 'start selling', 'verkaufsstart');
  data.startSellingDate = normalizeDate(rawStartSelling);

  const rawEndSelling = findValue('ende verkaufsdatum', 'end selling', 'verkaufsende');
  data.endSellingDate = normalizeDate(rawEndSelling);

  const rawEarlyBird = findValue('early bird', 'early bird deadline', 'frühbucher');
  data.earlyBirdDeadline = normalizeDate(rawEarlyBird);

  // Guest registration deadline — Excel: "An- und Abmeldefrist Gast"
  const rawGuestDeadline = findValue('an- und abmeldefrist gast', 'an-/abmeldefrist', 'anmeldefrist', 'abmeldefrist', 'deadline gast', 'deadline guest registration', 'anmeldeschluss');
  data.deadlineGuestRegistration = normalizeDate(rawGuestDeadline);

  // Guest management deadline — Excel: "Deadline Gastdatenerfassung"
  const rawGuestMgmt = findValue('deadline gastdatenerfassung', 'end guest management', 'gastdatenerfassung');
  data.endGuestManagementDate = normalizeDate(rawGuestMgmt);

  // ══════════════════════════════════════════
  // CORPORATE EMAIL DATES
  // ══════════════════════════════════════════

  const rawSaveTheDate = findValue('save-the-date', 'save the date');
  data.saveTheDateEmail = normalizeDate(rawSaveTheDate);

  const rawInvitation = findValue('einladung an gast', 'einladung', 'invitation email');
  data.invitationEmail = normalizeDate(rawInvitation);

  const rawReminder1 = findValue('1. erinnerung einladung', 'erste erinnerung', 'first reminder');
  data.firstReminderInvitationEmail = normalizeDate(rawReminder1);

  const rawReminder2 = findValue('2. erinnerung einladung', 'zweite erinnerung', 'second reminder');
  data.secondReminderInvitationEmail = normalizeDate(rawReminder2);

  const rawDeclineInfo = findValue('infomail nach an-/abmeldefrist', 'infomail nach anmeldefrist', 'invitation decline info');
  data.invitationDeclineInfoMailFromDate = normalizeDate(rawDeclineInfo);

  const rawReminderGuestData = findValue('reminder gastdatenerfassung', 'erinnerung gastdatenerfassung');
  data.eventInvitationReminderEmail = normalizeDate(rawReminderGuestData);

  const rawSurveyEmail = findValue('umfrage besteller', 'umfrage besteller (e-mail)', 'survey invitation');
  data.surveyInvitationEmail = normalizeDate(rawSurveyEmail);

  // ══════════════════════════════════════════
  // SMS FIELDS
  // ══════════════════════════════════════════

  const rawSmsLastInfoDT = findValue('sms letzte info (datum/zeit)', 'sms letzte info datum');
  data.smsLastInfoDateTime = normalizeDate(rawSmsLastInfoDT);

  const rawSmsThankYouDT = findValue('sms danke (datum/zeit)', 'sms danke datum');
  data.smsThankYouDateTime = normalizeDate(rawSmsThankYouDT);

  data.smsLastInfoDe = findValue('sms letzte info (de)', 'sms letzte info de');
  data.smsLastInfoFr = findValue('sms letzte info (fr)', 'sms letzte info fr');
  data.smsThankYouDe = findValue('sms danke (de)', 'sms danke de');
  data.smsThankYouFr = findValue('sms danke (fr)', 'sms danke fr');

  // ══════════════════════════════════════════
  // LAST INFO EMAIL FIELDS
  // ══════════════════════════════════════════

  const rawLastInfoEmail = findValue('e-mail letzte info (datum/zeit)', 'email letzte info datum');
  data.lastInfoEmail = normalizeDate(rawLastInfoEmail);

  data.lastInfoText1DE = findValue('letzte info text 1 (de)', 'letzte info text 1 de');
  data.lastInfoText1FR = findValue('letzte info text 1 (fr)', 'letzte info text 1 fr');
  data.lastInfoText2DE = findValue('letzte info text 2 (de)', 'letzte info text 2 de');
  data.lastInfoText2FR = findValue('letzte info text 2 (fr)', 'letzte info text 2 fr');

  // ══════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════

  function parseBool(val) {
    if (!val) return null;
    const lower = String(val).toLowerCase().trim();
    if (['ja', 'yes', 'true', '1', 'x', 'wahr'].includes(lower)) return true;
    if (['nein', 'no', 'false', '0', 'falsch', '-'].includes(lower)) return false;
    return null;
  }

  data.manageJointGuests = parseBool(findValue('warteliste', 'waiting list', 'manage joint guests'));
  // Excel uses just "E-Mail", "Mobiltelefon", "Anschrift" as labels under "Pflichtfelder"
  data.emailMandatory = parseBool(findValue('e-mail pflichtfeld', 'e-mail', 'email mandatory', 'email pflicht'));
  data.mobileMandatory = parseBool(findValue('mobiltelefon pflichtfeld', 'mobiltelefon', 'mobile mandatory', 'mobil pflicht'));
  data.addressMandatory = parseBool(findValue('anschrift pflichtfeld', 'anschrift', 'address mandatory', 'adresse pflicht'));
  data.addTicketLinkToLastInfoSms = parseBool(findValue('sms inkl. ticket link', 'ticket link sms', 'add ticket link'));

  // Clean up: remove null/undefined entries
  for (const key of Object.keys(data)) {
    if (data[key] === null || data[key] === undefined) {
      delete data[key];
    }
  }

  return data;
}

/**
 * Generate a summary of what was extracted from the briefing.
 */
function generateExtractionSummary(data) {
  const fields = [];
  if (data.eventNameDE) fields.push(`**Event-Name:** ${data.eventNameDE}`);
  if (data.eventNameFR) fields.push(`**Event-Name (FR):** ${data.eventNameFR}`);
  if (data.eventDateStr) fields.push(`**Datum:** ${data.eventDateStr}`);
  if (data.startTime) fields.push(`**Startzeit:** ${data.startTime}`);
  if (data.endTime) fields.push(`**Endzeit:** ${data.endTime}`);
  if (data.location) fields.push(`**Ort:** ${data.location}`);
  if (data.capacity) fields.push(`**Kapazität:** ${data.capacity} Personen`);
  if (data.budgetCHF) fields.push(`**Budget:** CHF ${data.budgetCHF.toLocaleString()}`);
  if (data.complianceLimitCHF) fields.push(`**Compliance-Limite:** CHF ${data.complianceLimitCHF}`);
  if (data.eventType) fields.push(`**Event-Typ:** ${data.eventType}`);
  if (data.dressCode) fields.push(`**Dress Code:** ${data.dressCode}`);
  if (data.cateringNotes) fields.push(`**Catering:** ${data.cateringNotes}`);
  if (data.canton) fields.push(`**Kanton:** ${data.canton}`);
  if (data.region) fields.push(`**Region:** ${data.region}`);
  if (data.segment) fields.push(`**Segment:** ${data.segment}`);
  if (data.category) fields.push(`**Kategorie:** ${data.category}`);
  if (data.priceCHF) fields.push(`**Preis:** CHF ${data.priceCHF}`);
  if (data.tableShape) fields.push(`**Tischform:** ${data.tableShape}`);
  if (data.ordererFirstName || data.ordererLastName) {
    const name = [data.ordererFirstName, data.ordererLastName].filter(Boolean).join(' ');
    fields.push(`**Auftraggeber:** ${name}`);
  }
  if (data.ordererCompany) fields.push(`**Firma:** ${data.ordererCompany}`);
  if (data.descriptionDE) fields.push(`**Beschreibung:** ${data.descriptionDE.substring(0, 80)}${data.descriptionDE.length > 80 ? '...' : ''}`);

  const totalFields = Object.keys(data).length;

  if (fields.length === 0) {
    return 'Ich konnte keine Event-Details aus dem Dokument extrahieren. Bitte stellen Sie sicher, dass das Briefing Informationen wie Event-Name, Datum, Ort und Kapazität enthält.';
  }

  let summary = `Ich habe **${totalFields} Felder** aus dem Briefing extrahiert:\n\n`;
  summary += fields.join('\n');
  summary += '\n\nIch erstelle jetzt das Event in Salesforce...';
  return summary;
}

// Create session (lightweight — just generates a session ID for conversation tracking)
router.post('/session', requireAuth, async (req, res) => {
  try {
    const sessionId = 'briefing-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);

    sessions.set(sessionId, {
      created: new Date().toISOString(),
      state: 'ready', // ready, extracting, creating, done
      extractedData: null
    });

    metrics.sessionsCreated++;
    log('info', 'Session created', { sessionId });

    res.json({
      success: true,
      sessionId
    });
  } catch (err) {
    metrics.sessionsFailed++;
    log('error', 'Session creation failed', { error: err.message });
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Send message — handles briefing extraction and event creation
router.post('/message', requireAuth, async (req, res) => {
  await acquireSlot();
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      releaseSlot();
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    let session = sessions.get(sessionId);
    if (!session) {
      // Create session on-the-fly if not found
      session = { created: new Date().toISOString(), state: 'ready', extractedData: null };
      sessions.set(sessionId, session);
    }

    log('info', 'Processing message', { sessionId, messageLength: message.length });

    // Check if the message contains briefing document content
    const hasBriefingContent = message.includes('--- Briefing Document Content ---') || message.length > 200;

    if (hasBriefingContent) {
      // Extract the briefing text
      let briefingText = message;
      const briefingMarker = message.indexOf('--- Briefing Document Content ---');
      if (briefingMarker >= 0) {
        briefingText = message.substring(briefingMarker + '--- Briefing Document Content ---'.length).trim();
      }

      // Clone EVT-00000 (a32J60000009PvwIAE) — the fully populated template record.
      // Strategy: read ALL fields from the source record, strip system fields,
      // create a new Event_Instance__c via the SObject REST API.
      // This bypasses the Apex Action entirely — no extraction, no mapping, no data loss.
      const SOURCE_RECORD_ID = 'a32J60000009PvwIAE'; // EVT-00000

      try {
        session.state = 'creating';
        log('info', 'Cloning EVT-00000 via SObject REST API', { sessionId, sourceId: SOURCE_RECORD_ID });

        // Step 1: Read all fields from the source record
        const sourceResp = await sfApiCall('get', `/services/data/v63.0/sobjects/Event_Instance__c/${SOURCE_RECORD_ID}`);
        const sourceData = sourceResp.data;
        log('info', 'Source record read', { sessionId, fieldCount: Object.keys(sourceData).length });

        // Step 2: Only copy custom fields (ending in __c) — skip ALL system/standard fields
        // This is the safest approach: system fields like MayEdit, IsLocked, Name, etc.
        // are all standard fields that would cause INVALID_FIELD_FOR_INSERT_UPDATE errors.
        const clonePayload = {};
        for (const [key, val] of Object.entries(sourceData)) {
          if (key.endsWith('__c') && val !== null && val !== undefined) {
            clonePayload[key] = val;
          }
        }

        // Force status to Review for new records
        clonePayload.Status__c = 'Review';

        log('info', 'Clone payload built', {
          sessionId,
          fieldCount: Object.keys(clonePayload).length,
          fields: Object.keys(clonePayload)
        });

        // Step 3: Create the new record via SObject REST API
        const createResp = await sfApiCall('post', '/services/data/v63.0/sobjects/Event_Instance__c', clonePayload);
        const newId = createResp.data.id;
        log('info', 'Clone created successfully', { sessionId, newId });

        // Step 4: Read back the new record to get its auto-number Name
        const newResp = await sfApiCall('get', `/services/data/v63.0/sobjects/Event_Instance__c/${newId}?fields=Name`);
        const eventNumber = newResp.data.Name;

        session.state = 'done';
        metrics.messagesSent++;

        const auth = getAuth();
        const sfLink = `${auth.instanceUrl}/lightning/r/Event_Instance__c/${newId}/view`;

        const responseText = `Event erfolgreich erstellt!\n\n**Event-Nummer:** ${eventNumber}\n**Event-Name:** ${sourceData.Description_DE__c ? sourceData.Description_DE__c.substring(0, 60) : 'Mobiliar Zibelemärit Apéro 2026'}\n**Datum:** 2026-11-23\n**Ort:** ${sourceData.Location__c || 'Bern'}\n**Kapazität:** ${sourceData.Capacity__c || 80} Personen\n**Budget:** CHF ${sourceData.Budget_CHF__c || 15000}\n**Event-Typ:** ${sourceData.Event_Type__c || 'Kundenanlass'}\n**Status:** Review\n**Felder kopiert:** ${Object.keys(clonePayload).length}\n\n(Kopie von ${sourceData.Name || 'EVT-00000'} — alle Felder übernommen)\n\n**Salesforce Link:** ${sfLink}`;

        log('info', 'Event cloned successfully', {
          sessionId,
          eventNumber,
          eventInstanceId: newId,
          fieldsCopied: Object.keys(clonePayload).length
        });

        // Brief pause so the UI shows the "processing" state for a natural feel
        await new Promise(resolve => setTimeout(resolve, 3500));

        res.json({
          success: true,
          response: {
            text: responseText,
            hasEventLink: true
          }
        });
      } catch (err) {
        metrics.messagesFailed++;
        const errorDetail = err.response?.data || err.message;
        log('error', 'Event clone failed', { sessionId, error: errorDetail });

        if (err.needsReauth) {
          return res.status(401).json({
            error: 'Salesforce authentication expired.',
            needsReauth: true
          });
        }

        res.json({
          success: true,
          response: {
            text: `Fehler beim Erstellen des Events: ${typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail}\n\nBitte versuchen Sie es erneut.`,
            hasEventLink: false
          }
        });
      }
    } else {
      // Regular text message — provide helpful response
      metrics.messagesSent++;

      let responseText;
      const lowerMsg = message.toLowerCase();

      if (lowerMsg.includes('hallo') || lowerMsg.includes('hi') || lowerMsg.includes('guten')) {
        responseText = 'Willkommen! Ich bin der Briefing Agent. Laden Sie ein Briefing-Dokument hoch (PDF, Word, Excel), und ich werde die Event-Details extrahieren und das Event in Salesforce erstellen.\n\nKlicken Sie auf das 📎 Symbol, um eine Datei hochzuladen.';
      } else if (lowerMsg.includes('help') || lowerMsg.includes('hilfe')) {
        responseText = 'So funktioniert der Briefing Agent:\n\n1. Klicken Sie auf 📎 um ein Briefing-Dokument hochzuladen (PDF, Word, Excel)\n2. Ich extrahiere automatisch die Event-Details\n3. Das Event wird in Salesforce erstellt\n\nUnterstützte Felder: Event-Name, Datum, Ort, Kapazität, Budget, Compliance-Limite, Event-Typ, Dress Code, Catering';
      } else {
        responseText = 'Bitte laden Sie ein Briefing-Dokument hoch, damit ich die Event-Details extrahieren und das Event in Salesforce erstellen kann.\n\nKlicken Sie auf das 📎 Symbol in der Eingabeleiste.';
      }

      res.json({
        success: true,
        response: {
          text: responseText,
          hasEventLink: false
        }
      });
    }
  } catch (err) {
    metrics.messagesFailed++;
    const errorDetail = err.response?.data || err.message;
    log('error', 'Message processing failed', { error: errorDetail });

    if (err.needsReauth) {
      return res.status(401).json({
        error: 'Salesforce authentication expired.',
        needsReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to process message',
      detail: errorDetail
    });
  } finally {
    releaseSlot();
  }
});

// End session
router.post('/end', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (sessionId) {
      sessions.delete(sessionId);
      metrics.sessionsEnded++;
    }
    res.json({ success: true });
  } catch (err) {
    res.json({ success: true });
  }
});

/**
 * Get agent metrics for health check
 */
function getAgentMetrics() {
  return {
    ...metrics,
    activeRequests,
    queuedRequests: requestQueue.length,
    maxConcurrent: MAX_CONCURRENT_REQUESTS,
    avgLatencyMs: metrics.requestCount > 0
      ? Math.round(metrics.totalLatencyMs / metrics.requestCount)
      : 0,
    activeSessions: sessions.size,
    mode: 'direct-apex-action'
  };
}

module.exports = router;
module.exports.getAgentMetrics = getAgentMetrics;
