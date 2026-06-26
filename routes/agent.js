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
 * Try to match a value to a picklist. Returns the matched value or null.
 */
function matchPicklist(val, validValues) {
  if (!val) return null;
  const lower = val.trim().toLowerCase();
  // Exact match
  const exact = validValues.find(v => v.toLowerCase() === lower);
  if (exact) return exact;
  // Contains match
  const contains = validValues.find(v => lower.includes(v.toLowerCase()));
  return contains || null;
}

/**
 * Extract structured event data from briefing text.
 * Handles both label:value patterns AND CSV table data from Excel uploads.
 * Maps to ALL available fields on Event_Instance__c.
 */
function extractBriefingData(text) {
  const data = {};

  // Build a lookup map from the text: key → value
  // This handles CSV (key,value per row), label: value, and label = value formats
  const kvMap = new Map();
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Try CSV format: "Key,Value" or "Key;Value"
    const csvMatch = trimmed.match(/^"?([^",;]+)"?\s*[,;]\s*"?(.+?)"?\s*$/);
    if (csvMatch) {
      kvMap.set(csvMatch[1].trim().toLowerCase(), csvMatch[2].trim());
    }

    // Try label: value or label = value
    const labelMatch = trimmed.match(/^([^:=]+?)\s*[:=]\s*(.+)$/);
    if (labelMatch) {
      kvMap.set(labelMatch[1].trim().toLowerCase(), labelMatch[2].trim());
    }
  }

  // Helper: find a value by trying multiple possible keys
  function findValue(...keys) {
    for (const key of keys) {
      const lower = key.toLowerCase();
      // Exact match
      if (kvMap.has(lower)) return kvMap.get(lower);
      // Partial match — find any key that contains the search term
      for (const [k, v] of kvMap) {
        if (k.includes(lower) || lower.includes(k)) return v;
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

  // Event name
  data.eventNameDE = findValue('event-name', 'event name', 'eventname', 'veranstaltung', 'anlass', 'titel', 'name', 'event name (de)', 'event-name (de)')
    || regexFind([
      /(?:Event(?:-?Name)?|Veranstaltung|Anlass|Titel)\s*[:=]\s*["']?(.+?)["']?\s*$/im,
      /^(?:Name|Titel|Event)\s*[:]\s*(.+)$/im
    ]);

  // Event name FR
  data.eventNameFR = findValue('event name (fr)', 'event-name (fr)', 'eventname fr', 'name fr', 'nom', 'titre fr');

  // Date
  const rawDate = findValue('datum', 'date', 'termin', 'event-datum', 'event datum', 'event date', 'eventdatum', 'wann')
    || regexFind([
      /(?:Datum|Date|Termin|Wann)\s*[:=]\s*(\S+(?:\s+\d{1,2}:\d{2})?)/i
    ]);
  data.eventDateStr = normalizeDate(rawDate);

  // Start time
  const rawStartTime = findValue('startzeit', 'start time', 'beginn', 'anfang', 'von', 'start', 'uhrzeit', 'zeit');
  data.startTime = normalizeTime(rawStartTime);

  // End time
  const rawEndTime = findValue('endzeit', 'end time', 'ende', 'bis', 'schluss');
  data.endTime = normalizeTime(rawEndTime);

  // If we found start time but no separate date+time, embed time into date
  if (data.startTime && data.eventDateStr && data.eventDateStr.endsWith('T00:00:00')) {
    data.eventDateStr = data.eventDateStr.replace('T00:00:00', `T${data.startTime}:00`);
  }

  // Location
  data.location = findValue('ort', 'location', 'veranstaltungsort', 'venue', 'standort', 'adresse', 'wo', 'plz/ort')
    || regexFind([/(?:Ort|Location|Veranstaltungsort|Venue|Wo|Standort|Adresse)\s*[:=]\s*(.+?)$/im]);

  // Capacity
  const rawCap = findValue('kapazität', 'kapazitaet', 'capacity', 'teilnehmer', 'personen', 'gäste', 'gaeste', 'anzahl', 'max. teilnehmer', 'max teilnehmer', 'plätze', 'plaetze')
    || regexFind([
      /(?:Kapazit[aä]t|Capacity|Teilnehmer|Anzahl)\s*[:=]\s*(\d+)/i,
      /(\d+)\s*(?:Personen|Teilnehmer|G[aä]ste)/i
    ]);
  if (rawCap) {
    const n = parseInt(rawCap);
    if (!isNaN(n)) data.capacity = n;
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

  // Description
  data.descriptionDE = findValue('beschreibung', 'beschreibung (de)', 'description', 'zusammenfassung', 'beschreibung de')
    || regexFind([/(?:Beschreibung|Description|Zusammenfassung)\s*[:=]\s*(.+?)$/im]);
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

  data.ordererFirstName = findValue('auftraggeber vorname', 'orderer first name', 'vorname auftraggeber', 'besteller vorname');
  data.ordererLastName = findValue('auftraggeber nachname', 'orderer last name', 'nachname auftraggeber', 'besteller nachname');
  data.ordererCompany = findValue('auftraggeber firma', 'orderer company', 'firma auftraggeber', 'besteller firma', 'firma');
  data.ordererEmail = findValue('auftraggeber e-mail', 'auftraggeber email', 'orderer email', 'e-mail auftraggeber', 'besteller email');
  data.ordererPhone = findValue('auftraggeber telefon', 'orderer phone', 'telefon auftraggeber', 'besteller telefon');
  data.ordererFunction = findValue('auftraggeber funktion', 'auftraggeber funktion (de)', 'orderer function', 'funktion auftraggeber');
  data.ordererFunctionFR = findValue('auftraggeber funktion (fr)', 'orderer function fr', 'funktion auftraggeber fr');

  // Also try combined "Auftraggeber" field and split first/last name
  if (!data.ordererFirstName && !data.ordererLastName) {
    const combined = findValue('auftraggeber', 'besteller', 'orderer', 'kontaktperson');
    if (combined) {
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

  data.featuresDE = findValue('besonderheiten', 'besonderheiten (de)', 'features', 'features de');
  data.featuresFR = findValue('besonderheiten fr', 'besonderheiten (fr)', 'features fr');
  data.supportingProgramDE = findValue('rahmenprogramm', 'rahmenprogramm (de)', 'supporting program', 'programm');
  data.supportingProgramFR = findValue('rahmenprogramm fr', 'rahmenprogramm (fr)', 'supporting program fr');

  // ══════════════════════════════════════════
  // DATE MILESTONES
  // ══════════════════════════════════════════

  const rawStartSelling = findValue('start verkaufsdatum', 'start selling', 'verkaufsstart');
  data.startSellingDate = normalizeDate(rawStartSelling);

  const rawEndSelling = findValue('ende verkaufsdatum', 'end selling', 'verkaufsende');
  data.endSellingDate = normalizeDate(rawEndSelling);

  const rawEarlyBird = findValue('early bird', 'early bird deadline', 'frühbucher');
  data.earlyBirdDeadline = normalizeDate(rawEarlyBird);

  const rawGuestDeadline = findValue('an-/abmeldefrist', 'anmeldefrist', 'abmeldefrist', 'deadline gast', 'deadline guest registration', 'anmeldeschluss');
  data.deadlineGuestRegistration = normalizeDate(rawGuestDeadline);

  const rawGuestMgmt = findValue('deadline gastdatenerfassung', 'end guest management', 'gastdatenerfassung');
  data.endGuestManagementDate = normalizeDate(rawGuestMgmt);

  // ══════════════════════════════════════════
  // FLAGS
  // ══════════════════════════════════════════

  function parseBool(val) {
    if (!val) return null;
    const lower = val.toLowerCase().trim();
    if (['ja', 'yes', 'true', '1', 'x', 'wahr'].includes(lower)) return true;
    if (['nein', 'no', 'false', '0', 'falsch', '-'].includes(lower)) return false;
    return null;
  }

  data.manageJointGuests = parseBool(findValue('warteliste', 'waiting list', 'manage joint guests'));
  data.emailMandatory = parseBool(findValue('e-mail pflichtfeld', 'email mandatory', 'email pflicht', 'e-mail pflicht'));
  data.mobileMandatory = parseBool(findValue('mobiltelefon pflichtfeld', 'mobile mandatory', 'mobil pflicht', 'handy pflicht'));
  data.addressMandatory = parseBool(findValue('anschrift pflichtfeld', 'address mandatory', 'adresse pflicht'));

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

      // Extract structured data from the briefing
      const extractedData = extractBriefingData(briefingText);
      session.extractedData = extractedData;
      session.state = 'extracting';

      log('info', 'Briefing data extracted', { sessionId, fields: Object.keys(extractedData) });

      // If we have at minimum an event name, proceed to create the event
      if (!extractedData.eventNameDE) {
        // Try to generate a name from the first meaningful line
        const firstLine = briefingText.split('\n').find(l => l.trim().length > 5);
        if (firstLine) {
          extractedData.eventNameDE = firstLine.trim().substring(0, 80);
        } else {
          extractedData.eventNameDE = 'Neues Event';
        }
      }

      // Call the Apex Action to create the event
      try {
        session.state = 'creating';

        // Build payload with ALL extracted fields
        const d = extractedData;
        const actionPayload = {
          inputs: [{
            // Core
            eventNameDE:        d.eventNameDE,
            eventNameFR:        d.eventNameFR || null,
            eventDateStr:       d.eventDateStr || null,
            location:           d.location || null,
            capacity:           d.capacity || null,
            budgetCHF:          d.budgetCHF || null,
            complianceLimitCHF: d.complianceLimitCHF || null,
            eventType:          d.eventType || null,
            dressCode:          d.dressCode || null,
            // Descriptions
            descriptionDE:      d.descriptionDE || null,
            descriptionFR:      d.descriptionFR || null,
            descriptionEN:      d.descriptionEN || null,
            descriptionIT:      d.descriptionIT || null,
            // Catering
            cateringNotes:      d.cateringNotes || null,
            cateringNotesFR:    d.cateringNotesFR || null,
            cateringNotesIT:    d.cateringNotesIT || null,
            // Content
            contentDE:          d.contentDE || null,
            contentFR:          d.contentFR || null,
            // Time
            startTime:          d.startTime || null,
            endTime:            d.endTime || null,
            // Pricing
            priceCHF:           d.priceCHF || null,
            reducedPriceCHF:    d.reducedPriceCHF || null,
            eventSinglePrice:   d.eventSinglePrice || null,
            // Geography
            canton:             d.canton || null,
            region:             d.region || null,
            segment:            d.segment || null,
            category:           d.category || null,
            // Logistics
            tableShape:         d.tableShape || null,
            imageURL:           d.imageURL || null,
            // Orderer
            ordererFirstName:   d.ordererFirstName || null,
            ordererLastName:    d.ordererLastName || null,
            ordererCompany:     d.ordererCompany || null,
            ordererEmail:       d.ordererEmail || null,
            ordererPhone:       d.ordererPhone || null,
            ordererFunction:    d.ordererFunction || null,
            ordererFunctionFR:  d.ordererFunctionFR || null,
            // Features
            featuresDE:         d.featuresDE || null,
            featuresFR:         d.featuresFR || null,
            supportingProgramDE: d.supportingProgramDE || null,
            supportingProgramFR: d.supportingProgramFR || null,
            // Date milestones
            startSellingDate:   d.startSellingDate || null,
            endSellingDate:     d.endSellingDate || null,
            earlyBirdDeadline:  d.earlyBirdDeadline || null,
            deadlineGuestRegistration: d.deadlineGuestRegistration || null,
            endGuestManagementDate:    d.endGuestManagementDate || null,
            // Flags
            manageJointGuests:  d.manageJointGuests != null ? d.manageJointGuests : null,
            emailMandatory:     d.emailMandatory != null ? d.emailMandatory : null,
            mobileMandatory:    d.mobileMandatory != null ? d.mobileMandatory : null,
            addressMandatory:   d.addressMandatory != null ? d.addressMandatory : null
          }]
        };

        log('info', 'Calling Apex action', { sessionId, eventName: extractedData.eventNameDE });

        const response = await sfApiCall('post', APEX_ACTION_PATH, actionPayload);
        const result = response.data[0];

        if (result.isSuccess && result.outputValues.success) {
          session.state = 'done';
          metrics.messagesSent++;

          const responseText = result.outputValues.message;

          log('info', 'Event created successfully', {
            sessionId,
            eventNumber: result.outputValues.eventNumber,
            eventInstanceId: result.outputValues.eventInstanceId
          });

          res.json({
            success: true,
            response: {
              text: responseText,
              hasEventLink: true
            }
          });
        } else {
          throw new Error(result.outputValues?.message || 'Apex action failed');
        }
      } catch (err) {
        metrics.messagesFailed++;
        const errorDetail = err.response?.data || err.message;
        log('error', 'Event creation failed', { sessionId, error: errorDetail });

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
