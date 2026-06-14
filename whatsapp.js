import makeWASocket, { DisconnectReason, proto } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils.js';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics.js';

let sock = null;
let isConnected = false;
let currentQr = null;
let database = null;
let reconnectTimeout = null;

// Helper to wrap Baileys SQLite Authentication State
export async function useSQLiteAuthState(db) {
  const writeData = async (data, id) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO whatsapp_auth_state (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
        [id, value],
        (err) => {
          if (err) {
            console.error('[WhatsApp Auth] Error writing state key:', id, err.message);
            reject(err);
          } else {
            resolve();
          }
        }
      );
    });
  };

  const readData = async (id) => {
    try {
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT value FROM whatsapp_auth_state WHERE id = ?', [id], (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
      if (!row) return null;
      return JSON.parse(row.value, BufferJSON.reviver);
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    try {
      await new Promise((resolve, reject) => {
        db.run('DELETE FROM whatsapp_auth_state WHERE id = ?', [id], (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
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
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                await writeData(value, key);
              } else {
                await removeData(key);
              }
            }
          }
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
      sock.end(new Error('Reconnecting'));
    } catch (err) {
      // Ignore
    }
    sock = null;
  }

  try {
    const { state, saveCreds } = await useSQLiteAuthState(database);
    const makeWASocketFn = makeWASocket.default || makeWASocket;

    sock = makeWASocketFn({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['THE THERAPY UNIVERSE', 'Chrome', '1.0.0']
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`WhatsApp connection closed (status code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
        
        currentQr = null;

        if (shouldReconnect) {
          reconnectTimeout = setTimeout(() => connectToWhatsApp(), 5000);
        }
      } else if (connection === 'open') {
        console.log('====================================================');
        console.log('✅ WHATSAPP NOTIFICATION BOT CONNECTED SUCCESSFULLY!');
        console.log('====================================================');
        isConnected = true;
        currentQr = null;
      }
    });

    // Handle messages upsert (Auto-reply to customer queries)
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const senderJid = msg.key.remoteJid;

      // SAFETY CHECK 1: Only reply to direct individual chats (ends with @s.whatsapp.net)
      // Exclude group chats (@g.us), status updates (@broadcast), and other system JIDs (@lid, etc.)
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

    sock.ev.on('creds.update', saveCreds);
  } catch (err) {
    console.error('Failed to initialize Baileys WhatsApp client:', err.message);
    reconnectTimeout = setTimeout(() => connectToWhatsApp(), 5000);
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
