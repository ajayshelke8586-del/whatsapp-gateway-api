const path = require('path');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');
const axios = require('axios');

const logger = pino({ level: 'silent' });
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

// Parse a WhatsApp JID into a clean phone number, or null if it's a group/status/broadcast
function parsePhoneFromJID(jid) {
  if (!jid) return null;

  // Filter out groups, status broadcasts, newsletters, etc.
  if (jid.endsWith('@g.us')) return null;          // group chat
  if (jid.endsWith('@broadcast')) return null;      // status / broadcast
  if (jid.endsWith('@newsletter')) return null;     // channels
  if (jid.startsWith('status')) return null;         // status@broadcast

  // Extract the number part before @
  const raw = jid.split('@')[0];
  if (!raw) return null;

  // Strip multi-device suffix (e.g. "919876543210:42" → "919876543210")
  const phone = raw.split(':')[0];

  // Must be all digits and at least 7 digits long to be a real phone number
  if (!/^\d{7,15}$/.test(phone)) return null;

  return `+${phone}`;
}

// Format phone number to JID format
function formatJID(phone) {
  const clean = phone.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

// Get Baileys module dynamically
async function getBaileys() {
  return await import('@whiskeysockets/baileys');
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

// Initialize a WhatsApp Web socket session
async function initSession(sessionId, sessionName = 'Default Session') {
  console.log(`[Gateway Engine] Initializing session ID: ${sessionId} ("${sessionName}")`);
  
  sessionMeta[sessionId] = {
    id: sessionId,
    session_name: sessionName,
    phone_number: sessionMeta[sessionId]?.phone_number || 'Connecting...',
    status: 'connecting',
    created_at: Date.now()
  };

  try {
    const baileys = await getBaileys();
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    const DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;

    if (typeof makeWASocket !== 'function') {
      throw new Error('Could not resolve makeWASocket from Baileys module');
    }
    
    const sessionsDir = path.join(__dirname, 'sessions');
    if (!fs.existsSync(sessionsDir)) {
      fs.mkdirSync(sessionsDir, { recursive: true });
    }
    
    const authDir = path.join(sessionsDir, `session-${sessionId}`);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const sock = makeWASocket({
      auth: state,
      logger: logger,
      printQRInTerminal: false
    });

    activeSockets[sessionId] = sock;

    // Listen for credential updates
    sock.ev.on('creds.update', saveCreds);

    // Connection updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log(`[Gateway Engine] QR Code generated for session ${sessionId}`);
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          sessionQRCodes[sessionId] = qrDataURL;
          sessionMeta[sessionId].status = 'qr_ready';
        } catch (err) {
          console.error('[Gateway Engine] Error generating QR data URL:', err.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
        console.log(`[Gateway Engine] Session ${sessionId} closed. Reconnecting: ${shouldReconnect}`);

        delete sessionQRCodes[sessionId];
        
        if (!shouldReconnect) {
          sessionMeta[sessionId].status = 'disconnected';
          delete activeSockets[sessionId];
          dispatchWebhook('session_disconnected', { sessionId, sessionName });
        } else {
          sessionMeta[sessionId].status = 'reconnecting';
          setTimeout(() => initSession(sessionId, sessionName), 4000);
        }
      }

      if (connection === 'open') {
        const userJID = sock.user.id.split(':')[0];
        const formattedPhone = `+${userJID}`;
        console.log(`[Gateway Engine] Session ${sessionId} CONNECTED! Phone: ${formattedPhone}`);

        delete sessionQRCodes[sessionId];
        sessionMeta[sessionId].phone_number = formattedPhone;
        sessionMeta[sessionId].status = 'active';

        dispatchWebhook('session_connected', {
          sessionId,
          sessionName,
          phone_number: formattedPhone
        });
      }
    });

    // Listen for incoming messages — only individual chats, skip groups/status/broadcasts
    sock.ev.on('messages.upsert', async (m) => {
      if (m.type !== 'notify') return;

      for (const msg of m.messages) {
        if (!msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        const contactPhone = parsePhoneFromJID(remoteJid);

        // Skip if it's a group, status, broadcast, or unparseable JID
        if (!contactPhone) continue;

        const contactName = msg.pushName || contactPhone;
        const isFromMe = msg.key.fromMe || false;

        let bodyText = '';
        if (msg.message.conversation) {
          bodyText = msg.message.conversation;
        } else if (msg.message.extendedTextMessage?.text) {
          bodyText = msg.message.extendedTextMessage.text;
        } else if (msg.message.imageMessage?.caption) {
          bodyText = `📷 ${msg.message.imageMessage.caption}`;
        } else if (msg.message.videoMessage?.caption) {
          bodyText = `🎥 ${msg.message.videoMessage.caption}`;
        } else if (msg.message.documentMessage?.fileName) {
          bodyText = `📎 ${msg.message.documentMessage.fileName}`;
        } else if (msg.message.imageMessage) {
          bodyText = '📷 Image';
        } else if (msg.message.videoMessage) {
          bodyText = '🎥 Video';
        } else if (msg.message.audioMessage) {
          bodyText = '🎵 Audio';
        } else if (msg.message.stickerMessage) {
          bodyText = '🏷️ Sticker';
        } else if (msg.message.contactMessage) {
          bodyText = '👤 Contact';
        } else if (msg.message.locationMessage) {
          bodyText = '📍 Location';
        }

        if (!bodyText) continue;

        const direction = isFromMe ? 'outbound' : 'inbound';

        console.log(`[Gateway] ${direction} on ${sessionName}: ${contactName} (${contactPhone}): "${bodyText}"`);

        dispatchWebhook('incoming_message', {
          session_id: sessionId,
          session_name: sessionName,
          sender_number: sessionMeta[sessionId]?.phone_number || 'Unknown',
          contact_number: contactPhone,
          contact_name: contactName,
          body: bodyText,
          direction: direction,
          timestamp: msg.messageTimestamp ? (Number(msg.messageTimestamp) * 1000) : Date.now()
        });
      }
    });

  } catch (err) {
    console.error(`[Gateway Engine Error] Session init error for ${sessionId}:`, err.message);
    sessionMeta[sessionId].status = 'error';
    sessionMeta[sessionId].error = err.message;
  }

  return sessionMeta[sessionId];
}

// Send outbound message
async function sendMessage(sessionId, recipientPhone, textBody) {
  const sock = activeSockets[sessionId];
  if (!sock) {
    throw new Error(`Session ID ${sessionId} is not active. Please scan QR first.`);
  }

  const jid = formatJID(recipientPhone);
  const result = await sock.sendMessage(jid, { text: textBody });
  return result;
}

// Get session details
function getSession(sessionId) {
  return {
    ...sessionMeta[sessionId],
    has_qr: !!sessionQRCodes[sessionId]
  };
}

// Get latest QR code for a session
function getQRCode(sessionId) {
  return sessionQRCodes[sessionId] || null;
}

// Get list of all sessions
function getAllSessions() {
  return Object.values(sessionMeta);
}

// Delete / Disconnect a session
async function deleteSession(sessionId) {
  const sock = activeSockets[sessionId];
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {}
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

// Dispatch Webhook to target URL
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

// Automatically restore sessions on startup
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
