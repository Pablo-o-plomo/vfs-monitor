/**
 * monitor.js — логика мониторинга VFS Global
 *
 * Стратегия:
 * 1. Логинимся (или используем сохранённую сессию)
 * 2. Переходим на страницу записи, выбираем центр / категорию
 * 3. Перехватываем XHR-запрос получения слотов (JSON API)
 * 4. Возвращаем список доступных дат/времён
 *
 * Если API-перехват не сработал (сайт изменился) —
 * падаем назад к парсингу DOM календаря.
 */

const { newPage, saveSession, randomDelay, sleep } = require('./browser');
const logger = require('./logger');
const config = require('./config');

const BASE = config.vfs.baseUrl; // https://visa.vfsglobal.com/rus/ru/hun
const LOGIN_URL = `${BASE}/dashboard`;

// ─────────────────────────────────────────────
// ЛОГИН
// ─────────────────────────────────────────────
async function login(page) {
  logger.info('Переходим на страницу входа...');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await randomDelay(1500, 3000);

  // Проверяем: уже залогинены?
  if (page.url().includes('/dashboard')) {
    logger.info('Уже авторизованы (сессия активна)');
    return true;
  }

  // Вводим email
  const emailInput = page.locator('input[type="email"], input[name="email"], #mat-input-0');
  await emailInput.waitFor({ timeout: 15_000 });
  await emailInput.click();
  await randomDelay(300, 700);
  await emailInput.fill(config.vfs.email);
  await randomDelay(400, 900);

  // Вводим пароль
  const passwordInput = page.locator('input[type="password"]').first();
  await passwordInput.click();
  await randomDelay(300, 700);
  await passwordInput.fill(config.vfs.password);
  await randomDelay(600, 1200);

  // Кнопка войти
  const submitBtn = page.locator('button[type="submit"], button:has-text("Войти"), button:has-text("Sign In")').first();
  await submitBtn.click();

  // Ждём редиректа
  await page.waitForURL('**/dashboard**', { timeout: 30_000 }).catch(() => {});
  await randomDelay(1000, 2000);

  if (page.url().includes('/dashboard')) {
    logger.info('Успешный вход');
    await saveSession();
    return true;
  }

  // Проверяем ошибку
  const error = await page.$('text=Неверный пароль, text=Invalid credentials, .error-message');
  if (error) {
    throw new Error('Ошибка входа: неверные credentials');
  }

  logger.warn('Непонятное состояние после логина, URL: ' + page.url());
  return false;
}

// ─────────────────────────────────────────────
// ПРОВЕРКА СЛОТОВ
// ─────────────────────────────────────────────

/**
 * Возвращает массив объектов { date, time, center } с доступными слотами
 * в заданном диапазоне дат.
 */
async function checkSlots() {
  const page = await newPage();

  // Перехватчик API-ответов со слотами
  const capturedSlots = [];
  let apiCaptured = false;

  page.on('response', async (response) => {
    const url = response.url();
    // VFS отдаёт доступность через эндпоинты с "slot" или "appointment"
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
          logger.info(`API перехват: найдено ${slots.length} слотов`);
        }
      } catch (_) {
        // не JSON — пропускаем
      }
    }
  });

  try {
    // ── Шаг 1: логин / проверка сессии ──────────────────────────────
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await randomDelay(1500, 2500);

    if (!page.url().includes('/dashboard')) {
      await login(page);
    } else {
      logger.info('Сессия активна, пропускаем логин');
    }

    // ── Шаг 2: переходим к записи ────────────────────────────────────
    await randomDelay(1000, 2000);
    await page.goto(`${BASE}/book-appointment`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await randomDelay(1500, 3000);

    // ── Шаг 3: выбор центра приложений ───────────────────────────────
    logger.info('Выбираем визовый центр...');
    await selectDropdownByText(page, config.vfs.center, 'Выберите свой Центр приложений, Выберите свой Центр');
    await randomDelay(800, 1500);

    // ── Шаг 4: категория ─────────────────────────────────────────────
    logger.info('Выбираем категорию...');
    await selectDropdownByText(page, config.vfs.category, 'Выберите категорию');
    await randomDelay(600, 1200);

    // ── Шаг 5: подкатегория ──────────────────────────────────────────
    logger.info('Выбираем подкатегорию...');
    await selectDropdownByText(page, config.vfs.subcategory, 'Выберите подкатегорию');
    await randomDelay(600, 1200);

    // ── Шаг 6: проверяем сообщение "нет слотов" сразу ────────────────
    const noSlotsMsg = await page.$('text=нет доступных слотов, text=no available slots');
    if (noSlotsMsg) {
      logger.info('Слотов нет (сообщение на шаге 1)');
      return [];
    }

    // ── Шаг 7: нажимаем "Продолжить" ────────────────────────────────
    const continueBtn = page.locator('button:has-text("Продолжить"), button:has-text("Continue")').first();
    if (await continueBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await continueBtn.click();
      await randomDelay(1500, 2500);
    }

    // ── Шаг 8 (если нужно): заполняем заявителя с тестовыми данными ──
    // VFS иногда требует заявителя перед выбором даты
    await fillApplicantIfNeeded(page);

    // ── Шаг 9: дождёмся страницы с календарём ────────────────────────
    logger.info('Ждём календарь...');
    await page.waitForSelector('.mat-calendar, .calendar, [class*="calendar"]', { timeout: 20_000 })
      .catch(() => logger.warn('Календарь не найден за 20 сек'));

    // Даём время API-запросам уйти и вернуться
    await sleep(3000);

    // ── Шаг 10: если API не поймали — парсим DOM ──────────────────────
    if (!apiCaptured) {
      logger.info('API не перехвачен, парсим DOM календаря...');
      const domSlots = await parseDomCalendar(page);
      return filterByDateRange(domSlots);
    }

    return filterByDateRange(capturedSlots);
  } finally {
    await page.close();
  }
}

// ─────────────────────────────────────────────
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ─────────────────────────────────────────────

/**
 * Выбрать значение в mat-select/custom dropdown по частичному тексту.
 * placeholder — текст плейсхолдера дропдауна для идентификации.
 */
async function selectDropdownByText(page, value, placeholderHint) {
  // Ищем mat-select или select содержащий плейсхолдер
  const selectors = [
    `mat-select:has(mat-placeholder:has-text("${placeholderHint.split(',')[0].trim()}"))`,
    `mat-select`,
    `select`,
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
    logger.warn(`Дропдаун "${placeholderHint}" не найден`);
    return;
  }

  await dropdown.click();
  await randomDelay(500, 1000);

  // Ищем нужный option
  const option = page.locator(`mat-option:has-text("${value}"), option:has-text("${value}")`).first();
  if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    await option.click();
    await randomDelay(400, 800);
  } else {
    // Пробуем найти по частичному совпадению
    const allOptions = await page.$$('mat-option, option');
    for (const opt of allOptions) {
      const text = await opt.textContent();
      if (text && text.includes(value)) {
        await opt.click();
        await randomDelay(400, 800);
        break;
      }
    }
  }
}

/**
 * На шаге "Информация о Вас" заполняем минимальные тестовые данные,
 * чтобы двинуться дальше к календарю.
 */
async function fillApplicantIfNeeded(page) {
  const firstNameInput = page.locator('input[formcontrolname="firstName"], input[name="firstName"]').first();
  if (!(await firstNameInput.isVisible({ timeout: 3000 }).catch(() => false))) return;

  logger.info('Заполняем данные заявителя (тестовые)...');

  await firstNameInput.fill('TEST');
  await randomDelay(300, 600);

  const lastNameInput = page.locator('input[formcontrolname="lastName"], input[name="lastName"]').first();
  if (await lastNameInput.isVisible().catch(() => false)) {
    await lastNameInput.fill('TESTOV');
    await randomDelay(300, 600);
  }

  // Дата рождения
  const dobInput = page.locator('input[formcontrolname="dob"], input[placeholder*="ДД"]').first();
  if (await dobInput.isVisible().catch(() => false)) {
    await dobInput.fill('01/01/1990');
    await randomDelay(300, 600);
  }

  // Нажимаем "Продолжить" / "Сохранить"
  const btn = page.locator('button:has-text("Сохранить"), button:has-text("Save"), button:has-text("Продолжить")').first();
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click();
    await randomDelay(1500, 2500);
  }
}

/**
 * Попытаться распарсить JSON из API VFS.
 * Структура может быть разной — пробуем известные форматы.
 */
function parseApiSlots(body) {
  const slots = [];

  // Формат 1: { data: [{ date, slots: [{ time }] }] }
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

  // Формат 2: массив дат напрямую
  if (Array.isArray(body)) {
    for (const item of body) {
      if (typeof item === 'string' && /\d{4}-\d{2}-\d{2}/.test(item)) {
        slots.push({ date: item, time: '', center: '' });
      } else if (item?.date) {
        slots.push({ date: item.date, time: item.time || '', center: '' });
      }
    }
  }

  // Формат 3: { availableDates: [...] }
  if (Array.isArray(body?.availableDates)) {
    for (const d of body.availableDates) {
      slots.push({ date: d, time: '', center: '' });
    }
  }

  return slots;
}

/**
 * DOM-парсинг: находим доступные даты на kalendare (mat-calendar).
 * Зелёные / незаблокированные кнопки дат.
 */
async function parseDomCalendar(page) {
  const slots = [];

  // Собираем все кликабельные кнопки в mat-calendar
  const availableBtns = await page.$$('.mat-calendar-body-cell:not(.mat-calendar-body-disabled)');

  for (const btn of availableBtns) {
    const ariaLabel = await btn.getAttribute('aria-label');
    if (ariaLabel) {
      // ariaLabel обычно содержит дату типа "20 июля 2026 г."
      const dateStr = parseRuDate(ariaLabel);
      if (dateStr) slots.push({ date: dateStr, time: '', center: '' });
    }
  }

  // Если нашли доступные даты, кликаем на первую и смотрим временные слоты
  if (slots.length > 0) {
    try {
      await availableBtns[0].click();
      await sleep(2000);

      // Парсим временные слоты
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

/**
 * Конвертация русской даты "20 июля 2026 г." → "2026-07-20"
 */
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

/**
 * Фильтровать слоты по заданному диапазону дат из конфига
 */
function filterByDateRange(slots) {
  const from = new Date(config.vfs.dateFrom);
  const to = new Date(config.vfs.dateTo);

  return slots.filter((s) => {
    if (!s.date) return false;
    const d = new Date(s.date);
    return d >= from && d <= to;
  });
}

module.exports = { checkSlots };
