const express = require('express');
const axios = require('axios');
const { getAuth, refreshAuth } = require('./auth');
const router = express.Router();

// Agent configuration
const AGENT_ID = process.env.SF_AGENT_ID || '0XxJ60000009XUqKAM';
const AGENT_API_BASE = '/services/einstein/ai-agent/v1';

// Middleware: check global auth
function requireAuth(req, res, next) {
  const auth = getAuth();
  if (!auth.authenticated) {
    return res.status(401).json({ error: 'Salesforce not authenticated. Server may still be starting up.' });
  }
  // Attach auth to request for convenience
  req.sfAuth = auth;
  next();
}

// Create agent session
router.post('/session', requireAuth, async (req, res) => {
  try {
    const { accessToken, instanceUrl } = req.sfAuth;
    const url = `${instanceUrl}${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`;

    const response = await axios.post(url, {}, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({
      success: true,
      sessionId: response.data.sessionId
    });
  } catch (err) {
    console.error('Session creation error:', err.response?.data || err.message);

    // If 401, try to refresh and retry once
    if (err.response?.status === 401) {
      const refreshed = await refreshAuth();
      if (refreshed) {
        try {
          const auth = getAuth();
          const url = `${auth.instanceUrl}${AGENT_API_BASE}/agents/${AGENT_ID}/sessions`;
          const retryResponse = await axios.post(url, {}, {
            headers: {
              'Authorization': `Bearer ${auth.accessToken}`,
              'Content-Type': 'application/json'
            }
          });
          return res.json({
            success: true,
            sessionId: retryResponse.data.sessionId
          });
        } catch (retryErr) {
          console.error('Retry session creation failed:', retryErr.response?.data || retryErr.message);
        }
      }
      return res.status(401).json({
        error: 'Salesforce authentication expired and refresh failed.',
        needsReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to create agent session',
      detail: err.response?.data || err.message
    });
  }
});

// Send message to agent
router.post('/message', requireAuth, async (req, res) => {
  try {
    const { sessionId, message } = req.body;

    if (!sessionId || !message) {
      return res.status(400).json({ error: 'sessionId and message are required' });
    }

    const { accessToken, instanceUrl } = req.sfAuth;
    const url = `${instanceUrl}${AGENT_API_BASE}/sessions/${sessionId}/messages`;

    const response = await axios.post(url, {
      message: {
        sequenceId: Date.now(),
        type: 'Text',
        text: message
      }
    }, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 120000 // 2 min timeout for agent processing
    });

    // Parse agent response
    const agentResponse = parseAgentResponse(response.data);

    res.json({
      success: true,
      response: agentResponse,
      raw: response.data
    });
  } catch (err) {
    console.error('Message error:', err.response?.data || err.message);

    // If 401, try to refresh and retry once
    if (err.response?.status === 401) {
      const refreshed = await refreshAuth();
      if (refreshed) {
        try {
          const auth = getAuth();
          const { sessionId, message } = req.body;
          const url = `${auth.instanceUrl}${AGENT_API_BASE}/sessions/${sessionId}/messages`;
          const retryResponse = await axios.post(url, {
            message: {
              sequenceId: Date.now(),
              type: 'Text',
              text: message
            }
          }, {
            headers: {
              'Authorization': `Bearer ${auth.accessToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 120000
          });
          const agentResponse = parseAgentResponse(retryResponse.data);
          return res.json({
            success: true,
            response: agentResponse,
            raw: retryResponse.data
          });
        } catch (retryErr) {
          console.error('Retry message failed:', retryErr.response?.data || retryErr.message);
        }
      }
      return res.status(401).json({
        error: 'Salesforce authentication expired and refresh failed.',
        needsReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to send message to agent',
      detail: err.response?.data || err.message
    });
  }
});

// End agent session
router.post('/end', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) {
      return res.json({ success: true });
    }

    const { accessToken, instanceUrl } = req.sfAuth;
    const url = `${instanceUrl}${AGENT_API_BASE}/sessions/${sessionId}`;

    await axios.delete(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({ success: true });
  } catch (err) {
    // Non-critical, session might have expired
    console.error('End session error:', err.response?.data || err.message);
    res.json({ success: true, warning: 'Session may have already ended' });
  }
});

// Parse agent response into display-friendly format
function parseAgentResponse(data) {
  let text = '';
  let actions = [];

  if (data.messages && Array.isArray(data.messages)) {
    for (const msg of data.messages) {
      if (msg.type === 'Text' || msg.type === 'text') {
        text += (msg.text || msg.message || '') + '\n';
      } else if (msg.type === 'InformativeText' || msg.type === 'informative') {
        text += (msg.text || msg.message || '') + '\n';
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

  // Clean up: remove double newlines
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return {
    text: text || 'Agent did not return a text response.',
    actions: actions,
    hasEventLink: text.includes('lightning.force.com') || text.includes('Event_Instance__c')
  };
}

module.exports = router;
