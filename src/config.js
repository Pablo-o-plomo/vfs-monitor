/**
 * src/config.js — только постоянные секреты из ENV
 * Параметры мониторинга хранятся в БД (visa_requests)
 */

require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Не задана переменная окружения: ${name}`);
  return val;
}

module.exports = {
  // PostgreSQL
  databaseUrl: required('DATABASE_URL'),

  // Telegram
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
  },

  // Учётная запись VFS Global (одна на всё агентство)
  vfs: {
    email:    required('VFS_EMAIL'),
    password: required('VFS_PASSWORD'),
    baseUrl:  'https://visa.vfsglobal.com/rus/ru',
  },

  // Web admin
  admin: {
    password: required('ADMIN_PASSWORD'),
    port: parseInt(process.env.PORT || '3000', 10),
  },

  // Worker
  worker: {
    pollIntervalMs:   parseInt(process.env.WORKER_POLL_MS    || '60000',  10), // как часто worker проверяет БД
    defaultIntervalMin: parseInt(process.env.DEFAULT_CHECK_MIN || '7',    10), // интервал VFS-проверки по умолчанию
    jitterMin:          parseInt(process.env.CHECK_JITTER_MIN  || '3',    10),
    sessionFile: process.env.SESSION_FILE || './session.json',
    dedupTtlMs:  parseInt(process.env.DEDUP_TTL_MS || String(60 * 60 * 1000), 10),
  },
};
