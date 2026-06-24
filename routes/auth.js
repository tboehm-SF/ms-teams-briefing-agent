const axios = require('axios');

// Salesforce auto-authentication module
// Supports two modes:
//   1. Username-password OAuth flow (SF_USERNAME + SF_PASSWORD + SF_CLIENT_ID + SF_CLIENT_SECRET)
//   2. Direct access token (SF_ACCESS_TOKEN + SF_INSTANCE_URL) — simpler, no Connected App needed
// No manual login required — authenticates automatically on server startup

const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_USERNAME = process.env.SF_USERNAME;
const SF_PASSWORD = process.env.SF_PASSWORD;
const SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || '';

// Direct token mode
const SF_ACCESS_TOKEN = process.env.SF_ACCESS_TOKEN;
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL;

// Token refresh interval (90 minutes — Salesforce tokens expire after ~2 hours)
const TOKEN_REFRESH_INTERVAL_MS = 90 * 60 * 1000;
let refreshTimer = null;

// Retry configuration
const MAX_AUTH_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// Auth state tracking
let authAttemptCount = 0;
let lastAuthTime = null;
let lastAuthError = null;

// Global token store — shared across all requests
let sfAuth = {
  accessToken: null,
  instanceUrl: null,
  username: null,
  issuedAt: null,
  mode: null // 'token' or 'password'
};

/**
 * Structured log helper with timestamps
 */
function log(level, message, data = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component: 'sf-auth',
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
 * Sleep helper for retry backoff
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Authenticate to Salesforce with retry logic.
 * Tries direct token first, then falls back to username-password flow.
 */
async function authenticate(retryCount = 0) {
  authAttemptCount++;

  // Mode 1: Direct access token (simplest — user provides token + instance URL)
  if (SF_ACCESS_TOKEN && SF_INSTANCE_URL) {
    log('info', 'Attempting direct access token authentication');
    sfAuth.accessToken = SF_ACCESS_TOKEN;
    sfAuth.instanceUrl = SF_INSTANCE_URL.replace(/\/$/, '');
    sfAuth.mode = 'token';

    try {
      const userInfo = await axios.get(`${sfAuth.instanceUrl}/services/oauth2/userinfo`, {
        headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` },
        timeout: 15000
      });
      sfAuth.username = userInfo.data.preferred_username || userInfo.data.name || 'Salesforce User';
      sfAuth.issuedAt = Date.now().toString();
      lastAuthTime = new Date().toISOString();
      lastAuthError = null;
      log('info', 'Salesforce connected (direct token)', {
        user: sfAuth.username,
        instance: sfAuth.instanceUrl
      });
      startRefreshTimer();
      return true;
    } catch (err) {
      log('warn', 'Direct token verification failed, falling back to password flow', {
        status: err.response?.status,
        error: err.response?.data || err.message
      });
      sfAuth.accessToken = null;
      sfAuth.instanceUrl = null;
    }
  }

  // Mode 2: Username-password OAuth flow
  if (SF_USERNAME && SF_PASSWORD && SF_CLIENT_ID && SF_CLIENT_SECRET) {
    try {
      log('info', 'Authenticating via username-password OAuth flow', {
        username: SF_USERNAME,
        loginUrl: SF_LOGIN_URL,
        attempt: retryCount + 1
      });

      const response = await axios.post(
        `${SF_LOGIN_URL}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'password',
          client_id: SF_CLIENT_ID,
          client_secret: SF_CLIENT_SECRET,
          username: SF_USERNAME,
          password: SF_PASSWORD + SF_SECURITY_TOKEN
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000
        }
      );

      sfAuth.accessToken = response.data.access_token;
      sfAuth.instanceUrl = response.data.instance_url;
      sfAuth.issuedAt = response.data.issued_at || Date.now().toString();
      sfAuth.mode = 'password';
      lastAuthTime = new Date().toISOString();
      lastAuthError = null;

      // Get display name
      try {
        const userInfo = await axios.get(response.data.id, {
          headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` },
          timeout: 10000
        });
        sfAuth.username = userInfo.data.display_name || userInfo.data.username || SF_USERNAME;
      } catch (e) {
        sfAuth.username = SF_USERNAME;
      }

      log('info', 'Salesforce authenticated (password flow)', {
        instance: sfAuth.instanceUrl,
        user: sfAuth.username
      });
      startRefreshTimer();
      return true;
    } catch (err) {
      const errorDetail = err.response?.data || err.message;
      lastAuthError = typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail;

      log('error', 'Salesforce password auth failed', {
        attempt: retryCount + 1,
        maxRetries: MAX_AUTH_RETRIES,
        error: lastAuthError
      });

      // Retry with exponential backoff
      if (retryCount < MAX_AUTH_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, retryCount);
        log('info', `Retrying authentication in ${delay}ms`, { nextAttempt: retryCount + 2 });
        await sleep(delay);
        return authenticate(retryCount + 1);
      }

      return false;
    }
  }

  log('error', 'No Salesforce credentials configured', {
    hasAccessToken: !!SF_ACCESS_TOKEN,
    hasInstanceUrl: !!SF_INSTANCE_URL,
    hasUsername: !!SF_USERNAME,
    hasPassword: !!SF_PASSWORD,
    hasClientId: !!SF_CLIENT_ID,
    hasClientSecret: !!SF_CLIENT_SECRET
  });
  return false;
}

/**
 * Start the proactive token refresh timer.
 * Re-authenticates every 90 minutes to prevent mid-session token expiry.
 */
function startRefreshTimer() {
  // Only refresh proactively in password mode (direct tokens can't be refreshed)
  if (sfAuth.mode !== 'password') return;

  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(async () => {
    log('info', 'Proactive token refresh starting');
    const success = await authenticate();
    if (success) {
      log('info', 'Proactive token refresh succeeded');
    } else {
      log('error', 'Proactive token refresh FAILED — agent API calls may fail');
    }
  }, TOKEN_REFRESH_INTERVAL_MS);

  log('info', `Token refresh timer started (every ${TOKEN_REFRESH_INTERVAL_MS / 60000} minutes)`);
}

/**
 * Re-authenticate (refresh) the token.
 * Called when a 401 is received from Salesforce APIs.
 */
async function refreshAuth() {
  log('info', 'Reactive token refresh triggered (401 received)');
  return authenticate();
}

/**
 * Get the current auth state (read-only).
 */
function getAuth() {
  return {
    accessToken: sfAuth.accessToken,
    instanceUrl: sfAuth.instanceUrl,
    username: sfAuth.username,
    authenticated: !!sfAuth.accessToken
  };
}

/**
 * Get auth diagnostics for health check (no secrets exposed).
 */
function getAuthHealth() {
  return {
    authenticated: !!sfAuth.accessToken,
    mode: sfAuth.mode,
    instanceUrl: sfAuth.instanceUrl || null,
    username: sfAuth.username || null,
    lastAuthTime,
    lastAuthError,
    authAttemptCount,
    tokenAge: sfAuth.issuedAt
      ? Math.round((Date.now() - parseInt(sfAuth.issuedAt)) / 60000) + ' minutes'
      : null,
    refreshTimerActive: !!refreshTimer
  };
}

module.exports = { authenticate, refreshAuth, getAuth, getAuthHealth };
