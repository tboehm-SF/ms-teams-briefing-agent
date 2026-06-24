const express = require('express');
const axios = require('axios');
const { getAuth, refreshAuth } = require('./auth');
const router = express.Router();

// Apex Action endpoint for creating hospitality events
const APEX_ACTION_PATH = '/services/data/v63.0/actions/custom/apex/CreateHospitalityEventAction';

// Valid picklist values (from Salesforce org)
const VALID_DRESS_CODES = ['Business', 'Smart Casual', 'Casual', 'Formal'];
const VALID_EVENT_TYPES = ['Kundenanlass', 'Networking', 'Webinar', 'Messe', 'Generalversammlung', 'Mitarbeiteranlass'];

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
 * Extract structured event data from briefing text.
 * Uses pattern matching to pull out dates, locations, capacities, budgets, etc.
 */
function extractBriefingData(text) {
  const data = {};

  // Event name — look for common patterns
  const namePatterns = [
    /(?:Event(?:-?Name)?|Veranstaltung|Anlass|Titel)\s*[:=]\s*["']?(.+?)["']?\s*$/im,
    /^(?:Name|Titel|Event)\s*[:]\s*(.+)$/im
  ];
  for (const p of namePatterns) {
    const m = text.match(p);
    if (m) { data.eventNameDE = m[1].trim(); break; }
  }

  // Date — ISO or German format
  const datePatterns = [
    /(?:Datum|Date|Termin|Wann)\s*[:=]\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?)/i,
    /(?:Datum|Date|Termin|Wann)\s*[:=]\s*(\d{1,2}\.\d{1,2}\.\d{4}(?:\s+\d{1,2}:\d{2})?)/i,
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/,
    /(\d{1,2}\.\d{1,2}\.\d{4})/
  ];
  for (const p of datePatterns) {
    const m = text.match(p);
    if (m) {
      let ds = m[1].trim();
      // Convert German date format to ISO
      const germanMatch = ds.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
      if (germanMatch) {
        const [, day, month, year, hour, min] = germanMatch;
        ds = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        if (hour) ds += `T${hour.padStart(2, '0')}:${min}:00`;
        else ds += 'T00:00:00';
      } else if (!ds.includes('T')) {
        ds += 'T00:00:00';
      }
      data.eventDateStr = ds;
      break;
    }
  }

  // Location
  const locPatterns = [
    /(?:Ort|Location|Veranstaltungsort|Venue|Wo|Standort|Adresse)\s*[:=]\s*(.+?)$/im
  ];
  for (const p of locPatterns) {
    const m = text.match(p);
    if (m) { data.location = m[1].trim(); break; }
  }

  // Capacity
  const capPatterns = [
    /(?:Kapazit[aä]t|Capacity|Teilnehmer|Personen|G[aä]ste|Anzahl)\s*[:=]\s*(\d+)/i,
    /(\d+)\s*(?:Personen|Teilnehmer|G[aä]ste|persons|guests|attendees)/i
  ];
  for (const p of capPatterns) {
    const m = text.match(p);
    if (m) { data.capacity = parseInt(m[1]); break; }
  }

  // Budget
  const budgetPatterns = [
    /(?:Budget|Gesamtbudget)\s*[:=]\s*(?:CHF\s*)?([0-9.,]+)/i,
    /(?:Budget|Gesamtbudget)\s*[:=]\s*([0-9.,]+)\s*(?:CHF)?/i
  ];
  for (const p of budgetPatterns) {
    const m = text.match(p);
    if (m) {
      data.budgetCHF = parseFloat(m[1].replace(/[.']/g, '').replace(',', '.'));
      break;
    }
  }

  // Compliance limit
  const compPatterns = [
    /(?:Compliance[- ]?Limit[e]?|Pro[- ]Person[- ]Limit)\s*[:=]\s*(?:CHF\s*)?([0-9.,]+)/i
  ];
  for (const p of compPatterns) {
    const m = text.match(p);
    if (m) {
      data.complianceLimitCHF = parseFloat(m[1].replace(/[.']/g, '').replace(',', '.'));
      break;
    }
  }

  // Event type
  const typePatterns = [
    /(?:Event[- ]?Typ|Typ|Art|Type|Kategorie)\s*[:=]\s*(.+?)$/im
  ];
  for (const p of typePatterns) {
    const m = text.match(p);
    if (m) {
      const val = m[1].trim();
      // Try to match to a valid picklist type
      const match = VALID_EVENT_TYPES.find(t => t.toLowerCase() === val.toLowerCase() || val.toLowerCase().includes(t.toLowerCase()));
      data.eventType = match || 'Kundenanlass'; // default
      break;
    }
  }
  // Also scan for type keywords in full text
  if (!data.eventType) {
    for (const t of VALID_EVENT_TYPES) {
      if (text.toLowerCase().includes(t.toLowerCase())) {
        data.eventType = t;
        break;
      }
    }
  }

  // Dress code — map to valid picklist values: Business, Smart Casual, Casual, Formal
  const dressPatterns = [
    /(?:Dress[- ]?Code|Kleiderordnung|Kleidung)\s*[:=]\s*(.+?)$/im
  ];
  for (const p of dressPatterns) {
    const m = text.match(p);
    if (m) {
      const raw = m[1].trim().toLowerCase();
      // Map common variations to valid picklist values
      if (raw.includes('formal') || raw.includes('abend')) {
        data.dressCode = 'Formal';
      } else if (raw.includes('smart casual') || raw.includes('business casual') || raw.includes('smart')) {
        data.dressCode = 'Smart Casual';
      } else if (raw.includes('business')) {
        data.dressCode = 'Business';
      } else if (raw.includes('casual') || raw.includes('leger') || raw.includes('zwanglos')) {
        data.dressCode = 'Casual';
      } else {
        // Try exact match
        const match = VALID_DRESS_CODES.find(v => v.toLowerCase() === raw);
        data.dressCode = match || 'Smart Casual'; // default
      }
      break;
    }
  }

  // Catering
  const cateringPatterns = [
    /(?:Catering|Verpflegung|Essen|Menu)\s*[:=]\s*(.+?)$/im
  ];
  for (const p of cateringPatterns) {
    const m = text.match(p);
    if (m) { data.cateringNotes = m[1].trim(); break; }
  }

  // Description — look for explicit description or use remaining context
  const descPatterns = [
    /(?:Beschreibung|Description|Zusammenfassung)\s*[:=]\s*(.+?)$/im
  ];
  for (const p of descPatterns) {
    const m = text.match(p);
    if (m) { data.descriptionDE = m[1].trim(); break; }
  }

  return data;
}

/**
 * Generate a summary of what was extracted from the briefing.
 */
function generateExtractionSummary(data) {
  const fields = [];
  if (data.eventNameDE) fields.push(`**Event-Name:** ${data.eventNameDE}`);
  if (data.eventDateStr) fields.push(`**Datum:** ${data.eventDateStr}`);
  if (data.location) fields.push(`**Ort:** ${data.location}`);
  if (data.capacity) fields.push(`**Kapazität:** ${data.capacity} Personen`);
  if (data.budgetCHF) fields.push(`**Budget:** CHF ${data.budgetCHF.toLocaleString()}`);
  if (data.complianceLimitCHF) fields.push(`**Compliance-Limite:** CHF ${data.complianceLimitCHF}`);
  if (data.eventType) fields.push(`**Event-Typ:** ${data.eventType}`);
  if (data.dressCode) fields.push(`**Dress Code:** ${data.dressCode}`);
  if (data.cateringNotes) fields.push(`**Catering:** ${data.cateringNotes}`);

  if (fields.length === 0) {
    return 'Ich konnte keine Event-Details aus dem Dokument extrahieren. Bitte stellen Sie sicher, dass das Briefing Informationen wie Event-Name, Datum, Ort und Kapazität enthält.';
  }

  let summary = 'Ich habe folgende Event-Details aus dem Briefing extrahiert:\n\n';
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

        const actionPayload = {
          inputs: [{
            eventNameDE: extractedData.eventNameDE,
            eventDateStr: extractedData.eventDateStr || null,
            location: extractedData.location || null,
            capacity: extractedData.capacity || null,
            budgetCHF: extractedData.budgetCHF || null,
            complianceLimitCHF: extractedData.complianceLimitCHF || null,
            eventType: extractedData.eventType || null,
            dressCode: extractedData.dressCode || null,
            cateringNotes: extractedData.cateringNotes || null,
            descriptionDE: extractedData.descriptionDE || null
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
