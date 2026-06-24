const express = require('express');
const axios = require('axios');
const router = express.Router();

// Salesforce OAuth2 Configuration
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

// Step 1: Redirect to Salesforce OAuth
router.get('/login', (req, res) => {
  const authUrl = `${SF_LOGIN_URL}/services/oauth2/authorize?` +
    `response_type=code` +
    `&client_id=${encodeURIComponent(SF_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('api chatbot_api sfap_api')}` +
    `&prompt=login`;
  res.redirect(authUrl);
});

// Step 2: Handle OAuth callback
router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) {
    return res.redirect('/?auth_error=' + encodeURIComponent(error));
  }

  if (!code) {
    return res.redirect('/?auth_error=no_code');
  }

  try {
    // Exchange code for tokens
    const tokenResponse = await axios.post(
      `${SF_LOGIN_URL}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { access_token, refresh_token, instance_url, id } = tokenResponse.data;

    // Get user info
    let username = 'Salesforce User';
    try {
      const userInfo = await axios.get(id, {
        headers: { 'Authorization': `Bearer ${access_token}` }
      });
      username = userInfo.data.display_name || userInfo.data.username || username;
    } catch (e) {
      // Non-critical, keep going
    }

    // Store in session
    req.session.sfAccessToken = access_token;
    req.session.sfRefreshToken = refresh_token;
    req.session.sfInstanceUrl = instance_url;
    req.session.sfUsername = username;

    res.redirect('/?auth_success=true');
  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    const errMsg = err.response?.data?.error_description || err.message;
    res.redirect('/?auth_error=' + encodeURIComponent(errMsg));
  }
});

// Refresh token
router.post('/refresh', async (req, res) => {
  if (!req.session.sfRefreshToken) {
    return res.status(401).json({ error: 'No refresh token available' });
  }

  try {
    const tokenResponse = await axios.post(
      `${SF_LOGIN_URL}/services/oauth2/token`,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: req.session.sfRefreshToken,
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    req.session.sfAccessToken = tokenResponse.data.access_token;
    if (tokenResponse.data.instance_url) {
      req.session.sfInstanceUrl = tokenResponse.data.instance_url;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Token refresh error:', err.response?.data || err.message);
    res.status(401).json({ error: 'Token refresh failed' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

module.exports = router;
