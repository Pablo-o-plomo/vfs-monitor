#!/usr/bin/env node
/**
 * tools/import-cookies.js
 *
 * Импортирует полный browser state VFS в PostgreSQL vfs_sessions.
 * Worker на Railway восстановит cookies + localStorage + sessionStorage.
 *
 * Инструкция (полный экспорт):
 *   1. Chrome → visa.vfsglobal.com/dashboard → F12 Console
 *      Вставьте содержимое tools/export-session-snippet.js → скачается vfs-state-hun.json
 *   2. Cookie-Editor → Export → cookies-hun.json
 *   3. node tools/import-cookies.js hun cookies-hun.json --state vfs-state-hun.json --verify
 *
 * Инструкция (только cookies):
 *   1. Cookie-Editor → cookies-hun.json
 *   2. node tools/import-cookies.js hun cookies-hun.json --verify
 */

try {
  require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
} catch (_) {}

const fs   = require('fs');
const path = require('path');

try { require.resolve('pg'); } catch (_) {
  console.error('\n❌ pkg "pg" not installed. Run: npm install\n'); process.exit(1);
}

const { Pool } = require('pg');

// ── ARGS ──────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const countryCode = (args[0] || 'hun').toLowerCase();
const cookiesFile = args[1] || `cookies-${countryCode}.json`;
const stateIdx    = args.indexOf('--state');
const stateFile   = stateIdx >= 0 ? args[stateIdx + 1] : null;

if (!process.env.DATABASE_URL) {
  console.error('\n❌ DATABASE_URL not set. Add to .env or prepend to command.\n');
  process.exit(1);
}

// ── NORMALIZE cookie ──────────────────────────────────────────────

function normalizeSameSite(val) {
  if (!val) return 'Lax';
  const v = String(val).toLowerCase();
  if (v === 'strict') return 'Strict';
  if (v === 'none' || v === 'no_restriction') return 'None';
  return 'Lax';
}

function normalizeCookie(c) {
  let expires = -1;
  if (typeof c.expires === 'number' && c.expires > 0)            expires = c.expires;
  else if (typeof c.expirationDate === 'number' && c.expirationDate > 0) expires = Math.floor(c.expirationDate);
  return {
    name:     String(c.name  || ''),
    value:    String(c.value || ''),
    domain:   String(c.domain || ''),
    path:     String(c.path  || '/'),
    expires,
    httpOnly: Boolean(c.httpOnly),
    secure:   Boolean(c.secure),
    sameSite: normalizeSameSite(c.sameSite),
  };
}

// ── PARSE cookies file ────────────────────────────────────────────

function parseCookiesFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ File not found: ${filePath}\n`); process.exit(1);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (e) { console.error(`\n❌ JSON error: ${e.message}\n`); process.exit(1); }

  // Format v2: export-session-snippet.js
  if (raw && typeof raw === 'object' && raw.version === 2 && raw.localStorage) {
    console.log('   Format: vfs-state v2 (localStorage + cookies)');
    return {
      cookies:        (raw.cookies || []).map(normalizeCookie),
      localStorage:   raw.localStorage   || {},
      sessionStorage: raw.sessionStorage || {},
      userAgent:      raw.userAgent      || null,
      originUrl:      raw.location       || null,
    };
  }
  // Playwright storageState
  if (raw && typeof raw === 'object' && Array.isArray(raw.cookies)) {
    console.log('   Format: Playwright storageState');
    return { cookies: raw.cookies.map(normalizeCookie), localStorage: {}, sessionStorage: {}, userAgent: null, originUrl: null };
  }
  // Cookie-Editor / plain array
  if (Array.isArray(raw)) {
    const sample = raw[0] || {};
    const fmt = 'expirationDate' in sample ? 'Cookie-Editor' : 'expires' in sample ? 'Playwright array' : 'JSON array';
    console.log(`   Format: ${fmt}`);
    return { cookies: raw.map(normalizeCookie), localStorage: {}, sessionStorage: {}, userAgent: null, originUrl: null };
  }

  console.error('\n❌ Unsupported format. Expected JSON array or { cookies: [...] }\n');
  process.exit(1);
}

// ── PARSE state file ──────────────────────────────────────────────

function parseStateFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`\n❌ State file not found: ${filePath}\n`); process.exit(1);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')); }
  catch (e) { console.error(`\n❌ JSON error in state file: ${e.message}\n`); process.exit(1); }
  return {
    localStorage:   raw.localStorage   || {},
    sessionStorage: raw.sessionStorage || {},
    userAgent:      raw.userAgent      || null,
    originUrl:      raw.location       || null,
    cookies:        Array.isArray(raw.cookies) ? raw.cookies.map(normalizeCookie) : [],
  };
}

// ── VALIDATE cookies ──────────────────────────────────────────────

function validateCookies(cookies) {
  const vfs = cookies.filter(c => c.domain && c.domain.includes('vfsglobal'));
  if (vfs.length === 0) {
    console.warn('   ⚠️  No vfsglobal.com cookies found — check export source');
  } else {
    console.log(`   ✅ VFS cookies: ${vfs.length} (domain vfsglobal.com)`);
  }
  const auth = cookies.filter(c => /auth|token|session|jwt|bearer|access/i.test(c.name));
  if (auth.length > 0) console.log(`   ✅ Auth cookies: ${auth.map(c => c.name).join(', ')}`);
}

// ── MAIN ──────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Adria Travel — import VFS session state');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Country: ${countryCode.toUpperCase()}`);
  console.log(`  Cookies: ${path.resolve(cookiesFile)}`);
  if (stateFile) console.log(`  State:   ${path.resolve(stateFile)}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('\U0001f4c2 Reading cookies file...');
  let { cookies, localStorage: ls, sessionStorage: ss, userAgent, originUrl } = parseCookiesFile(cookiesFile);
  console.log(`   Total cookies: ${cookies.length}`);
  validateCookies(cookies);

  if (stateFile) {
    console.log('\n\U0001f4c2 Reading state file (localStorage/sessionStorage)...');
    const sd = parseStateFile(stateFile);
    ls        = Object.assign({}, ls, sd.localStorage);
    ss        = Object.assign({}, ss, sd.sessionStorage);
    userAgent = sd.userAgent  || userAgent;
    originUrl = sd.originUrl  || originUrl;
    // add non-httpOnly cookies from snippet (skip duplicates)
    const existingNames = new Set(cookies.map(c => c.name));
    const extra = sd.cookies.filter(c => !existingNames.has(c.name));
    if (extra.length > 0) { cookies = cookies.concat(extra); console.log(`   +${extra.length} non-httpOnly cookies from state`); }
  }

  const lsKeys = Object.keys(ls).length;
  const ssKeys = Object.keys(ss).length;
  console.log(`\n   localStorage:   ${lsKeys} keys`);
  console.log(`   sessionStorage: ${ssKeys} keys`);
  if (userAgent) console.log(`   userAgent:      ${userAgent.slice(0, 70)}`);
  if (originUrl) console.log(`   origin:         ${originUrl}`);

  // ── Save to DB ────────────────────────────────────────────────
  console.log('\n\U0001f5c4️  Saving to PostgreSQL...');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vfs_sessions (
        id           SERIAL      PRIMARY KEY,
        country_code TEXT        NOT NULL DEFAULT 'hun',
        cookies_json TEXT        NOT NULL,
        saved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        saved_by     TEXT        NOT NULL DEFAULT 'local'
      )`);
    await pool.query(`ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS local_storage_json  TEXT`);
    await pool.query(`ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS session_storage_json TEXT`);
    await pool.query(`ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS user_agent           TEXT`);
    await pool.query(`ALTER TABLE vfs_sessions ADD COLUMN IF NOT EXISTS origin_url           TEXT`);

    const cookiesJson = JSON.stringify(cookies);
    const lsJson      = lsKeys > 0 ? JSON.stringify(ls) : null;
    const ssJson      = ssKeys > 0 ? JSON.stringify(ss) : null;

    await pool.query(
      `INSERT INTO vfs_sessions
         (country_code, cookies_json, local_storage_json, session_storage_json,
          user_agent, origin_url, saved_at, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6,NOW(),'import')`,
      [countryCode, cookiesJson, lsJson, ssJson, userAgent, originUrl],
    );
    await pool.query(
      `DELETE FROM vfs_sessions WHERE id NOT IN (
         SELECT id FROM vfs_sessions ORDER BY saved_at DESC LIMIT 3)`,
    );

    const { rows } = await pool.query(
      `SELECT id, saved_at, saved_by, local_storage_json IS NOT NULL AS has_ls
       FROM vfs_sessions WHERE country_code=$1 ORDER BY saved_at DESC LIMIT 3`,
      [countryCode],
    );

    console.log(`\n✅ Saved: ${cookies.length} cookies, localStorage=${lsKeys}, sessionStorage=${ssKeys}`);
    console.log('\n   Sessions in DB:');
    for (const r of rows) {
      const tag   = r.id === rows[0].id ? ' ⬅ just now' : '';
      const lsTag = r.has_ls ? ' [+localStorage]' : '';
      console.log(`   #${r.id}  ${new Date(r.saved_at).toLocaleString('ru-RU')}  (${r.saved_by})${lsTag}${tag}`);
    }
    console.log('\n\U0001f3af Done! Next steps:');
    console.log('   1. Open Railway admin panel');
    console.log(`   2. Find request for ${countryCode.toUpperCase()}`);
    console.log('   3. Click "Check now"');
    console.log('   4. Worker will load full state and proceed authorized\n');

  } catch (e) {
    console.error(`\n❌ DB error: ${e.message}\n`); process.exit(1);
  } finally {
    await pool.end();
  }

  if (args.includes('--verify') || args.includes('-v')) {
    console.log('\n\U0001f50d Running session verification...');
    await verifyCookies(cookies, ls, ss, countryCode);
  } else {
    const stateArg = stateFile ? ` --state ${stateFile}` : '';
    console.log(`   \U0001f4a1 Add --verify to check session: node tools/import-cookies.js ${countryCode} ${cookiesFile}${stateArg} --verify\n`);
  }
}

// ── VERIFY SESSION ────────────────────────────────────────────────

async function verifyCookies(cookies, localStorageData, sessionStorageData, countryCode) {
  try { require.resolve('playwright-extra'); } catch (_) {
    console.warn('⚠️  playwright-extra not installed, skipping verify.');
    console.warn('   Run: npm install playwright-extra puppeteer-extra-plugin-stealth');
    return;
  }
  const { chromium }  = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium.use(StealthPlugin());

  const dashUrl = `https://visa.vfsglobal.com/rus/ru/${countryCode}/dashboard`;
  const lsEntries = Object.entries(localStorageData   || {});
  const ssEntries = Object.entries(sessionStorageData || {});

  console.log(`\U0001f310 Opening headless Chrome -> ${dashUrl}`);
  if (lsEntries.length) console.log(`   Restoring localStorage: ${lsEntries.length} keys`);
  if (ssEntries.length) console.log(`   Restoring sessionStorage: ${ssEntries.length} keys`);

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      locale: 'ru-RU',
    });
    await ctx.addCookies(cookies);

    if (lsEntries.length || ssEntries.length) {
      await ctx.addInitScript(([ls, ss]) => {
        if (!location.hostname.includes('vfsglobal')) return;
        ls.forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (_) {} });
        ss.forEach(([k, v]) => { try { sessionStorage.setItem(k, v); } catch (_) {} });
      }, [lsEntries, ssEntries]);
    }

    const page = await ctx.newPage();
    await page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    const finalUrl = page.url();
    console.log(`   URL: ${finalUrl}`);

    if (finalUrl.includes('/login')) {
      console.error('\n❌ VERIFY FAILED: session invalid (redirected to /login)');
      console.error('   Re-login to VFS manually and re-export cookies.\n');
      return;
    }

    const AUTH_MARKERS = [
      'button:has-text("Записаться на прием")',
      'button:has-text("Записаться на приём")',
      'button:has-text("Start New Booking")',
      '[role="button"]:has-text("Записаться на прием")',
      'text="Выйти"', 'text="Logout"', 'text="Активная запись"',
    ].join(', ');

    await page.waitForSelector(AUTH_MARKERS, { timeout: 20_000 }).catch(() => {});

    const BOOKING_BTN = 'button:has-text("Записаться на прием"), button:has-text("Записаться на приём"), button:has-text("Start New Booking"), [role="button"]:has-text("Записаться на прием")';
    const btnLoc    = page.locator(BOOKING_BTN);
    const btnOk     = await btnLoc.first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasLogout = await page.locator('text="Выйти", text="Logout"').first().isVisible({ timeout: 2000 }).catch(() => false);

    if (btnOk) {
      const btnText = await btnLoc.first().textContent({ timeout: 2000 }).catch(() => '');
      console.log('\n✅ VERIFY SUCCESS!');
      console.log('   Dashboard confirmed. Found button: "' + (btnText || '').trim() + '"');
      console.log('   Session is active. Worker will use it on next check.\n');
    } else if (hasLogout) {
      console.log('\n✅ VERIFY SUCCESS!');
      console.log('   Dashboard confirmed via "Logout" marker.');
      console.log('   Session is active.\n');
    } else {
      const body = await page.evaluate(() => (document.body.innerText || '').slice(0, 300)).catch(() => '');
      console.error('\n❌ VERIFY FAILED: no auth markers found');
      console.error('   Body: ' + body.replace(/\s+/g, ' ').trim());
      console.error('   Re-login to VFS manually and re-export cookies.\n');
    }
  } catch (e) {
    console.error('⚠️  Verify error: ' + e.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main().catch(e => {
  console.error(`\n❌ Error: ${e.message}\n`); process.exit(1);
});
