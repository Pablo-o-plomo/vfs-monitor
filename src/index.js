/**
 * index.js — главный цикл мониторинга VFS Global
 *
 * Алгоритм:
 * 1. Проверяем слоты
 * 2. Если нашли новые — шлём в Telegram
 * 3. Ждём случайный интервал (intervalMin ± jitterMin)
 * 4. Повторяем
 *
 * Дедупликация: не отправляем повторное уведомление
 * об одном и том же слоте в течение DEDUP_TTL_MS.
 */

require('dotenv').config();

const { checkSlots } = require('./monitor');
const { notifySlots, notifyStart, notifyError } = require('./telegram');
const { closeBrowser, sleep } = require('./browser');
const logger = require('./logger');
const config = require('./config');

// Дедупликация: храним ключи найденных слотов с timestamp
const seenSlots = new Map();
const DEDUP_TTL_MS = 60 * 60 * 1000; // 1 час — после этого снова уведомляем

let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * Случайный интервал ожидания (в мс)
 */
function nextIntervalMs() {
  const base = config.monitor.intervalMin * 60 * 1000;
  const jitter = config.monitor.jitterMin * 60 * 1000;
  return base + (Math.random() * 2 - 1) * jitter;
}

/**
 * Фильтрует слоты, исключая уже отправленные недавно
 */
function filterNew(slots) {
  const now = Date.now();

  // Чистим устаревшие записи
  for (const [key, ts] of seenSlots.entries()) {
    if (now - ts > DEDUP_TTL_MS) seenSlots.delete(key);
  }

  return slots.filter((s) => {
    const key = `${s.date}|${s.time}`;
    if (seenSlots.has(key)) return false;
    seenSlots.set(key, now);
    return true;
  });
}

/**
 * Одна итерация проверки
 */
async function runCheck() {
  logger.info('── Начинаем проверку слотов ──────────────────');
  const slots = await checkSlots();

  if (slots.length === 0) {
    logger.info('Слотов нет');
    consecutiveErrors = 0;
    return;
  }

  logger.info(`Найдено слотов: ${slots.length}`);
  const newSlots = filterNew(slots);

  if (newSlots.length === 0) {
    logger.info('Все слоты уже были отправлены ранее');
    return;
  }

  logger.info(`Новых слотов для уведомления: ${newSlots.length}`);
  await notifySlots(newSlots);
  consecutiveErrors = 0;
}

/**
 * Главный цикл
 */
async function main() {
  logger.info('=== VFS Monitor стартует ===');
  await notifyStart();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runCheck();
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logger.error(`Ошибка проверки (#${consecutiveErrors}): ${err.message}`);

      // При серьёзных ошибках закрываем браузер, чтобы пересоздать сессию
      await closeBrowser().catch(() => {});

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        const msg = `Слишком много ошибок подряд (${consecutiveErrors}). Перезапуск через 10 мин.`;
        logger.error(msg);
        await notifyError(msg);
        await sleep(10 * 60 * 1000);
        consecutiveErrors = 0;
      }
    }

    const waitMs = nextIntervalMs();
    const waitMin = (waitMs / 60_000).toFixed(1);
    logger.info(`Следующая проверка через ${waitMin} мин`);
    await sleep(waitMs);
  }
}

// Корректное завершение при SIGINT / SIGTERM (PM2 stop)
async function shutdown() {
  logger.info('Завершение работы...');
  await closeBrowser().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection: ' + err?.message);
});

main().catch(async (err) => {
  logger.error('Критическая ошибка: ' + err.message);
  await notifyError(err.message).catch(() => {});
  await closeBrowser().catch(() => {});
  process.exit(1);
});
