const axios = require('axios');

// Salesforce authentication module
// Supports four modes:
//   1. Username-password OAuth flow (SF_USERNAME + SF_PASSWORD + SF_CLIENT_ID + SF_CLIENT_SECRET)
//   2. Direct access token (SF_ACCESS_TOKEN + SF_INSTANCE_URL) — simpler, no Connected App needed
//   3. Client Credentials OAuth flow (SF_CC_CLIENT_ID + SF_CC_CLIENT_SECRET + SF_INSTANCE_URL)
//      — Required for Agent API access (chatbot_api + sfap_api scopes via External Client App)
//   4. Runtime login — user enters credentials via the login UI at startup
// Environment variables auto-authenticate on boot. If none are set, the login UI is shown.

// Mutable credentials — can be set at runtime via the login UI
let credentials = {
  loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com',
  clientId: process.env.SF_CLIENT_ID || '',
  clientSecret: process.env.SF_CLIENT_SECRET || '',
  username: process.env.SF_USERNAME || '',
  password: process.env.SF_PASSWORD || '',
  securityToken: process.env.SF_SECURITY_TOKEN || '',
  accessToken: process.env.SF_ACCESS_TOKEN || '',
  instanceUrl: process.env.SF_INSTANCE_URL || '',
  // Client Credentials flow (External Client App — required for Agent API scopes)
  ccClientId: process.env.SF_CC_CLIENT_ID || '',
  ccClientSecret: process.env.SF_CC_CLIENT_SECRET || '',
  ccInstanceUrl: process.env.SF_CC_INSTANCE_URL || process.env.SF_INSTANCE_URL || ''
};

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
  mode: null // 'token', 'password', or 'client_credentials'
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
 * Set credentials at runtime (from the login UI).
 * Overwrites the in-memory credentials and triggers authentication.
 * Returns { success, error? }
 */
async function setCredentials(newCreds) {
  if (newCreds.mode === 'client_credentials' && newCreds.clientId && newCreds.clientSecret && newCreds.instanceUrl) {
    // Client Credentials flow — External Client App with Agent API scopes
    credentials.ccClientId = newCreds.clientId;
    credentials.ccClientSecret = newCreds.clientSecret;
    credentials.ccInstanceUrl = newCreds.instanceUrl;
    // Clear other modes so client_credentials takes priority
    credentials.accessToken = '';
    credentials.username = '';
    credentials.password = '';
  } else if (newCreds.accessToken && newCreds.instanceUrl) {
    credentials.accessToken = newCreds.accessToken;
    credentials.instanceUrl = newCreds.instanceUrl;
  } else if (newCreds.username && newCreds.password && newCreds.clientId && newCreds.clientSecret) {
    credentials.username = newCreds.username;
    credentials.password = newCreds.password;
    credentials.clientId = newCreds.clientId;
    credentials.clientSecret = newCreds.clientSecret;
    credentials.securityToken = newCreds.securityToken || '';
    credentials.loginUrl = newCreds.loginUrl || 'https://login.salesforce.com';
  } else {
    return { success: false, error: 'Incomplete credentials. Provide Client Credentials (Consumer Key + Secret + Instance URL), Access Token + Instance URL, or Username + Password + Client ID + Client Secret.' };
  }

  // Clear previous auth state
  sfAuth.accessToken = null;
  sfAuth.instanceUrl = null;
  sfAuth.username = null;
  sfAuth.mode = null;
  lastAuthError = null;

  const ok = await authenticate();
  if (ok) {
    return { success: true };
  }
  return { success: false, error: lastAuthError || 'Authentication failed' };
}

/**
 * Check if any credentials are configured (env vars or runtime).
 */
function hasCredentials() {
  return !!(
    (credentials.ccClientId && credentials.ccClientSecret && credentials.ccInstanceUrl) ||
    (credentials.accessToken && credentials.instanceUrl) ||
    (credentials.username && credentials.password && credentials.clientId && credentials.clientSecret)
  );
}

/**
 * Authenticate to Salesforce with retry logic.
 * Tries direct token first, then falls back to username-password flow.
 */
async function authenticate(retryCount = 0) {
  authAttemptCount++;

  // Mode 1: Direct access token (simplest — user provides token + instance URL)
  if (credentials.accessToken && credentials.instanceUrl) {
    log('info', 'Attempting direct access token authentication');
    sfAuth.accessToken = credentials.accessToken;
    sfAuth.instanceUrl = credentials.instanceUrl.replace(/\/$/, '');
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
      const errorDetail = err.response?.data || err.message;
      lastAuthError = typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail;
      log('warn', 'Direct token verification failed, falling back to password flow', {
        status: err.response?.status,
        error: errorDetail
      });
      sfAuth.accessToken = null;
      sfAuth.instanceUrl = null;
    }
  }

  // Mode 2: Client Credentials OAuth flow (External Client App — has chatbot_api + sfap_api scopes)
  // This is the REQUIRED mode for Agent API access.
  if (credentials.ccClientId && credentials.ccClientSecret && credentials.ccInstanceUrl) {
    try {
      const ccInstanceUrl = credentials.ccInstanceUrl.replace(/\/$/, '');
      log('info', 'Authenticating via Client Credentials OAuth flow', {
        instanceUrl: ccInstanceUrl,
        attempt: retryCount + 1
      });

      const response = await axios.post(
        `${ccInstanceUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: credentials.ccClientId,
          client_secret: credentials.ccClientSecret
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 30000
        }
      );

      sfAuth.accessToken = response.data.access_token;
      sfAuth.instanceUrl = response.data.instance_url || ccInstanceUrl;
      sfAuth.issuedAt = response.data.issued_at || Date.now().toString();
      sfAuth.mode = 'client_credentials';
      lastAuthTime = new Date().toISOString();
      lastAuthError = null;

      // Get display name from userinfo
      try {
        const userInfo = await axios.get(`${sfAuth.instanceUrl}/services/oauth2/userinfo`, {
          headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` },
          timeout: 10000
        });
        sfAuth.username = userInfo.data.preferred_username || userInfo.data.name || 'External Client App';
      } catch (e) {
        sfAuth.username = 'External Client App';
      }

      log('info', 'Salesforce authenticated (client_credentials flow)', {
        instance: sfAuth.instanceUrl,
        user: sfAuth.username
      });
      startRefreshTimer();
      return true;
    } catch (err) {
      const errorDetail = err.response?.data || err.message;
      lastAuthError = typeof errorDetail === 'object' ? JSON.stringify(errorDetail) : errorDetail;

      log('error', 'Salesforce client_credentials auth failed', {
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

  // Mode 3: Username-password OAuth flow
  if (credentials.username && credentials.password && credentials.clientId && credentials.clientSecret) {
    try {
      log('info', 'Authenticating via username-password OAuth flow', {
        username: credentials.username,
        loginUrl: credentials.loginUrl,
        attempt: retryCount + 1
      });

      const response = await axios.post(
        `${credentials.loginUrl}/services/oauth2/token`,
        new URLSearchParams({
          grant_type: 'password',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          username: credentials.username,
          password: credentials.password + credentials.securityToken
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
        sfAuth.username = userInfo.data.display_name || userInfo.data.username || credentials.username;
      } catch (e) {
        sfAuth.username = credentials.username;
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

  log('warn', 'No Salesforce credentials configured — waiting for login', {
    hasAccessToken: !!credentials.accessToken,
    hasInstanceUrl: !!credentials.instanceUrl,
    hasUsername: !!credentials.username,
    hasPassword: !!credentials.password,
    hasClientId: !!credentials.clientId,
    hasClientSecret: !!credentials.clientSecret
  });
  return false;
}

/**
 * Start the proactive token refresh timer.
 * Re-authenticates every 90 minutes to prevent mid-session token expiry.
 */
function startRefreshTimer() {
  // Refresh proactively for password and client_credentials modes (direct tokens can't be refreshed)
  if (sfAuth.mode !== 'password' && sfAuth.mode !== 'client_credentials') return;

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

/**
 * Disconnect / logout — clear auth state so login screen is shown again.
 */
function logout() {
  sfAuth.accessToken = null;
  sfAuth.instanceUrl = null;
  sfAuth.username = null;
  sfAuth.issuedAt = null;
  sfAuth.mode = null;
  lastAuthTime = null;
  lastAuthError = null;
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  log('info', 'Logged out — auth state cleared');
}

module.exports = { authenticate, refreshAuth, getAuth, getAuthHealth, setCredentials, hasCredentials, logout };
