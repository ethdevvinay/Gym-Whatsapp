/**
 * THE CLUB 777° — WHATSAPP BAILEYS TRANSPORT ADAPTER
 * Manages WebSocket multi-device lifecycle, pairing QR generation, message dispatch,
 * and truthful delivery receipt listeners (ACK 2 = Server, ACK 3 = Delivered, ACK 4 = Read).
 */

import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { config } from './config.js';
import { logger } from './logger.js';
import { execute } from './db.js';
import { QueueManager } from './queue.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class WhatsAppTransport {
  constructor() {
    this.sock = null;
    this.connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'auth_required'
    this.currentQrRaw = null;
    this.currentQrImage = null;
    this.connectedUser = null;
    this.reconnectAttempts = 0;
    this.isInitializing = false;
    this.reconnectTimer = null;

    // Anti-Ban Throttling & Rate Limit Tracking
    this.lastDirectSendTime = 0;
    this.hourlySendCount = 0;
    this.lastHourReset = Date.now();
    this.dailySendCount = 0;
    this.lastDayReset = Date.now();
  }

  destroySocket() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners();
        if (this.sock.ws) {
          this.sock.ws.removeAllListeners();
          this.sock.ws.close();
        }
        if (typeof this.sock.end === 'function') {
          this.sock.end();
        }
      } catch (e) {
        // Ignore socket teardown errors
      }
      this.sock = null;
    }
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    // Clear any existing reconnect timer
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      if (!fs.existsSync(config.authDir)) {
        fs.mkdirSync(config.authDir, { recursive: true });
      }

      // Ensure previous socket is fully destroyed before creating a new one
      this.destroySocket();

      const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
      const { version } = await fetchLatestBaileysVersion().catch(() => ({
        version: [2, 3000, 1015901307]
      }));

      this.connectionState = 'connecting';
      logger.info({ version: version.join('.') }, '[Transport] Booting Baileys WhatsApp Socket');

      const silentPino = pino({ level: 'silent' });

      this.sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: silentPino,
        browser: ['THE CLUB 777', 'Chrome', '124.0.0'],
        syncFullHistory: false,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 25000
      });

      this.sock.ev.on('creds.update', saveCreds);

      this.sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.currentQrRaw = qr;
          this.connectionState = 'qr_ready';
          try {
            this.currentQrImage = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
            logger.info('[Transport] New QR code generated for pairing');
            await this.syncStatusToDb();
          } catch (qrErr) {
            logger.error({ qrErr: qrErr.message }, '[Transport] Failed to render QR image');
          }
        }

        if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message || 'Connection closed';
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isReplaced = statusCode === DisconnectReason.connectionReplaced;
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;

          this.currentQrRaw = null;
          this.currentQrImage = null;
          this.connectedUser = null;

          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }

          if (isLoggedOut) {
            this.connectionState = 'auth_required';
            logger.warn({ statusCode, error: errorMsg }, '[Transport] WhatsApp session logged out (401). Auth required.');
            try {
              if (fs.existsSync(config.authDir)) {
                fs.rmSync(config.authDir, { recursive: true, force: true });
              }
            } catch (e) {}
            await this.syncStatusToDb();
            return;
          }

          if (isReplaced) {
            this.connectionState = 'disconnected';
            logger.warn(
              { statusCode },
              '[Transport] Connection replaced by another session/process (440). Halting auto-reconnect to avoid collision loop.'
            );
            await this.syncStatusToDb();
            return;
          }

          this.connectionState = 'disconnected';
          logger.warn({ statusCode, isRestartRequired, error: errorMsg }, '[Transport] Connection closed');
          await this.syncStatusToDb();

          // Auto-reconnect with safety guards
          if (isRestartRequired) {
            logger.info('[Transport] Restart required by WhatsApp protocol (515). Reconnecting cleanly in 1.5s...');
            this.reconnectTimer = setTimeout(() => {
              this.isInitializing = false;
              this.initialize();
            }, 1500);
          } else {
            this.reconnectAttempts++;
            if (this.reconnectAttempts > 15) {
              logger.warn({ attempts: this.reconnectAttempts }, '[Transport] Excessive reconnect attempts. Cooling down for 60s.');
              this.reconnectTimer = setTimeout(() => {
                this.reconnectAttempts = 0;
                this.isInitializing = false;
                this.initialize();
              }, 60000);
            } else {
              const delay = Math.min(this.reconnectAttempts * 3000, 20000);
              logger.info({ delaySeconds: delay / 1000, attempt: this.reconnectAttempts }, '[Transport] Scheduling automatic reconnect');
              this.reconnectTimer = setTimeout(() => {
                this.isInitializing = false;
                this.initialize();
              }, delay);
            }
          }
        } else if (connection === 'open') {
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.reconnectAttempts = 0;
          this.connectionState = 'connected';
          this.currentQrRaw = null;
          this.currentQrImage = null;
          this.connectedUser = this.sock.user;

          logger.info(
            { user: this.sock.user?.id, name: this.sock.user?.name },
            '[Transport] WhatsApp Socket Connected Successfully'
          );
          await this.syncStatusToDb();
        }
      });

      // Truthful Message Acknowledgement Listener
      this.sock.ev.on('messages.update', async (updates) => {
        for (const u of updates) {
          if (u.key && u.key.id && u.update && u.update.status !== undefined) {
            const wamid = u.key.id;
            const ack = u.update.status;
            // ack values: 0=error, 1=pending, 2=server_ack, 3=delivery_receipt, 4=read, 5=played
            await QueueManager.updateAckByWamid(wamid, ack);
          }
        }
      });

      // Inbound Anti-Ban Shield: Opt-Out / Opt-In Listener
      this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key?.fromMe) continue;
          const senderJid = msg.key?.remoteJid;
          if (!senderJid || !senderJid.endsWith('@s.whatsapp.net')) continue;
          const rawText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
          if (!rawText) continue;

          const cleanPhone = senderJid.replace(/[^0-9]/g, '');
          const localPhone10 = cleanPhone.slice(-10);

          const optOutWords = ['stop', 'unsubscribe', 'optout', 'opt out', 'mat bhejo', 'band karo', 'don\'t send', 'block', 'cancel'];
          const isOptOut = optOutWords.some(w => rawText === w || rawText.startsWith(w));

          const optInWords = ['start', 'subscribe', 'resume', 'unblock'];
          const isOptIn = optInWords.some(w => rawText === w || rawText.startsWith(w));

          if (isOptOut) {
            logger.info({ phone: cleanPhone }, '[Anti-Ban Shield] Inbound STOP opt-out received');
            try {
              await execute(
                `UPDATE members SET whatsapp_opt_out = 1 WHERE phone LIKE ? OR whatsapp_no LIKE ?`,
                [`%${localPhone10}%`, `%${localPhone10}%`]
              );
              await execute(
                `UPDATE reminder_queue rq 
                 JOIN members m ON rq.member_id = m.id 
                 SET rq.status = 'cancelled', rq.last_error = 'Recipient sent STOP' 
                 WHERE (m.phone LIKE ? OR m.whatsapp_no LIKE ?) AND rq.status IN ('pending', 'processing', 'retry_scheduled')`,
                [`%${localPhone10}%`, `%${localPhone10}%`]
              );
              await this.sock.sendMessage(senderJid, {
                text: `THE CLUB 777: You have been successfully unsubscribed from automated promotional messages.\n\nReply *START* anytime if you wish to re-subscribe. Stay healthy! 💪`
              });
            } catch (dbErr) {
              logger.error({ err: dbErr.message }, '[Anti-Ban] Error saving opt-out preference');
            }
          } else if (isOptIn) {
            logger.info({ phone: cleanPhone }, '[Anti-Ban Shield] Inbound START opt-in received');
            try {
              await execute(
                `UPDATE members SET whatsapp_opt_out = 0 WHERE phone LIKE ? OR whatsapp_no LIKE ?`,
                [`%${localPhone10}%`, `%${localPhone10}%`]
              );
              await this.sock.sendMessage(senderJid, {
                text: `THE CLUB 777: Welcome back! You are now subscribed to receive gym reminders and fitness updates. 🏋️‍♂️`
              });
            } catch (dbErr) {
              logger.error({ err: dbErr.message }, '[Anti-Ban] Error saving opt-in preference');
            }
          }
        }
      });

    } catch (err) {
      logger.error({ err: err.message }, '[Transport Init Error]');
      this.connectionState = 'disconnected';
      await this.syncStatusToDb();
    } finally {
      this.isInitializing = false;
    }
  }

  async syncStatusToDb() {
    try {
      const phone = this.connectedUser?.id ? this.connectedUser.id.split('@')[0].split(':')[0] : null;
      const userName = this.connectedUser?.name || (phone ? `Club 777 (${phone})` : null);

      await execute(
        `UPDATE whatsapp_worker_status 
         SET status = ?, 
             connected_phone = ?, 
             connected_user = ?, 
             auth_qr_raw = ?, 
             last_heartbeat = NOW() 
         WHERE id = 1`,
        [this.connectionState, phone, userName, this.currentQrImage || null]
      );
    } catch (dbErr) {
      logger.error({ dbErr: dbErr.message }, '[Transport] Failed to sync status to database');
    }
  }

  /**
   * Simulates realistic human behavior: opens chat, marks online, shows 'typing...' presence
   */
  async simulateHumanTyping(jid, text) {
    if (!config.antiBan.humanTypingSimulation || !this.sock) return;
    try {
      await this.sock.presenceSubscribe(jid).catch(() => {});
      await sleep(300 + Math.floor(Math.random() * 400));
      await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
      
      const charCount = (text || '').length;
      const targetDuration = Math.min(
        config.antiBan.maxTypingDelayMs,
        Math.max(config.antiBan.minTypingDelayMs, charCount * 20)
      );
      await sleep(targetDuration);
      await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});
    } catch (e) {}
  }

  /**
   * Hourly and Daily dispatch rate limiter to prevent spam flags
   */
  checkRateLimits() {
    const now = Date.now();
    if (now - this.lastHourReset > 3600000) {
      this.hourlySendCount = 0;
      this.lastHourReset = now;
    }
    if (now - this.lastDayReset > 86400000) {
      this.dailySendCount = 0;
      this.lastDayReset = now;
    }

    if (config.antiBan.hourlyLimit > 0 && this.hourlySendCount >= config.antiBan.hourlyLimit) {
      return { allowed: false, error: `Anti-Ban: Hourly safety limit of ${config.antiBan.hourlyLimit} messages reached. Throttling for account protection.` };
    }
    if (config.antiBan.dailyLimit > 0 && this.dailySendCount >= config.antiBan.dailyLimit) {
      return { allowed: false, error: `Anti-Ban: Daily safety limit of ${config.antiBan.dailyLimit} messages reached. Dispatch paused until tomorrow.` };
    }
    return { allowed: true };
  }

  /**
   * Dispatches a single message payload
   * @param {Object} options
   * @param {string} options.phone e.g. 919876543210
   * @param {string} options.message
   * @returns {Promise<{success: boolean, wamid?: string, error?: string, errorCategory?: string, isDryRun?: boolean}>}
   */
  async sendMessage({ phone, message }) {
    // 1. Check Dry Run or Experimental Mode
    if (config.dryRunMode || !config.experimentalDispatchEnabled) {
      logger.info({ phone, preview: message.slice(0, 60) }, '[Transport DRY-RUN] Message simulated successfully');
      return {
        success: true,
        wamid: `dryrun_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        isDryRun: true
      };
    }

    // 2. Check Connection State (Circuit Breaker)
    if (this.connectionState !== 'connected' || !this.sock) {
      return {
        success: false,
        error: 'WhatsApp transport is not connected',
        errorCategory: 'auth_required'
      };
    }

    // 3. Normalize recipient JID
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    const jid = `${cleanPhone}@s.whatsapp.net`;

    // 4. Anti-Ban Rate Limit Check
    const rateCheck = this.checkRateLimits();
    if (!rateCheck.allowed) {
      logger.warn(rateCheck.error);
      return {
        success: false,
        error: rateCheck.error,
        errorCategory: 'rate_limited'
      };
    }

    // 5. Anti-Ban Cooldown Buffer between direct calls
    const now = Date.now();
    const timeSinceLast = now - this.lastDirectSendTime;
    if (timeSinceLast < config.antiBan.directSendCooldownMs) {
      const waitNeeded = config.antiBan.directSendCooldownMs - timeSinceLast;
      logger.debug({ waitMs: waitNeeded }, '[Anti-Ban] Applying direct send safety cooldown');
      await sleep(waitNeeded);
    }

    // 6. Simulate Human Typing Presence
    await this.simulateHumanTyping(jid, message);

    try {
      const result = await this.sock.sendMessage(jid, { text: message });
      const wamid = result?.key?.id;
      this.lastDirectSendTime = Date.now();
      this.hourlySendCount++;
      this.dailySendCount++;

      return {
        success: true,
        wamid,
        isDryRun: false
      };
    } catch (sendError) {
      logger.error({ phone, err: sendError.message }, '[Transport Send Error]');
      const isTransient = sendError.message.includes('timeout') || sendError.message.includes('disconnect') || sendError.message.includes('network');
      return {
        success: false,
        error: sendError.message,
        errorCategory: isTransient ? 'transient' : 'permanent'
      };
    }
  }

  /**
   * Dispatches a document (PDF receipt/invoice) or text fallback
   */
  async sendDocument({ phone, caption, file_name, file_base64, file_path }) {
    if (config.dryRunMode || !config.experimentalDispatchEnabled) {
      logger.info({ phone, file_name, preview: (caption || '').slice(0, 60) }, '[Transport DRY-RUN] Document simulated successfully');
      return {
        success: true,
        wamid: `dryrun_doc_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        isDryRun: true
      };
    }

    if (this.connectionState !== 'connected' || !this.sock) {
      return {
        success: false,
        error: 'WhatsApp transport is not connected',
        errorCategory: 'auth_required'
      };
    }

    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    const jid = `${cleanPhone}@s.whatsapp.net`;

    const rateCheck = this.checkRateLimits();
    if (!rateCheck.allowed) {
      return { success: false, error: rateCheck.error, errorCategory: 'rate_limited' };
    }

    await this.simulateHumanTyping(jid, caption || file_name || 'Document');

    try {
      let buffer = null;
      if (file_base64) {
        buffer = Buffer.from(file_base64, 'base64');
      } else if (file_path && fs.existsSync(file_path)) {
        buffer = fs.readFileSync(file_path);
      }

      let result;
      if (buffer) {
        result = await this.sock.sendMessage(jid, {
          document: buffer,
          mimetype: 'application/pdf',
          fileName: file_name || 'Receipt.pdf',
          caption: caption || ''
        });
      } else {
        result = await this.sock.sendMessage(jid, { text: caption || 'Receipt' });
      }

      const wamid = result?.key?.id;
      this.lastDirectSendTime = Date.now();
      this.hourlySendCount++;
      this.dailySendCount++;

      return {
        success: true,
        wamid,
        isDryRun: false
      };
    } catch (sendError) {
      logger.error({ phone, err: sendError.message }, '[Transport Send Document Error]');
      return {
        success: false,
        error: sendError.message,
        errorCategory: 'document_send_failed'
      };
    }
  }

  /**
   * Resets session credentials and disconnects
   */
  async logout() {
    try {
      if (this.sock) {
        await this.sock.logout().catch(() => {});
      }
      if (fs.existsSync(config.authDir)) {
        fs.rmSync(config.authDir, { recursive: true, force: true });
      }
      this.sock = null;
      this.connectedUser = null;
      this.currentQrRaw = null;
      this.currentQrImage = null;
      this.connectionState = 'disconnected';
      await this.syncStatusToDb();
      logger.info('[Transport] Session logged out and auth directory cleared');
      return { success: true };
    } catch (err) {
      logger.error({ err: err.message }, '[Transport Logout Error]');
      return { success: false, error: err.message };
    }
  }

  getStatus() {
    return {
      status: this.connectionState,
      connected: this.connectionState === 'connected',
      user: this.connectedUser ? {
        id: this.connectedUser.id,
        name: this.connectedUser.name || 'THE CLUB 777® Bot',
        phone: this.connectedUser.id ? this.connectedUser.id.split('@')[0].split(':')[0] : null
      } : null,
      qr: this.currentQrImage,
      dryRunMode: config.dryRunMode,
      experimentalDispatchEnabled: config.experimentalDispatchEnabled
    };
  }
}

export const transport = new WhatsAppTransport();
