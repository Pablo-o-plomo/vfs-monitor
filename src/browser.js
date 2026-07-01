/**
 * browser.js — стелс-браузер на Playwright + stealth
 * Сохраняет и восстанавливает сессию (cookies) между запусками.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('./config');

// Подключаем stealth-плагин
chromium.use(StealthPlugin());

let browser = null;
let context = null;

// ─── Browser Pool State ───────────────────────────────────────────
let _browserPid       = null;
let _browserStartedAt = null;
let _browserChecks    = 0;
let _openPages        = 0;

/** Состояние browser pool для supervisor (читается из heartbeat) */
function getBrowserState() {
  const running = browser !== null &&
    (typeof browser.isConnected === 'function' ? browser.isConnected() : true);
  return {
    running,
    pid:        _browserPid,
    pages:      _openPages,
    checks:     _browserChecks,
    started_at: _browserStartedAt,
  };
}

/** Вызывается из worker после каждой успешной VFS-проверки */
function incrementBrowserChecks() {
  _browserChecks++;
}

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
  _browserStartedAt = new Date();
  _browserChecks    = 0;
  _openPages        = 0;

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

  // Запоминаем PID браузерного процесса
  try { _browserPid = browser.process()?.pid || null; } catch (_) { _browserPid = null; }

  // Восстанавливаем сессию, если есть
  await loadSession();

  logger.info('Браузер запущен (PID: ' + (_browserPid || '?') + ')');
}

/**
 * Сохранить cookies в БД (основное) + файл (резерв).
 * БД — shared storage между Railway web и worker контейнерами.
 */
async function saveSession() {
  if (!context) return;
  const cookies = await context.cookies();
  const json = JSON.stringify(cookies, null, 2);

  // Файл (резерв / локальное использование)
  try {
    fs.writeFileSync(config.worker.sessionFile, json);
    logger.info(`Сессия сохранена в файл (${cookies.length} cookies)`);
  } catch (e) {
    logger.warn('Не удалось сохранить сессию в файл: ' + e.message);
  }

  // БД (Railway: worker перезапускается, файл теряется → только БД надёжна)
  try {
    const { query } = require('./db');
    await query(
      `INSERT INTO vfs_sessions (country_code, cookies_json, saved_at, saved_by)
       VALUES ('hun', $1, NOW(), 'worker')`,
      [json],
    );
    // Держим только 3 последних сессии
    await query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3
       )`,
    );
    logger.info(`Сессия сохранена в БД`);
  } catch (e) {
    logger.warn('Не удалось сохранить сессию в БД: ' + e.message);
  }
}

/**
 * Загрузить cookies: сначала из БД (свежее), затем из файла.
 */
async function loadSession() {
  let cookies = null;

  // Пробуем БД
  try {
    const { query } = require('./db');
    const { rows } = await query(
      `SELECT cookies_json, saved_at FROM vfs_sessions
       ORDER BY saved_at DESC LIMIT 1`,
    );
    if (rows.length > 0) {
      cookies = JSON.parse(rows[0].cookies_json);
      const ageSec = Math.floor((Date.now() - new Date(rows[0].saved_at).getTime()) / 1000);
      logger.info('Сессия загружена из БД (' + cookies.length + ' cookies, возраст ' + Math.floor(ageSec/3600) + 'ч)');
    }
  } catch (e) {
    logger.warn('Не удалось загрузить сессию из БД: ' + e.message);
  }

  // Резерв: файл
  if (!cookies) {
    const file = config.worker.sessionFile;
    if (fs.existsSync(file)) {
      try {
        cookies = JSON.parse(fs.readFileSync(file, 'utf-8'));
        logger.info('Сессия загружена из файла (' + cookies.length + ' cookies)');
      } catch (e) {
        logger.warn('Не удалось загрузить сессию из файла: ' + e.message);
      }
    }
  }

  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies).catch(e =>
      logger.warn('addCookies error: ' + e.message)
    );
  }
}

/**
 * Открыть новую страницу в текущем контексте
 */
async function newPage() {
  if (!context) await launchBrowser();
  const page = await context.newPage();

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  _openPages++;
  page.on('close', () => { _openPages = Math.max(0, _openPages - 1); });

  return page;
}

/**
 * Закрыть браузер
 */
async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser           = null;
    context           = null;
    _browserPid       = null;
    _browserStartedAt = null;
    _openPages        = 0;
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
  getBrowserState,
  incrementBrowserChecks,
};
