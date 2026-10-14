import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  host: process.env.HOST || '127.0.0.1',

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

  dispatchDelayMinMs: parseInt(process.env.DISPATCH_DELAY_MIN_MS || '8000', 10),
  dispatchDelayMaxMs: parseInt(process.env.DISPATCH_DELAY_MAX_MS || '15000', 10),
  maxRetryAttempts: parseInt(process.env.MAX_RETRY_ATTEMPTS || '3', 10),

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
