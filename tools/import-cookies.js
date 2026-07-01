#!/usr/bin/env node
/**
 * tools/import-cookies.js
 *
 * Импортирует cookies из обычного Chrome в PostgreSQL vfs_sessions.
 * Worker на Railway подхватит их при следующей проверке.
 *
 * ─── Инструкция ───────────────────────────────────────────────────
 *  1. Откройте обычный Chrome (НЕ Playwright — ваш личный браузер)
 *  2. Войдите на https://visa.vfsglobal.com/rus/ru/hun/login
 *  3. Установите расширение "Cookie-Editor" (Chrome Web Store)
 *     https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm
 *  4. Нажмите иконку расширения → Export → скопируйте JSON
 *     или: Export → Save as file → cookies-hun.json
 *  5. Запустите:
 *       node tools/import-cookies.js hun cookies-hun.json
 * ──────────────────────────────────────────────────────────────────
 *
 * Поддерживаемые форматы:
 *   - Cookie-Editor (JSON array)
 *   - EditThisCookie (JSON array)
 *   - Playwright storageState { cookies: [...] }
 *   - Plain Playwright cookies array (уже нормализованный)
 *
 * Использование:
 *   node tools/import-cookies.js [country_code] [cookies_file.json]
 *   node tools/import-cookies.js hun cookies-hun.json
 *   node tools/import-cookies.js deu ./export-deu.json
 */

try {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
} catch (_) {}

const fs   = require('fs');
const path = require('path');

// Preflight
if (!require('module')._resolveFilename && typeof require.resolve !== 'function') {
  console.error('Node.js resolve недоступен'); process.exit(1);
}
try { require.resolve('pg'); } catch (_) {
  console.error('\n❌ Пакет "pg" не установлен. Запустите: npm install\n');
  process.exit(1);
}

const { Pool } = require('pg');

// ─────────────────────────────────────────────
// ARGS
// ─────────────────────────────────────────────

const args        = process.argv.slice(2);
const countryCode = (args[0] || 'hun').toLowerCase();
const cookiesFile = args[1] || `cookies-${countryCode}.json`;

if (!process.env.DATABASE_URL) {
  console.error('\n❌ DATABASE_URL не задан.');
  console.error('   1. Добавьте в vfs-monitor/.env: DATABASE_URL=postgres://...');
  console.error('   2. Или передайте напрямую:');
  console.error('      DATABASE_URL=postgres://... node tools/import-cookies.js hun cookies.json\n');
  process.exit(1);
}

// ─────────────────────────────────────────────
// NORMALIZE sameSite
// ─────────────────────────────────────────────

function normalizeSameSite(val) {
  if (!val) return 'Lax';
  const v = String(val).toLowerCase();
  if (v === 'strict')         return 'Strict';
  if (v === 'none' || v === 'no_restriction') return 'None';
  // 'lax', 'unspecified', '' и всё остальное → Lax
  return 'Lax';
}

// ─────────────────────────────────────────────
// NORMALIZE одного cookie
// Поддерживаем:
//   Cookie-Editor: { name, value, domain, path, expirationDate, secure, httpOnly, sameSite, session }
//   EditThisCookie: то же самое + id, storeId
//   Playwright:    { name, value, domain, path, expires, secure, httpOnly, sameSite }
// ─────────────────────────────────────────────

function normalizeCookie(c) {
  // expires: Playwright ждёт Unix-timestamp (секунды) или -1 для сессионных
  let expires = -1;
  if (typeof c.expires === 'number' && c.expires > 0) {
    expires = c.expires;
  } else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) {
    expires = Math.floor(c.expirationDate);
  } else if (c.session === true || c.session === 'true') {
    expires = -1;
  }

  // domain: Playwright хочет начинать с точки для поддомена
  let domain = String(c.domain || '');
  if (domain && !domain.startsWith('.') && !domain.startsWith('www')) {
    // оставляем как есть — Playwright сам разберётся
  }

  return {
    name:     String(c.name  || ''),
    value:    String(c.value || ''),
    domain:   domain,
    path:     String(c.path  || '/'),
    expires:  expires,
    httpOnly: Boolean(c.httpOnly),
    secure:   Boolean(c.secure),
    sameSite: normalizeSameSite(c.sameSite),
  };
}

// ─────────────────────────────────────────────
// PARSE FILE — определяем формат и нормализуем
// ─────────────────────────────────────────────

function parseCookiesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ Файл не найден: ${filePath}`);
    console.error('   Убедитесь что путь правильный и файл существует.\n');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    console.error(`\n❌ Ошибка разбора JSON: ${e.message}`);
    console.error('   Файл должен быть валидным JSON (экспорт из Cookie-Editor).\n');
    process.exit(1);
  }

  let cookiesArr;

  // Формат 1: Playwright storageState { cookies: [...], origins: [] }
  if (raw && typeof raw === 'object' && Array.isArray(raw.cookies)) {
    console.log('ℹ️  Формат: Playwright storageState');
    cookiesArr = raw.cookies;
  }
  // Формат 2: массив cookies (Cookie-Editor, EditThisCookie, plain Playwright)
  else if (Array.isArray(raw)) {
    // Определяем источник по полям
    const sample = raw[0] || {};
    if ('expirationDate' in sample) {
      console.log('ℹ️  Формат: Cookie-Editor / EditThisCookie');
    } else if ('expires' in sample) {
      console.log('ℹ️  Формат: Playwright cookies array');
    } else {
      console.log('ℹ️  Формат: JSON array (неизвестный, пробуем нормализовать)');
    }
    cookiesArr = raw;
  }
  else {
    console.error('\n❌ Неподдерживаемый формат файла.');
    console.error('   Ожидается: JSON-массив cookies или { cookies: [...] }');
    console.error('   Экспортируйте через Cookie-Editor → Export → All.\n');
    process.exit(1);
  }

  if (cookiesArr.length === 0) {
    console.error('\n❌ Файл содержит 0 cookies.\n');
    process.exit(1);
  }

  return cookiesArr.map(normalizeCookie);
}

// ─────────────────────────────────────────────
// VALIDATE — есть ли VFS-cookies
// ─────────────────────────────────────────────

function validateVfsCookies(cookies) {
  const vfsCookies = cookies.filter(c =>
    c.domain && (
      c.domain.includes('vfsglobal.com') ||
      c.domain.includes('visa.vfsglobal')
    )
  );

  if (vfsCookies.length === 0) {
    console.warn('⚠️  Внимание: среди cookies нет ни одного от домена vfsglobal.com.');
    console.warn('   Убедитесь что вы экспортировали cookies с сайта visa.vfsglobal.com.');
    console.warn('   Импорт продолжается...\n');
  } else {
    console.log(`✅ Найдено ${vfsCookies.length} VFS-cookies (домен vfsglobal.com)`);
  }

  // Ищем признаки авторизации
  const authCookies = cookies.filter(c =>
    /auth|token|session|jwt|bearer|access/i.test(c.name)
  );
  if (authCookies.length > 0) {
    const names = authCookies.map(c => c.name).join(', ');
    console.log(`✅ Возможные auth-cookies: ${names}`);
  }

  return vfsCookies.length;
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Adria Travel — импорт cookies в Railway');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Страна:   ${countryCode.toUpperCase()}`);
  console.log(`  Файл:     ${path.resolve(cookiesFile)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Парсим файл
  console.log('\U0001f4c2 Читаем файл...');
  const cookies = parseCookiesFile(cookiesFile);
  console.log(`   Всего cookies в файле: ${cookies.length}`);

  // Валидируем
  validateVfsCookies(cookies);

  // Подключаемся к БД
  console.log('\n\U0001f5c4️  Сохраняем в PostgreSQL...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    // Создаём таблицу если нет
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vfs_sessions (
        id           SERIAL      PRIMARY KEY,
        country_code TEXT        NOT NULL DEFAULT 'hun',
        cookies_json TEXT        NOT NULL,
        saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        saved_by     TEXT        NOT NULL DEFAULT 'local'
      )
    `);

    const json = JSON.stringify(cookies);

    await pool.query(
      `INSERT INTO vfs_sessions (country_code, cookies_json, saved_at, saved_by)
       VALUES ($1, $2, NOW(), 'import')`,
      [countryCode, json],
    );

    // Держим только 3 последних сессии
    await pool.query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3
       )`,
    );

    // Показываем что сохранено
    const { rows } = await pool.query(
      `SELECT id, saved_at, saved_by FROM vfs_sessions
       WHERE country_code = $1 ORDER BY saved_at DESC LIMIT 3`,
      [countryCode],
    );

    console.log(`\n✅ Сохранено ${cookies.length} cookies в vfs_sessions (country=${countryCode})`);
    console.log('\n   Последние сессии в БД:');
    for (const r of rows) {
      const flag = r.id === rows[0].id ? ' ⬅ только что' : '';
      console.log(`   #${r.id}  ${new Date(r.saved_at).toLocaleString('ru-RU')}  (${r.saved_by})${flag}`);
    }

    console.log('\n\U0001f3af Готово! Следующие шаги:');
    console.log('   1. Откройте админку Railway');
    console.log(`   2. Найдите заявку для ${countryCode.toUpperCase()}`);
    console.log('   3. Нажмите "Проверить сейчас"');
    console.log('   4. Worker загрузит cookies из БД и войдёт уже авторизованным\n');

  } catch (e) {
    console.error(`\n❌ Ошибка БД: ${e.message}\n`);
    process.exit(1);
  } finally {
    await pool.end();
  }

  // Опциональная верификация: --verify / -v
  if (args.includes('--verify') || args.includes('-v')) {
    console.log('\n🔍 Запускаем верификацию сессии...');
    await verifyCookies(cookies, countryCode);
  } else {
    console.log('   💡 Для проверки сессии запустите с --verify:');
    console.log(`   node tools/import-cookies.js ${countryCode} ${cookiesFile} --verify\n`);
  }
}

// ─────────────────────────────────────────────
// VERIFY SESSION
// Открываем headless Chrome с импортированными cookies,
// переходим на /dashboard и проверяем кнопку Start New Booking.
// ─────────────────────────────────────────────

async function verifyCookies(cookies, countryCode) {
  try { require.resolve('playwright-extra'); } catch (_) {
    console.warn('⚠️  playwright-extra не установлен, верификация пропущена.');
    console.warn('   Запустите: npm install playwright-extra puppeteer-extra-plugin-stealth');
    return;
  }
  const { chromium } = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  const dashUrl = `https://visa.vfsglobal.com/rus/ru/${countryCode}/dashboard`;
  const START_BTN = [
    'button:has-text("Start New Booking")',
    'button:has-text("New Booking")',
    'button:has-text("Начать новое бронирование")',
    'button:has-text("Новое бронирование")',
    'button:has-text("Записаться на прием")',
    'button:has-text("Записаться на приём")',
    '[role="button"]:has-text("Записаться на прием")',
    '[role="button"]:has-text("Записаться на приём")',
    '[role="button"]:has-text("Start New Booking")',
  ].join(', ');

  console.log(`🌐 Открываю браузер → ${dashUrl}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'ru-RU',
    });
    await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});

    const finalUrl = page.url();
    console.log(`   URL: ${finalUrl}`);

    if (finalUrl.includes('/login')) {
      console.error('\n❌ Верификация ПРОВАЛЕНА: сессия невалидна (редирект на /login)');
      console.error('   Войдите в VFS вручную и экспортируйте cookies заново.\n');
      return;
    }

    const btnLoc = page.locator(START_BTN);
    const btnOk = await btnLoc.first().isVisible({ timeout: 10_000 }).catch(() => false);
    if (btnOk) {
      const btnText = await btnLoc.first().textContent({ timeout: 2000 }).catch(() => '');
      console.log('\n✅ Верификация УСПЕШНА!');
      console.log('   Dashboard подтвержден. Найдена кнопка: "' + (btnText || '').trim() + '"');
      console.log('   Сессия активна. Worker подхватит её при следующей проверке.\n');
    } else {
      const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 200)).catch(() => '');
      console.error('\n❌ Верификация ПРОВАЛЕНА: кнопка Start New Booking не найдена');
      console.error('   Body: ' + body.replace(/\s+/g, ' ').trim());
      console.error('   Войдите в VFS вручную и экспортируйте cookies заново.\n');
    }
  } catch (e) {
    console.error('⚠️  Ошибка верификации: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch(e => {
  console.error(`\n❌ Ошибка: ${e.message}\n`);
  process.exit(1);
});
