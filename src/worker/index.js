/**
 * src/worker/index.js — Worker мониторинга
 *
 * Алгоритм:
 * 1. Каждые WORKER_POLL_MS (60 сек) смотрим в БД
 * 2. Берём все active заявки у которых job.next_check_at <= NOW()
 * 3. Пропускаем заявки с work_night=false в ночное время МСК (23:00–07:00)
 * 4. Сортировка: priority DESC, next_check_at ASC
 * 5. Для каждой: vfs.checkSlots() → slot_events + Telegram + check_history
 * 6. Анти-спам: не отправлять больше notify_limit_per_day уведомлений в сутки
 * 7. При ошибке 5+ подряд → заявка переходит в error
 */

require('dotenv').config();

const { query, migrate } = require('../db');
const { checkSlots }     = require('../services/vfs');
const { notifySlots, notifyWorkerStart, notifyError } = require('../services/notifier');
const { closeBrowser, sleep } = require('../browser');
const logger = require('../logger');
const config = require('../config');

const MAX_ERRORS   = 5;
const DEDUP_TTL_MS = config.worker.dedupTtlMs;

// In-memory дедупликация: requestId → Map(slotKey → timestamp)
const seenSlots = new Map();

// ─────────────────────────────────────────────
// НОЧНОЕ ВРЕМЯ МСК
// ─────────────────────────────────────────────

function isNightMsk() {
  // МСК = UTC+3, midnight window: 23:00–07:00
  const msk  = new Date(Date.now() + 3 * 3600 * 1000);
  const hour = msk.getUTCHours();
  return hour >= 23 || hour < 7;
}

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

function nextCheckAt(intervalMin, jitterMin) {
  const jitter = jitterMin ?? config.worker.jitterMin;
  const delta  = (intervalMin + (Math.random() * 2 - 1) * jitter) * 60 * 1000;
  return new Date(Date.now() + delta);
}

// ─────────────────────────────────────────────
// ЗАПИСЬ ИСТОРИИ
// ─────────────────────────────────────────────

async function writeHistory({ requestId, jobId, result, slotsCount, notified, errorMsg }) {
  try {
    await query(`
      INSERT INTO check_history(request_id, job_id, result, slots_count, notified, error_msg)
      VALUES($1,$2,$3,$4,$5,$6)
    `, [requestId, jobId, result, slotsCount || 0, notified || false, errorMsg || null]);
  } catch (e) {
    // check_history может не существовать на старых деплоях до применения миграции
    logger.warn('[worker] check_history insert failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────
// ОБРАБОТКА ОДНОЙ ЗАЯВКИ
// ─────────────────────────────────────────────

async function processRequest(vr, job) {
  const reqId      = vr.id;
  const jobId      = job.id;
  const intervalMin = vr.interval_minutes || config.worker.defaultIntervalMin;
  const jitterMin   = vr.jitter_minutes   || config.worker.jitterMin;

  logger.info(`[worker] Заявка #${reqId}: ${vr.country_name} / ${vr.center} (${vr.client_name})`);

  // Помечаем job как running
  await query(
    "UPDATE monitoring_jobs SET status='running' WHERE id=$1",
    [jobId]
  );

  try {
    const slots = await checkSlots({
      countryCode: vr.country_code,
      center:      vr.center,
      category:    vr.category,
      subcategory: vr.subcategory,
      dateFrom:    vr.date_from,
      dateTo:      vr.date_to,
    });

    logger.info(`[worker] Заявка #${reqId}: найдено ${slots.length} слотов`);

    const newSlots = slots.filter(s => isNewSlot(reqId, s));
    let notified  = false;
    let msgText   = '';

    if (newSlots.length > 0) {
      logger.info(`[worker] Заявка #${reqId}: ${newSlots.length} новых → проверяем лимит уведомлений`);

      // Лимит уведомлений за сутки (из check_history)
      const limitPerDay = vr.notify_limit_per_day ?? 5;
      const { rows: [{ cnt }] } = await query(`
        SELECT COUNT(*) AS cnt FROM check_history
        WHERE request_id = $1 AND notified = true
        AND checked_at > NOW() - INTERVAL '24 hours'
      `, [reqId]).catch(() => ({ rows: [{ cnt: '0' }] }));
      const notifToday = parseInt(cnt);

      if (notifToday >= limitPerDay) {
        logger.info(`[worker] Заявка #${reqId}: лимит уведомлений (${notifToday}/${limitPerDay}) — пропускаем Telegram`);
      } else {
        // Сохраняем slot_events
        const savedEvents = [];
        for (const s of newSlots) {
          const { rows: [ev] } = await query(`
            INSERT INTO slot_events(request_id, job_id, slot_date, slot_time, center, raw_data)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id
          `, [reqId, jobId, s.date, s.time || null, s.center || vr.center, JSON.stringify(s)]);
          savedEvents.push(ev);
        }

        // Telegram — основной чат (админ)
        const client  = { name: vr.client_name, phone: vr.client_phone };
        const request = vr; // все поля заявки уже в vr

        try {
          await notifySlots({ client, request, slots: newSlots, requestId: reqId });
          notified = true;
        } catch (tgErr) {
          logger.error(`[worker] Telegram admin error: ${tgErr.message}`);
        }

        // Telegram — клиентский чат (если настроен)
        if (vr.notify_client_telegram) {
          try {
            await notifySlots({
              client, request, slots: newSlots, requestId: reqId,
              chatId: vr.notify_client_telegram,
            });
          } catch (tgErr) {
            logger.error(`[worker] Telegram client error: ${tgErr.message}`);
          }
        }

        // Сохраняем в таблицу notifications
        msgText = `${vr.country_name}/${vr.center} — ${newSlots.length} слот(ов)`;
        for (const ev of savedEvents) {
          await query(`
            INSERT INTO notifications(request_id, slot_event_id, channel, message, status)
            VALUES($1,$2,'telegram',$3,'sent')
          `, [reqId, ev.id, msgText]).catch(() => {});
        }
      }
    }

    // Пишем историю проверки
    await writeHistory({
      requestId: reqId,
      jobId,
      result:     newSlots.length > 0 ? 'slot_found' : 'no_slots',
      slotsCount: newSlots.length,
      notified,
    });

    // Сбрасываем ошибки, обновляем времена
    const nextAt = nextCheckAt(intervalMin, jitterMin);
    await query(`
      UPDATE monitoring_jobs
      SET status='idle', last_check_at=NOW(), next_check_at=$1,
          error_count=0, last_error=NULL,
          total_checks = COALESCE(total_checks,0) + 1
      WHERE id=$2
    `, [nextAt, jobId]);

    logger.info(`[worker] Заявка #${reqId}: следующая проверка в ${nextAt.toLocaleString('ru-RU')}`);

  } catch (err) {
    logger.error(`[worker] Ошибка заявки #${reqId}: ${err.message}`);

    const newErrCount = (job.error_count || 0) + 1;
    const nextAt = nextCheckAt(intervalMin * 2, jitterMin); // увеличиваем интервал при ошибке

    await writeHistory({
      requestId: reqId,
      jobId,
      result:   'error',
      errorMsg: err.message.slice(0, 500),
    });

    await query(`
      UPDATE monitoring_jobs
      SET status='error', last_check_at=NOW(), next_check_at=$1,
          error_count=$2, last_error=$3,
          total_checks = COALESCE(total_checks,0) + 1
      WHERE id=$4
    `, [nextAt, newErrCount, err.message.slice(0, 500), jobId]);

    if (newErrCount >= MAX_ERRORS) {
      await query(
        "UPDATE visa_requests SET status='error', updated_at=NOW() WHERE id=$1",
        [reqId]
      );
      await notifyError(
        `Заявка #${reqId} (${vr.client_name} / ${vr.country_name}) → error после ${newErrCount} ошибок.\n` +
        `Последняя: ${err.message}`
      ).catch(() => {});
    }
  }
}

// ─────────────────────────────────────────────
// ОСНОВНОЙ ЦИКЛ
// ─────────────────────────────────────────────

async function tick() {
  // Ночной режим: проверяем глобально, нужно ли вообще что-то делать
  const nightMode = isNightMsk();

  const { rows } = await query(`
    SELECT vr.*, c.name AS client_name, c.phone AS client_phone,
           mj.id AS job_id_col, mj.status AS job_status,
           mj.error_count, mj.last_error, mj.check_interval_minutes,
           mj.next_check_at
    FROM visa_requests vr
    JOIN clients c ON c.id = vr.client_id
    JOIN monitoring_jobs mj ON mj.request_id = vr.id
    WHERE vr.status = 'active'
      AND mj.status != 'running'
      AND mj.next_check_at <= NOW()
    ORDER BY vr.priority DESC, mj.next_check_at ASC
  `);

  if (rows.length === 0) {
    logger.info('[worker] Нет заявок для проверки');
    return;
  }

  logger.info(`[worker] Tick: ${rows.length} заявок${nightMode ? ' (ночной режим МСК)' : ''}`);

  for (const row of rows) {
    // Ночной режим: пропускаем заявки где work_night=false
    if (nightMode && !row.work_night) {
      logger.info(`[worker] Заявка #${row.id}: ночной режим, пропускаем (work_night=false)`);
      continue;
    }

    const job = {
      id:                    row.job_id_col,
      status:                row.job_status,
      check_interval_minutes: row.check_interval_minutes,
      error_count:           row.error_count,
      last_error:            row.last_error,
    };
    await processRequest(row, job);

    // Пауза между заявками — 20-40 сек
    const pause = 20_000 + Math.random() * 20_000;
    await sleep(pause);
  }

  await closeBrowser().catch(() => {});
}

// ─────────────────────────────────────────────
// СТАРТ
// ─────────────────────────────────────────────

async function main() {
  logger.info('[worker] === Adria Travel Monitor Worker стартует ===');

  await migrate();

  const { rows } = await query("SELECT COUNT(*) FROM visa_requests WHERE status='active'");
  const activeCount = parseInt(rows[0].count);
  await notifyWorkerStart(activeCount).catch(() => {});

  // Сбрасываем застрявшие running статусы
  await query("UPDATE monitoring_jobs SET status='idle' WHERE status='running'");

  logger.info(`[worker] Активных заявок: ${activeCount}`);
  logger.info(`[worker] Интервал опроса БД: ${config.worker.pollIntervalMs / 1000} сек`);

  await tick().catch(e => logger.error('[worker] Ошибка тика: ' + e.message));

  setInterval(async () => {
    try { await tick(); }
    catch (e) { logger.error('[worker] Ошибка тика: ' + e.message); }
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

module.exports = { main };
