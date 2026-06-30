/**
 * telegram.js — отправка уведомлений в Telegram
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const logger = require('./logger');

let bot = null;

function getBot() {
  if (!bot) {
    bot = new TelegramBot(config.telegram.token);
  }
  return bot;
}

/**
 * Отправить сообщение в чат/канал
 */
async function send(text) {
  try {
    await getBot().sendMessage(config.telegram.chatId, text, { parse_mode: 'HTML' });
    logger.info('Telegram уведомление отправлено');
  } catch (e) {
    logger.error('Ошибка отправки в Telegram: ' + e.message);
  }
}

/**
 * Форматировать список слотов в читаемое сообщение
 */
function formatSlotsMessage(slots) {
  const bookUrl = config.vfs.baseUrl + '/book-appointment';

  const lines = slots.map((s) => {
    const dateStr = s.date || '—';
    const timeStr = s.time ? ` в <b>${s.time}</b>` : '';
    const centerStr = s.center ? ` (${s.center})` : '';
    return `📅 <b>${dateStr}</b>${timeStr}${centerStr}`;
  });

  return [
    '🟢 <b>Найдены свободные слоты VFS Global!</b>',
    '',
    ...lines,
    '',
    `🔗 <a href="${bookUrl}">Записаться сейчас →</a>`,
    '',
    `⏱ Проверено: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
  ].join('\n');
}

/**
 * Уведомить о найденных слотах
 */
async function notifySlots(slots) {
  const msg = formatSlotsMessage(slots);
  await send(msg);
}

/**
 * Уведомить о старте бота
 */
async function notifyStart() {
  await send(
    `🤖 <b>VFS Monitor запущен</b>\n` +
    `Визовый центр: ${config.vfs.center}\n` +
    `Диапазон: ${config.vfs.dateFrom} — ${config.vfs.dateTo}\n` +
    `Интервал проверки: ~${config.monitor.intervalMin} мин`
  );
}

/**
 * Уведомить об ошибке (критической)
 */
async function notifyError(errorMsg) {
  await send(`❌ <b>VFS Monitor: ошибка</b>\n<code>${errorMsg}</code>`);
}

module.exports = { send, notifySlots, notifyStart, notifyError };
