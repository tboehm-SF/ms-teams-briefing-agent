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

// Global token store — shared across all requests
let sfAuth = {
  accessToken: null,
  instanceUrl: null,
  username: null,
  issuedAt: null,
  mode: null // 'token' or 'password'
};

/**
 * Authenticate to Salesforce.
 * Tries direct token first, then falls back to username-password flow.
 */
async function authenticate() {
  // Mode 1: Direct access token (simplest — user provides token + instance URL)
  if (SF_ACCESS_TOKEN && SF_INSTANCE_URL) {
    console.log('Using direct access token mode...');
    sfAuth.accessToken = SF_ACCESS_TOKEN;
    sfAuth.instanceUrl = SF_INSTANCE_URL.replace(/\/$/, ''); // remove trailing slash
    sfAuth.mode = 'token';

    // Verify the token works by fetching user info
    try {
      const userInfo = await axios.get(`${sfAuth.instanceUrl}/services/oauth2/userinfo`, {
        headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` }
      });
      sfAuth.username = userInfo.data.preferred_username || userInfo.data.name || 'Salesforce User';
      console.log(`Salesforce connected (direct token). User: ${sfAuth.username}, Instance: ${sfAuth.instanceUrl}`);
      return true;
    } catch (err) {
      console.error('Direct token verification failed:', err.response?.status, err.response?.data || err.message);
      // Token might be expired — fall through to password flow if available
      sfAuth.accessToken = null;
      sfAuth.instanceUrl = null;
      console.log('Falling back to username-password flow...');
    }
  }

  // Mode 2: Username-password OAuth flow
  if (SF_USERNAME && SF_PASSWORD && SF_CLIENT_ID && SF_CLIENT_SECRET) {
    try {
      console.log('Authenticating to Salesforce as', SF_USERNAME, '...');

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
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
      );

      sfAuth.accessToken = response.data.access_token;
      sfAuth.instanceUrl = response.data.instance_url;
      sfAuth.issuedAt = response.data.issued_at;
      sfAuth.mode = 'password';

      // Get display name
      try {
        const userInfo = await axios.get(response.data.id, {
          headers: { 'Authorization': `Bearer ${sfAuth.accessToken}` }
        });
        sfAuth.username = userInfo.data.display_name || userInfo.data.username || SF_USERNAME;
      } catch (e) {
        sfAuth.username = SF_USERNAME;
      }

      console.log(`Salesforce authenticated (password flow). Instance: ${sfAuth.instanceUrl}`);
      return true;
    } catch (err) {
      console.error('Salesforce password auth failed:', err.response?.data || err.message);
      return false;
    }
  }

  console.error('No Salesforce credentials configured. Set either:');
  console.error('  Option A: SF_ACCESS_TOKEN + SF_INSTANCE_URL');
  console.error('  Option B: SF_USERNAME + SF_PASSWORD + SF_CLIENT_ID + SF_CLIENT_SECRET');
  return false;
}

/**
 * Re-authenticate (refresh) the token.
 * Called when a 401 is received from Salesforce APIs.
 */
async function refreshAuth() {
  console.log('Refreshing Salesforce authentication...');
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

module.exports = { authenticate, refreshAuth, getAuth };
