#!/usr/bin/env node
/**
 * tools/local-login.js
 *
 * Ручной вход в VFS Global для обхода Cloudflare Turnstile.
 * Открывает видимый браузер, ждёт ручного входа, затем сохраняет
 * cookies в Railway PostgreSQL. Worker потом использует эту сессию.
 *
 * Использование:
 *   node tools/local-login.js [код страны: hun / deu / fra ...]
 *
 * Требуется DATABASE_URL в .env (или как переменная окружения).
 * VFS_EMAIL и VFS_PASSWORD — необязательны (для автозаполнения).
 *
 * Пример:
 *   cd vfs-monitor
 *   node tools/local-login.js hun
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { Pool } = require('pg');
const readline = require('readline');

chromium.use(StealthPlugin());

const countryCode = (process.argv[2] || 'hun').toLowerCase();
const LOGIN_URL   = `https://visa.vfsglobal.com/rus/ru/${countryCode}/login`;

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('\n❌ DATABASE_URL не задан.');
    console.error('   Добавьте в .env файл или передайте как переменную:');
    console.error('   DATABASE_URL=postgres://... node tools/local-login.js\n');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Создаём таблицу если ещё нет
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vfs_sessions (
      id           SERIAL      PRIMARY KEY,
      country_code TEXT        NOT NULL DEFAULT 'hun',
      cookies_json TEXT        NOT NULL,
      saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      saved_by     TEXT        NOT NULL DEFAULT 'local'
    )
  `).catch(() => {});

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Adria Travel — ручной вход в VFS Global');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Страна:   ${countryCode.toUpperCase()}`);
  console.log(`  URL:      ${LOGIN_URL}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({
    headless: false,            // ВИДИМЫЙ браузер — обязательно!
    args: ['--start-maximized'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport:     null,         // null = следует за окном браузера
    locale:       'ru-RU',
    timezoneId:   'Europe/Moscow',
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' },
  });

  const page = await context.newPage();

  console.log('🚀 Открываю браузер...');
  await page.goto(LOGIN_URL).catch(() => {});

  // Пре-заполняем email если VFS_EMAIL задан (пользователь вводит пароль сам)
  if (process.env.VFS_EMAIL) {
    await page.waitForSelector('input[type="email"], input[formcontrolname="email"], input[formcontrolname="userName"]',
      { state: 'attached', timeout: 15000 }
    ).catch(() => {});
    try {
      const emailEl = page.locator('input[type="email"], input[formcontrolname="email"], input[formcontrolname="userName"]').first();
      await emailEl.fill(process.env.VFS_EMAIL);
      console.log(`📧 Email предзаполнен: ${process.env.VFS_EMAIL}`);
    } catch (_) {}
  }

  console.log('\n📋 Что нужно сделать в браузере:');
  console.log('   1. Введите email и пароль VFS');
  console.log('   2. Нажмите на галочку Cloudflare "Verify you are human"');
  console.log('   3. Нажмите кнопку "Войти"');
  console.log('   4. Дождитесь загрузки страницы /dashboard\n');
  console.log('🔄 Ожидаю вход... (автосохранение при переходе на /dashboard)\n');

  // Автодетект: как только URL содержит /dashboard — сохраняем
  let saved = false;
  const autoCheck = setInterval(async () => {
    try {
      const url = page.url();
      if (!saved && url.includes('/dashboard')) {
        saved = true;
        clearInterval(autoCheck);
        console.log('✅ Вход обнаружен! Сохраняю сессию...');
        await saveCookies(context, pool, countryCode);
        await browser.close();
        await pool.end();
        process.exit(0);
      }
    } catch (_) {}
  }, 800);

  // Резерв: нажатие Enter вручную
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Или нажмите Enter вручную после входа: ', async () => {
    rl.close();
    if (saved) return; // уже сохранили через autoCheck
    clearInterval(autoCheck);
    saved = true;
    const url = page.url();
    if (!url.includes('/dashboard')) {
      console.log(`\n⚠️  Текущий URL: ${url}`);
      console.log('   Убедитесь что вы на странице /dashboard. Сохраняю текущую сессию...\n');
    }
    await saveCookies(context, pool, countryCode);
    await browser.close();
    await pool.end();
    process.exit(0);
  });
}

async function saveCookies(context, pool, countryCode) {
  try {
    const cookies = await context.cookies();
    if (cookies.length === 0) {
      console.warn('⚠️  Cookies пустые — возможно, вход не выполнен.');
      return;
    }

    const json = JSON.stringify(cookies);
    await pool.query(
      `INSERT INTO vfs_sessions (country_code, cookies_json, saved_at, saved_by)
       VALUES ($1, $2, NOW(), 'local')`,
      [countryCode, json],
    );

    // Держим только 3 последних сессии
    await pool.query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3
       )`,
    );

    console.log(`\n✅ Сессия сохранена в БД (${cookies.length} cookies)`);
    console.log('   Railway worker подхватит её при следующей проверке.');
    console.log('   Нажмите кнопку "Запустить проверку" в админке.\n');
  } catch (e) {
    console.error('❌ Ошибка сохранения сессии:', e.message);
  }
}

main().catch(e => {
  console.error('\n❌ Ошибка:', e.message);
  process.exit(1);
});
