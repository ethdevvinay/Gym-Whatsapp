import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '0.0.0.0',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    database: process.env.DB_NAME || 'gym_db',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '5', 10),
    timezone: '+05:30' // Indian Standard Time
  },

  workerSecret: process.env.WORKER_SECRET || '',

  dryRunMode: process.env.DRY_RUN_MODE === 'true' || process.env.DRY_RUN_MODE === '1',
  experimentalDispatchEnabled: process.env.EXPERIMENTAL_DISPATCH_ENABLED === 'true' || process.env.EXPERIMENTAL_DISPATCH_ENABLED === '1',

  timezone: process.env.TIMEZONE || 'Asia/Kolkata',
  schedulerIntervalMinutes: parseInt(process.env.SCHEDULER_INTERVAL_MINUTES || '60', 10),
  queuePollIntervalSeconds: parseInt(process.env.QUEUE_POLL_INTERVAL_SECONDS || '10', 10),

  dispatchDelayMinMs: parseInt(process.env.DISPATCH_DELAY_MIN_MS || '10000', 10),
  dispatchDelayMaxMs: parseInt(process.env.DISPATCH_DELAY_MAX_MS || '22000', 10),
  maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10),

  // 100% Anti-Ban & Human Emulation Safety Shield
  antiBan: {
    enabled: process.env.ANTI_BAN_SHIELD !== 'false',
    humanTypingSimulation: process.env.HUMAN_TYPING_SIMULATION !== 'false',
    minTypingDelayMs: parseInt(process.env.MIN_TYPING_DELAY_MS || '1500', 10),
    maxTypingDelayMs: parseInt(process.env.MAX_TYPING_DELAY_MS || '3500', 10),
    directSendCooldownMs: parseInt(process.env.DIRECT_SEND_COOLDOWN_MS || '3000', 10),
    hourlyLimit: parseInt(process.env.HOURLY_DISPATCH_LIMIT || '45', 10),
    dailyLimit: parseInt(process.env.DAILY_DISPATCH_LIMIT || '300', 10),
    quietHoursEnabled: process.env.QUIET_HOURS_ENABLED !== 'false',
    quietHoursStartHour: 21.5, // 9:30 PM IST
    quietHoursEndHour: 8.5      // 8:30 AM IST
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  authDir: path.resolve(__dirname, '../auth_info')
};

export function validateConfig() {
  const errors = [];
  if (!config.db.database) errors.push('DB_NAME is required');
  if (!config.workerSecret) errors.push('WORKER_SECRET is required');
  if (config.dispatchDelayMinMs < 1000) errors.push('DISPATCH_DELAY_MIN_MS must be at least 1000ms');
  return {
    valid: errors.length === 0,
    errors
  };
}
