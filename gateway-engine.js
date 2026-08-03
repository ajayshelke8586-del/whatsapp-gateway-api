const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');

const logger = pino({ level: 'silent' });
const activeClients = {};
const activeSockets = {};
const sessionQRCodes = {};
const sessionMeta = {};

let webhookUrl = process.env.WEBHOOK_URL || 'https://wacrm.panthm.com/api/webhook.php';

function setWebhookUrl(url) {
  webhookUrl = url;
  console.log(`[Gateway Engine] Destination Webhook set to: ${url}`);
}

function getWebhookUrl() {
  return webhookUrl;
}

function parsePhoneFromJID(jid) {
  if (!jid) return null;
  if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return null;
  const raw = jid.split('@')[0].split(':')[0];
  if (!/^\d{7,15}$/.test(raw)) return null;
  return `+${raw}`;
}

function formatJID(phone) {
  const clean = phone.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

async function getBaileys() {
  return await import('@whiskeysockets/baileys');
}

async function loadSavedSessions() {
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const folders = fs.readdirSync(sessionsDir);
  for (const folder of folders) {
    if (folder.startsWith('session-')) {
      const sessionId = folder.replace('session-', '');
      console.log(`[Gateway Engine] Auto-restoring session: ${sessionId}`);
      initSession(sessionId, 'Saved Account').catch(err => {
        console.error(`[Gateway Engine] Auto-restore error for ${sessionId}:`, err.message);
      });
    }
  }
}

async function initSession(sessionId, sessionName = 'Sales Line') {
  console.log(`[Gateway Engine] Initializing Session ID: ${sessionId} ("${sessionName}")`);

  sessionMeta[sessionId] = {
    id: sessionId,
    session_name: sessionName,
    phone_number: sessionMeta[sessionId]?.phone_number || 'Connecting...',
    status: 'connecting',
    created_at: Date.now()
  };

  const possiblePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable'
  ];

  let chromePath = null;
  for (const p of possiblePaths) {
    if (p && fs.existsSync(p)) {
      chromePath = p;
      break;
    }
  }

  // Try WebJS if Chrome path exists, else fall back to Baileys WebSockets
  if (chromePath) {
    console.log(`[Gateway Engine] Chrome binary detected at ${chromePath}. Using WebJS Engine.`);
    return initWebJSEngine(sessionId, sessionName, chromePath);
  } else {
    console.log(`[Gateway Engine] No OS Chromium binary detected. Using Baileys WebSockets Cloud Engine.`);
    return initBaileysEngine(sessionId, sessionName);
  }
}

async function initWebJSEngine(sessionId, sessionName, chromePath) {
  try {
    const authDir = path.join(__dirname, 'sessions');
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: sessionId, dataPath: authDir }),
      puppeteer: {
        headless: 'new',
        executablePath: chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      }
    });

    activeClients[sessionId] = client;
    sessionMeta[sessionId].engine = 'webjs';

    client.on('qr', async (qr) => {
      const qrDataURL = await QRCode.toDataURL(qr);
      sessionQRCodes[sessionId] = qrDataURL;
      sessionMeta[sessionId].status = 'qr_ready';
    });

    client.on('ready', async () => {
      const phone = client.info?.wid?.user ? `+${client.info.wid.user}` : '+919834969054';
      delete sessionQRCodes[sessionId];
      sessionMeta[sessionId].phone_number = phone;
      sessionMeta[sessionId].status = 'active';
      dispatchWebhook('session_connected', { sessionId, sessionName, phone_number: phone });
    });

    client.on('message', async (msg) => handleWebJSMessage(sessionId, sessionName, msg));
    client.on('message_create', async (msg) => { if (msg.fromMe) handleWebJSMessage(sessionId, sessionName, msg); });

    client.initialize().catch(err => {
      console.error(`[WebJS Engine Error]: ${err.message}. Falling back to Baileys...`);
      initBaileysEngine(sessionId, sessionName);
    });
  } catch (err) {
    initBaileysEngine(sessionId, sessionName);
  }
  return sessionMeta[sessionId];
}

async function initBaileysEngine(sessionId, sessionName) {
  try {
    const baileys = await getBaileys();
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    const DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;

    const authDir = path.join(__dirname, 'sessions', `session-${sessionId}`);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      logger: logger,
      printQRInTerminal: false
    });

    activeSockets[sessionId] = sock;
    sessionMeta[sessionId].engine = 'baileys';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log(`[Baileys Engine] QR generated for ${sessionId}`);
        const qrDataURL = await QRCode.toDataURL(qr);
        sessionQRCodes[sessionId] = qrDataURL;
        sessionMeta[sessionId].status = 'qr_ready';
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
        delete sessionQRCodes[sessionId];
        if (!shouldReconnect) {
          sessionMeta[sessionId].status = 'disconnected';
          delete activeSockets[sessionId];
        } else {
          sessionMeta[sessionId].status = 'reconnecting';
          setTimeout(() => initBaileysEngine(sessionId, sessionName), 3000);
        }
      }
      if (connection === 'open') {
        const userJID = sock.user.id.split(':')[0];
        const phone = `+${userJID}`;
        delete sessionQRCodes[sessionId];
        sessionMeta[sessionId].phone_number = phone;
        sessionMeta[sessionId].status = 'active';
        dispatchWebhook('session_connected', { sessionId, sessionName, phone_number: phone });
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;
      for (const msg of m.messages) {
        if (!msg.message) continue;
        const contactPhone = parsePhoneFromJID(msg.key.remoteJid);
        if (!contactPhone) continue;

        const bodyText = msg.message.conversation || msg.message.extendedTextMessage?.text || (msg.message.imageMessage ? '📷 Image' : '');
        if (!bodyText) continue;

        dispatchWebhook('incoming_message', {
          session_id: sessionId,
          session_name: sessionName,
          sender_number: sessionMeta[sessionId]?.phone_number || 'Unknown',
          contact_number: contactPhone,
          contact_name: msg.pushName || contactPhone,
          body: bodyText,
          direction: msg.key.fromMe ? 'outbound' : 'inbound',
          timestamp: msg.messageTimestamp ? (Number(msg.messageTimestamp) * 1000) : Date.now()
        });
      }
    });

  } catch (err) {
    console.error(`[Baileys Engine Error ${sessionId}]:`, err.message);
    sessionMeta[sessionId].status = 'error';
    sessionMeta[sessionId].error = err.message;
  }
  return sessionMeta[sessionId];
}

async function handleWebJSMessage(sessionId, sessionName, msg) {
  try {
    const contact = await msg.getContact().catch(() => null);
    const rawFrom = msg.fromMe ? msg.to : msg.from;
    const phone = parsePhoneFromJID(rawFrom);
    if (!phone) return;

    const contactName = contact?.pushname || contact?.name || phone;
    const direction = msg.fromMe ? 'outbound' : 'inbound';
    const bodyText = msg.body || (msg.hasMedia ? '📷 Photo' : '');
    if (!bodyText) return;

    dispatchWebhook('incoming_message', {
      session_id: sessionId,
      session_name: sessionName,
      sender_number: sessionMeta[sessionId]?.phone_number || 'Unknown',
      contact_number: phone,
      contact_name: contactName,
      body: bodyText,
      direction: direction,
      timestamp: msg.timestamp ? (msg.timestamp * 1000) : Date.now()
    });
  } catch (e) {}
}

async function sendMessage(sessionId, recipientPhone, textBody) {
  const webjsClient = activeClients[sessionId];
  if (webjsClient) {
    const clean = recipientPhone.replace(/\D/g, '');
    return await webjsClient.sendMessage(`${clean}@c.us`, textBody);
  }

  const sock = activeSockets[sessionId] || Object.values(activeSockets)[0];
  if (sock) {
    const clean = recipientPhone.replace(/\D/g, '');
    return await sock.sendMessage(`${clean}@s.whatsapp.net`, { text: textBody });
  }

  throw new Error(`Session ID ${sessionId} is not active. Please scan QR first.`);
}

function getSession(sessionId) {
  return { ...sessionMeta[sessionId], has_qr: !!sessionQRCodes[sessionId] };
}

function getQRCode(sessionId) {
  return sessionQRCodes[sessionId] || null;
}

function getAllSessions() {
  return Object.values(sessionMeta);
}

async function deleteSession(sessionId) {
  if (activeClients[sessionId]) {
    await activeClients[sessionId].destroy().catch(() => {});
    delete activeClients[sessionId];
  }
  if (activeSockets[sessionId]) {
    try { await activeSockets[sessionId].logout(); } catch (e) {}
    delete activeSockets[sessionId];
  }
  delete sessionQRCodes[sessionId];
  delete sessionMeta[sessionId];

  const authDir = path.join(__dirname, 'sessions', `session-${sessionId}`);
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true });

  return { success: true, message: `Session ${sessionId} deleted.` };
}

async function dispatchWebhook(event, payload) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, { event, data: payload, timestamp: Date.now() }, { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });
  } catch (err) {}
}

loadSavedSessions().catch(() => {});

module.exports = {
  setWebhookUrl,
  getWebhookUrl,
  initSession,
  sendMessage,
  getSession,
  getQRCode,
  getAllSessions,
  deleteSession,
  loadSavedSessions
};
