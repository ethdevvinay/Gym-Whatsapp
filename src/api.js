/**
 * THE CLUB 777° — SECURE NODE.JS WORKER ADMINISTRATIVE REST API
 * Authenticated via X-Worker-Auth header matching the database setting.
 * Provides queue controls, QR stream, manual scans, and status endpoints.
 */

import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { logger } from './logger.js';
import { transport } from './transport.js';
import { QueueManager } from './queue.js';
import { runReminderScan } from './scheduler.js';
import { query } from './db.js';

export function createApiRouter() {
  const router = express.Router();

  // 1. Authentication Middleware (Guards all admin endpoints)
  router.use((req, res, next) => {
    // Health check endpoint is public for local supervisor & Hostinger container monitoring
    if (req.path === '/' || req.path === '/health') {
      return next();
    }

    const authHeader = req.headers['x-worker-auth'] || req.query.auth_token;
    if (!authHeader || authHeader !== config.workerSecret) {
      logger.warn({ ip: req.ip, path: req.path }, '[API] Unauthorized access attempt');
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Valid X-Worker-Auth secret required'
      });
    }
    next();
  });

  // 2. Health & Liveness Check
  router.get('/', (req, res) => {
    res.json({
      service: 'theclub777-whatsapp-worker',
      status: 'online',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  router.get('/health', (req, res) => {
    res.json({
      service: 'theclub777-whatsapp-worker',
      status: 'healthy',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString()
    });
  });

  // 3. Operational & Connection Status
  router.get('/status', async (req, res) => {
    try {
      const transportStatus = transport.getStatus();
      const queueStats = await QueueManager.getQueueStats();
      const mem = process.memoryUsage();

      res.json({
        success: true,
        service: 'theclub777-whatsapp-worker',
        status: transportStatus.status,
        connected: transportStatus.connected,
        user: transportStatus.user,
        qr: transportStatus.qr,
        queue: queueStats,
        config: {
          dryRunMode: config.dryRunMode,
          experimentalDispatchEnabled: config.experimentalDispatchEnabled,
          timezone: config.timezone
        },
        system: {
          uptimeSeconds: Math.round(process.uptime()),
          memoryRssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
          pid: process.pid
        },
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error({ err: err.message }, '[API] Status fetch error');
      res.status(500).json({ success: false, error: 'Failed to retrieve operational status' });
    }
  });

  // 4. QR Code Pairing Stream
  router.get('/qr', (req, res) => {
    const status = transport.getStatus();
    if (status.connected) {
      return res.json({
        success: true,
        status: 'connected',
        message: 'WhatsApp session is already paired and active'
      });
    }
    if (!status.qr) {
      return res.json({
        success: false,
        status: status.status,
        message: 'QR code is generating or socket is initializing. Please wait...'
      });
    }
    res.json({
      success: true,
      status: 'qr_ready',
      qr: status.qr
    });
  });

  // 5. Queue Job Explorer & Pagination
  router.get('/queue', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
      const page = Math.max(parseInt(req.query.page || '1', 10), 1);
      const offset = (page - 1) * limit;
      const filterStatus = req.query.status || '';

      let sql = 'SELECT * FROM whatsapp_reminder_queue';
      const params = [];
      if (filterStatus) {
        sql += ' WHERE status = ?';
        params.push(filterStatus);
      }
      sql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows] = await query(sql, params);
      const [countResult] = await query('SELECT COUNT(*) as total FROM whatsapp_reminder_queue' + (filterStatus ? ' WHERE status = ?' : ''), filterStatus ? [filterStatus] : []);

      res.json({
        success: true,
        data: rows,
        pagination: {
          page,
          limit,
          total: countResult[0].total,
          totalPages: Math.ceil(countResult[0].total / limit)
        }
      });
    } catch (err) {
      logger.error({ err: err.message }, '[API] Queue fetch error');
      res.status(500).json({ success: false, error: 'Failed to fetch queue records' });
    }
  });

  // 6. Trigger Manual Scheduler Reminder Scan
  router.post('/scan', async (req, res) => {
    try {
      const correlationId = `admin_scan_${Date.now()}`;
      const summary = await runReminderScan({
        dryRun: config.dryRunMode,
        correlationId
      });
      res.json({
        success: true,
        message: `Reminder scan completed. Queued ${summary.totalQueued} new reminders.`,
        summary
      });
    } catch (err) {
      logger.error({ err: err.message }, '[API] Manual scan error');
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. Retry a Failed or Cancelled Job
  router.post('/retry/:id', async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId) return res.status(400).json({ success: false, error: 'Valid Job ID required' });

    try {
      const retried = await QueueManager.retryJobNow(jobId);
      if (retried) {
        res.json({ success: true, message: `Job #${jobId} re-queued for immediate processing` });
      } else {
        res.status(404).json({ success: false, error: `Job #${jobId} not found or not eligible for retry` });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 8. Cancel a Pending Job
  router.post('/cancel/:id', async (req, res) => {
    const jobId = parseInt(req.params.id, 10);
    if (!jobId) return res.status(400).json({ success: false, error: 'Valid Job ID required' });

    try {
      const cancelled = await QueueManager.cancelJob(jobId, req.body.reason || 'Admin cancelled');
      if (cancelled) {
        res.json({ success: true, message: `Job #${jobId} cancelled successfully` });
      } else {
        res.status(404).json({ success: false, error: `Job #${jobId} not found or already processed` });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 9. Toggle Experimental Mode / Dry-Run
  router.post('/toggle-mode', (req, res) => {
    if (req.body.dryRunMode !== undefined) {
      config.dryRunMode = Boolean(req.body.dryRunMode);
    }
    if (req.body.experimentalDispatchEnabled !== undefined) {
      config.experimentalDispatchEnabled = Boolean(req.body.experimentalDispatchEnabled);
    }
    res.json({
      success: true,
      config: {
        dryRunMode: config.dryRunMode,
        experimentalDispatchEnabled: config.experimentalDispatchEnabled
      }
    });
  });

  // 10. Direct Single Message Dispatch (Backwards Compatible with PHP Invoice Sender)
  router.post('/send', async (req, res) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) {
        return res.status(400).json({ success: false, error: 'Phone and message are required' });
      }

      const result = await transport.sendMessage({ phone, message });
      if (result.success) {
        res.json({
          success: true,
          message_id: result.wamid,
          is_dry_run: result.isDryRun,
          status: 'submitted'
        });
      } else {
        res.status(503).json({
          success: false,
          error: result.error,
          errorCategory: result.errorCategory
        });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 11. Disconnect / Session Reset
  router.post('/logout', async (req, res) => {
    const result = await transport.logout();
    res.json(result);
  });

  return router;
}
