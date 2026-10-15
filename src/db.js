import mysql from 'mysql2/promise';
import { config } from './config.js';
import { logger } from './logger.js';

let pool = null;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      queueLimit: 0,
      timezone: config.db.timezone,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });

    pool.on('error', (err) => {
      logger.error({ err }, '[MySQL Pool Error]');
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        pool = null;
      }
    });
  }
  return pool;
}

export async function testConnection() {
  try {
    const p = getPool();
    const [rows] = await p.query('SELECT 1 as connected, NOW() as server_time');
    return {
      connected: true,
      serverTime: rows[0].server_time
    };
  } catch (error) {
    logger.error({ error: error.message }, '[MySQL Connection Failed]');
    return {
      connected: false,
      error: error.message
    };
  }
}

export async function query(sql, params = []) {
  const p = getPool();
  return p.query(sql, params);
}

export async function execute(sql, params = []) {
  const p = getPool();
  return p.execute(sql, params);
}

export async function withTransaction(callback) {
  const p = getPool();
  const conn = await p.getConnection();
  try {
    await conn.beginTransaction();
    const result = await callback(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info('[MySQL Pool Closed Gracefully]');
  }
}
