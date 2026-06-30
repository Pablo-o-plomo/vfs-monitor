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
const logger = require('../logger');
const config = require('../config');

// ─────────────────────────────────────────────
// ЛОГИН
// ─────────────────────────────────────────────

async function login(page, baseUrl) {
  logger.info('[vfs] Переходим на страницу входа...');
  await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await randomDelay(1500, 3000);

  if (page.url().includes('/dashboard')) {
    logger.info('[vfs] Уже авторизованы (сессия активна)');
    return;
  }

  const emailInput = page.locator('input[type="email"], input[name="email"], #mat-input-0');
  await emailInput.waitFor({ timeout: 15_000 });
  await emailInput.click();
  await randomDelay(300, 700);
  await emailInput.fill(config.vfs.email);
  await randomDelay(400, 900);

  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.click();
  await randomDelay(300, 700);
  await passwordInput.fill(config.vfs.password);
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
// ГЛАВНАЯ ФУНКЦИЯ — принимает params из БД
// ─────────────────────────────────────────────

async function checkSlots(params) {
  const {
    countryCode = 'hun',
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
      await login(page, baseUrl);
    } else {
      logger.info('[vfs] Сессия активна, пропускаем логин');
    }

    // ── 2. Страница записи ────────────────────────────────────────────
    await randomDelay(1000, 2000);
    await page.goto(`${baseUrl}/book-appointment`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await randomDelay(1500, 3000);

    // ── 3. Выбор визового центра ──────────────────────────────────────
    logger.info(`[vfs] Выбираем центр: ${center}`);
    await selectDropdownByText(page, center, 'Выберите свой Центр приложений');
    await randomDelay(800, 1500);

    // ── 4. Категория ──────────────────────────────────────────────────
    logger.info(`[vfs] Выбираем категорию: ${category}`);
    await selectDropdownByText(page, category, 'Выберите категорию');
    await randomDelay(600, 1200);

    // ── 5. Подкатегория ───────────────────────────────────────────────
    logger.info(`[vfs] Выбираем подкатегорию: ${subcategory}`);
    await selectDropdownByText(page, subcategory, 'Выберите подкатегорию');
    await randomDelay(600, 1200);

    // ── 6. Ранняя проверка «нет слотов» ──────────────────────────────
    const noSlotsEl = await page.$('text=нет доступных слотов');
    if (noSlotsEl) {
      logger.info('[vfs] Слотов нет (сообщение на шаге выбора)');
      return [];
    }

    // ── 7. Продолжить ─────────────────────────────────────────────────
    const continueBtn = page.locator(
      'button:has-text("Продолжить"), button:has-text("Continue")'
    ).first();
    if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continueBtn.click();
      await randomDelay(1500, 2500);
    }

    // ── 8. Заявитель (тестовые данные, если форма появилась) ──────────
    await fillApplicantIfNeeded(page);

    // ── 9. Ждём календарь ────────────────────────────────────────────
    logger.info('[vfs] Ждём календарь...');
    await page
      .waitForSelector('.mat-calendar, .calendar, [class*="calendar"]', { timeout: 20_000 })
      .catch(() => logger.warn('[vfs] Календарь не найден за 20 сек'));

    await sleep(3000); // время для API-ответов

    // ── 10. Парсинг DOM если API не поймали ──────────────────────────
    if (!apiCaptured) {
      logger.info('[vfs] API не перехвачен, парсим DOM...');
      const domSlots = await parseDomCalendar(page);
      return filterByDateRange(domSlots, dateFrom, dateTo);
    }

    return filterByDateRange(capturedSlots, dateFrom, dateTo);

  } finally {
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
    if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      dropdown = el;
      break;
    }
  }

  if (!dropdown) {
    logger.warn(`[vfs] Дропдаун "${placeholderHint}" не найден`);
    return;
  }

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

async function fillApplicantIfNeeded(page) {
  const firstNameInput = page
    .locator('input[formcontrolname="firstName"], input[name="firstName"]')
    .first();
  if (!(await firstNameInput.isVisible({ timeout: 3000 }).catch(() => false))) return;

  logger.info('[vfs] Заполняем тестовые данные заявителя...');
  await firstNameInput.fill('TEST');
  await randomDelay(300, 600);

  const lastNameInput = page
    .locator('input[formcontrolname="lastName"], input[name="lastName"]')
    .first();
  if (await lastNameInput.isVisible().catch(() => false)) {
    await lastNameInput.fill('TESTOV');
    await randomDelay(300, 600);
  }

  const dobInput = page
    .locator('input[formcontrolname="dob"], input[placeholder*="ДД"]')
    .first();
  if (await dobInput.isVisible().catch(() => false)) {
    await dobInput.fill('01/01/1990');
    await randomDelay(300, 600);
  }

  const saveBtn = page
    .locator('button:has-text("Сохранить"), button:has-text("Save"), button:has-text("Продолжить")')
    .first();
  if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await saveBtn.click();
    await randomDelay(1500, 2500);
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
    января: '01', февраля: '02', марта: '03', апреля: '04',
    мая: '05', июня: '06', июля: '07', августа: '08',
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

module.exports = { checkSlots };
