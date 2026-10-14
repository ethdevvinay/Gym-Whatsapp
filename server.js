/**
 * THE CLUB 777° — NODE.JS WHATSAPP REMINDER WORKER & GATEWAY SERVICE
 * Unified entry point: starts DB pool, Baileys transport, reminder worker, and secure admin API.
 */

import express from 'express';
import cors from 'cors';
import { config, validateConfig } from './src/config.js';
import { logger } from './src/logger.js';
import { testConnection, closePool } from './src/db.js';
import { transport } from './src/transport.js';
import { worker } from './src/worker.js';
import { createApiRouter } from './src/api.js';

async function bootstrap() {
  logger.info('===========================================================');
  logger.info(' THE CLUB 777° — WHATSAPP REMINDER WORKER & GATEWAY');
  logger.info('===========================================================');

  // 1. Validate Environment Configuration
  const validation = validateConfig();
  if (!validation.valid) {
    logger.fatal({ errors: validation.errors }, '[Fatal] Invalid configuration');
    process.exit(1);
  }

  // 2. Test Database Connection
  const dbTest = await testConnection();
  if (!dbTest.connected) {
    logger.fatal({ error: dbTest.error }, '[Fatal] Database connection failed');
    process.exit(1);
  }
  logger.info({ serverTime: dbTest.serverTime }, '[MySQL] Connected successfully');

  // 3. Start Express Application
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // Mount API router
  app.use('/', createApiRouter());

  const server = app.listen(config.port, config.host, () => {
    logger.info(`[HTTP Server] Listening on http://${config.host}:${config.port}`);
  });

  // 4. Initialize Baileys Transport & Background Worker
  await transport.initialize();
  await worker.start();

  // 5. Graceful Termination Handlers
  async function gracefulShutdown(signal) {
    logger.info({ signal }, '[Shutdown] Received shutdown signal. Closing resources...');
    server.close();
    await worker.stop();
    await closePool();
    logger.info('[Shutdown] Clean exit complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[Bootstrap Error]', err);
  process.exit(1);
});
