/**
 * tools/export-session-snippet.js
 * ─────────────────────────────────────────────────────────────────
 * БРАУЗЕРНЫЙ СНИППЕТ — вставьте в консоль Chrome/Firefox
 * на странице https://visa.vfsglobal.com/rus/ru/hun/dashboard
 *
 * Экспортирует:
 *   - localStorage (токены Angular/VFS)
 *   - sessionStorage
 *   - document.cookie (не-httpOnly cookies)
 *   - navigator.userAgent
 *   - location.href
 *
 * Результат: файл vfs-state-hun.json (скачивается автоматически)
 *
 * ВАЖНО: httpOnly cookies (sessionId и т.п.) сюда НЕ попадают.
 * Для полного экспорта используйте Cookie-Editor совместно:
 *   1. Экспорт через этот сниппет → vfs-state-hun.json
 *   2. Экспорт через Cookie-Editor → cookies-hun.json
 *   3. node tools/import-cookies.js hun cookies-hun.json --state vfs-state-hun.json
 *
 * ─────────────────────────────────────────────────────────────────
 * КОД ДЛЯ КОНСОЛИ БРАУЗЕРА (скопируйте всё ниже):
 * ─────────────────────────────────────────────────────────────────
 */

(function exportVfsSession() {
  const COUNTRY = 'hun';

  // ── Собираем localStorage ─────────────────────────────────────
  const ls = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      ls[k] = localStorage.getItem(k);
    }
  } catch (e) { console.warn('localStorage read error:', e.message); }

  // ── Собираем sessionStorage ───────────────────────────────────
  const ss = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      ss[k] = sessionStorage.getItem(k);
    }
  } catch (e) { console.warn('sessionStorage read error:', e.message); }

  // ── Не-httpOnly cookies из document.cookie ────────────────────
  const docCookies = [];
  try {
    document.cookie.split(';').forEach(pair => {
      const idx = pair.indexOf('=');
      if (idx < 0) return;
      const name  = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      if (name) {
        docCookies.push({
          name, value,
          domain: location.hostname,
          path: '/',
          httpOnly: false,
          secure: location.protocol === 'https:',
          sameSite: 'Lax',
        });
      }
    });
  } catch (e) { console.warn('document.cookie read error:', e.message); }

  // ── Собираем state ─────────────────────────────────────────────
  const state = {
    version: 2,
    exportedAt: new Date().toISOString(),
    country: COUNTRY,
    location: location.href,
    userAgent: navigator.userAgent,
    cookies: docCookies,   // non-httpOnly only; merge with Cookie-Editor export for full set
    localStorage: ls,
    sessionStorage: ss,
  };

  // ── Скачиваем файл ─────────────────────────────────────────────
  const filename = `vfs-state-${COUNTRY}.json`;
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  // ── Итог в консоли ─────────────────────────────────────────────
  console.log('\n✅ VFS session state exported!');
  console.log(`   File:           ${filename}`);
  console.log(`   URL:            ${state.location}`);
  console.log(`   localStorage:   ${Object.keys(ls).length} keys`);
  console.log(`   sessionStorage: ${Object.keys(ss).length} keys`);
  console.log(`   cookies (js):   ${docCookies.length} (non-httpOnly only)`);
  console.log('\n   Далее:');
  console.log('   1. Экспортируйте httpOnly cookies через Cookie-Editor → cookies-hun.json');
  console.log('   2. node tools/import-cookies.js hun cookies-hun.json --state vfs-state-hun.json --verify');
})();
