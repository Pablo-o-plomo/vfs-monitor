require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Не задана переменная окружения: ${name}`);
  return val;
}

module.exports = {
  vfs: {
    baseUrl: 'https://visa.vfsglobal.com/rus/ru/hun',
    email: required('VFS_EMAIL'),
    password: required('VFS_PASSWORD'),
    center: process.env.VFS_CENTER || 'Краснодар',
    category: process.env.VFS_CATEGORY || 'Краткосрочные',
    subcategory: process.env.VFS_SUBCATEGORY || 'Туризм',
    dateFrom: process.env.DATE_FROM || '2026-07-01',
    dateTo: process.env.DATE_TO || '2026-08-31',
  },
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    chatId: required('TELEGRAM_CHAT_ID'),
  },
  monitor: {
    intervalMin: parseInt(process.env.CHECK_INTERVAL_MIN || '7', 10),
    jitterMin: parseInt(process.env.CHECK_INTERVAL_JITTER || '3', 10),
    sessionFile: process.env.SESSION_FILE || './session.json',
  },
};
