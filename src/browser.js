/**
 * browser.js — стелс-браузер на Playwright + stealth
 * Сохраняет и восстанавливает полный browser state:
 *   cookies + localStorage + sessionStorage
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs   = require('fs');
const path = require('path');
const logger = require('./logger');
const config = require('./config');

chromium.use(StealthPlugin());

let browser = null;
let context = null;

let _browserPid       = null;
let _browserStartedAt = null;
let _browserChecks    = 0;
let _openPages        = 0;

function getBrowserState() {
  const running = browser !== null &&
    (typeof browser.isConnected === 'function' ? browser.isConnected() : true);
  return { running, pid: _browserPid, pages: _openPages, checks: _browserChecks, started_at: _browserStartedAt };
}

function incrementBrowserChecks() { _browserChecks++; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function randomDelay(minMs = 800, maxMs = 2200) {
  return sleep(Math.floor(Math.random() * (maxMs - minMs) + minMs));
}

/**
 * Запустить браузер. Восстанавливает полный session state из БД.
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

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' },
  });

  try { _browserPid = browser.process()?.pid || null; } catch (_) { _browserPid = null; }

  await loadSession();
  logger.info('Браузер запущен (PID: ' + (_browserPid || '?') + ')');
}

/**
 * Сохранить полный browser state: cookies + localStorage + sessionStorage.
 * @param {import('playwright').Page|null} page — страница на VFS domain для извлечения storage.
 */
async function saveSession(page = null) {
  if (!context) return;
  const cookies     = await context.cookies();
  const cookiesJson = JSON.stringify(cookies, null, 2);

  let localStorageJson   = null;
  let sessionStorageJson = null;
  let userAgent          = null;
  let originUrl          = null;

  if (page) {
    try {
      const state = await page.evaluate(() => {
        const ls = {}, ss = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i); ls[k] = localStorage.getItem(k);
        }
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k);
        }
        return { ls, ss, ua: navigator.userAgent, url: location.href };
      });
      localStorageJson   = JSON.stringify(state.ls);
      sessionStorageJson = JSON.stringify(state.ss);
      userAgent  = state.ua;
      originUrl  = state.url;
      logger.info('Session storage extracted: localStorage=' + Object.keys(state.ls).length +
        ' keys, sessionStorage=' + Object.keys(state.ss).length + ' keys');
    } catch (e) {
      logger.warn('Could not extract localStorage/sessionStorage: ' + e.message);
    }
  }

  // File fallback
  try {
    fs.writeFileSync(config.worker.sessionFile, cookiesJson);
    logger.info('Session saved to file (' + cookies.length + ' cookies)');
  } catch (e) {
    logger.warn('Could not save session to file: ' + e.message);
  }

  // DB (primary shared storage between Railway web/worker)
  try {
    const { query } = require('./db');
    await query(
      `INSERT INTO vfs_sessions
         (country_code, cookies_json, local_storage_json, session_storage_json,
          user_agent, origin_url, saved_at, saved_by)
       VALUES ('hun', $1, $2, $3, $4, $5, NOW(), 'worker')`,
      [cookiesJson, localStorageJson, sessionStorageJson, userAgent, originUrl],
    );
    await query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3)`,
    );
    logger.info('Session saved to DB (' + cookies.length + ' cookies)');
  } catch (e) {
    logger.warn('Could not save session to DB: ' + e.message);
  }
}

/**
 * Загрузить полный browser state из БД.
 * localStorage/sessionStorage восстанавливаются через addInitScript:
 * выполняются ДО загрузки Angular на каждой странице VFS.
 */
async function loadSession() {
  let cookies            = null;
  let localStorageData   = null;
  let sessionStorageData = null;

  // From DB
  try {
    const { query } = require('./db');
    const { rows } = await query(
      `SELECT cookies_json, local_storage_json, session_storage_json, saved_at
       FROM vfs_sessions ORDER BY saved_at DESC LIMIT 1`,
    );
    if (rows.length > 0) {
      const row    = rows[0];
      cookies      = JSON.parse(row.cookies_json);
      const ageSec = Math.floor((Date.now() - new Date(row.saved_at).getTime()) / 1000);
      if (row.local_storage_json) {
        try { localStorageData   = JSON.parse(row.local_storage_json); }   catch (_) {}
      }
      if (row.session_storage_json) {
        try { sessionStorageData = JSON.parse(row.session_storage_json); } catch (_) {}
      }
      const lsKeys = localStorageData   ? Object.keys(localStorageData).length   : 0;
      const ssKeys = sessionStorageData ? Object.keys(sessionStorageData).length : 0;
      logger.info(
        'Session loaded from DB: ' + cookies.length + ' cookies, ' +
        'localStorage=' + lsKeys + ' keys, sessionStorage=' + ssKeys + ' keys, ' +
        'age=' + Math.floor(ageSec / 3600) + 'h'
      );
    }
  } catch (e) {
    logger.warn('Could not load session from DB: ' + e.message);
  }

  // File fallback (cookies only)
  if (!cookies) {
    const file = config.worker.sessionFile;
    if (fs.existsSync(file)) {
      try {
        cookies = JSON.parse(fs.readFileSync(file, 'utf-8'));
        logger.info('Session loaded from file (' + cookies.length + ' cookies)');
      } catch (e) {
        logger.warn('Could not load session from file: ' + e.message);
      }
    }
  }

  // Apply cookies
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies).catch(e => logger.warn('addCookies error: ' + e.message));
  }

  // Restore localStorage/sessionStorage via initScript (runs before Angular bootstrap)
  if (localStorageData || sessionStorageData) {
    const lsEntries = localStorageData   ? Object.entries(localStorageData)   : [];
    const ssEntries = sessionStorageData ? Object.entries(sessionStorageData) : [];

    await context.addInitScript(([ls, ss]) => {
      if (!location.hostname.includes('vfsglobal')) return;
      try {
        ls.forEach(([k, v]) => { try { localStorage.setItem(k, v); }   catch (_) {} });
        ss.forEach(([k, v]) => { try { sessionStorage.setItem(k, v); } catch (_) {} });
      } catch (_) {}
    }, [lsEntries, ssEntries]);

    logger.info(
      'localStorage (' + lsEntries.length + ' keys) and ' +
      'sessionStorage (' + ssEntries.length + ' keys) ' +
      'will be restored on every VFS page load'
    );
  }
}

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

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null; context = null; _browserPid = null; _browserStartedAt = null; _openPages = 0;
  }
}

module.exports = {
  launchBrowser, newPage, saveSession, loadSession,
  closeBrowser, randomDelay, sleep, getBrowserState, incrementBrowserChecks,
};
