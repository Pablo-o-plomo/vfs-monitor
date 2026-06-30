/**
 * browser.js — стелс-браузер на Playwright + stealth
 * Сохраняет и восстанавливает сессию (cookies) между запусками.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('./config');

// Подключаем stealth-плагин
chromium.use(StealthPlugin());

let browser = null;
let context = null;

/**
 * Человекоподобная задержка (мс)
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDelay(minMs = 800, maxMs = 2200) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs) + minMs));
}

/**
 * Запустить браузер и создать контекст.
 * Если есть сохранённая сессия — загружает cookies.
 */
async function launchBrowser() {
  if (browser) return;

  logger.info('Запуск браузера...');
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1366,768',
    ],
  });

  // Создаём контекст с реалистичными заголовками
  context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    extraHTTPHeaders: {
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });

  // Восстанавливаем сессию, если есть
  await loadSession();

  logger.info('Браузер запущен');
}

/**
 * Сохранить cookies текущего контекста в файл
 */
async function saveSession() {
  if (!context) return;
  const cookies = await context.cookies();
  fs.writeFileSync(config.monitor.sessionFile, JSON.stringify(cookies, null, 2));
  logger.info(`Сессия сохранена (${cookies.length} cookies)`);
}

/**
 * Загрузить cookies из файла в контекст
 */
async function loadSession() {
  const file = config.monitor.sessionFile;
  if (!fs.existsSync(file)) return;
  try {
    const cookies = JSON.parse(fs.readFileSync(file, 'utf-8'));
    await context.addCookies(cookies);
    logger.info(`Сессия загружена (${cookies.length} cookies)`);
  } catch (e) {
    logger.warn('Не удалось загрузить сессию: ' + e.message);
  }
}

/**
 * Открыть новую страницу в текущем контексте
 */
async function newPage() {
  if (!context) await launchBrowser();
  const page = await context.newPage();

  // Скрываем webdriver-флаги дополнительно
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  return page;
}

/**
 * Закрыть браузер
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
  }
}

module.exports = {
  launchBrowser,
  newPage,
  saveSession,
  loadSession,
  closeBrowser,
  randomDelay,
  sleep,
};
