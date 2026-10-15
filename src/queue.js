/**
 * THE CLUB 777° — REMINDER QUEUE MANAGER & CONSERVATIVE RETRY ENGINE
 * Provides atomic job claiming, exponential backoff with jitter, and truthful status tracking.
 */

import { query, execute } from './db.js';
import { logger } from './logger.js';
import { config } from './config.js';

export class QueueManager {
  /**
   * Fetches the next eligible jobs ready for processing
   * @param {number} limit 
   * @returns {Promise<Array>}
   */
  static async fetchPendingJobs(limit = 5) {
    const sql = `
      SELECT * FROM whatsapp_reminder_queue
      WHERE (
        status = 'pending' 
        OR (status = 'retry_scheduled' AND next_retry_at <= NOW())
      )
      AND attempt_count < max_attempts
      ORDER BY scheduled_for ASC
      LIMIT ?
    `;
    const [rows] = await query(sql, [limit]);
    return rows;
  }

  /**
   * Atomically claims a job for execution
   * Returns true if successfully claimed, false if another process claimed it
   * @param {number} jobId 
   * @returns {Promise<boolean>}
   */
  static async claimJob(jobId) {
    const sql = `
      UPDATE whatsapp_reminder_queue
      SET status = 'processing',
          attempt_count = attempt_count + 1,
          last_attempt_at = NOW()
      WHERE id = ? AND status IN ('pending', 'retry_scheduled')
    `;
    const [result] = await execute(sql, [jobId]);
    return result.affectedRows === 1;
  }

  /**
   * Calculates exponential backoff in seconds with random jitter
   * Formula: min(300, 15 * 2^(attempts-1)) + random(2, 10)
   * @param {number} attempts 
   * @returns {number} Delay in seconds
   */
  static calculateBackoffSeconds(attempts) {
    const base = Math.min(300, 15 * Math.pow(2, Math.max(0, attempts - 1)));
    const jitter = Math.floor(Math.random() * 9) + 2; // 2 to 10 seconds jitter
    return base + jitter;
  }

  /**
   * Marks a job as submitted to the transport socket
   * Note: This is NOT proof of delivery; it means Baileys accepted the payload.
   * @param {number} jobId 
   * @param {string} wamid WhatsApp Message ID
   * @param {Object} transportResult 
   */
  static async markSubmitted(jobId, wamid, transportResult = {}) {
    const sql = `
      UPDATE whatsapp_reminder_queue
      SET status = 'submitted',
          wamid = ?,
          transport_result = ?,
          error_category = 'none'
      WHERE id = ?
    `;
    await execute(sql, [wamid || null, JSON.stringify(transportResult), jobId]);
    logger.info({ jobId, wamid }, '[Queue] Job marked as SUBMITTED');
  }

  /**
   * Marks a job as officially confirmed delivered based on network ACK event
   * @param {string} wamid 
   * @param {number} ackStatus 
   */
  static async updateAckByWamid(wamid, ackStatus) {
    let targetStatus = 'submitted';
    if (ackStatus === 2) targetStatus = 'sent'; // Server ACK observed
    else if (ackStatus === 3) targetStatus = 'delivered'; // Recipient Device Delivery ACK
    else if (ackStatus === 4 || ackStatus === 5) targetStatus = 'read'; // Read receipt

    const sql = `
      UPDATE whatsapp_reminder_queue
      SET status = ?,
          ack_status = ?
      WHERE wamid = ? AND status IN ('submitted', 'sent', 'delivered')
    `;
    const [res] = await execute(sql, [targetStatus, ackStatus, wamid]);
    if (res.affectedRows > 0) {
      logger.info({ wamid, targetStatus, ackStatus }, '[Queue] Delivery ACK verified');
    }
  }

  /**
   * Marks a job as failed, scheduling a retry if eligible or moving to final failed state
   * @param {number} jobId 
   * @param {string} errorCategory 'transient' | 'permanent' | 'auth_required' | 'opted_out'
   * @param {string} errorMessage 
   * @param {number} currentAttempts 
   */
  static async markFailed(jobId, errorCategory, errorMessage, currentAttempts) {
    const maxAttempts = config.maxRetryAttempts;
    const isRetryable = errorCategory === 'transient' && currentAttempts < maxAttempts;

    if (isRetryable) {
      const backoffSec = this.calculateBackoffSeconds(currentAttempts);
      const sql = `
        UPDATE whatsapp_reminder_queue
        SET status = 'retry_scheduled',
            error_category = ?,
            transport_result = ?,
            next_retry_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
        WHERE id = ?
      `;
      await execute(sql, [errorCategory, JSON.stringify({ error: errorMessage, attempt: currentAttempts }), backoffSec, jobId]);
      logger.warn({ jobId, backoffSec, attempt: currentAttempts }, '[Queue] Job failed; RETRY SCHEDULED');
    } else {
      const sql = `
        UPDATE whatsapp_reminder_queue
        SET status = 'failed',
            error_category = ?,
            transport_result = ?
        WHERE id = ?
      `;
      await execute(sql, [errorCategory, JSON.stringify({ error: errorMessage, attempt: currentAttempts, final: true }), jobId]);
      logger.error({ jobId, errorCategory, errorMessage }, '[Queue] Job permanently FAILED');
    }
  }

  /**
   * Cancels a pending or retry_scheduled job upon administrator request
   * @param {number} jobId 
   * @param {string} reason 
   */
  static async cancelJob(jobId, reason = 'Administrator request') {
    const sql = `
      UPDATE whatsapp_reminder_queue
      SET status = 'cancelled',
          transport_result = ?
      WHERE id = ? AND status IN ('pending', 'scheduled', 'retry_scheduled')
    `;
    const [res] = await execute(sql, [JSON.stringify({ cancelled_reason: reason, cancelled_at: new Date() }), jobId]);
    return res.affectedRows === 1;
  }

  /**
   * Re-queues a failed or cancelled job for immediate retry
   * @param {number} jobId 
   */
  static async retryJobNow(jobId) {
    const sql = `
      UPDATE whatsapp_reminder_queue
      SET status = 'pending',
          next_retry_at = NOW(),
          error_category = 'none'
      WHERE id = ? AND status IN ('failed', 'cancelled', 'retry_scheduled')
    `;
    const [res] = await execute(sql, [jobId]);
    return res.affectedRows === 1;
  }

  /**
   * Fetches comprehensive queue statistics
   * @returns {Promise<Object>}
   */
  static async getQueueStats() {
    const sql = `
      SELECT 
        status, 
        COUNT(*) as cnt 
      FROM whatsapp_reminder_queue 
      GROUP BY status
    `;
    const [rows] = await query(sql);
    const stats = {
      pending: 0,
      processing: 0,
      submitted: 0,
      sent: 0,
      delivered: 0,
      read: 0,
      failed: 0,
      retry_scheduled: 0,
      cancelled: 0,
      skipped: 0,
      total: 0
    };
    for (const r of rows) {
      if (stats[r.status] !== undefined) {
        stats[r.status] = r.cnt;
        stats.total += r.cnt;
      }
    }
    return stats;
  }
}
