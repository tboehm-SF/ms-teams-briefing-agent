require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const { authenticate, getAuth, getAuthHealth, setCredentials, hasCredentials, logout } = require('./routes/auth');
const agentRoutes = require('./routes/agent');
const { getAgentMetrics } = require('./routes/agent');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer for file uploads (memory storage for processing)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/plain',
      'text/csv'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Please upload PDF, Word, Excel, CSV, or text files.'));
    }
  }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'teams-briefing-agent-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' ? true : false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Trust proxy for Heroku (secure cookies behind load balancer)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Make upload middleware available
app.set('upload', upload);

// Routes
app.use('/api/agent', agentRoutes);

// Main page — redirect to login if not authenticated
app.get('/', (req, res) => {
  const auth = getAuth();
  if (!auth.authenticated) {
    return res.redirect('/login');
  }
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

// Auth status endpoint — returns global auth state
app.get('/api/auth/status', (req, res) => {
  const auth = getAuth();
  res.json({
    authenticated: auth.authenticated,
    instanceUrl: auth.instanceUrl || null,
    username: auth.username || null
  });
});

// Login endpoint — accepts credentials from the login UI
app.post('/api/auth/login', async (req, res) => {
  const { mode } = req.body;

  try {
    let result;

    if (mode === 'client_credentials') {
      result = await setCredentials({
        mode: 'client_credentials',
        clientId: req.body.clientId,
        clientSecret: req.body.clientSecret,
        instanceUrl: req.body.instanceUrl
      });
    } else if (mode === 'token') {
      result = await setCredentials({
        accessToken: req.body.accessToken,
        instanceUrl: req.body.instanceUrl
      });
    } else if (mode === 'oauth') {
      result = await setCredentials({
        username: req.body.username,
        password: req.body.password,
        clientId: req.body.clientId,
        clientSecret: req.body.clientSecret,
        securityToken: req.body.securityToken || '',
        loginUrl: req.body.loginUrl || 'https://login.salesforce.com'
      });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid auth mode' });
    }

    if (result.success) {
      const auth = getAuth();
      res.json({ success: true, username: auth.username });
    } else {
      res.status(401).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  logout();
  res.json({ success: true });
});

// Health check endpoint — for monitoring and stress testing
app.get('/api/health', (req, res) => {
  const authHealth = getAuthHealth();
  const agentMetrics = getAgentMetrics();

  const status = authHealth.authenticated ? 'healthy' : 'degraded';

  res.json({
    status,
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    auth: authHealth,
    agent: agentMetrics,
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
    }
  });
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const text = await extractText(req.file);
    res.json({
      success: true,
      filename: req.file.originalname,
      text: text,
      size: req.file.size
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message || 'Failed to process file' });
  }
});

// Text extraction from uploaded files
async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === '.txt' || ext === '.csv') {
    return file.buffer.toString('utf-8');
  }

  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(file.buffer);
    return data.text;
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }

  if (ext === '.xlsx' || ext === '.xls') {
    const XLSX = require('xlsx');
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    let text = '';

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      text += `--- ${sheetName} ---\n`;

      // Smart extraction: read the sheet as an array of arrays
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // For event template sheets with dual-column layout (A/B = Series, F/G = Event)
      // Extract key-value pairs from BOTH column pairs
      let hasMultiColumn = false;
      for (const row of rows) {
        if (row.length >= 7 && row[5] && row[6]) {
          hasMultiColumn = true;
          break;
        }
      }

      if (hasMultiColumn) {
        // Extract from columns F/G (Event instance data — primary)
        text += '--- Event Instance Fields ---\n';
        for (const row of rows) {
          const label = row[5] ? String(row[5]).trim() : '';
          const value = row[6] ? String(row[6]).trim() : '';
          if (label && value && !label.startsWith('Hilfe') && label !== 'Event') {
            text += `${label}: ${value}\n`;
          }
        }
        text += '\n';

        // Also extract from columns A/B (Series data — secondary/fallback)
        text += '--- Event Series Fields ---\n';
        for (const row of rows) {
          const label = row[0] ? String(row[0]).trim() : '';
          const value = row[1] ? String(row[1]).trim() : '';
          if (label && value && !label.startsWith('Hilfe') && !label.startsWith('Erfassung') &&
              !label.startsWith('Jeder Event') && !label.startsWith('An einer') &&
              !label.startsWith('Die blau') && !label.startsWith('Immer zuerst') &&
              label !== 'Event Serie') {
            text += `${label}: ${value}\n`;
          }
        }
        text += '\n';
      } else {
        // Standard two-column sheet (A=label, B=value) — like "Event Details Übersicht"
        for (const row of rows) {
          const label = row[0] ? String(row[0]).trim() : '';
          const value = row[1] ? String(row[1]).trim() : '';
          if (label && value) {
            text += `${label}: ${value}\n`;
          } else if (label) {
            text += `${label}\n`;
          }
        }
        text += '\n';
      }
    }
    return text;
  }

  return '[Unsupported file format]';
}

// Try auto-authenticate from env vars, then start the server
async function startServer() {
  if (hasCredentials()) {
    console.log('Salesforce credentials found — attempting auto sign-in...');
    const authSuccess = await authenticate();
    if (authSuccess) {
      console.log('Salesforce auto sign-in successful!');
    } else {
      console.warn('WARNING: Salesforce auto sign-in failed. Login screen will be shown.');
    }
  } else {
    console.log('No Salesforce credentials configured — login screen will be shown.');
  }

  app.listen(PORT, () => {
    console.log(`MS Teams Briefing Agent running on port ${PORT}`);
    const auth = getAuth();
    if (auth.authenticated) {
      console.log(`  Salesforce: connected as ${auth.username}`);
    } else {
      console.log(`  Salesforce: awaiting login at http://localhost:${PORT}/login`);
    }
  });
}

startServer();
