const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const engine = require('./gateway-engine');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Default webhook destination
const defaultWebhook = process.env.WEBHOOK_URL || 'https://wacrm.panthm.com/api/webhook';
engine.setWebhookUrl(defaultWebhook);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Custom WhatsApp Gateway API',
    uptime: process.uptime(),
    webhook_url: engine.getWebhookUrl(),
    timestamp: new Date().toISOString()
  });
});

// Configure Webhook Target URL
app.post('/api/webhook/config', (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url is required in body' });
  }

  engine.setWebhookUrl(url);
  res.json({ success: true, webhook_url: url });
});

// 1. Create a WhatsApp session & start QR flow
app.post('/api/sessions/create', async (req, res) => {
  const { session_id, session_name } = req.body;
  const id = session_id || `session-${Date.now()}`;
  const name = session_name || 'Sales Line';

  try {
    const meta = await engine.initSession(id, name);
    res.json({
      success: true,
      sessionId: id,
      sessionName: name,
      meta
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Get session status & QR code base64 payload
app.get('/api/sessions/:id/qr', (req, res) => {
  const sessionId = req.params.id;
  const qr = engine.getQRCode(sessionId);
  const session = engine.getSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    sessionId,
    status: session.status,
    phone_number: session.phone_number || 'Connecting...',
    session_name: session.session_name || 'Sales Line',
    qr: qr || null,
    has_qr: !!qr
  });
});

// 3. Get all session details
app.get('/api/sessions', (req, res) => {
  const sessions = engine.getAllSessions();
  res.json(sessions);
});

// 4. Delete / Disconnect a session
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const result = await engine.deleteSession(req.params.id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. Send WhatsApp Message (HTTP REST Endpoint)
app.post('/api/messages/send', async (req, res) => {
  const { session_id, recipient, message } = req.body;

  if (!session_id || !recipient || !message) {
    return res.status(400).json({
      error: 'session_id, recipient, and message fields are required.'
    });
  }

  try {
    const result = await engine.sendMessage(session_id, recipient, message);
    res.json({
      success: true,
      session_id,
      recipient,
      message_id: result?.key?.id || null,
      timestamp: Date.now()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`  Custom WhatsApp Gateway API running on port ${PORT}`);
  console.log(`  Health Check: http://localhost:${PORT}/health`);
  console.log(`====================================================`);
});
