/**
 * src/services/notifier.js — Telegram-уведомления с контекстом клиента
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../logger');

let bot = null;

function getBot() {
  if (!bot) bot = new TelegramBot(config.telegram.token);
  return bot;
}

async function send(text, chatId) {
  const target = chatId || config.telegram.chatId;
  try {
    await getBot().sendMessage(target, text, { parse_mode: 'HTML' });
  } catch (e) {
    logger.error(`[notifier] Ошибка Telegram (chat ${target}): ${e.message}`);
  }
}

/**
 * Уведомление о найденных слотах
 * @param {Object} ctx  — { client, request, slots }
 */
async function notifySlots({ client, request, slots }) {
  const bookUrl = `${config.vfs.baseUrl}/${request.country_code}/book-appointment`;

  const slotLines = slots.map((s) => {
    const time = s.time ? ` в <b>${s.time}</b>` : '';
    return `  📅 <b>${s.date}</b>${time}`;
  }).join('\n');

  const text = [
    `🟢 <b>Найдены свободные слоты!</b>`,
    ``,
    `👤 Клиент: <b>${client.name}</b>`,
    `🌍 Страна: ${request.country_name}`,
    `🏢 Центр: ${request.center}`,
    `📋 Категория: ${request.category} / ${request.subcategory}`,
    `📆 Период: ${request.date_from} — ${request.date_to}`,
    ``,
    slotLines,
    ``,
    `🔗 <a href="${bookUrl}">Записаться →</a>`,
    ``,
    `⏱ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
  ].join('\n');

  await send(text);
}

/**
 * Стартовое уведомление при запуске worker
 */
async function notifyWorkerStart(activeCount) {
  await send(
    `🤖 <b>Adria Monitor запущен</b>\n` +
    `Активных заявок: <b>${activeCount}</b>`
  );
}

/**
 * Уведомление о критической ошибке worker
 */
async function notifyError(message) {
  await send(`❌ <b>Monitor Error</b>\n<code>${message}</code>`);
}

module.exports = { send, notifySlots, notifyWorkerStart, notifyError };
