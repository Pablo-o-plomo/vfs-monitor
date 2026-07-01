/**
 * src/services/notifier.js — Telegram-уведомления
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
 *
 * @param {object} ctx
 * @param {object} ctx.client     — { name, phone }
 * @param {object} ctx.request    — поля из visa_requests
 * @param {Array}  ctx.slots      — найденные слоты [{ date, time }]
 * @param {number} ctx.requestId  — id заявки (для ссылки на панель)
 * @param {string} [ctx.chatId]   — переопределить chatId (для клиентского Telegram)
 */
async function notifySlots({ client, request, slots, requestId, chatId }) {
  const bookUrl = `${config.vfs.baseUrl}/${request.country_code}/book-appointment`;

  const slotLines = slots.map((s) => {
    const time = s.time ? ` в <b>${s.time}</b>` : '';
    return `  📅 <b>${s.date}</b>${time}`;
  }).join('\n');

  // Форматируем период (pg DATE → строка dd.mm.yyyy если ещё не строка)
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    const day = String(dt.getUTCDate()).padStart(2, '0');
    const mon = String(dt.getUTCMonth() + 1).padStart(2, '0');
    return `${day}.${mon}.${dt.getUTCFullYear()}`;
  };

  const phoneStr = client.phone ? `  📞 ${client.phone}` : '';
  const adminLink = config.publicUrl && requestId
    ? `\n🔗 <a href="${config.publicUrl}/requests/${requestId}">Открыть заявку →</a>`
    : '';

  const text = [
    `🟢 <b>Найдены свободные слоты!</b>`,
    ``,
    `👤 <b>${client.name}</b>${phoneStr}`,
    `🌍 ${request.country_name} — ${request.center}`,
    `📋 ${request.category} / ${request.subcategory}`,
    `📆 ${fmtDate(request.date_from)} — ${fmtDate(request.date_to)}`,
    ``,
    slotLines,
    ``,
    `🔗 <a href="${bookUrl}">Записаться на VFS →</a>${adminLink}`,
    ``,
    `⏱ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`,
  ].join('\n');

  // Основной чат (админ)
  if (!chatId) {
    await send(text, config.telegram.chatId);
  } else {
    // Клиентский чат — более короткое сообщение без admin-ссылки
    const clientText = [
      `🟢 <b>Нашли слот в визовый центр!</b>`,
      ``,
      `🌍 ${request.country_name} — ${request.center}`,
      `📋 ${request.category} / ${request.subcategory}`,
      ``,
      slotLines,
      ``,
      `🔗 <a href="${bookUrl}">Записаться →</a>`,
      ``,
      `⏱ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`,
    ].join('\n');
    await send(clientText, chatId);
  }
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

async function notifyBooked({ client, request, booking, requestId }) {
  const fmtDate = (d) => {
    if (!d) return '—';
    const dt = new Date(d);
    return `${String(dt.getUTCDate()).padStart(2,'0')}.${String(dt.getUTCMonth()+1).padStart(2,'0')}.${dt.getUTCFullYear()}`;
  };

  const refStr   = booking.ref  ? `\n🎫 Номер записи: <b>${booking.ref}</b>` : '';
  const timeStr  = booking.time ? ` в <b>${booking.time}</b>` : '';
  const phoneStr = client.phone ? `  📞 ${client.phone}` : '';
  const adminLink = config.publicUrl && requestId
    ? `\n🔗 <a href="${config.publicUrl}/requests/${requestId}">Открыть заявку →</a>` : '';

  const text = [
    `✅ <b>Запись оформлена автоматически!</b>`,
    ``,
    `👤 <b>${client.name}</b>${phoneStr}`,
    `🌍 ${request.country_name} — ${request.center}`,
    `📋 ${request.category} / ${request.subcategory}`,
    ``,
    `📅 Дата: <b>${fmtDate(booking.date)}</b>${timeStr}`,
    refStr,
    adminLink,
    ``,
    `⏱ ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК`,
  ].join('\n');

  await send(text, config.telegram.chatId);
  if (request.notify_client_telegram) await send(text, request.notify_client_telegram);
}

async function notifyBookingFailed({ client, request, slot, reason, requestId }) {
  const adminLink = config.publicUrl && requestId
    ? `\n🔗 <a href="${config.publicUrl}/requests/${requestId}">Открыть заявку →</a>` : '';

  const text = [
    `⚠️ <b>Слот найден, но автозапись не удалась</b>`,
    ``,
    `👤 <b>${client.name}</b>`,
    `🌍 ${request.country_name} — ${request.center}`,
    `📅 Слот: <b>${slot.date}</b>`,
    ``,
    `❌ Причина: <code>${String(reason).slice(0, 200)}</code>`,
    ``,
    `Запишитесь вручную на VFS.`,
    adminLink,
  ].join('\n');

  await send(text, config.telegram.chatId);
}

module.exports = { send, notifySlots, notifyWorkerStart, notifyError, notifyBooked, notifyBookingFailed };
