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

class WhatsAppTransport {
  constructor() {
    this.sock = null;
    this.connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected' | 'auth_required'
    this.currentQrRaw = null;
    this.currentQrImage = null;
    this.connectedUser = null;
    this.reconnectAttempts = 0;
    this.isInitializing = false;
  }

  async initialize() {
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      if (!fs.existsSync(config.authDir)) {
        fs.mkdirSync(config.authDir, { recursive: true });
      }

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
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;

          this.currentQrRaw = null;
          this.currentQrImage = null;
          this.connectedUser = null;
          this.connectionState = isLoggedOut ? 'auth_required' : 'disconnected';

          logger.warn({ statusCode, isLoggedOut }, '[Transport] Connection closed');
          await this.syncStatusToDb();

          if (!isLoggedOut) {
            this.reconnectAttempts++;
            const delay = Math.min(this.reconnectAttempts * 3000, 20000);
            logger.info({ delaySeconds: delay / 1000 }, '[Transport] Scheduling automatic reconnect');
            setTimeout(() => {
              this.isInitializing = false;
              this.initialize();
            }, delay);
          } else {
            logger.warn('[Transport] Session logged out. Awaiting manual re-pairing.');
          }
        } else if (connection === 'open') {
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

    try {
      const result = await this.sock.sendMessage(jid, { text: message });
      const wamid = result?.key?.id;

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
