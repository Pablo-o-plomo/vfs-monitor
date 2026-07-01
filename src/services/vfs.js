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

// ─────────────────────────────────────────────
// CLOUDFLARE TURNSTILE — пытаемся решить автоматически
// ─────────────────────────────────────────────

async function handleCloudflare(page) {
  try {
    await sleep(1500); // дать время iframe CF загрузиться

    // Ищем iframe Cloudflare
    let cfFrame = null;
    for (const frame of page.frames()) {
      const u = frame.url();
      if (u.includes('cloudflare.com') || u.includes('challenges.cf') || u.includes('turnstile')) {
        cfFrame = frame;
        break;
      }
    }
    if (!cfFrame) return false; // CF не обнаружен

    logger.info('[vfs] Cloudflare Turnstile обнаружен, пробуем решить...');

    // Кликаем по чекбоксу внутри CF-iframe
    const cb = cfFrame.locator('input[type="checkbox"]');
    if (await cb.isVisible({ timeout: 4000 }).catch(() => false)) {
      await cb.click({ force: true });
      logger.info('[vfs] CF checkbox нажат, ждём проверки (6с)...');
      await sleep(6000);
      return true;
    }

    logger.warn('[vfs] CF checkbox не найден внутри iframe');
    return false;
  } catch (e) {
    logger.warn('[vfs] CF handling error: ' + e.message);
    return false;
  }
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

  // Cloudflare Turnstile (если есть) — пробуем решить до заполнения формы
  await handleCloudflare(page);

  // Ждём email-поле в DOM (state:'attached' — не требует видимости в понимании Playwright,
  // нужно т.к. Angular + CF Turnstile могут держать форму с opacity:0/pointer-events:none)
  const EMAIL_SEL = [
    'input[type="email"]',
    'input[name="email"]',
    'input[formcontrolname="email"]',
    'input[formcontrolname="userName"]',
    'input[placeholder*="email" i]',
    '#mat-input-0',
  ].join(', ');

  await page.waitForSelector(EMAIL_SEL, { state: 'attached', timeout: 30_000 });
  const emailInput = page.locator(EMAIL_SEL).first();
  await randomDelay(400, 800);
  await emailInput.click({ force: true });
  await randomDelay(300, 600);
  await emailInput.fill(config.vfs.email, { force: true });
  await randomDelay(400, 900);

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.click({ force: true });
  await randomDelay(300, 700);
  await passwordInput.fill(config.vfs.password, { force: true });
  await randomDelay(600, 1200);

  const submitBtn = page.locator(
    'button[type="submit"], button:has-text("Войти"), button:has-text("Sign In")'
  ).first();
  await submitBtn.click();

  await page.waitForURL('**/dashboard**', { timeout: 30_000 }).catch(() => {});
  await randomDelay(1000, 2000);

  if (page.url().includes('/dashboard')) {
    logger.info('[vfs] Успешный вход');
    await saveSession();
    return;
  }

  throw new Error('Не удалось войти в VFS Global. Проверьте VFS_EMAIL / VFS_PASSWORD.');
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

    if (!page.url().includes('/dashboard')) {
      if (onStage) await onStage('login', 'Авторизация');
      await login(page, baseUrl);
      if (onStage) await onStage('login', 'Авторизация успешна');
    } else {
      logger.info('[vfs] Сессия активна, пропускаем логин');
      if (onStage) await onStage('login', 'Сессия активна, вход пропущен');
    }

    if (onStage) await onStage('checking_slots', 'Переходим к записи');

    // ── 2. Страница записи ────────────────────────────────────────────
    await randomDelay(1000, 2000);
    await page.goto(`${baseUrl}/book-appointment`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

    // Если VFS перекинул на /login — сессия устарела, перелогиниваемся
    if (page.url().includes('/login')) {
      logger.warn(`[vfs] book-appointment → редирект на login, сессия устарела, перелогиниваемся`);
      if (onStage) await onStage('login', 'Сессия устарела, авторизуемся заново');
      await login(page, baseUrl);
      if (onStage) await onStage('login', 'Авторизация успешна');
      await randomDelay(1000, 2000);
      await page.goto(`${baseUrl}/book-appointment`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
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

    // ── 5а. Баннер «Ближайший доступный слот» ────────────────────────
    // VFS показывает текст вида:
    // "Ближайший доступный слот для 1 заявителя: 30.07.2026"
    // Перехватываем его ДО нажатия «Продолжить»
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
    // Останавливаем polling (последний кадр остаётся в БД — видно что было на экране)
    if (stopLiveScreenshot) stopLiveScreenshot();
    await page.close();
  }
}

// ─────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (без изменений)
// ─────────────────────────────────────────────

async function selectDropdownByText(page, value, placeholderHint) {
  const selectors = [
    `mat-select:has(mat-placeholder:has-text("${placeholderHint}"))`,
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
    logger.warn(`[vfs] Дропдаун "${placeholderHint}" не найден`);
    return;
  }

  logger.info(`[vfs] Клик по дропдауну для "${value}"`);
  await dropdown.click();
  await randomDelay(500, 1000);

  const option = page
    .locator(`mat-option:has-text("${value}"), option:has-text("${value}")`)
    .first();

  if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    await option.click();
  } else {
    // частичное совпадение
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
        // Преобразуем YYYY-MM-DD → DD/MM/YYYY (формат VFS)
        const [y, m, d] = String(params.birthDate).slice(0, 10).split('-');
        return `${d}/${m}/${y}`;
      })()
    : '01/01/1990';

  logger.info(`[vfs] Заполняем данные заявителя: ${firstName} ${lastName}, ${dob}`);

  await firstNameInput.fill(firstName);
  await randomDelay(300, 600);

  const lastNameInput = page
    .locator('input[formcontrolname="lastName"], input[name="lastName"]')
    .first();
  if (await lastNameInput.isVisible().catch(() => false)) {
    await lastNameInput.fill(lastName);
    await randomDelay(300, 600);
  }

  // Пол — VFS на русском: «Мужской» / «Женский»
  if (params.gender) {
    const genderSel = page.locator('mat-select[formcontrolname="gender"], select[name="gender"]').first();
    if (await genderSel.isVisible({ timeout: 2000 }).catch(() => false)) {
      await genderSel.click();
      await randomDelay(300, 600);
      const genderLabel = params.gender === 'M' ? 'Мужской' : 'Женский';
      const gOpt = page.locator(
        `mat-option:has-text("${genderLabel}"), option:has-text("${genderLabel}"),` +
        `mat-option:has-text("Male"), option:has-text("Male")`
      ).first();
      if (await gOpt.isVisible({ timeout: 2000 }).catch(() => false)) await gOpt.click();
      await randomDelay(300, 600);
    }
  }

  // Дата рождения
  const dobInput = page
    .locator('input[formcontrolname="dob"], input[placeholder*="ДД"], input[placeholder*="DD"]')
    .first();
  if (await dobInput.isVisible().catch(() => false)) {
    await dobInput.fill(dob);
    await randomDelay(300, 600);
  }

  // Номер паспорта
  if (params.passportNum) {
    const passInput = page
      .locator('input[formcontrolname="passportNumber"], input[formcontrolname="passportNum"]')
      .first();
    if (await passInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await passInput.fill(String(params.passportNum));
      await randomDelay(300, 600);
    }
  }

  // Срок действия паспорта (YYYY-MM-DD → DD/MM/YYYY)
  if (params.passportExp) {
    const [ey, em, ed] = String(params.passportExp).slice(0, 10).split('-');
    const expFormatted = `${ed}/${em}/${ey}`;
    const expInput = page
      .locator('input[formcontrolname="passportExpiry"], input[formcontrolname="expiryDate"]')
      .first();
    if (await expInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await expInput.fill(expFormatted);
      await randomDelay(300, 600);
    }
  }

  // Контактный номер: два поля — код страны (7) + номер
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
      // Убираем +7 / 8 в начале, оставляем 10 цифр
      await phoneInput.fill(String(params.applicantPhone).replace(/^\+?7|^8/, ''));
      await randomDelay(300, 600);
    }
  }

  // Email
  if (params.applicantEmail) {
    const emailInput = page
      .locator('input[formcontrolname="email"][type="email"], input[type="email"]')
      .last();
    if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await emailInput.fill(params.applicantEmail);
      await randomDelay(300, 600);
    }
  }

  // VFS требует ждать 30 сек перед сохранением (предупреждение на странице)
  logger.info('[vfs] Ожидаем 30 сек (требование VFS перед сохранением данных)...');
  await sleep(30_000);

  const saveBtn = page
    .locator('button:has-text("Сохранить"), button:has-text("Save")')
    .first();
  if (await saveBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await saveBtn.click();
    await randomDelay(2000, 3000);
  }

  // После сохранения VFS показывает «Сводка ваших данных» — нужно нажать Продолжить
  const summaryBody = await page.evaluate(() => document.body.innerText || '');
  if (summaryBody.includes('Сводка') || summaryBody.includes('Summary')) {
    logger.info('[vfs] Страница сводки заявителя — нажимаем Продолжить');
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

  // { data: [{ date, slots: [{ time }] }] }
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

  // Массив дат / объектов напрямую
  if (Array.isArray(body)) {
    for (const item of body) {
      if (typeof item === 'string' && /\d{4}-\d{2}-\d{2}/.test(item)) {
        slots.push({ date: item, time: '', center: '' });
      } else if (item?.date) {
        slots.push({ date: item.date, time: item.time || '', center: '' });
      }
    }
  }

  // { availableDates: [...] }
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
    января: '01', февраля: '02', марта: '03',     апреля: '04', мая: '05', июня: '06', июля: '07', августа: '08',
    сентября: '09', октября: '10', ноября: '11', декабря: '12',
  };
  const m = str.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (!m) return null;
  const [, day, monthRu, year] = m;
  const month = months[monthRu.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

function filterByDateRange(slots, dateFrom, dateTo) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  return slots.filter((s) => {
    if (!s.date) return false;
    const d = new Date(s.date);
    return d >= from && d <= to;
  });
}

// БАННЕР «БЛИЖАЙШИЙ ДОСТУПНЫЙ СЛОТ»
async function parseEarliestSlotBanner(page, dateFrom, dateTo, onStage = null) {
  try {
    const bodyText = await page.evaluate(
      () => document.body.innerText || document.body.textContent || ''
    );

    logger.info('[vfs] Сканируем страницу на наличие баннера слота...');

    const patterns = [
      /[Бб]лижайший\s+доступный\s+слот[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
      /[Nn]earest\s+available\s+slot[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
      /[Nn]ext\s+available\s+appointment[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
      /slot[^:]*available[^:]*:\s*(\d{2}\.\d{2}\.\d{4})/i,
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
      logger.info('[vfs] Баннер ближайшего слота не найден на странице');
      return [];
    }

    logger.info(`[vfs] Найден текст слота: "${matchedText}"`);

    const [dd, mm, yyyy] = rawDate.split('.');
    if (!dd || !mm || !yyyy) {
      logger.warn(`[vfs] Не удалось разобрать дату слота: ${rawDate}`);
      if (onStage) await onStage('banner_error', `Баннер слота найден, но дата не распознана: ${rawDate}`);
      return [];
    }
    const isoDate  = `${yyyy}-${mm}-${dd}`;
    const humanDate = rawDate; // DD.MM.YYYY — для читаемых сообщений
    logger.info(`[vfs] Извлечена дата слота: ${isoDate}`);

    const slotDate = new Date(isoDate);
    const from = new Date(dateFrom);
    const to   = new Date(dateTo);
    const inRange = slotDate >= from && slotDate <= to;

    logger.info(`[vfs] Дата входит в диапазон [${dateFrom} — ${dateTo}]: ${inRange ? 'YES' : 'NO'}`);

    if (!inRange) {
      if (onStage) await onStage('banner_out_of_range', `Ближайший слот вне диапазона: ${humanDate}`);
      return [];
    }

    if (onStage) await onStage('slot_found', `Найден ближайший слот: ${humanDate}`);
    if (onStage) await onStage('slot_in_range', 'Слот подходит по диапазону дат');
    logger.info(`[vfs] Слот сохранён: ${isoDate}`);
    return [{ date: isoDate, time: '', center: '' }];

  } catch (err) {
    logger.warn(`[vfs] Ошибка при поиске баннера слота: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// АВТОБРОНИРОВАНИЕ
// ─────────────────────────────────────────────
//
// Вызывается когда найден слот через баннер И auto_book=true.
// Браузер уже открыт на странице выбора подкатегории.
//
// Шаги:
//   1. Нажать «Продолжить»
//   2. Заполнить форму заявителя реальными данными
//   3. Перейти к календарю
//   4. Выбрать нужную дату
//   5. Выбрать первое доступное время
//   6. Подтвердить запись
//   7. Извлечь номер записи с confirmation-страницы

async function attemptBooking(page, params, slotDate, onStage = null) {
  const log = (msg) => logger.info(`[booking] ${msg}`);
  const warn = (msg) => logger.warn(`[booking] ${msg}`);

  try {
    // ── 1. Нажать «Продолжить» ──────────────────────────────────────
    log('Шаг 1: нажимаем «Продолжить»');
    const continueBtn = page.locator(
      'button:has-text("Продолжить"), button:has-text("Continue"), button:has-text("Next")'
    ).first();
    if (!(await continueBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      throw new Error('Кнопка «Продолжить» не найдена после выбора подкатегории');
    }
    await continueBtn.click();
    await randomDelay(1500, 2500);

    // ── 2. Заполнить форму заявителя ────────────────────────────────
    log('Шаг 2: заполняем форму заявителя');
    if (onStage) await onStage('filling_applicant', 'Заполняем данные заявителя');
    await fillApplicantIfNeeded(page, params);

    // ── 3. Страница «Запись на прием» (/book-appointment) ──────────
    log('Шаг 3: ждём страницу записи');
    // Ждём появления радиокнопок или календаря
    await page
      .waitForSelector('mat-radio-button, .mat-calendar, [class*="calendar"]', { timeout: 25_000 })
      .catch(() => warn('Страница записи не загрузилась за 25 сек'));

    // VFS показывает «Выберите тип записи»: «Выберите слот» | «Подача в любое время»
    // «Выберите слот» выбран по умолчанию, но явно кликаем для надёжности
    const slotRadio = page
      .locator('mat-radio-button:has-text("Выберите слот"), label:has-text("Выберите слот")')
      .first();
    if (await slotRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
      await slotRadio.click().catch(() => {});
      log('Выбран тип записи: "Выберите слот"');
      await randomDelay(500, 1000);
    }

    // Ждём календарь
    await page
      .waitForSelector('.mat-calendar, .calendar, [class*="calendar"]', { timeout: 15_000 })
      .catch(() => warn('Календарь не найден за 15 сек'));
    await sleep(2000);

    // ── 4. Выбираем нужную дату ─────────────────────────────────────
    log(`Шаг 4: выбираем дату ${slotDate}`);
    const [yyyy, mm, dd] = slotDate.split('-');
    const targetDay = parseInt(dd, 10);

    // Ищем кнопку с нужным числом в доступных ячейках календаря
    let dateClicked = false;
    const calCells = await page.$$('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)');
    for (const cell of calCells) {
      const label = await cell.getAttribute('aria-label') || '';
      const text  = await cell.textContent().then(t => t.trim()).catch(() => '');
      const dayNum = parseInt(text, 10);
      if (dayNum === targetDay || label.includes(slotDate) || label.includes(String(targetDay))) {
        await cell.click();
        dateClicked = true;
        log(`Дата ${slotDate} выбрана`);
        break;
      }
    }
    if (!dateClicked) warn(`Дата ${slotDate} не найдена в календаре — пробуем первую доступную`);
    await randomDelay(1000, 2000);

    // ── 5. Выбираем первое доступное время ──────────────────────────
    if (onStage) await onStage('selecting_time', 'Выбираем время');
    log('Шаг 5: выбираем время');
    await sleep(2000);

    let appointmentTime = '';
    let timeClicked = false;

    // VFS показывает таблицу: «Время | Доступно → кнопка "Выбрать"»
    // Кнопка называется «Выбрать», время — в соседней ячейке той же строки
    const selectTimeBtns = await page.$$('button:has-text("Выбрать"), button:has-text("Select")');
    if (selectTimeBtns.length > 0) {
      try {
        // Читаем время из ячейки строки, где есть кнопка «Выбрать»
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
      log(`Нажата кнопка "Выбрать", время: ${appointmentTime || '?'}`);
    }

    // Fallback: кнопки, содержащие время в тексте
    if (!timeClicked) {
      const timeButtons = await page.$$('[class*="time"]:not([disabled]), [class*="slot"]:not([disabled])');
      for (const btn of timeButtons) {
        const text = await btn.textContent().then(t => t.trim()).catch(() => '');
        if (/\d{1,2}:\d{2}/.test(text)) {
          appointmentTime = text;
          await btn.click();
          timeClicked = true;
          log(`Время выбрано (fallback): ${text}`);
          break;
        }
      }
    }
    if (!timeClicked) warn('Слот времени не найден, продолжаем');
    await randomDelay(1000, 2000);

    // ── 5.5 Переходим к странице «Детали и оплата» (/review-pay) ────
    const goToReviewBtn = page
      .locator('button:has-text("Продолжить"), button:has-text("Continue")')
      .first();
    if (await goToReviewBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await goToReviewBtn.click();
      log('Переходим к странице подтверждения');
      await randomDelay(2000, 3000);
    }

    // ── 6. Страница «Детали и оплата» (/review-pay) — принимаем условия ──
    if (onStage) await onStage('confirming', 'Подтверждаем запись');
    log('Шаг 6: страница подтверждения (/review-pay)');

    // Ждём загрузки кнопки «Подтвердить»
    await page
      .waitForSelector('button:has-text("Подтвердить"), button:has-text("Confirm")', { timeout: 15_000 })
      .catch(() => warn('Страница подтверждения не загрузилась за 15 сек'));

    // Обязательный чекбокс «Я принимаю Условия использования»
    const tosCheckbox = page
      .locator('mat-checkbox')
      .filter({ hasText: 'Условия использования' })
      .first();
    if (await tosCheckbox.isVisible({ timeout: 3000 }).catch(() => false)) {
      const tosClass = await tosCheckbox.getAttribute('class').catch(() => '');
      if (!tosClass.includes('mat-checkbox-checked')) {
        await tosCheckbox.click();
        await randomDelay(500, 1000);
        log('Условия использования приняты');
      }
    }

    // Нажимаем «Подтвердить»
    let confirmed = false;
    const confirmBtn = page
      .locator('button:has-text("Подтвердить"), button:has-text("Confirm")')
      .first();
        if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click();
      confirmed = true;
      log('Кнопка «Подтвердить» нажата');
    }

    await sleep(4000);

    // Детектируем ошибку «слот уже занят»
    const afterConfirmText = await page.evaluate(() => document.body.innerText || '').catch(() => '');
    if (
      afterConfirmText.includes('all appointments are scheduled in this slot') ||
      afterConfirmText.includes('select different date and time')
    ) {
      warn('Слот занят — другой заявитель успел раньше');
      return { success: false, date: slotDate, time: appointmentTime, ref: null, error: 'slot_taken' };
    }

    // Детектируем подтверждение брони (номер ссылки)
    const refMatch = afterConfirmText.match(/[A-Z]{2,6}\d{6,12}|#[\w-]{8,20}/);
    const bookingRef = refMatch ? refMatch[0] : null;

    if (!confirmed) {
      warn('Кнопка «Подтвердить» не найдена — возможно бронирование не завершено');
      return { success: false, date: slotDate, time: appointmentTime, ref: null, error: 'confirm_btn_missing' };
    }

    log(`Бронирование завершено! Дата: ${slotDate}, время: ${appointmentTime}, ref: ${bookingRef}`);
    return { success: true, date: slotDate, time: appointmentTime, ref: bookingRef, error: null };

  } catch (err) {
    warn('Ошибка при бронировании: ' + err.message);
    await saveErrorArtifacts(page, params.requestId).catch(() => {});
    return { success: false, date: null, time: null, ref: null, error: err.message };
  } finally {
    // Страница закрывается в checkSlots
  }
}

// ─────────────────────────────────────────────
// ЭКСПОРТ
// ─────────────────────────────────────────────

module.exports = { checkSlots };
