require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const authRoutes = require('./routes/auth');
const agentRoutes = require('./routes/agent');

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
app.use('/auth', authRoutes);
app.use('/api/agent', agentRoutes);

// Main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Auth status endpoint
app.get('/api/auth/status', (req, res) => {
  res.json({
    authenticated: !!req.session.sfAccessToken,
    instanceUrl: req.session.sfInstanceUrl || null,
    username: req.session.sfUsername || null
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
      text += XLSX.utils.sheet_to_csv(sheet) + '\n\n';
    }
    return text;
  }

  return '[Unsupported file format]';
}

app.listen(PORT, () => {
  console.log(`MS Teams Briefing Agent running on port ${PORT}`);
});
