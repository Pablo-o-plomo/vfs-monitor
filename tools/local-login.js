#!/usr/bin/env node
/**
 * tools/local-login.js — ручной вход через реальный Chrome
 *
 * Cloudflare Turnstile error 600010 = "Bot detected".
 * Решение: запускаем системный Google Chrome с persistent profile,
 * убираем все automation-флаги, скрываем navigator.webdriver.
 *
 * Использование:
 *   node tools/local-login.js [hun | deu | fra ...]
 *
 * Требуется DATABASE_URL в .env или как переменная окружения.
 * VFS_EMAIL — необязателен (для автозаполнения поля email).
 */

// dotenv опционален: если не установлен — используем env напрямую
try {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
} catch (_) {}

const path = require('path');

// Preflight: проверяем пакеты до старта браузера
const REQUIRED = ['playwright-extra', 'puppeteer-extra-plugin-stealth', 'pg'];
const missing = REQUIRED.filter(m => {
  try { require.resolve(m); return false; } catch (_) { return true; }
});
if (missing.length > 0) {
  console.error('\n\u274c Не установлены пакеты: ' + missing.join(', '));
  console.error('   Запустите: npm install');
  console.error('   Затем:     npx playwright install chromium\n');
  process.exit(1);
}

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Pool }      = require('pg');
const readline      = require('readline');

// Stealth активен — дополнительно скрывает признаки автоматизации
chromium.use(StealthPlugin());

const countryCode  = (process.argv[2] || 'hun').toLowerCase();
const LOGIN_URL    = `https://visa.vfsglobal.com/rus/ru/${countryCode}/login`;

// Persistent profile — браузер выглядит как обычный профиль пользователя
// (cookies, localStorage, history между запусками сохраняются)
const USER_DATA_DIR = path.join(__dirname, '../.local-profile');

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('\n\u274c DATABASE_URL не задан.');
    console.error('   Варианты:');
    console.error('   1. Создайте vfs-monitor/.env с DATABASE_URL=postgres://...');
    console.error('      и выполните: npm install  (для загрузки dotenv)');
    console.error('   2. DATABASE_URL=postgres://... node tools/local-login.js hun\n');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS vfs_sessions (
      id           SERIAL      PRIMARY KEY,
      country_code TEXT        NOT NULL DEFAULT 'hun',
      cookies_json TEXT        NOT NULL,
      saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      saved_by     TEXT        NOT NULL DEFAULT 'local'
    )
  `).catch(() => {});

  console.log('\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
  console.log('  Adria Travel \u2014 ручной вход в VFS Global');
  console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501');
  console.log(`  Страна:   ${countryCode.toUpperCase()}`);
  console.log(`  URL:      ${LOGIN_URL}`);
  console.log(`  Профиль:  ${USER_DATA_DIR}`);
  console.log('\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n');

  // ── Запуск Chrome ──────────────────────────────────────────────────────
  // channel: 'chrome' → системный Google Chrome (не bundled Chromium).
  // launchPersistentContext → сохраняет cookies/profile между запусками.
  // ignoreDefaultArgs: ['--enable-automation'] → убирает инфобар "Chrome управляется".
  // --disable-blink-features=AutomationControlled → скрывает флаг в JS.

  let context;
  try {
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      channel:  'chrome',                          // реальный Google Chrome
      ignoreDefaultArgs: ['--enable-automation'],  // убираем automation-бар
      args: [
        '--disable-blink-features=AutomationControlled',
        '--start-maximized',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport:  null,              // null = следует за размером окна
      locale:    'ru-RU',
      timezoneId: 'Europe/Moscow',
      extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' },
    });
  } catch (e) {
    if (/chrome|executable|not found/i.test(e.message)) {
      console.error('\n\u274c Google Chrome не найден в системе.');
      console.error('   Установите: https://www.google.com/chrome/');
      console.error('   Или задайте PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chrome\n');
    }
    throw e;
  }

  // Скрываем navigator.webdriver для всех страниц контекста
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    delete window.__playwright;
    delete window.__pwInitScripts;
  });

  const page = await context.newPage();

  console.log('\U0001f680 Открываю браузер...');
  await page.goto(LOGIN_URL).catch(() => {});

  // Предзаполняем email если VFS_EMAIL задан
  if (process.env.VFS_EMAIL) {
    const EMAIL_SEL =
      'input[type="email"], input[formcontrolname="email"], input[formcontrolname="userName"]';
    await page.waitForSelector(EMAIL_SEL, { state: 'attached', timeout: 15000 }).catch(() => {});
    try {
      await page.locator(EMAIL_SEL).first().fill(process.env.VFS_EMAIL);
      console.log(`\U0001f4e7 Email предзаполнен: ${process.env.VFS_EMAIL}`);
    } catch (_) {}
  }

  console.log('\n\U0001f4cb Что нужно сделать в браузере:');
  console.log('   1. Введите email и пароль VFS');
  console.log('   2. Пройдите Cloudflare Turnstile (галочка или задача)');
  console.log('   3. Нажмите кнопку "Войти"');
  console.log('   4. Дождитесь загрузки страницы /dashboard\n');
  console.log('\U0001f504 Ожидаю вход... (автосохранение при /dashboard)\n');

  let saved = false;

  // Автодетект: URL содержит /dashboard → сохраняем сессию
  const autoCheck = setInterval(async () => {
    try {
      if (!saved && page.url().includes('/dashboard')) {
        saved = true;
        clearInterval(autoCheck);
        console.log('\u2705 Вход обнаружен! Сохраняю сессию...');
        await saveCookies(context, pool, countryCode);
        await context.close();
        await pool.end();
        process.exit(0);
      }
    } catch (_) {}
  }, 800);

  // Резерв: ручное подтверждение через Enter
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Или нажмите Enter вручную после входа: ', async () => {
    rl.close();
    if (saved) return;
    clearInterval(autoCheck);
    saved = true;
    if (!page.url().includes('/dashboard')) {
      console.log(`\n\u26a0\ufe0f  Текущий URL: ${page.url()}`);
      console.log('   Сохраняю текущую сессию (убедитесь что вы на /dashboard)...\n');
    }
    await saveCookies(context, pool, countryCode);
    await context.close();
    await pool.end();
    process.exit(0);
  });
}

// ─────────────────────────────────────────────
// SAVE COOKIES
// ─────────────────────────────────────────────

async function saveCookies(context, pool, countryCode) {
  try {
    const cookies = await context.cookies();
    if (cookies.length === 0) {
      console.warn('\u26a0\ufe0f  Cookies пустые — возможно, вход не выполнен.');
      return;
    }

    const json = JSON.stringify(cookies);
    await pool.query(
      `INSERT INTO vfs_sessions (country_code, cookies_json, saved_at, saved_by)
       VALUES ($1, $2, NOW(), 'local')`,
      [countryCode, json],
    );
    await pool.query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3
       )`,
    );

    console.log(`\n\u2705 Сессия сохранена в БД (${cookies.length} cookies)`);
    console.log('   Railway worker подхватит её при следующей проверке.');
    console.log('   Нажмите "Запустить проверку" в админке.\n');
  } catch (e) {
    console.error('\u274c Ошибка сохранения сессии:', e.message);
  }
}

main().catch(e => {
  console.error('\n\u274c Ошибка:', e.message);
  process.exit(1);
});
