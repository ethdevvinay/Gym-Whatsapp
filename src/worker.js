/**
 * THE CLUB 777° — REMINDER WORKER SERVICE COORDINATOR
 * Handles background queue polling, safe dispatch with rate jitter,
 * heartbeat updates, and graceful termination.
 */

import { config } from './config.js';
import { logger } from './logger.js';
import { query, execute } from './db.js';
import { QueueManager } from './queue.js';
import { transport } from './transport.js';
import { runReminderScan } from './scheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getRandomJitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class ReminderWorker {
  constructor() {
    this.isRunning = false;
    this.heartbeatTimer = null;
    this.queueTimer = null;
    this.schedulerTimer = null;
    this.isProcessingQueue = false;
    this.startTime = Date.now();
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info(
      {
        dryRun: config.dryRunMode,
        experimental: config.experimentalDispatchEnabled,
        pid: process.pid
      },
      '[Worker] Starting Reminder Worker Service'
    );

    // 1. Initial Heartbeat
    await this.updateHeartbeat();
    this.heartbeatTimer = setInterval(() => this.updateHeartbeat(), 15000);

    // 2. Initial Reminder Scan on Startup
    try {
      await runReminderScan({ dryRun: config.dryRunMode });
    } catch (scanErr) {
      logger.error({ err: scanErr.message }, '[Worker] Initial reminder scan failed');
    }

    // 3. Periodic Scheduler Timer
    const schedulerMs = config.schedulerIntervalMinutes * 60 * 1000;
    this.schedulerTimer = setInterval(async () => {
      try {
        await runReminderScan({ dryRun: config.dryRunMode });
      } catch (err) {
        logger.error({ err: err.message }, '[Worker] Periodic scheduler scan error');
      }
    }, schedulerMs);

    // 4. Queue Polling Loop
    const queuePollMs = config.queuePollIntervalSeconds * 1000;
    this.queueTimer = setInterval(() => this.processNextBatch(), queuePollMs);

    // Trigger immediate first queue pass
    this.processNextBatch();
  }

  async updateHeartbeat() {
    try {
      const memoryUsage = process.memoryUsage();
      const rssMb = Math.round((memoryUsage.rss / 1024 / 1024) * 10) / 10;
      const uptimeSec = Math.round((Date.now() - this.startTime) / 1000);
      const queueStats = await QueueManager.getQueueStats();

      await execute(
        `UPDATE whatsapp_worker_status 
         SET last_heartbeat = NOW(),
             active_pid = ?,
             uptime_seconds = ?,
             memory_rss_mb = ?,
             total_jobs_processed = ?,
             total_jobs_delivered = ?,
             total_jobs_failed = ?,
             is_experimental_active = ?,
             dry_run_mode = ?
         WHERE id = 1`,
        [
          process.pid,
          uptimeSec,
          rssMb,
          queueStats.total,
          queueStats.delivered,
          queueStats.failed,
          config.experimentalDispatchEnabled ? 1 : 0,
          config.dryRunMode ? 1 : 0
        ]
      );
    } catch (err) {
      logger.error({ err: err.message }, '[Worker] Heartbeat update failed');
    }
  }

  async processNextBatch() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    try {
      const pendingJobs = await QueueManager.fetchPendingJobs(3);
      if (pendingJobs.length === 0) {
        this.isProcessingQueue = false;
        return;
      }

      logger.info({ count: pendingJobs.length }, '[Worker] Processing queue batch');

      for (const job of pendingJobs) {
        // 1. Verify Member Communication Opt-Out
        const [optCheck] = await query('SELECT whatsapp_opt_out FROM members WHERE id = ?', [job.member_id]);
        if (optCheck.length > 0 && optCheck[0].whatsapp_opt_out === 1) {
          logger.warn({ jobId: job.id, memberId: job.member_id }, '[Worker] Member opted out; cancelling job');
          await QueueManager.cancelJob(job.id, 'Customer communication preference: Opted Out');
          continue;
        }

        // 2. Atomic Claiming Lock
        const claimed = await QueueManager.claimJob(job.id);
        if (!claimed) {
          logger.debug({ jobId: job.id }, '[Worker] Job already claimed by another process');
          continue;
        }

        // 3. Jitter Delay Between Dispatches (Safe Rate Throttling)
        const delay = getRandomJitter(config.dispatchDelayMinMs, config.dispatchDelayMaxMs);
        logger.debug({ jobId: job.id, delayMs: delay }, '[Worker] Applying rate throttling delay');
        await sleep(delay);

        // 4. Dispatch via Transport
        const dispatchResult = await transport.sendMessage({
          phone: job.recipient_phone,
          message: job.message_payload
        });

        // 5. Update Status Based on Result
        if (dispatchResult.success) {
          await QueueManager.markSubmitted(job.id, dispatchResult.wamid, dispatchResult);
        } else {
          await QueueManager.markFailed(
            job.id,
            dispatchResult.errorCategory || 'transient',
            dispatchResult.error || 'Failed to dispatch',
            job.attempt_count + 1
          );
        }
      }
    } catch (batchErr) {
      logger.error({ err: batchErr.message }, '[Worker] Batch processing error');
    } finally {
      this.isProcessingQueue = false;
    }
  }

  async stop() {
    logger.info('[Worker] Stopping Reminder Worker Service');
    this.isRunning = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.schedulerTimer) clearInterval(this.schedulerTimer);

    try {
      await execute("UPDATE whatsapp_worker_status SET status = 'stopped' WHERE id = 1");
    } catch (e) {}
  }
}

export const worker = new ReminderWorker();
