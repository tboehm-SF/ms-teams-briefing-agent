const express = require('express');
const axios = require('axios');
const { getAuth, refreshAuth } = require('./auth');
const router = express.Router();

// Agent configuration
const AGENT_ID = process.env.SF_AGENT_ID || '0XxJ60000009XUqKAM';
const AGENT_API_BASE = '/services/einstein/ai-agent/v1';

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
 * Concurrency limiter — queues requests when at max capacity
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

// Create agent session
router.post('/session', requireAuth, async (req, res) => {
  await acquireSlot();
  try {
    const url = `${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`;

    log('info', 'Creating agent session', { agentId: AGENT_ID });

    const response = await sfApiCall('post', url, {});

    metrics.sessionsCreated++;
    log('info', 'Agent session created', { sessionId: response.data.sessionId });

    res.json({
      success: true,
      sessionId: response.data.sessionId
    });
  } catch (err) {
    metrics.sessionsFailed++;
    const errorDetail = err.response?.data || err.message;
    log('error', 'Session creation failed', { error: errorDetail });

    if (err.needsReauth) {
      return res.status(401).json({
        error: 'Salesforce authentication expired and refresh failed.',
        needsReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to create agent session',
      detail: errorDetail
    });
  } finally {
    releaseSlot();
  }
});

// Send message to agent
router.post('/message', requireAuth, async (req, res) => {
  await acquireSlot();
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      releaseSlot();
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const url = `${AGENT_API_BASE}/sessions/${sessionId}/messages`;

    log('info', 'Sending message to agent', {
      sessionId,
      messageLength: message.length
    });

    const response = await sfApiCall('post', url, {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message
      }
    }, { timeout: 120000 });

    metrics.messagesSent++;

    // Parse agent response
    const agentResponse = parseAgentResponse(response.data);

    log('info', 'Agent response received', {
      sessionId,
      responseLength: agentResponse.text.length,
      hasEventLink: agentResponse.hasEventLink
    });

    res.json({
      success: true,
      response: agentResponse,
      raw: response.data
    });
  } catch (err) {
    metrics.messagesFailed++;
    const errorDetail = err.response?.data || err.message;
    log('error', 'Message send failed', { error: errorDetail });

    if (err.needsReauth) {
      return res.status(401).json({
        error: 'Salesforce authentication expired and refresh failed.',
        needsReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to send message to agent',
      detail: errorDetail
    });
  } finally {
    releaseSlot();
  }
});

// End agent session
router.post('/end', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.json({ success: true });
    }

    const url = `${AGENT_API_BASE}/sessions/${sessionId}`;

    log('info', 'Ending agent session', { sessionId });

    await sfApiCall('delete', url);
    metrics.sessionsEnded++;

    res.json({ success: true });
  } catch (err) {
    // Non-critical, session might have expired
    log('warn', 'End session error (non-critical)', {
      error: err.response?.data || err.message
    });
    res.json({ success: true, warning: 'Session may have already ended' });
  }
});

// Parse agent response into display-friendly format
function parseAgentResponse(data) {
  let text = '';
  let actions = [];

  // Handle the standard Agent API response format
  if (data.messages && Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      const msgType = (msg.type || '').toLowerCase();
      if (msgType === 'text' || msgType === 'informativetext' || msgType === 'informative') {
        text += (msg.text || msg.message || '') + '\n';
      } else if (msgType === 'error') {
        log('warn', 'Agent returned error message', { errorText: msg.text || msg.message });
        text += '[Error] ' + (msg.text || msg.message || 'Unknown agent error') + '\n';
      } else if (msgType === 'endofturn') {
        // End of turn — agent finished processing
        log('info', 'Agent end of turn received');
      }
    }
  }

  // Fallback: try to extract text from various response shapes
  if (!text && data.message) {
    text = typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
  }
  if (!text && data.text) {
    text = data.text;
  }
  if (!text && data.response) {
    text = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
  }

  // Clean up: remove excessive newlines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return {
    text: text || 'Agent did not return a text response.',
    actions: actions,
    hasEventLink: text.includes('lightning.force.com') || text.includes('Event_Instance__c')
  };
}

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
    agentId: AGENT_ID
  };
}

module.exports = router;
module.exports.getAgentMetrics = getAgentMetrics;
