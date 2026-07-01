/**
 * src/services/vfs.js
 *
 * Логика мониторинга VFS Global.
 * Перенесена из src/monitor.js без изменений алгоритма.
 * Ключевое отличие: принимает объект params вместо чтения из ENV.
 *
 * params: {
 *   countryCode  string  — 'hun'
 *   center       string  — 'Краснодар'
 *   category     string  — 'Краткосрочные визы'
 *   subcategory  string  — 'Туризм'
 *   dateFrom     string  — '2026-07-01'
 *   dateTo       string  — '2026-08-31'
 * }
 *
 * Возвращает: Array<{ date, time, center }>
 */

const { newPage, saveSession, randomDelay, sleep } = require('../browser');
const { query } = require('../db');
const logger = require('../logger');
const config = require('../config');
const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// ЛОГИН
// ─────────────────────────────────────────────

// Симулируем движение мыши — Cloudflare Turnstile поведенческий:
// он снимает галочку "Verify you are human" сам, когда видит нормальное движение мыши.
// page.fill() не генерирует mouse events, поэтому нужны явные mouse.move().
async function simulateMouseNearWidget(page) {
  try {
    const vp = page.viewportSize() || { width: 1366, height: 768 };
    const W = vp.width;
    const H = vp.height;
    logger.info('[vfs] Симулируем движение мыши (Cloudflare поведенческая проверка)...');

    // Двигаем мышь по странице — форма + зона CF виджета (низ формы ~60-70% высоты)
    const moves = [
      { x: W * 0.40, y: H * 0.30 },
      { x: W * 0.50, y: H * 0.40 },
      { x: W * 0.42, y: H * 0.48 },
      { x: W * 0.38, y: H * 0.55 },  // зона CF виджета
      { x: W * 0.48, y: H * 0.58 },
      { x: W * 0.44, y: H * 0.62 },
      { x: W * 0.52, y: H * 0.56 },
      { x: W * 0.46, y: H * 0.50 },
    ];

    for (const pt of moves) {
      await page.mouse.move(
        Math.round(pt.x + (Math.random() - 0.5) * 40),
        Math.round(pt.y + (Math.random() - 0.5) * 25),
        { steps: 8 + Math.floor(Math.random() * 10) },
      );
      await sleep(120 + Math.random() * 250);
    }
  } catch (e) {
    logger.warn('[vfs] simulateMouseNearWidget error: ' + e.message);
  }
}

// Ждём пока кнопка "Войти" станет активной (CF Turnstile снял блокировку)
async function waitForSubmitEnabled(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const enabled = await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]');
      if (!btn) return false;
      return !btn.disabled && !btn.hasAttribute('disabled') &&
             !btn.classList.contains('mat-button-disabled');
    }).catch(() => false);

    if (enabled) {
      logger.info('[vfs] Кнопка "Войти" активна — Turnstile решён');
      return true;
    }
    await sleep(600);
  }
  logger.warn('[vfs] Turnstile не решён за ' + (timeoutMs / 1000) + 'с, продолжаем...');
  return false;
}

async function login(page, baseUrl) {
  logger.info('[vfs] Переходим на страницу входа...');
  // networkidle ждёт когда Angular закончит рендер формы
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle', timeout: 60_000 })
    .catch(() => {}); // networkidle может не дождаться — продолжаем
  await randomDelay(2000, 3500);

  if (page.url().includes('/dashboard')) {
    logger.info('[vfs] Уже авторизованы (сессия активна)');
    return;
  }

  // Ждём email-поле в DOM (state:'attached' — не требует видимости в понимании Playwright,
  // нужно т.к. Angular + CF Turnstile могут держать форму с opacity:0/pointer-events:none)
  const EMAIL_SEL = [
    '#mat-input-0',                            // Angular mat-input — точный ID (надёжнее attr)
    'input[type="email"]',
    'input[name="email"]',
    'input[formcontrolname="email"]',
    'input[formcontrolname="userName"]',
    'input[placeholder*="email" i]',
  ].join(', ');

  await page.waitForSelector(EMAIL_SEL, { state: 'attached', timeout: 30_000 });

  // Небольшое движение мыши пока форма грузится — CF начинает анализ сразу
  await simulateMouseNearWidget(page);

  const emailInput = page.locator(EMAIL_SEL).first();
  await randomDelay(400, 800);
  await emailInput.click({ force: true });
  await randomDelay(300, 600);
  await emailInput.fill(config.vfs.email, { force: true });
  await randomDelay(500, 1000);

  const passwordInput = page.locator('#mat-input-1, input[type="password"]').first();
  await passwordInput.click({ force: true });
  await randomDelay(300, 700);
  await passwordInput.fill(config.vfs.password, { force: true });
  await randomDelay(600, 1000);

  // Ещё одна серия движений мыши — CF должен увидеть поведение и активировать кнопку
  await simulateMouseNearWidget(page);

  // Ждём пока CF Turnstile активирует кнопку «Войти» (до 15 сек)
  const cfSolved = await waitForSubmitEnabled(page, 15000);
  if (!cfSolved) {
    const cfErr = new Error(
      'CF_TURNSTILE: Cloudflare Turnstile не активировал кнопку за 15 сек. ' +
      'Запустите tools/local-login.js для ручного входа.'
    );
    cfErr.isCfTurnstile = true;
    throw cfErr;
  }
  await randomDelay(500, 1000);

  const submitBtn = page.locator(
    'button[type="submit"], button:has-text("Войти"), button:has-text("Sign In")'
  ).first();
  await submitBtn.click({ force: true });

  // Ждём: либо редирект на /dashboard, либо кнопку "Start New Booking"
  // (оба признака = успешный вход)
  const START_BTN_LOGIN_SEL = [
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

  await Promise.race([
    page.waitForURL('**/dashboard**', { timeout: 30_000 }),
    page.waitForSelector(START_BTN_LOGIN_SEL, { timeout: 30_000 }),
  ]).catch(() => {});
  await randomDelay(1000, 2000);

  const onDashboard = page.url().includes('/dashboard');
  const startBtnAfterLogin = await page.locator(START_BTN_LOGIN_SEL)
    .isVisible({ timeout: 2000 }).catch(() => false);

  if (onDashboard || startBtnAfterLogin) {
    logger.info('[vfs] Успешный вход (dashboard=' + onDashboard + ', startBtn=' + startBtnAfterLogin + ')');
    await saveSession();
    return;
  }

  // Не попали на dashboard — CF или другая проблема, но НЕ неверный пароль
  throw new Error(
    'Не удалось войти в VFS Global (не открылся /dashboard). ' +
    'Возможно, Cloudflare заблокировал вход. Запустите tools/import-cookies.js.'
  );
}


// ─────────────────────────────────────────────
// ДИАГНОСТИКА СЕССИИ
// ─────────────────────────────────────────────

/** Логирует краткую информацию о загруженных cookies */
async function logCookieInfo(page) {
  try {
    const cookies = await page.context().cookies().catch(() => []);
    if (cookies.length === 0) {
      logger.info('[vfs] Cookies: нет загруженных cookies');
      return;
    }
    const vfsCookies = cookies.filter(c => c.domain && c.domain.includes('vfsglobal'));
    const now = Math.floor(Date.now() / 1000);
    const expired = vfsCookies.filter(c => c.expires > 0 && c.expires < now).length;
    const domains = [...new Set(cookies.map(c => c.domain).filter(Boolean))].slice(0, 5).join(', ');
    logger.info(
      '[vfs] Cookies загружено: ' + cookies.length +
      ' всего, ' + vfsCookies.length + ' VFS, ' + expired + ' истекших. Домены: ' + domains
    );
  } catch (e) {
    logger.warn('[vfs] logCookieInfo error: ' + e.message);
  }
}

/** Универсальный селектор кнопки записи VFS (EN + RU + role=button) */
const BOOKING_BTN_SEL = [
  'button:has-text("Start New Booking")',
  'button:has-text("New Booking")',
  'button:has-text("Начать новое бронирование")',
  'button:has-text("Новое бронирование")',
  'button:has-text("Записаться на прием")',
  'button:has-text("Записаться на приём")',
  '[role="button"]:has-text("Записаться на прием")',
  '[role="button"]:has-text("Записаться на приём")',
  '[role="button"]:has-text("Start New Booking")',
  '[role="button"]:has-text("New Booking")',
].join(', ');

/**
 * Проверяет что сессия VFS реально активна.
 * Ждёт загрузки Angular (SPA) — сначала domcontentloaded, потом networkidle,
 * затем ждёт один из маркеров аутентифицированного дашборда.
 * Возвращает: { ok: boolean, btnText: string|null }
 */
async function verifySession(page) {
  try {
    // Шаг 1: ждём базовую отрисовку DOM
    await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    // Шаг 2: даём Angular время выполнить bootstrap (SPA не виден до JS)
    await page.waitForTimeout(5000);
    // Шаг 3: ждём networkidle (могут быть XHR-запросы от Angular)
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    logger.info('[vfs] Dashboard Angular loaded. URL: ' + page.url());

    // Если Angular переключил на /login — сессия мертва
    if (page.url().includes('/login')) {
      logger.warn('[vfs] После загрузки Angular — редирект на /login');
      return { ok: false, btnText: null };
    }

    // Шаг 4: ждём один из признаков аутентифицированного дашборда (таймаут 20 с)
    const AUTH_MARKERS = [
      // кнопка записи (EN + RU)
      BOOKING_BTN_SEL,
      // навигационные маркеры — присутствуют на любой странице после входа
      'text="Выйти"',
      'text="Logout"',
      'text="Sign Out"',
      // контентные маркеры
      'text="Активная запись"',
      'text="Active Booking"',
    ].join(', ');

    await page.waitForSelector(AUTH_MARKERS, { timeout: 20_000 })
      .catch(() => {});

    // Шаг 5: оцениваем результат
    // 5a. Есть кнопка записи — идеально
    const loc = page.locator(BOOKING_BTN_SEL);
    const btnVisible = await loc.first().isVisible({ timeout: 3000 }).catch(() => false);
    if (btnVisible) {
      const btnText = await loc.first().textContent({ timeout: 2000 }).catch(() => '');
      logger.info('[vfs] Dashboard подтвержден. Найдена кнопка: "' + (btnText || '').trim() + '"');
      return { ok: true, btnText: (btnText || '').trim() };
    }

    // 5b. Кнопки записи нет, но есть Выйти / Активная запись — сессия валидна
    const hasLogout = await page.locator('text="Выйти", text="Logout", text="Sign Out"')
      .first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasActiveBooking = await page.locator('text="Активная запись", text="Active Booking"')
      .first().isVisible({ timeout: 2000 }).catch(() => false);

    if (hasLogout || hasActiveBooking) {
      const marker = hasActiveBooking ? 'Активная запись' : 'Выйти';
      logger.info('[vfs] Dashboard подтвержден по маркеру: "' + marker + '" (кнопки записи нет)');
      return { ok: true, btnText: null };
    }

    // 5c. Ничего не нашли — логируем диагностику
    const bodyText = await page.evaluate(
      () => (document.body.innerText || document.body.textContent || '').slice(0, 400)
    ).catch(() => '');
    logger.warn('[vfs] Маркеры аутентификации НЕ найдены. URL: ' + page.url());
    logger.warn('[vfs] Body (400 символов): ' + bodyText.replace(/\s+/g, ' ').trim());
    return { ok: false, btnText: null };
  } catch (e) {
    logger.warn('[vfs] verifySession error: ' + e.message);
    return { ok: false, btnText: null };
  }
}

// ─────────────────────────────────────────────
// ДИАГНОСТИКА ОШИБОК — СОХРАНЕНИЕ АРТЕФАКТОВ
// ─────────────────────────────────────────────

async function saveErrorArtifacts(page, requestId) {
  if (!page || !requestId) return null;
  try {
    const dir = path.join(process.cwd(), 'artifacts', `request_${requestId}`);
    fs.mkdirSync(dir, { recursive: true });

    const screenshotPath = path.join(dir, 'last-error.png');
    await page.screenshot({ path: screenshotPath, fullPage: true })
      .catch(e => logger.warn('[vfs] screenshot failed: ' + e.message));

    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(path.join(dir, 'last-error.html'), html, 'utf-8');

    const url   = page.url();
    const title = await page.title().catch(() => '');
    logger.info(`[vfs] Артефакты ошибки сохранены: ${dir}`);
    return { url, title };
  } catch (e) {
    logger.warn('[vfs] Не удалось сохранить артефакты ошибки: ' + e.message);
    return null;
  }
}

// ─────────────────────────────────────────────
// МИНИ-БРАУЗЕР — polling screenshot для admin panel
// ─────────────────────────────────────────────

async function startLiveScreenshot(page, requestId) {
  if (!requestId) return null;

  let firstFrame = true;
  let frameCount = 0;

  logger.info(`[live] Запуск live-screenshot polling (700ms, requestId=${requestId})`);

  const interval = setInterval(async () => {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, fullPage: false });
      const b64 = buf.toString('base64');

      await query(
        `UPDATE monitoring_jobs
           SET live_frame     = $1,
               live_frame_url = $2,
               live_frame_at  = NOW()
         WHERE request_id = $3`,
        [b64, page.url(), requestId],
      );

      frameCount++;
      if (firstFrame) {
        logger.info(`[live] Первый кадр записан в БД (requestId=${requestId})`);
        firstFrame = false;
      }
    } catch (e) {
      logger.warn(`[live] Ошибка записи кадра: ${e.message}`);
    }
  }, 700);

  // Возвращаем stop-функцию (последний кадр остаётся в БД)
  return function stopLiveScreenshot() {
    clearInterval(interval);
    logger.info(`[live] Live-screenshot остановлен (кадров записано: ${frameCount})`);
  };
}

// ─────────────────────────────────────────────
// ГЛАВНАЯ ФУНКЦИЯ — принимает params из БД
// ─────────────────────────────────────────────

async function checkSlots(params, onStage = null) {
  const {
    requestId,
    countryCode = 'hun',
    countryName,
    center,
    category,
    subcategory,
    dateFrom,
    dateTo,
  } = params;

  const baseUrl = `${config.vfs.baseUrl}/${countryCode}`;
  const loginUrl = `${baseUrl}/dashboard`;

  const page = await newPage();
  const capturedSlots = [];
  let apiCaptured = false;

  // Запускаем live-screenshot polling для admin panel (мини-браузер)
  const stopLiveScreenshot = await startLiveScreenshot(page, requestId);

  // Перехватываем JSON-ответы с доступностью слотов
  page.on('response', async (response) => {
    const url = response.url();
    if (
      (url.includes('slot') || url.includes('appointment') || url.includes('schedule')) &&
      response.status() === 200
    ) {
      try {
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const body = await response.json();
        const slots = parseApiSlots(body);
        if (slots.length > 0) {
          capturedSlots.push(...slots);
          apiCaptured = true;
          logger.info(`[vfs] API перехват: ${slots.length} слотов`);
        }
      } catch (_) { /* не JSON */ }
    }
  });

  try {
    // ── 1. Логин / проверка сессии ───────────────────────────────────
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await randomDelay(1500, 2500);

    // Логируем состояние cookies ПЕРЕД проверкой сессии
    await logCookieInfo(page);
    logger.info('[vfs] URL после goto dashboard: ' + page.url());

    // Cookies из БД загружены в browser context (browser.js loadSession).
    // Если VFS всё равно редиректит на /login — cookies невалидны или неполны.
    // Автологин через Playwright ОТКЛЮЧЁН (CF Turnstile блокирует).
    // Единственный выход — импортировать свежие cookies вручную.
    if (page.url().includes('/login')) {
      logger.warn('[vfs] Редирект на /login после загрузки cookies — сессия невалидна');
      const err = new Error(
        'SESSION_INVALID: cookies ведут на /login — сессия истекла или неполна. ' +
        'Экспортируйте cookies из браузера через Cookie-Editor и запустите: ' +
        'node tools/import-cookies.js hun cookies-hun.json'
      );
      err.isSessionInvalid = true;
      throw err;
    }

    // На /dashboard — проверяем реальную кнопку записи (VFS может вернуть shell без auth)
    const { ok: sessionOk } = await verifySession(page);
    if (sessionOk) {
      if (onStage) await onStage('login', 'Сессия активна');
    } else {
      logger.warn('[vfs] Страница /dashboard, но кнопка записи не найдена — сессия нерабочая');
      const err = new Error(
        'SESSION_INVALID: VFS открыл /dashboard, но кнопка записи отсутствует — ' +
        'сессия истекла или неполна. ' +
        'Экспортируйте cookies из браузера через Cookie-Editor и запустите: ' +
        'node tools/import-cookies.js hun cookies-hun.json'
      );
      err.isSessionInvalid = true;
      throw err;
    }

    if (onStage) await onStage('checking_slots', 'Переходим к форме записи');

    // ── 2. Переход к форме записи через UI-кнопку (не прямой URL) ────────────
    // VFS отдаёт 403201 при прямом goto('/book-appointment').
    // Правильный путь: кликнуть "Start New Booking" на dashboard, как это делает пользователь.
    await randomDelay(2000, 3500);

    // BOOKING_BTN_SEL определён выше (глобальная константа модуля)
    const startBtnLoc = page.locator(BOOKING_BTN_SEL).first();
    const startBtnOk  = await startBtnLoc.isVisible({ timeout: 10_000 }).catch(() => false);

    if (startBtnOk) {
      const btnLabel = await startBtnLoc.textContent({ timeout: 2000 }).catch(() => '');
      logger.info('[vfs] Dashboard подтвержден. Найдена кнопка: "' + (btnLabel || '').trim() + '"');
      logger.info('[vfs] Переход к форме записи через UI-кнопку');
      await startBtnLoc.click();
      await randomDelay(1500, 2500);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    } else {
      // Fallback: прямой URL (если кнопка не найдена — нестандартная локаль)
      logger.warn('[vfs] Кнопка записи не найдена — fallback: прямой URL /book-appointment');
      await page.goto(`${baseUrl}/book-appointment`, { waitUntil: 'networkidle', timeout: 60_000 });

      // Проверяем 403201 при прямом переходе
      const bodyAfterGoto = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (bodyAfterGoto.includes('"code"') && bodyAfterGoto.includes('403')) {
        logger.warn('[vfs] book-appointment вернул JSON 403201 — session invalid');
        logger.warn('[vfs] Body: ' + bodyAfterGoto.slice(0, 300));
        const err = new Error(
          'SESSION_INVALID: book-appointment ответил 403201 — сессия истекла. ' +
          'Import cookies: node tools/import-cookies.js hun cookies-hun.json'
        );
        err.isSessionInvalid = true;
        throw err;
      }
    }

    // Если после клика по кнопке VFS вернул /login — сессия истекла на сервере
    if (page.url().includes('/login')) {
      logger.warn('[vfs] Редирект на /login после клика на кнопку записи — сессия истекла');
      const err = new Error(
        'SESSION_INVALID: VFS вернул /login после перехода к форме записи — ' +
        'сессия истекла. Экспортируйте cookies через Cookie-Editor: ' +
        'node tools/import-cookies.js hun cookies-hun.json'
      );
      err.isSessionInvalid = true;
      throw err;
    }

    logger.info(`[vfs] Форма записи: ${page.url()}`);

    // Ждём пока Angular отрисует mat-select
    await page.waitForSelector('mat-select, select', { timeout: 15_000 })
      .catch(() => logger.warn('[vfs] mat-select не появился — форма может не загрузиться'));
    await randomDelay(1000, 2000);

    // ── 3. Выбор страны и центра ─────────────────────────────────────
    // Плейсхолдеры VFS: "Выберите приложения своего Центра" / "Выберите запись" / "Выберите подкатегорию"
    // selectDropdownByText падает на первый mat-select если плейсхолдер не найден — это корректно,
    // т.к. дропдауны идут в нужном порядке на странице
    logger.info(`[vfs] Выбираем центр: ${center}`);
    if (onStage) await onStage('selecting_country', `Выбрана страна: ${countryName || countryCode.toUpperCase()}`);
    await selectDropdownByText(page, center, 'Выберите приложения своего Центра');
    await randomDelay(800, 1500);

    if (onStage) await onStage('selecting_center', `Выбран центр: ${center}`);

    // ── 4. Категория ──────────────────────────────────────────────────
    logger.info(`[vfs] Выбираем категорию: ${category}`);
    await selectDropdownByText(page, category, 'Выберите запись');
    await randomDelay(600, 1200);

    // ── 5. Подкатегория ───────────────────────────────────────────────
    logger.info(`[vfs] Выбираем подкатегорию: ${subcategory}`);
    if (onStage) await onStage('selecting_category', `Выбрана категория: ${subcategory}`);
    await selectDropdownByText(page, subcategory, 'Выберите подкатегорию');

    // Ждём появления баннера слота или сообщения «нет слотов» от VFS
    // Angular обновляет DOM асинхронно, случайной задержки недостаточно
    await page.waitForFunction(
      () => {
        const t = document.body.innerText || '';
        return t.includes('Ближайший доступный слот') ||
               t.includes('Nearest available slot') ||
               t.includes('нет доступных слотов') ||
               t.includes('No available slots');
      },
      { timeout: 8000 }
    ).catch(() => {}); // если баннер не появился — продолжаем
    await randomDelay(500, 1000);

    // ── 5а. div.alert — детекция слотов (как в vfs-appointment-bot) ──────────
    // После выбора подкатегории VFS рендерит alert-блок с ближайшей датой
    const alertSlots = await parseAlertSlots(page, dateFrom, dateTo, onStage);
    if (alertSlots.length > 0) {
      logger.info('[vfs] Слоты найдены через div.alert');
      if (params.autoBook) {
        logger.info('[vfs] auto_book=true → запускаем автобронирование');
        const booking = await attemptBooking(page, params, alertSlots[0].date, onStage);
        return { slots: alertSlots, booking };
      }
      return { slots: alertSlots, booking: null };
    }

    // ── 5б. Баннер «Ближайший доступный слот» ────────────────────────
    // VFS показывает текст вида:
    // "Ближайший доступный слот для 1 заявителя: 30.07.2026"
    const bannerSlots = await parseEarliestSlotBanner(page, dateFrom, dateTo, onStage);
    if (bannerSlots.length > 0) {
      logger.info('[vfs] Слот найден через баннер');

      if (params.autoBook) {
        logger.info('[vfs] auto_book=true → запускаем автобронирование');
        const booking = await attemptBooking(page, params, bannerSlots[0].date, onStage);
        return { slots: bannerSlots, booking };
      }

      logger.info('[vfs] auto_book=false → только уведомление');
      return { slots: bannerSlots, booking: null };
    }

    // ── 6. Ранняя проверка «нет слотов» ──────────────────────────────
    const noSlotsEl = await page.$('text=нет доступных слотов');
    if (noSlotsEl) {
      logger.info('[vfs] Слотов нет (сообщение на шаге выбора)');
      const earlyUrl = page.url(); const earlyTitle = await page.title().catch(() => '');
      return { slots: [], booking: null, pageUrl: earlyUrl, pageTitle: earlyTitle };
    }

    // ── 7. Продолжить ─────────────────────────────────────────────────
    const continueBtn = page.locator(
      'button:has-text("Продолжить"), button:has-text("Continue")'
    ).first();
    if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continueBtn.click();
      await randomDelay(1500, 2500);
    }

    // ── 8. Заявитель (данные из заявки, если форма появилась) ────────
    await fillApplicantIfNeeded(page, params);

    // ── 9. Ждём календарь ────────────────────────────────────────────
    logger.info('[vfs] Ждём календарь...');
    if (onStage) await onStage('calendar_waiting', 'Ожидаем загрузку календаря');
    await page
      .waitForSelector('.mat-calendar, .calendar, [class*="calendar"]', { timeout: 20_000 })
      .catch(() => logger.warn('[vfs] Календарь не найден за 20 сек'));
    if (onStage) await onStage('calendar_open', 'Календарь открыт');

    await sleep(3000); // время для API-ответов

    // ── 10. Парсинг DOM если API не поймали ──────────────────────────
    if (onStage) await onStage('searching_dates', 'Ищем доступные даты');
    if (!apiCaptured) {
      logger.info('[vfs] API не перехвачен, парсим DOM...');
      const domSlots = await parseDomCalendar(page);
      const pgUrl1 = page.url(); const pgTitle1 = await page.title().catch(() => '');
      return { slots: filterByDateRange(domSlots, dateFrom, dateTo), booking: null, pageUrl: pgUrl1, pageTitle: pgTitle1 };
    }

    const pgUrl = page.url(); const pgTitle = await page.title().catch(() => '');
    return { slots: filterByDateRange(capturedSlots, dateFrom, dateTo), booking: null, pageUrl: pgUrl, pageTitle: pgTitle };

  } catch (err) {
    // Сохраняем скриншот и HTML при любой ошибке проверки
    const artifacts = await saveErrorArtifacts(page, requestId);
    if (artifacts) {
      err._artifactSaved = true;
      err._artifactUrl   = artifacts.url;
      err._artifactTitle = artifacts.title;
    }
    throw err;
  } finally {
    if (stopLiveScreenshot) stopLiveScreenshot();
    await page.close();
  }
}

// ─────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (без изменений)
// ─────────────────────────────────────────────

async function selectDropdownByText(page, value, placeholderHint) {
  const selectors = [
    'mat-select:has(mat-placeholder:has-text("' + placeholderHint + '"))',
    'mat-select',
    'select',
  ];

  let dropdown = null;
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 5000 }).catch(() => false)) {
      dropdown = el;
      break;
    }
  }

  if (!dropdown) {
    logger.warn('[vfs] Дропдаун "' + placeholderHint + '" не найден');
    return;
  }

  logger.info('[vfs] Клик по дропдауну для "' + value + '"');
  await dropdown.click();
  await randomDelay(500, 1000);

  const option = page
    .locator('mat-option:has-text("' + value + '"), option:has-text("' + value + '")')
    .first();

  if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    await option.click();
  } else {
    const allOptions = await page.$$('mat-option, option');
    for (const opt of allOptions) {
      const text = await opt.textContent();
      if (text && text.includes(value)) {
        await opt.click();
        break;
      }
    }
  }
  await randomDelay(400, 800);
}

async function fillApplicantIfNeeded(page, params = {}) {
  const firstNameInput = page
    .locator('input[formcontrolname="firstName"], input[name="firstName"]')
    .first();
  if (!(await firstNameInput.isVisible({ timeout: 5000 }).catch(() => false))) return;

  const firstName = params.firstName || 'TEST';
  const lastName  = params.lastName  || 'TESTOV';
  const dob       = params.birthDate
    ? (() => {
        const [y, m, d] = String(params.birthDate).slice(0, 10).split('-');
        return d + '/' + m + '/' + y;
      })()
    : '01/01/1990';

  logger.info('[vfs] Заполняем данные заявителя: ' + firstName + ' ' + lastName + ', ' + dob);

  await firstNameInput.fill(firstName);
  await randomDelay(300, 600);

  const lastNameInput = page
    .locator('input[formcontrolname="lastName"], input[name="lastName"]')
    .first();
  if (await lastNameInput.isVisible().catch(() => false)) {
    await lastNameInput.fill(lastName);
    await randomDelay(300, 600);
  }

  if (params.gender) {
    const genderSel = page.locator('mat-select[formcontrolname="gender"], select[name="gender"]').first();
    if (await genderSel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await genderSel.click();
      await randomDelay(300, 600);
      const genderLabel = params.gender === 'M' ? 'Мужской' : 'Женский';
      const gOpt = page.locator(
        'mat-option:has-text("' + genderLabel + '"), option:has-text("' + genderLabel + '"),' +
        'mat-option:has-text("Male"), option:has-text("Male")'
      ).first();
      if (await gOpt.isVisible({ timeout: 2000 }).catch(() => false)) await gOpt.click();
      await randomDelay(300, 600);
    }
  }

  const dobInput = page
    .locator('input[formcontrolname="dob"], input[placeholder*="ДД"], input[placeholder*="DD"]')
    .first();
  if (await dobInput.isVisible().catch(() => false)) {
    await dobInput.fill(dob);
    await randomDelay(300, 600);
  }

  if (params.passportNum) {
    const passInput = page
      .locator('input[formcontrolname="passportNumber"], input[formcontrolname="passportNum"]')
      .first();
    if (await passInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await passInput.fill(String(params.passportNum));
      await randomDelay(300, 600);
    }
  }

  if (params.passportExp) {
    const [ey, em, ed] = String(params.passportExp).slice(0, 10).split('-');
    const expFormatted = ed + '/' + em + '/' + ey;
    const expInput = page
      .locator('input[formcontrolname="passportExpiry"], input[formcontrolname="expiryDate"]')
      .first();
    if (await expInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expInput.fill(expFormatted);
      await randomDelay(300, 600);
    }
  }

  if (params.applicantPhone) {
    const phoneCodeInput = page
      .locator('input[formcontrolname="countryCode"], input[formcontrolname="phoneCode"]')
      .first();
    if (await phoneCodeInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await phoneCodeInput.fill('7');
      await randomDelay(200, 400);
    }
    const phoneInput = page
      .locator('input[formcontrolname="contactNumber"], input[formcontrolname="phone"]')
      .first();
    if (await phoneInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await phoneInput.fill(String(params.applicantPhone).replace(/^\+?7|^8/, ''));
      await randomDelay(300, 600);
    }
  }

  if (params.applicantEmail) {
    const emailInput = page
      .locator('input[formcontrolname="email"][type="email"], input[type="email"]')
      .last();
    if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emailInput.fill(params.applicantEmail);
      await randomDelay(300, 600);
    }
  }

  logger.info('[vfs] Ожидаем 30 сек (требование VFS перед сохранением данных)...');
  await sleep(30_000);

  const saveBtn = page
    .locator('button:has-text("Сохранить"), button:has-text("Save")')
    .first();
  if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await saveBtn.click();
    await randomDelay(2000, 3000);
  }

  const summaryBody = await page.evaluate(() => document.body.innerText || '');
  if (summaryBody.includes('Сводка') || summaryBody.includes('Summary')) {
    logger.info('[vfs] Страница сводки — нажимаем Продолжить');
    const contBtn = page
      .locator('button:has-text("Продолжить"), button:has-text("Continue")')
      .first();
    if (await contBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await contBtn.click();
      await randomDelay(1500, 2500);
    }
  }
}

function parseApiSlots(body) {
  const slots = [];
  if (Array.isArray(body?.data)) {
    for (const item of body.data) {
      if (item.date && Array.isArray(item.slots)) {
        for (const s of item.slots) {
          slots.push({ date: item.date, time: s.time || s.slot || '', center: '' });
        }
      } else if (item.date && item.available) {
        slots.push({ date: item.date, time: '', center: '' });
      }
    }
  }
  if (Array.isArray(body)) {
    for (const item of body) {
      if (typeof item === 'string' && /\d{4}-\d{2}-\d{2}/.test(item)) {
        slots.push({ date: item, time: '', center: '' });
      } else if (item?.date) {
        slots.push({ date: item.date, time: item.time || '', center: '' });
      }
    }
  }
  if (Array.isArray(body?.availableDates)) {
    for (const d of body.availableDates) {
      slots.push({ date: d, time: '', center: '' });
    }
  }
  return slots;
}

async function parseDomCalendar(page) {
  const slots = [];
  const availableBtns = await page.$$('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)');
  for (const btn of availableBtns) {
    const ariaLabel = await btn.getAttribute('aria-label');
    if (ariaLabel) {
      const dateStr = parseRuDate(ariaLabel);
      if (dateStr) slots.push({ date: dateStr, time: '', center: '' });
    }
  }
  if (slots.length > 0) {
    try {
      await availableBtns[0].click();
      await sleep(2000);
      const timeSlots = await page.$$('button:has-text(":"), [class*="time-slot"]:not([disabled])');
      for (const ts of timeSlots) {
        const text = await ts.textContent();
        if (text && /\d{1,2}:\d{2}/.test(text.trim())) {
          slots[0].time = text.trim();
          break;
        }
      }
    } catch (_) {}
  }
  return slots;
}

function parseRuDate(str) {
  const months = {
    'января':'01','февраля':'02','марта':'03','апреля':'04','мая':'05','июня':'06',
    'июля':'07','августа':'08','сентября':'09','октября':'10','ноября':'11','декабря':'12',
  };
  const m = str.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return null;
  const [, day, monthRu, year] = m;
  const month = months[monthRu.toLowerCase()];
  if (!month) return null;
  return year + '-' + month + '-' + day.padStart(2, '0');
}

function filterByDateRange(slots, dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to   = new Date(dateTo);
  return slots.filter(s => {
    if (!s.date) return false;
    const d = new Date(s.date);
    return d >= from && d <= to;
  });
}

// ─────────────────────────────────────────────
// ДЕТЕКЦИЯ СЛОТОВ ЧЕРЕЗ div.alert
// Аналог vfs-appointment-bot: после выбора дропдаунов VFS показывает
// alert-блок с ближайшей доступной датой.
// ─────────────────────────────────────────────

async function parseAlertSlots(page, dateFrom, dateTo, onStage) {
  try {
    const alertEls = await page.$$('div.alert, .alert-info, .alert-success, [class*="alert"]');
    if (alertEls.length === 0) return [];

    const slots = [];
    let noSlotsFound = false;

    for (const el of alertEls) {
      const text = (await el.textContent().catch(() => '')).trim();
      if (!text) continue;

      logger.info('[vfs] Найден alert-блок слотов: ' + text.slice(0, 150));

      // Явное "нет слотов"
      if (/no available|нет доступных|unavailable|not available|no slot/i.test(text)) {
        noSlotsFound = true;
        continue;
      }

      // Ищем дату ISO: YYYY-MM-DD
      const isoMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
      if (isoMatch) {
        logger.info('[vfs] Дата слота найдена в alert (ISO): ' + isoMatch[1]);
        slots.push({ date: isoMatch[1], time: '', center: '' });
        continue;
      }

      // Ищем дату DD.MM.YYYY или DD-MM-YYYY
      const dmyMatch = text.match(/(\d{2})[.\-](\d{2})[.\-](\d{4})/);
      if (dmyMatch) {
        const iso = dmyMatch[3] + '-' + dmyMatch[2] + '-' + dmyMatch[1];
        logger.info('[vfs] Дата слота найдена в alert (DD.MM.YYYY): ' + iso);
        slots.push({ date: iso, time: '', center: '' });
      }
    }

    if (slots.length > 0) {
      const inRange = filterByDateRange(slots, dateFrom, dateTo);
      if (inRange.length > 0) {
        if (onStage) await onStage('slot_found', 'Слот в alert-блоке: ' + inRange[0].date);
        if (onStage) await onStage('slot_in_range', 'Слот входит в диапазон дат');
        return inRange;
      }
      if (onStage) await onStage('banner_out_of_range', 'Alert: слот вне диапазона: ' + slots[0].date);
      return [];
    }

    return []; // алерты есть, но без распознанных дат
  } catch (err) {
    logger.warn('[vfs] parseAlertSlots error: ' + err.message);
    return [];
  }
}

async function parseEarliestSlotBanner(page, dateFrom, dateTo, onStage) {
  try {
    const bodyText = await page.evaluate(() => document.body.innerText || document.body.textContent || '');
    logger.info('[vfs] Сканируем страницу на наличие баннера слота...');
    const patterns = [
      /[Бб]лижайший\s+доступный\s+слот[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
      /[Nn]earest\s+available\s+slot[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
      /[Nn]ext\s+available\s+appointment[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
    ];
    let rawDate = null;
    let matchedText = null;
    for (const pattern of patterns) {
      const m = bodyText.match(pattern);
      if (m) {
        rawDate = m[1];
        const idx = bodyText.indexOf(m[0]);
        matchedText = bodyText.slice(Math.max(0, idx - 10), idx + m[0].length + 10).trim();
        break;
      }
    }
    if (!rawDate) {
      logger.info('[vfs] Баннер ближайшего слота не найден');
      return [];
    }
    logger.info('[vfs] Найден текст слота: "' + matchedText + '"');
    const [dd, mm, yyyy] = rawDate.split('.');
    if (!dd || !mm || !yyyy) {
      if (onStage) await onStage('banner_error', 'Баннер слота найден, но дата не распознана: ' + rawDate);
      return [];
    }
    const isoDate  = yyyy + '-' + mm + '-' + dd;
    const slotDate = new Date(isoDate);
    const from     = new Date(dateFrom);
    const to       = new Date(dateTo);
    const inRange  = slotDate >= from && slotDate <= to;
    logger.info('[vfs] Дата слота: ' + isoDate + ', входит в диапазон: ' + (inRange ? 'YES' : 'NO'));
    if (!inRange) {
      if (onStage) await onStage('banner_out_of_range', 'Ближайший слот вне диапазона: ' + rawDate);
      return [];
    }
    if (onStage) await onStage('slot_found', 'Найден ближайший слот: ' + rawDate);
    if (onStage) await onStage('slot_in_range', 'Слот подходит по диапазону дат');
    return [{ date: isoDate, time: '', center: '' }];
  } catch (err) {
    logger.warn('[vfs] Ошибка при поиске баннера: ' + err.message);
    return [];
  }
}

// attemptBooking и module.exports
async function attemptBooking(page, params, slotDate, onStage) {
  const log  = msg => logger.info('[booking] ' + msg);
  const warn = msg => logger.warn('[booking] ' + msg);
  try {
    log('Шаг 1: нажимаем Продолжить');
    const continueBtn = page.locator('button:has-text("Продолжить"), button:has-text("Continue"), button:has-text("Next")').first();
    if (!(await continueBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      throw new Error('Кнопка Продолжить не найдена');
    }
    await continueBtn.click();
    await randomDelay(1500, 2500);

    log('Шаг 2: заполняем данные заявителя');
    if (onStage) await onStage('filling_applicant', 'Заполняем данные заявителя');
    await fillApplicantIfNeeded(page, params);

    await page.waitForSelector('mat-radio-button, .mat-calendar, [class*="calendar"]', { timeout: 25_000 })
      .catch(() => warn('Страница записи не загрузилась'));

    const slotRadio = page.locator('mat-radio-button:has-text("Выберите слот"), label:has-text("Выберите слот")').first();
    if (await slotRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
      await slotRadio.click().catch(() => {});
      await randomDelay(500, 1000);
    }

    await page.waitForSelector('.mat-calendar, [class*="calendar"]', { timeout: 15_000 }).catch(() => {});
    await sleep(2000);

    log('Шаг 4: выбираем дату ' + slotDate);
    const [yyyy, mm, dd] = slotDate.split('-');
    const targetDay = parseInt(dd, 10);
    let dateClicked = false;
    const calCells = await page.$$('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)');
    for (const cell of calCells) {
      const label  = await cell.getAttribute('aria-label') || '';
      const text   = await cell.textContent().then(t => t.trim()).catch(() => '');
      const dayNum = parseInt(text, 10);
      if (dayNum === targetDay || label.includes(slotDate)) {
        await cell.click();
        dateClicked = true;
        break;
      }
    }
    if (!dateClicked) warn('Дата ' + slotDate + ' не найдена в календаре');
    await randomDelay(1000, 2000);

    if (onStage) await onStage('selecting_time', 'Выбираем время');
    await sleep(2000);
    let appointmentTime = '';
    let timeClicked = false;
    const selectTimeBtns = await page.$$('button:has-text("Выбрать"), button:has-text("Select")');
    if (selectTimeBtns.length > 0) {
      try {
        appointmentTime = await page.evaluate(() => {
          const rows = document.querySelectorAll('tr');
          for (const row of rows) {
            const btn = row.querySelector('button');
            if (btn && (btn.textContent.includes('Выбрать') || btn.textContent.includes('Select'))) {
              for (const cell of row.querySelectorAll('td')) {
                const t = (cell.innerText || '').trim();
                if (/^\d{1,2}:\d{2}$/.test(t)) return t;
              }
            }
          }
          return '';
        });
      } catch (_) {}
      await selectTimeBtns[0].click();
      timeClicked = true;
    }
    if (!timeClicked) warn('Слот времени не найден');
    await randomDelay(1000, 2000);

    const goToReviewBtn = page.locator('button:has-text("Продолжить"), button:has-text("Continue")').first();
    if (await goToReviewBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await goToReviewBtn.click();
      await randomDelay(2000, 3000);
    }

    if (onStage) await onStage('confirming', 'Подтверждаем запись');
    await page.waitForSelector('button:has-text("Подтвердить"), button:has-text("Confirm")', { timeout: 15_000 }).catch(() => {});

    const tosCheckbox = page.locator('mat-checkbox').filter({ hasText: 'Условия использования' }).first();
    if (await tosCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      const tosClass = await tosCheckbox.getAttribute('class').catch(() => '');
      if (!tosClass.includes('mat-checkbox-checked')) {
        await tosCheckbox.click();
        await randomDelay(500, 1000);
      }
    }

    let confirmed = false;
    const confirmBtn = page.locator('button:has-text("Подтвердить"), button:has-text("Confirm")').first();
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click();
      confirmed = true;
    }
    await sleep(4000);

    const afterText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (afterText.includes('all appointments are scheduled in this slot')) {
      return { success: false, date: slotDate, time: appointmentTime, ref: null, error: 'slot_taken' };
    }
    const refMatch   = afterText.match(/[A-Z]{2,6}\d{6,12}|#[\w-]{8,20}/);
    const bookingRef = refMatch ? refMatch[0] : null;

    if (!confirmed) {
      return { success: false, date: slotDate, time: appointmentTime, ref: null, error: 'confirm_btn_missing' };
    }
    log('Бронирование завершено! ref: ' + bookingRef);
    return { success: true, date: slotDate, time: appointmentTime, ref: bookingRef, error: null };
  } catch (err) {
    warn('Ошибка при бронировании: ' + err.message);
    await saveErrorArtifacts(page, params.requestId).catch(() => {});
    return { success: false, date: null, time: null, ref: null, error: err.message };
  }
}

module.exports = { checkSlots };
