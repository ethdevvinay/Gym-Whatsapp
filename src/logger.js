import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: ['req.headers["x-worker-auth"]', 'workerSecret', 'password', 'creds'],
    censor: '[REDACTED]'
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  base: {
    service: 'club777-whatsapp-worker'
  }
});
