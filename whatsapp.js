import makeWASocket, { DisconnectReason, proto, fetchLatestWaWebVersion, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics.js';

let sock = null;
let isConnected = false;
let currentQr = null;
let database = null;
let reconnectTimeout = null;

// Helper to wrap Baileys PostgreSQL Authentication State
export async function usePgAuthState(db) {
  const writeData = async (data, id) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    try {
      await db.query(
        'INSERT INTO whatsapp_auth_state (id, value) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value',
        [id, value]
      );
    } catch (err) {
      console.error('[WhatsApp Auth] Error writing state key:', id, err.message);
      throw err;
    }
  };

  const readData = async (id) => {
    try {
      const res = await db.query('SELECT value FROM whatsapp_auth_state WHERE id = $1', [id]);
      if (!res.rows || res.rows.length === 0) return null;
      return JSON.parse(res.rows[0].value, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await db.query('DELETE FROM whatsapp_auth_state WHERE id = $1', [id]);
    } catch (error) {
      // Ignore
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      return writeData(creds, 'creds');
    }
  };
}

export async function connectToWhatsApp(db) {
  if (db) {
    database = db;
  }

  if (!database) {
    console.error('Database not initialized for WhatsApp bot.');
    return;
  }

let keepAliveTimer = null;
let reconnectAttempts = 0;

export async function connectToWhatsApp(db) {
  if (db) {
    database = db;
  }

  if (!database) {
    console.error('Database not initialized for WhatsApp bot.');
    return;
  }

  // Clear any existing timers
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }

  // Clean up old socket connection
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.ev.removeAllListeners('messages.upsert');
      sock.end(undefined);
    } catch (err) {
      // Ignore
    }
    sock = null;
  }

  try {
    const { state, saveCreds } = await usePgAuthState(database);
    const makeWASocketFn = makeWASocket.default || makeWASocket;

    let version = [2, 3000, 1015901307];
    try {
      const waVersion = await fetchLatestWaWebVersion();
      if (waVersion && waVersion.version) {
        version = waVersion.version;
        console.log(`[WhatsApp] Using WA Web v${version.join('.')}, isLatest: ${waVersion.isLatest}`);
      }
    } catch (vErr) {
      console.warn('[WhatsApp] Could not fetch latest WA Web version, using fallback:', vErr.message);
    }

    const browserConfig = Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '120.0.0.0'];

    sock = makeWASocketFn({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: browserConfig,
      keepAliveIntervalMs: 15000,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      markOnlineOnConnect: true,
      retryRequestOptions: {
        maxRetries: 5,
        delayMs: 2000
      }
    });

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (err) {
        console.warn('[WhatsApp Creds] Failed to save creds to PostgreSQL:', err.message);
      }
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        currentQr = qr;
        console.log('\n==================================================================');
        console.log('SCAN QR CODE BELOW TO CONNECT THE CLINIC WHATSAPP NOTIFICATION BOT:');
        console.log('==================================================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n==================================================================\n');
      }

      if (connection === 'close') {
        isConnected = false;
        if (keepAliveTimer) {
          clearInterval(keepAliveTimer);
          keepAliveTimer = null;
        }

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[WhatsApp Status] Connection closed (status code: ${statusCode}). Attempting persistent auto-reconnect...`);
        
        currentQr = null;

        // Auto-reconnect indefinitely unless explicit logout was triggered
        reconnectAttempts++;
        const backoffDelay = Math.min(3000 * Math.pow(1.2, reconnectAttempts), 30000);
        console.log(`[WhatsApp Reconnect] Reconnecting in ${(backoffDelay / 1000).toFixed(1)}s (Attempt #${reconnectAttempts})...`);
        
        reconnectTimeout = setTimeout(() => connectToWhatsApp(), backoffDelay);
      } else if (connection === 'open') {
        console.log('====================================================');
        console.log('✅ WHATSAPP NOTIFICATION BOT CONNECTED SUCCESSFULLY!');
        console.log('====================================================');
        isConnected = true;
        currentQr = null;
        reconnectAttempts = 0; // Reset counter on successful connection

        // Active Heartbeat keep-alive every 20 seconds to prevent connection drops
        keepAliveTimer = setInterval(async () => {
          if (sock && isConnected) {
            try {
              await sock.sendPresenceUpdate('available');
            } catch (pErr) {
              console.warn('[WhatsApp KeepAlive] Heartbeat presence ping warning:', pErr.message);
            }
          }
        }, 20000);
      }
    });

    // Handle messages upsert (Auto-reply to customer queries)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const senderJid = msg.key.remoteJid;

      // SAFETY CHECK 1: Only reply to direct individual chats (ends with @s.whatsapp.net)
      if (!senderJid || !senderJid.endsWith('@s.whatsapp.net')) {
        return;
      }

      // SAFETY CHECK 2: Ignore historical messages synced on startup
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const msgTimestamp = msg.messageTimestamp;
      if (msgTimestamp && (currentTimestamp - msgTimestamp) > 15) {
        return;
      }

      // SAFETY CHECK 3: Ensure the message contains text content
      const messageContent = msg.message.conversation || 
                            msg.message.extendedTextMessage?.text || 
                            msg.message.imageMessage?.caption || 
                            msg.message.videoMessage?.caption;
                            
      if (!messageContent) {
        return;
      }
      
      const replyText = 
        `Hello! 👋 Welcome to *THE THERAPY UNIVERSE*.\n\n` +
        `We have received your message. Our specialist team will review it and get back to you shortly!\n\n` +
        `To book an appointment directly, please visit our website: http://localhost:5174/#/booking`;
      
      try {
        await sock.sendMessage(senderJid, { text: replyText });
        console.log(`[WhatsApp] Auto-reply dispatched to sender: ${senderJid}`);
      } catch (err) {
        console.error('[WhatsApp] Failed to send auto-reply:', err.message);
      }
    });
  } catch (err) {
    console.error('Failed to initialize Baileys WhatsApp client:', err.message);
    reconnectAttempts++;
    const backoffDelay = Math.min(3000 * Math.pow(1.2, reconnectAttempts), 30000);
    reconnectTimeout = setTimeout(() => connectToWhatsApp(), backoffDelay);
  }
}

export async function sendWhatsAppNotification(toPhone, message) {
  if (!sock || !isConnected) {
    console.warn('\n⚠️ WhatsApp notification alert skipped. WhatsApp bot is offline or scanning is pending.');
    console.warn('Dispatch payload:\n', message, '\n');
    return false;
  }

  try {
    // Format recipient phone number to JID format
    let cleanPhone = toPhone.replace(/[^0-9]/g, '');
    if (!cleanPhone.startsWith('91') && cleanPhone.length === 10) {
      cleanPhone = '91' + cleanPhone;
    }
    const jid = `${cleanPhone}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    console.log(`[WhatsApp Success] Notification message dispatched to: ${jid}`);
    return true;
  } catch (err) {
    console.error('Error dispatching WhatsApp notification via Baileys:', err.message);
    return false;
  }
}

export function getWhatsAppStatus() {
  return {
    isConnected,
    qrCode: isConnected ? null : currentQr
  };
}

export async function resetWhatsAppAuth(db) {
  const targetDb = db || database;
  if (!targetDb) {
    console.error('Cannot reset WhatsApp auth: Database not initialized.');
    return false;
  }

  // Clear any existing reconnect timeout
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }

  // Clean up old socket connection
  if (sock) {
    try {
      sock.ev.removeAllListeners('connection.update');
      sock.ev.removeAllListeners('creds.update');
      sock.end(new Error('Resetting connection'));
    } catch (err) {
      // Ignore
    }
    sock = null;
  }

  isConnected = false;
  currentQr = null;

  try {
    // Clear whatsapp_auth_state table completely
    await targetDb.query('DELETE FROM whatsapp_auth_state');
    console.log('[WhatsApp Auth Reset] Cleared all auth state credentials.');

    // Connect with a fresh session
    await connectToWhatsApp(targetDb);
    return true;
  } catch (err) {
    console.error('[WhatsApp Auth Reset] Reset failed:', err.message);
    return false;
  }
}
