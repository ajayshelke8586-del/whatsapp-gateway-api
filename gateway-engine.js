const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');

const activeClients = {};
const activeSockets = {};
const sessionQRCodes = {};
const sessionMeta = {};

// Configurable Webhook Target URL
let webhookUrl = process.env.WEBHOOK_URL || 'https://wacrm.panthm.com/api/webhook';

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
  return `${clean}@c.us`;
}

// Automatically load and reconnect all saved sessions from disk on server startup
async function loadSavedSessions() {
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const folders = fs.readdirSync(sessionsDir);
  for (const folder of folders) {
    if (folder.startsWith('session-')) {
      const sessionId = folder.replace('session-', '');
      console.log(`[Gateway Engine] Auto-restoring saved session: ${sessionId}`);
      initSession(sessionId, 'Saved Account').catch(err => {
        console.error(`[Gateway Engine] Auto-restore error for ${sessionId}:`, err.message);
      });
    }
  }
}

// Initialize a WhatsApp Web socket session using WebJS Primary Engine (with Baileys Fallback)
async function initSession(sessionId, sessionName = 'Default Session') {
  console.log(`[Gateway Engine WebJS] Initializing Primary WebJS Session ID: ${sessionId} ("${sessionName}")`);

  sessionMeta[sessionId] = {
    id: sessionId,
    session_name: sessionName,
    phone_number: sessionMeta[sessionId]?.phone_number || 'Connecting...',
    status: 'connecting',
    engine: 'webjs',
    created_at: Date.now()
  };

  try {
    const authDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const puppeteerArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ];

    const puppeteerOptions = {
      headless: true,
      args: puppeteerArgs
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: authDir
      }),
      puppeteer: puppeteerOptions
    });

    activeClients[sessionId] = client;

    client.on('qr', async (qr) => {
      console.log(`[WebJS Engine] QR Code generated for session ${sessionId}`);
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        sessionQRCodes[sessionId] = qrDataURL;
        sessionMeta[sessionId].status = 'qr_ready';
      } catch (err) {
        console.error('[WebJS Engine] Error generating QR data URL:', err.message);
      }
    });

    client.on('authenticated', () => {
      console.log(`[WebJS Engine ${sessionId}] Authenticated successfully!`);
      sessionMeta[sessionId].status = 'authenticated';
      delete sessionQRCodes[sessionId];
    });

    client.on('ready', async () => {
      const info = client.info;
      const phone = info?.wid?.user ? `+${info.wid.user}` : '+919834969054';
      console.log(`[WebJS Engine ${sessionId}] READY! Phone: ${phone}`);

      delete sessionQRCodes[sessionId];
      sessionMeta[sessionId].phone_number = phone;
      sessionMeta[sessionId].status = 'active';

      dispatchWebhook('session_connected', {
        sessionId,
        sessionName,
        phone_number: phone
      });

      // Full Chat & Contact History Sync to Hostinger CRM
      syncWebJSHistory(sessionId, client);
    });

    client.on('message', async (msg) => {
      handleWebJSMessage(sessionId, sessionName, msg);
    });

    client.on('message_create', async (msg) => {
      if (msg.fromMe) {
        handleWebJSMessage(sessionId, sessionName, msg);
      }
    });

    client.on('disconnected', (reason) => {
      console.log(`[WebJS Engine ${sessionId}] Disconnected: ${reason}`);
      sessionMeta[sessionId].status = 'disconnected';
      delete activeClients[sessionId];
      delete sessionQRCodes[sessionId];
      dispatchWebhook('session_disconnected', { sessionId, sessionName });
    });

    client.initialize().catch((err) => {
      console.error(`[WebJS Init Error ${sessionId}]: ${err.message}. Falling back to Baileys Engine...`);
      initBaileysFallback(sessionId, sessionName);
    });

  } catch (err) {
    console.error(`[WebJS Primary Exception ${sessionId}]: ${err.message}. Falling back to Baileys Engine...`);
    initBaileysFallback(sessionId, sessionName);
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
  } catch (e) {
    console.error('[WebJS Message Handler Error]:', e.message);
  }
}

async function syncWebJSHistory(sessionId, client) {
  try {
    const chats = await client.getChats().catch(() => []);
    const formattedContacts = chats.map(c => ({
      phone_number: `+${c.id.user}`,
      name: c.name || c.pushname || `+${c.id.user}`
    })).filter(c => c.phone_number.length >= 8);

    dispatchWebhook('history_sync', {
      session_id: sessionId,
      contacts: formattedContacts,
      messages: []
    });
  } catch (e) {
    console.error('[WebJS History Sync Warning]:', e.message);
  }
}

// Fallback Baileys Engine Initialization
async function initBaileysFallback(sessionId, sessionName) {
  try {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    const DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;

    const sessionsDir = path.join(__dirname, 'sessions');
    const authDir = path.join(sessionsDir, `session-${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: false
    });

    activeSockets[sessionId] = sock;
    sessionMeta[sessionId].engine = 'baileys_fallback';

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        const qrDataURL = await QRCode.toDataURL(qr);
        sessionQRCodes[sessionId] = qrDataURL;
        sessionMeta[sessionId].status = 'qr_ready';
      }
      if (connection === 'open') {
        const userJID = sock.user.id.split(':')[0];
        sessionMeta[sessionId].phone_number = `+${userJID}`;
        sessionMeta[sessionId].status = 'active';
      }
    });

  } catch (err) {
    console.error('[Baileys Fallback Error]:', err.message);
  }
}

// Send outbound message (WebJS Primary -> Baileys Fallback)
async function sendMessage(sessionId, recipientPhone, textBody) {
  const webjsClient = activeClients[sessionId];
  if (webjsClient) {
    const jid = formatJID(recipientPhone);
    return await webjsClient.sendMessage(jid, textBody);
  }

  const sock = activeSockets[sessionId];
  if (sock) {
    const clean = recipientPhone.replace(/\D/g, '');
    const jid = `${clean}@s.whatsapp.net`;
    return await sock.sendMessage(jid, { text: textBody });
  }

  throw new Error(`Session ID ${sessionId} is not active. Please scan QR first.`);
}

function getSession(sessionId) {
  return {
    ...sessionMeta[sessionId],
    has_qr: !!sessionQRCodes[sessionId]
  };
}

function getQRCode(sessionId) {
  return sessionQRCodes[sessionId] || null;
}

function getAllSessions() {
  return Object.values(sessionMeta);
}

async function deleteSession(sessionId) {
  const client = activeClients[sessionId];
  if (client) {
    await client.destroy().catch(() => {});
    delete activeClients[sessionId];
  }
  const sock = activeSockets[sessionId];
  if (sock) {
    try { await sock.logout(); } catch (e) {}
    delete activeSockets[sessionId];
  }
  delete sessionQRCodes[sessionId];
  delete sessionMeta[sessionId];

  const authDir = path.join(__dirname, 'sessions', `session-${sessionId}`);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  return { success: true, message: `Session ${sessionId} deleted.` };
}

async function dispatchWebhook(event, payload) {
  if (!webhookUrl) return;
  try {
    await axios.post(webhookUrl, {
      event,
      data: payload,
      timestamp: Date.now()
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    });
    console.log(`[Webhook Relay] Sent "${event}" to ${webhookUrl}`);
  } catch (err) {
    console.error(`[Webhook Relay Failed] "${event}":`, err.message);
  }
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
