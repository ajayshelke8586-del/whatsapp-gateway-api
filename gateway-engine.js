const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const axios = require('axios');
const { Client, LocalAuth } = require('whatsapp-web.js');

const activeClients = {};
const sessionQRCodes = {};
const sessionMeta = {};

// Configurable Webhook Target URL
let webhookUrl = process.env.WEBHOOK_URL || 'https://wacrm.panthm.com/api/webhook';

function setWebhookUrl(url) {
  webhookUrl = url;
  console.log(`[Pure WebJS Engine] Destination Webhook set to: ${url}`);
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

// Automatically restore all saved sessions on startup
async function loadSavedSessions() {
  const sessionsDir = path.join(__dirname, 'sessions');
  if (!fs.existsSync(sessionsDir)) return;

  const folders = fs.readdirSync(sessionsDir);
  for (const folder of folders) {
    if (folder.startsWith('session-')) {
      const sessionId = folder.replace('session-', '');
      console.log(`[Pure WebJS Engine] Auto-restoring session: ${sessionId}`);
      initSession(sessionId, 'Saved WebJS Account').catch(err => {
        console.error(`[Pure WebJS Engine] Auto-restore error for ${sessionId}:`, err.message);
      });
    }
  }
}

// Initialize Pure whatsapp-web.js + Puppeteer Engine Session
async function initSession(sessionId, sessionName = 'Primary WebJS Line') {
  if (activeClients[sessionId]) {
    return sessionMeta[sessionId];
  }

  console.log(`[Pure WebJS Engine] Initializing Session ID: ${sessionId} ("${sessionName}")`);

  sessionMeta[sessionId] = {
    id: sessionId,
    session_name: sessionName,
    phone_number: sessionMeta[sessionId]?.phone_number || 'Connecting WebJS...',
    status: 'connecting',
    engine: 'pure_webjs',
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
      headless: 'new',
      args: puppeteerArgs
    };

    const possiblePaths = [
      process.env.PUPPETEER_EXECUTABLE_PATH,
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome-stable'
    ];

    for (const p of possiblePaths) {
      if (p && fs.existsSync(p)) {
        puppeteerOptions.executablePath = p;
        console.log(`[Pure WebJS Engine] Using Chromium binary at: ${p}`);
        break;
      }
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
      console.log(`[Pure WebJS Engine] QR Code generated for session ${sessionId}`);
      try {
        const qrDataURL = await QRCode.toDataURL(qr);
        sessionQRCodes[sessionId] = qrDataURL;
        sessionMeta[sessionId].status = 'qr_ready';
      } catch (err) {
        console.error('[Pure WebJS Engine] Error generating QR data URL:', err.message);
      }
    });

    client.on('authenticated', () => {
      console.log(`[Pure WebJS Engine ${sessionId}] Authenticated successfully!`);
      sessionMeta[sessionId].status = 'authenticated';
      delete sessionQRCodes[sessionId];
    });

    client.on('ready', async () => {
      const info = client.info;
      const phone = info?.wid?.user ? `+${info.wid.user}` : '+919834969054';
      console.log(`[Pure WebJS Engine ${sessionId}] READY! Phone: ${phone}`);

      delete sessionQRCodes[sessionId];
      sessionMeta[sessionId].phone_number = phone;
      sessionMeta[sessionId].status = 'active';

      dispatchWebhook('session_connected', {
        sessionId,
        sessionName,
        phone_number: phone,
        engine: 'pure_webjs'
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
      console.log(`[Pure WebJS Engine ${sessionId}] Disconnected: ${reason}`);
      sessionMeta[sessionId].status = 'disconnected';
      delete activeClients[sessionId];
      delete sessionQRCodes[sessionId];
      dispatchWebhook('session_disconnected', { sessionId, sessionName });
    });

    client.initialize().catch((err) => {
      console.error(`[Pure WebJS Init Error ${sessionId}]:`, err);
      sessionMeta[sessionId].status = 'error';
      sessionMeta[sessionId].error = err.stack || err.message || String(err);
    });

  } catch (err) {
    console.error(`[Pure WebJS Exception ${sessionId}]:`, err);
    sessionMeta[sessionId].status = 'error';
    sessionMeta[sessionId].error = err.stack || err.message || String(err);
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
    console.error('[Pure WebJS Message Error]:', e.message);
  }
}

async function syncWebJSHistory(sessionId, client) {
  try {
    const chats = await client.getChats().catch(() => []);
    console.log(`[Pure WebJS History Sync] Found ${chats.length} chats in WebJS DOM`);

    for (const chat of chats) {
      if (chat.isGroup) continue;
      const phone = parsePhoneFromJID(chat.id._serialized) || (chat.id.user ? `+${chat.id.user}` : null);
      if (!phone) continue;

      const contactName = chat.name || chat.pushname || phone;
      
      // Fetch up to 50 historical messages per chat directly from WhatsApp Web DOM
      const messages = await chat.fetchMessages({ limit: 50 }).catch(() => []);
      
      for (const msg of messages) {
        const bodyText = msg.body || (msg.hasMedia ? '📷 Photo' : '');
        if (!bodyText) continue;

        dispatchWebhook('incoming_message', {
          session_id: sessionId,
          session_name: sessionMeta[sessionId]?.session_name || 'Primary WebJS Line',
          sender_number: sessionMeta[sessionId]?.phone_number || 'Unknown',
          contact_number: phone,
          contact_name: contactName,
          body: bodyText,
          direction: msg.fromMe ? 'outbound' : 'inbound',
          timestamp: msg.timestamp ? (msg.timestamp * 1000) : Date.now()
        });
      }
    }
  } catch (e) {
    console.error('[Pure WebJS History Sync Error]:', e.message);
  }
}

// Outbound Message Sender
async function sendMessage(sessionId, recipientPhone, textBody) {
  const client = activeClients[sessionId] || Object.values(activeClients)[0];
  if (!client) {
    throw new Error(`WebJS Session ${sessionId} is not active. Please scan QR first.`);
  }

  const jid = formatJID(recipientPhone);
  return await client.sendMessage(jid, textBody);
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
  delete sessionQRCodes[sessionId];
  delete sessionMeta[sessionId];

  const authDir = path.join(__dirname, 'sessions', `session-${sessionId}`);
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true, force: true });
  }

  return { success: true, message: `WebJS Session ${sessionId} deleted.` };
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
