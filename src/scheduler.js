/**
 * THE CLUB 777° — MEMBERSHIP EXPIRY REMINDER SCHEDULER
 * Scans active subscriptions across calendar milestone boundaries (7d, 3d, tomorrow, today, expired)
 * Applies strict deduplication using deterministic idempotency keys and respects customer opt-outs.
 */

import { query, execute } from './db.js';
import { logger } from './logger.js';
import { DEFAULT_TEMPLATES, normalizePhoneNumber, renderTemplate, formatDateIST } from './templates.js';

export async function runReminderScan(options = {}) {
  const { dryRun = false, correlationId = `scan_${Date.now()}` } = options;
  const startTime = Date.now();
  logger.info({ correlationId, dryRun }, '[Scheduler] Starting Membership Reminder Scan');

  const summary = {
    correlationId,
    timestamp: new Date().toISOString(),
    dryRun,
    milestones: {
      expiring_7d: { found: 0, queued: 0, skipped: 0 },
      expiring_3d: { found: 0, queued: 0, skipped: 0 },
      expiring_tomorrow: { found: 0, queued: 0, skipped: 0 },
      expiring_today: { found: 0, queued: 0, skipped: 0 },
      expired: { found: 0, queued: 0, skipped: 0 }
    },
    totalQueued: 0,
    durationMs: 0
  };

  try {
    // Fetch Gym settings for template rendering
    const [settingsRows] = await query(
      "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('gym_name', 'gym_phone', 'currency_symbol')"
    );
    const gymSettings = {};
    for (const r of settingsRows) {
      gymSettings[r.setting_key] = r.setting_value;
    }
    const gymName = gymSettings.gym_name || 'THE CLUB 777®';
    const gymPhone = gymSettings.gym_phone || '8053576777';

    // Define the 5 core milestone boundaries
    const milestones = [
      {
        type: 'expiring_7d',
        dateSql: 'DATE_ADD(CURRENT_DATE(), INTERVAL 7 DAY)',
        statusFilter: "ms.status = 'active'"
      },
      {
        type: 'expiring_3d',
        dateSql: 'DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY)',
        statusFilter: "ms.status = 'active'"
      },
      {
        type: 'expiring_tomorrow',
        dateSql: 'DATE_ADD(CURRENT_DATE(), INTERVAL 1 DAY)',
        statusFilter: "ms.status = 'active'"
      },
      {
        type: 'expiring_today',
        dateSql: 'CURRENT_DATE()',
        statusFilter: "ms.status = 'active'"
      },
      {
        type: 'expired',
        dateSql: 'DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)', // Expired yesterday
        statusFilter: "ms.status IN ('active', 'expired')"
      }
    ];

    for (const m of milestones) {
      const sql = `
        SELECT 
          ms.id as subscription_id,
          ms.start_date,
          ms.end_date,
          ms.status as sub_status,
          m.id as member_id,
          m.name as member_name,
          m.phone,
          m.whatsapp_no,
          m.whatsapp_opt_out,
          mt.plan_title
        FROM member_subscriptions ms
        JOIN members m ON ms.member_id = m.id
        LEFT JOIN membership_types mt ON ms.membership_type_id = mt.id
        WHERE ms.end_date = ${m.dateSql}
          AND ${m.statusFilter}
          AND ms.status != 'frozen'
          AND m.status = 'active'
      `;

      const [candidates] = await query(sql);
      summary.milestones[m.type].found = candidates.length;

      for (const row of candidates) {
        // 1. Check Customer Communication Opt-Out
        if (row.whatsapp_opt_out === 1) {
          summary.milestones[m.type].skipped++;
          logger.debug({ memberId: row.member_id }, '[Scheduler] Member opted out of WhatsApp reminders');
          continue;
        }

        // 2. Validate & Normalize Phone Number
        const targetPhone = row.whatsapp_no || row.phone;
        const normalizedPhone = normalizePhoneNumber(targetPhone);
        if (!normalizedPhone) {
          summary.milestones[m.type].skipped++;
          logger.warn({ memberId: row.member_id, rawPhone: targetPhone }, '[Scheduler] Invalid phone number skipped');
          continue;
        }

        // 3. Format Target Date (YYYY-MM-DD)
        const targetDate = new Date(row.end_date).toISOString().split('T')[0];

        // 4. Deterministic Idempotency Key
        const idempotencyKey = `rem_${row.member_id}_${row.subscription_id}_${m.type}_${targetDate}`;

        // 5. Render Message Payload
        const templateDef = DEFAULT_TEMPLATES[m.type];
        const messageText = renderTemplate(templateDef.template, {
          member_name: row.member_name.split(' ')[0], // First name for warm, polite address
          plan_title: row.plan_title || 'Gym Membership',
          end_date: formatDateIST(row.end_date),
          gym_name: gymName,
          gym_phone: gymPhone
        });

        // 6. Insert Into Queue (Idempotent via UNIQUE idempotency_key)
        try {
          const insertSql = `
            INSERT INTO whatsapp_reminder_queue (
              member_id,
              subscription_id,
              reminder_type,
              scheduled_for,
              target_date,
              status,
              correlation_id,
              idempotency_key,
              recipient_phone,
              recipient_name,
              message_payload
            ) VALUES (?, ?, ?, NOW(), ?, 'pending', ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE updated_at = NOW()
          `;

          const [insertResult] = await execute(insertSql, [
            row.member_id,
            row.subscription_id,
            m.type,
            targetDate,
            correlationId,
            idempotencyKey,
            normalizedPhone,
            row.member_name,
            messageText
          ]);

          if (insertResult.affectedRows === 1) {
            summary.milestones[m.type].queued++;
            summary.totalQueued++;
          } else {
            summary.milestones[m.type].skipped++; // Already queued in previous scan
          }
        } catch (queueErr) {
          logger.error({ err: queueErr.message, idempotencyKey }, '[Scheduler] Error enqueuing reminder');
          summary.milestones[m.type].skipped++;
        }
      }
    }

    summary.durationMs = Date.now() - startTime;
    logger.info({ summary }, '[Scheduler] Completed Membership Reminder Scan');

    // Record last scheduler run in worker status table
    await execute(
      `UPDATE whatsapp_worker_status 
       SET last_scheduler_run = NOW(), 
           last_scheduler_result = ? 
       WHERE id = 1`,
      [JSON.stringify(summary)]
    );

    return summary;
  } catch (error) {
    logger.error({ error: error.message }, '[Scheduler Fatal Error]');
    summary.error = error.message;
    summary.durationMs = Date.now() - startTime;
    return summary;
  }
}
