/**
 * src/utils.js — общие утилиты (используются в worker и web)
 */

/**
 * Ночное время МСК (UTC+3): 23:00–07:00
 * work_night=false → пропускаем проверки в этот период
 */
function isNightMsk() {
  const msk  = new Date(Date.now() + 3 * 3600 * 1000);
  const hour = msk.getUTCHours();
  return hour >= 23 || hour < 7;
}

/**
 * Секунды → человекочитаемая строка ("2д 3ч 14м", "45м 10с", "33с")
 */
function formatUptime(seconds) {
  const s   = Math.floor(seconds);
  const d   = Math.floor(s / 86400);
  const h   = Math.floor((s % 86400) / 3600);
  const m   = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м ${sec}с`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

module.exports = { isNightMsk, formatUptime };
