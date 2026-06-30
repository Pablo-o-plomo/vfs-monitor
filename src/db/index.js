/**
 * src/db/index.js — pg Pool + migrate helper
 */

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  logger.error('pg pool error: ' + err.message);
});

/**
 * Выполнить SQL-запрос
 */
async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/**
 * Применить все миграции из папки /migrations
 * Простая стратегия: выполнить 001_init.sql если ещё не применялась
 */
async function migrate() {
  // Таблица-журнал миграций
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '../../migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rows } = await query('SELECT 1 FROM _migrations WHERE name = $1', [file]);
    if (rows.length > 0) {
      logger.info(`Migration already applied: ${file}`);
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    logger.info(`Applying migration: ${file}`);
    await query(sql);
    await query('INSERT INTO _migrations(name) VALUES($1)', [file]);
    logger.info(`Migration applied: ${file}`);
  }
}

module.exports = { pool, query, migrate };
