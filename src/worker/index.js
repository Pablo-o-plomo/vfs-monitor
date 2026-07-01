/**
 * src/worker/index.js — Worker мониторинга (v2 supervisor)
 *
 * Алгоритм:
 * 1. Каждые WORKER_POLL_MS смотрим в БД все active заявки с next_check_at <= NOW()
 * 2. Пропускаем заявки с work_night=false в ночное время МСК (23:00–07:00)
 * 3. Сортировка: priority DESC, next_check_at ASC
 * 4. Для каждой: checkSlots() → slot_events + Telegram + check_history
 * 5. Анти-спам: не отправлять больше notify_limit_per_day уведомлений за 24ч
 * 6. Retry: ошибка → [5мин, 15мин, 30мин] затем permanent error
 * 7. Heartbeat каждые 30с: pid, mem, cpu, browser state
 * 8. При uncaughtException: пишем last_crash в БД, уведомляем, выходим
 */

require('dotenv').config();

const { query, migrate } = require('../db');
const { checkSlots }     = require('../services/vfs');
const { notifySlots, notifyWorkerStart, notifyError } = require('../services/notifier');
const { closeBrowser, sleep, getBrowserState, incrementBrowserChecks } = require('../browser');
const { isNightMsk } = require('../utils');
const logger = require('../logger');
const config = require('../config');

const APP_VERSION  = require('../../package.json').version;

const DEDUP_TTL_MS  = config.worker.dedupTtlMs;
const HEARTBEAT_MS  = 30_000;            // каждые 30 сек
const RETRY_DELAYS  = [5, 15, 30];       // минуты: 1-я ошибка, 2-я, 3-я; 4-я → permanent

const workerStartedAt = new Date();

// In-memory дедупликация: requestId → Map(slotKey → timestamp)
const seenSlots = new Map();

// ─────────────────────────────────────────────
// HEARTBEAT (расширенный)
// ─────────────────────────────────────────────

async function heartbeat() {
  try {
    const mem    = process.memoryUsage();
    const cpu    = process.cpuUsage();
    const bState = getBrowserState();

    await query(`
      INSERT INTO worker_status(id, pid, started_at, last_beat, beat_count,
        version, mem_rss_mb, mem_heap_mb, cpu_user_ms, cpu_sys_ms,
        browser_pid, browser_pages, browser_checks, browser_started_at)
      VALUES (1, $1, $2, NOW(), 1, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (id) DO UPDATE SET
        last_beat        = NOW(),
        beat_count       = worker_status.beat_count + 1,
        pid              = EXCLUDED.pid,
        started_at       = COALESCE(worker_status.started_at, EXCLUDED.started_at),
        version          = $3,
        mem_rss_mb       = $4,
        mem_heap_mb      = $5,
        cpu_user_ms      = $6,
        cpu_sys_ms       = $7,
        browser_pid      = $8,
        browser_pages    = $9,
        browser_checks   = $10,
        browser_started_at = $11
    `, [
      process.pid,
      workerStartedAt,
      APP_VERSION,
      +(mem.rss       / 1024 / 1024).toFixed(2),
      +(mem.heapUsed  / 1024 / 1024).toFixed(2),
      Math.floor(cpu.user   / 1000),   // мкс → мс
      Math.floor(cpu.system / 1000),
      bState.pid,
      bState.pages,
      bState.checks,
      bState.started_at,
    ]);
  } catch (e) {
    logger.warn('[worker] heartbeat failed: ' + e.message);
  }
}

async function setCurrentJob(id, desc) {
  await query(
    'UPDATE worker_status SET current_job_id=$1, current_job_desc=$2 WHERE id=1',
    [id, desc]
  ).catch(() => {});
}

async function clearCurrentJob() {
  await query(
    'UPDATE worker_status SET current_job_id=NULL, current_job_desc=NULL WHERE id=1'
  ).catch(() => {});
}

async function writeCrash(reason) {
  await query(
    'UPDATE worker_status SET last_crash_at=NOW(), last_crash_reason=$1 WHERE id=1',
    [String(reason).slice(0, 500)]
  ).catch(() => {});
}

// ─────────────────────────────────────────────
// ДЕДУПЛИКАЦИЯ
// ─────────────────────────────────────────────

function isNewSlot(requestId, slot) {
  const now = Date.now();
  if (!seenSlots.has(requestId)) seenSlots.set(requestId, new Map());
  const seen = seenSlots.get(requestId);

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
    logger.warn('[worker] check_history insert failed: ' + e.message);
  }
}

// ─────────────────────────────────────────────
// ОБРАБОТКА ОДНОЙ ЗАЯВКИ
// ─────────────────────────────────────────────

async function processRequest(vr, job) {
  const reqId       = vr.id;
  const jobId       = job.id;
  const intervalMin = vr.interval_minutes || config.worker.defaultIntervalMin;
  const jitterMin   = vr.jitter_minutes   || config.worker.jitterMin;

  logger.info(`[worker] Заявка #${reqId}: ${vr.country_name} / ${vr.center} (${vr.client_name})`);

  await setCurrentJob(reqId, `${vr.country_name} / ${vr.center} — ${vr.client_name}`);

  // Помечаем job как running + state=running
  await query(
    "UPDATE monitoring_jobs SET status='running', state='running' WHERE id=$1",
    [jobId]
  );

  try {
    const slots = await checkSlots({
      countryCode:    vr.country_code,
      center:         vr.center,
      category:       vr.category,
      subcategory:    vr.subcategory,
      dateFrom:       vr.date_from,
      dateTo:         vr.date_to,
      firstName:      vr.first_name      || null,
      lastName:       vr.last_name       || null,
      birthDate:      vr.birth_date      || null,
      gender:         vr.gender          || null,
      citizenship:    vr.citizenship     || null,
      passportNum:    vr.passport_num    || null,
      applicantEmail: vr.applicant_email || null,
      applicantPhone: vr.applicant_phone || null,
    });

    // Считаем проверку в browser pool
    incrementBrowserChecks();

    logger.info(`[worker] Заявка #${reqId}: найдено ${slots.length} слотов`);

    const newSlots = slots.filter(s => isNewSlot(reqId, s));
    let notified  = false;

    if (newSlots.length > 0) {
      logger.info(`[worker] Заявка #${reqId}: ${newSlots.length} новых → проверяем лимит`);

      const limitPerDay = vr.notify_limit_per_day ?? 5;
      const { rows: [{ cnt }] } = await query(`
        SELECT COUNT(*) AS cnt FROM check_history
        WHERE request_id = $1 AND notified = true
          AND checked_at > NOW() - INTERVAL '24 hours'
      `, [reqId]).catch(() => ({ rows: [{ cnt: '0' }] }));
      const notifToday = parseInt(cnt);

      if (notifToday >= limitPerDay) {
        logger.info(`[worker] Заявка #${reqId}: лимит (${notifToday}/${limitPerDay})`);
      } else {
        const savedEvents = [];
        for (const s of newSlots) {
          const { rows: [ev] } = await query(`
            INSERT INTO slot_events(request_id, job_id, slot_date, slot_time, center, raw_data)
            VALUES($1,$2,$3,$4,$5,$6) RETURNING id
          `, [reqId, jobId, s.date, s.time || null, s.center || vr.center, JSON.stringify(s)]);
          savedEvents.push(ev);
        }

        const client  = { name: vr.client_name, phone: vr.client_phone };
        const request = vr;

        try {
          await notifySlots({ client, request, slots: newSlots, requestId: reqId });
          notified = true;
        } catch (tgErr) {
          logger.error(`[worker] Telegram admin error: ${tgErr.message}`);
        }

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

        const msgText = `${vr.country_name}/${vr.center} — ${newSlots.length} слот(ов)`;
        for (const ev of savedEvents) {
          await query(`
            INSERT INTO notifications(request_id, slot_event_id, channel, message, status)
            VALUES($1,$2,'telegram',$3,'sent')
          `, [reqId, ev.id, msgText]).catch(() => {});
        }
      }
    }

    await writeHistory({
      requestId: reqId,
      jobId,
      result:     newSlots.length > 0 ? 'slot_found' : 'no_slots',
      slotsCount: newSlots.length,
      notified,
    });

    // Успех → сбрасываем retry, ставим waiting
    const nextAt = nextCheckAt(intervalMin, jitterMin);
    await query(`
      UPDATE monitoring_jobs
      SET status='idle', state='waiting', last_check_at=NOW(), next_check_at=$1,
          error_count=0, last_error=NULL, retry_count=0, retry_at=NULL,
          total_checks = COALESCE(total_checks, 0) + 1
      WHERE id=$2
    `, [nextAt, jobId]);

    logger.info(`[worker] Заявка #${reqId}: следующая в ${nextAt.toLocaleString('ru-RU')}`);

  } catch (err) {
    logger.error(`[worker] Ошибка заявки #${reqId}: ${err.message}`);

    const newRetryCount = (job.retry_count || 0) + 1;
    const isPermanent   = newRetryCount > RETRY_DELAYS.length;

    await writeHistory({
      requestId: reqId,
      jobId,
      result:   'error',
      errorMsg: err.message.slice(0, 500),
    });

    if (isPermanent) {
      // Перманентная ошибка — заявка → error
      await query(`
        UPDATE monitoring_jobs
        SET status='error', state='error', last_check_at=NOW(),
            error_count=$1, retry_count=$1, last_error=$2,
            total_checks = COALESCE(total_checks, 0) + 1
        WHERE id=$3
      `, [newRetryCount, err.message.slice(0, 500), jobId]);

      await query(
        "UPDATE visa_requests SET status='error', updated_at=NOW() WHERE id=$1",
        [reqId]
      );

      await notifyError(
        `Заявка #${reqId} (${vr.client_name} / ${vr.country_name}) → постоянная ошибка` +
        ` после ${newRetryCount} попыток.\nПоследняя: ${err.message}`
      ).catch(() => {});

      logger.error(`[worker] Заявка #${reqId}: PERMANENT ERROR после ${newRetryCount} попыток`);
    } else {
      // Временная ошибка — ставим retry с задержкой
      const delayMin = RETRY_DELAYS[newRetryCount - 1];
      const retryAt  = new Date(Date.now() + delayMin * 60 * 1000);

      await query(`
        UPDATE monitoring_jobs
        SET status='error', state='retry', last_check_at=NOW(),
            next_check_at=$1, retry_at=$1, error_count=$2, retry_count=$2,
            last_error=$3,
            total_checks = COALESCE(total_checks, 0) + 1
        WHERE id=$4
      `, [retryAt, newRetryCount, err.message.slice(0, 500), jobId]);

      logger.info(`[worker] Заявка #${reqId}: retry #${newRetryCount} через ${delayMin} мин`);
    }
  } finally {
    await clearCurrentJob();
  }
}

// ─────────────────────────────────────────────
// ОСНОВНОЙ ЦИКЛ
// ─────────────────────────────────────────────

async function tick() {
  const nightMode = isNightMsk();

  const { rows } = await query(`
    SELECT vr.*, c.name AS client_name, c.phone AS client_phone,
           mj.id AS job_id_col, mj.status AS job_status, mj.state AS job_state,
           mj.error_count, mj.last_error, mj.check_interval_minutes,
           mj.next_check_at, mj.retry_count
    FROM visa_requests vr
    JOIN clients c         ON c.id  = vr.client_id
    JOIN monitoring_jobs mj ON mj.request_id = vr.id
    WHERE vr.status = 'active'
      AND (mj.state IS NULL OR mj.state IN ('waiting', 'retry'))
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
    if (nightMode && !row.work_night) {
      logger.info(`[worker] Заявка #${row.id}: ночной режим, пропускаем (work_night=false)`);
      continue;
    }

    const job = {
      id:                     row.job_id_col,
      status:                 row.job_status,
      state:                  row.job_state || 'waiting',
      check_interval_minutes: row.check_interval_minutes,
      error_count:            row.error_count || 0,
      retry_count:            row.retry_count || 0,
      last_error:             row.last_error,
    };
    await processRequest(row, job);

    const pause = 20_000 + Math.random() * 20_000;
    await sleep(pause);
  }

  await closeBrowser().catch(() => {});
}

// ─────────────────────────────────────────────
// СТАРТ
// ─────────────────────────────────────────────

async function main() {
  logger.info('[worker] === Adria Travel Monitor Worker стартует (v' + APP_VERSION + ') ===');

  await migrate();

  await query("UPDATE monitoring_jobs SET status='idle', state='waiting' WHERE status='running'");
  await clearCurrentJob();

  await heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);

  const { rows } = await query("SELECT COUNT(*) FROM visa_requests WHERE status='active'");
  const activeCount = parseInt(rows[0].count);
  await notifyWorkerStart(activeCount).catch(() => {});

  logger.info(`[worker] Активных заявок: ${activeCount}`);
  logger.info(`[worker] Retry delays: ${RETRY_DELAYS.join(', ')} мин → permanent error`);
  logger.info(`[worker] Heartbeat: каждые ${HEARTBEAT_MS / 1000} сек`);

  await tick().catch(e => logger.error('[worker] Ошибка тика: ' + e.message));

  setInterval(async () => {
    try { await tick(); }
    catch (e) { logger.error('[worker] Ошибка тика: ' + e.message); }
  }, config.worker.pollIntervalMs);
}

// ─────────────────────────────────────────────
// CRASH HANDLER
// ─────────────────────────────────────────────

process.on('uncaughtException', async (err) => {
  logger.error('[worker] UNCAUGHT EXCEPTION: ' + err.message + '\n' + (err.stack || ''));
  await writeCrash(err.message || String(err));
  await notifyError('Worker crash: ' + err.message).catch(() => {});
  await closeBrowser().catch(() => {});
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('[worker] Unhandled Rejection: ' + (reason?.message || String(reason)));
});

process.on('SIGINT', () => {
  logger.info('[worker] SIGINT received, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('[worker] SIGTERM received, shutting down...');
  process.exit(0);
});

module.exports = { main };
