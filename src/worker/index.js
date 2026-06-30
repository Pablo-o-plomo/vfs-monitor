/**
 * src/worker/index.js — Worker мониторинга
 *
 * Алгоритм:
 * 1. Каждые WORKER_POLL_MS (60 сек) смотрим в БД
 * 2. Берём все active заявки у которых job.next_check_at <= NOW() и status != 'running'
 * 3. Для каждой: запускаем vfs.checkSlots(params)
 * 4. Новые слоты → slot_events + notifications + Telegram
 * 5. Обновляем job: last_check_at, next_check_at = now + interval±jitter
 * 6. При ошибке: инкремент error_count, при 5+ → status=error на заявке
 */

require('dotenv').config();

const { query, migrate } = require('../db');
const { checkSlots }     = require('../services/vfs');
const { notifySlots, notifyWorkerStart, notifyError } = require('../services/notifier');
const { closeBrowser, sleep } = require('../browser');
const logger = require('../logger');
const config = require('../config');

const MAX_ERRORS     = 5;
const DEDUP_TTL_MS   = config.worker.dedupTtlMs;

// In-memory дедупликация: requestId → Map(slotKey → timestamp)
const seenSlots = new Map();

// ─────────────────────────────────────────────
// ДЕДУПЛИКАЦИЯ
// ─────────────────────────────────────────────

function isNewSlot(requestId, slot) {
  const now = Date.now();
  if (!seenSlots.has(requestId)) seenSlots.set(requestId, new Map());
  const seen = seenSlots.get(requestId);

  // Чистим устаревшие
  for (const [k, ts] of seen.entries()) {
    if (now - ts > DEDUP_TTL_MS) seen.delete(k);
  }

  const key = `${slot.date}|${slot.time}`;
  if (seen.has(key)) return false;
  seen.set(key, now);
  return true;
}

// ─────────────────────────────────────────────
// СЛЕДУЮЩИЙ ИНТЕРВАЛ
// ─────────────────────────────────────────────

function nextCheckAt(intervalMin) {
  const jitter = config.worker.jitterMin;
  const delta  = (intervalMin + (Math.random() * 2 - 1) * jitter) * 60 * 1000;
  return new Date(Date.now() + delta);
}

// ─────────────────────────────────────────────
// ОБРАБОТКА ОДНОЙ ЗАЯВКИ
// ─────────────────────────────────────────────

async function processRequest(vr, job) {
  const reqId = vr.id;
  const jobId = job.id;
  logger.info(`[worker] Проверяем заявку #${reqId}: ${vr.country_name} / ${vr.center} (клиент: ${vr.client_name})`);

  // Помечаем job как running
  await query(
    "UPDATE monitoring_jobs SET status='running' WHERE id=$1",
    [jobId]
  );

  try {
    const slots = await checkSlots({
      countryCode:  vr.country_code,
      center:       vr.center,
      category:     vr.category,
      subcategory:  vr.subcategory,
      dateFrom:     vr.date_from,
      dateTo:       vr.date_to,
    });

    logger.info(`[worker] Заявка #${reqId}: найдено ${slots.length} слотов`);

    // Фильтруем новые (дедупликация)
    const newSlots = slots.filter(s => isNewSlot(reqId, s));

    if (newSlots.length > 0) {
      logger.info(`[worker] Заявка #${reqId}: ${newSlots.length} новых слотов — сохраняем и уведомляем`);

      // Сохраняем slot_events
      const savedEvents = [];
      for (const s of newSlots) {
        const { rows: [ev] } = await query(
          `INSERT INTO slot_events(request_id, job_id, slot_date, slot_time, center, raw_data)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
          [reqId, jobId, s.date, s.time || null, s.center || vr.center, JSON.stringify(s)]
        );
        savedEvents.push(ev);
      }

      // Telegram
      const client = { name: vr.client_name };
      const request = {
        country_code:  vr.country_code,
        country_name:  vr.country_name,
        center:        vr.center,
        category:      vr.category,
        subcategory:   vr.subcategory,
        date_from:     vr.date_from,
        date_to:       vr.date_to,
      };

      let msgText = '';
      try {
        // Перехватываем текст сообщения для сохранения в notifications
        const { send } = require('../services/notifier');
        const bookUrl = `${config.vfs.baseUrl}/${vr.country_code}/book-appointment`;

        msgText = [
          `🟢 Найдены свободные слоты!`,
          `Клиент: ${vr.client_name}`,
          `${vr.country_name} / ${vr.center}`,
          `${vr.category} / ${vr.subcategory}`,
          newSlots.map(s => `${s.date}${s.time ? ' ' + s.time : ''}`).join(', '),
          bookUrl,
        ].join('\n');

        await notifySlots({ client, request, slots: newSlots });
      } catch (tgErr) {
        logger.error(`[worker] Telegram error: ${tgErr.message}`);
      }

      // Сохраняем notifications
      for (const ev of savedEvents) {
        await query(
          `INSERT INTO notifications(request_id, slot_event_id, channel, message, status)
           VALUES($1,$2,'telegram',$3,'sent')`,
          [reqId, ev.id, msgText]
        ).catch(() => {});
      }
    }

    // Сбрасываем ошибки, обновляем времена
    const nextAt = nextCheckAt(job.check_interval_minutes);
    await query(
      `UPDATE monitoring_jobs
       SET status='idle', last_check_at=NOW(), next_check_at=$1, error_count=0, last_error=NULL
       WHERE id=$2`,
      [nextAt, jobId]
    );

    logger.info(`[worker] Заявка #${reqId}: следующая проверка в ${nextAt.toLocaleString('ru-RU')}`);

  } catch (err) {
    logger.error(`[worker] Ошибка заявки #${reqId}: ${err.message}`);

    const newErrCount = (job.error_count || 0) + 1;
    const nextAt = nextCheckAt(job.check_interval_minutes * 2); // увеличиваем интервал при ошибке

    await query(
      `UPDATE monitoring_jobs
       SET status='error', last_check_at=NOW(), next_check_at=$1,
           error_count=$2, last_error=$3
       WHERE id=$4`,
      [nextAt, newErrCount, err.message.slice(0, 500), jobId]
    );

    // Переводим заявку в error если слишком много сбоев подряд
    if (newErrCount >= MAX_ERRORS) {
      await query(
        "UPDATE visa_requests SET status='error', updated_at=NOW() WHERE id=$1",
        [reqId]
      );
      await notifyError(
        `Заявка #${reqId} (${vr.client_name} / ${vr.country_name}) переведена в error после ${newErrCount} ошибок подряд.\nПоследняя: ${err.message}`
      ).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
// ОСНОВНОЙ ЦИКЛ
// ─────────────────────────────────────────────

async function tick() {
  // Берём все активные заявки с jobs готовыми к проверке
  const { rows } = await query(`
    SELECT vr.*, c.name AS client_name,
           mj.id AS job_id_col, mj.status AS job_status,
           mj.check_interval_minutes, mj.error_count, mj.last_error,
           mj.next_check_at
    FROM visa_requests vr
    JOIN clients c ON c.id = vr.client_id
    JOIN monitoring_jobs mj ON mj.request_id = vr.id
    WHERE vr.status = 'active'
      AND mj.status != 'running'
      AND mj.next_check_at <= NOW()
    ORDER BY mj.next_check_at ASC
  `);

  if (rows.length === 0) {
    logger.info('[worker] Нет заявок для проверки');
    return;
  }

  logger.info(`[worker] Tick: ${rows.length} заявок для проверки`);

  // Обрабатываем заявки последовательно (не параллельно — щадим VFS и браузер)
  for (const row of rows) {
    const job = {
      id: row.job_id_col,
      status: row.job_status,
      check_interval_minutes: row.check_interval_minutes,
      error_count: row.error_count,
      last_error: row.last_error,
    };
    await processRequest(row, job);

    // Пауза между заявками — 20-40 сек
    const pause = 20_000 + Math.random() * 20_000;
    await sleep(pause);
  }

  // Закрываем браузер после обработки всех заявок тика
  await closeBrowser().catch(() => {});
}

// ─────────────────────────────────────────────
// СТАРТ
// ─────────────────────────────────────────────

async function main() {
  logger.info('[worker] === Adria Travel Monitor Worker стартует ===');

  await migrate();

  // Считаем активные заявки для стартового уведомления
  const { rows } = await query("SELECT COUNT(*) FROM visa_requests WHERE status='active'");
  const activeCount = parseInt(rows[0].count);
  await notifyWorkerStart(activeCount).catch(() => {});

  // Сбрасываем застрявшие 'running' статусы (если worker упал в прошлый раз)
  await query("UPDATE monitoring_jobs SET status='idle' WHERE status='running'");

  logger.info(`[worker] Активных заявок: ${activeCount}`);
  logger.info(`[worker] Интервал опроса БД: ${config.worker.pollIntervalMs / 1000} сек`);

  // Первый тик сразу
  await tick().catch(e => logger.error('[worker] Ошибка тика: ' + e.message));

  // Затем по расписанию
  setInterval(async () => {
    try {
      await tick();
    } catch (e) {
      logger.error('[worker] Ошибка тика: ' + e.message);
    }
  }, config.worker.pollIntervalMs);
}

process.on('SIGINT',  async () => { await closeBrowser().catch(() => {}); process.exit(0); });
process.on('SIGTERM', async () => { await closeBrowser().catch(() => {}); process.exit(0); });
process.on('unhandledRejection', (e) => logger.error('[worker] Unhandled: ' + e?.message));

main().catch(async (e) => {
  logger.error('[worker] Fatal: ' + e.message);
  await notifyError('Worker fatal: ' + e.message).catch(() => {});
  process.exit(1);
});

// Экспортируем main для режима dev (npm run dev)
module.exports = { main };
