/**
 * src/web/routes/api.js — JSON API
 * Монтируется на /api (под requireAuth).
 *
 * Endpoints:
 *   GET /api/live    — полное состояние системы для dashboard-поллинга
 *   GET /api/health  — статусы сервисов (200/503), для мониторинга
 *   GET /api/worker  — supervisor-детали worker-процесса
 *   GET /api/queue   — очередь с state-машиной и skip_reason
 *   GET /api/jobs    — все заявки с метаданными job
 */

const express = require('express');
const { query } = require('../../db');
const { isNightMsk, formatUptime } = require('../../utils');
const config = require('../../config');

const router = express.Router();

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function getWorkerStatus() {
  const { rows: [ws] } = await query('SELECT * FROM worker_status WHERE id=1');
  return ws || {};
}

function workerAlive(ws) {
  if (!ws || !ws.last_beat) return false;
  return (Date.now() - new Date(ws.last_beat).getTime()) < 90_000;
}

function beatAgeSec(ws) {
  if (!ws || !ws.last_beat) return null;
  return Math.floor((Date.now() - new Date(ws.last_beat).getTime()) / 1000);
}

function uptimeSec(ws) {
  if (!ws || !ws.started_at) return null;
  return Math.floor((Date.now() - new Date(ws.started_at).getTime()) / 1000);
}

// ─────────────────────────────────────────────
// GET /api/live  — dashboard-поллинг (10 сек)
// ─────────────────────────────────────────────

router.get('/live', async (req, res, next) => {
  try {
    const [wsRes, queueRes, historyRes, countsRes] = await Promise.all([

      query('SELECT * FROM worker_status WHERE id = 1'),

      query(`
        SELECT
          vr.id          AS request_id,
          vr.country_name,
          vr.center,
          c.name         AS client_name,
          mj.status      AS job_status,
          mj.state       AS job_state,
          mj.next_check_at,
          mj.last_check_at,
          mj.error_count,
          mj.retry_count,
          EXTRACT(EPOCH FROM (mj.next_check_at - NOW()))::int AS seconds_until
        FROM visa_requests vr
        JOIN clients c         ON c.id  = vr.client_id
        JOIN monitoring_jobs mj ON mj.request_id = vr.id
        WHERE vr.status = 'active'
        ORDER BY mj.status = 'running' DESC, mj.next_check_at ASC
        LIMIT 10
      `),

      query(`
        SELECT
          ch.id, ch.request_id, ch.checked_at,
          ch.result, ch.slots_count, ch.notified, ch.error_msg,
          vr.country_name, vr.center,
          c.name AS client_name
        FROM check_history ch
        JOIN visa_requests vr ON vr.id = ch.request_id
        JOIN clients c        ON c.id  = vr.client_id
        ORDER BY ch.checked_at DESC
        LIMIT 12
      `).catch(() => ({ rows: [] })),

      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'paused') AS paused,
          COUNT(*) FILTER (WHERE status = 'error')  AS error
        FROM visa_requests
      `),
    ]);

    const ws      = wsRes.rows[0] || {};
    const alive   = workerAlive(ws);
    const beatAge = beatAgeSec(ws);

    const dbOk        = true;
    const workerOk    = alive;
    const browserOk   = alive && !!ws.browser_pid;
    const schedulerOk = alive;
    const tgOk        = !!config.telegram.token;

    res.json({
      ts: new Date(),
      worker: {
        alive,
        pid:         ws.pid         || null,
        version:     ws.version     || null,
        started_at:  ws.started_at  || null,
        last_beat:   ws.last_beat   || null,
        beat_age_s:  beatAge,
        beat_count:  ws.beat_count  || 0,
        mem_rss_mb:  ws.mem_rss_mb  || null,
        mem_heap_mb: ws.mem_heap_mb || null,
        current_job: ws.current_job_id
          ? { id: ws.current_job_id, desc: ws.current_job_desc }
          : null,
        last_crash: ws.last_crash_at
          ? { at: ws.last_crash_at, reason: ws.last_crash_reason }
          : null,
      },
      browser: {
        running:    browserOk,
        pid:        ws.browser_pid        || null,
        pages:      ws.browser_pages      || 0,
        checks:     ws.browser_checks     || 0,
        started_at: ws.browser_started_at || null,
      },
      health: {
        worker:    workerOk    ? 'ok' : 'down',
        scheduler: schedulerOk ? 'ok' : 'down',
        browser:   browserOk   ? 'ok' : (alive ? 'idle' : 'unknown'),
        database:  dbOk        ? 'ok' : 'down',
        telegram:  tgOk        ? 'ok' : 'missing',
      },
      queue:   queueRes.rows,
      history: historyRes.rows,
      counts:  countsRes.rows[0] || {},
    });

  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────
// GET /api/health
// ─────────────────────────────────────────────

router.get('/health', async (req, res, next) => {
  const startMs = Date.now();
  try {
    await query('SELECT 1');
    const dbLatencyMs = Date.now() - startMs;

    const ws      = await getWorkerStatus();
    const alive   = workerAlive(ws);
    const beatAge = beatAgeSec(ws);

    const services = {
      worker: {
        status:     !ws.last_beat ? 'unknown'
                  : alive         ? 'ok'
                  : beatAge < 300 ? 'degraded' : 'down',
        beat_age_s: beatAge,
        pid:        ws.pid     || null,
        version:    ws.version || null,
      },
      scheduler: { status: alive ? 'ok' : 'down' },
      browser: {
        status: alive && ws.browser_pid ? 'ok' : (alive ? 'idle' : 'unknown'),
        pid:    ws.browser_pid    || null,
        pages:  ws.browser_pages  || 0,
        checks: ws.browser_checks || 0,
      },
      database: { status: 'ok', latency_ms: dbLatencyMs },
      telegram: { status: config.telegram.token ? 'configured' : 'missing' },
    };

    const statuses = Object.values(services).map(s => s.status);
    const overall  = statuses.includes('down')     ? 'down'
                   : statuses.includes('degraded') ? 'degraded'
                   : 'ok';

    res.status(overall === 'down' ? 503 : 200).json({
      status: overall, timestamp: new Date(), services,
    });
  } catch (e) {
    res.status(503).json({ status: 'down', error: e.message, timestamp: new Date() });
  }
});

// ─────────────────────────────────────────────
// GET /api/worker
// ─────────────────────────────────────────────

router.get('/worker', async (req, res, next) => {
  try {
    const ws = await getWorkerStatus();
    if (!ws || !ws.last_beat) return res.json({ status: 'not_started' });
    const beatAge = beatAgeSec(ws);
    const uptime  = uptimeSec(ws);
    res.json({
      alive:        workerAlive(ws),
      pid:          ws.pid,
      version:      ws.version,
      started_at:   ws.started_at,
      uptime_s:     uptime,
      uptime_human: uptime ? formatUptime(uptime) : null,
      last_beat:    ws.last_beat,
      beat_age_s:   beatAge,
      beat_count:   ws.beat_count,
      current_job:  ws.current_job_id
        ? { id: ws.current_job_id, desc: ws.current_job_desc }
        : null,
      memory: { rss_mb: ws.mem_rss_mb, heap_mb: ws.mem_heap_mb },
      cpu:    { user_ms: ws.cpu_user_ms, sys_ms: ws.cpu_sys_ms },
      browser: {
        running:    !!(ws.browser_pid),
        pid:        ws.browser_pid        || null,
        pages:      ws.browser_pages      || 0,
        checks:     ws.browser_checks     || 0,
        started_at: ws.browser_started_at || null,
      },
      last_crash: ws.last_crash_at
        ? { at: ws.last_crash_at, reason: ws.last_crash_reason }
        : null,
    });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────
// GET /api/queue
// ─────────────────────────────────────────────

router.get('/queue', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        vr.id AS request_id, vr.status AS request_status,
        vr.country_name, vr.center, vr.work_night,
        vr.notify_limit_per_day, vr.interval_minutes, vr.priority,
        c.name AS client_name,
        mj.id AS job_id, mj.status AS job_status, mj.state AS job_state,
        mj.next_check_at, mj.last_check_at,
        mj.error_count, mj.retry_count, mj.retry_at, mj.last_error,
        EXTRACT(EPOCH FROM (mj.next_check_at - NOW()))::int AS seconds_until
      FROM visa_requests vr
      JOIN clients c         ON c.id  = vr.client_id
      JOIN monitoring_jobs mj ON mj.request_id = vr.id
      ORDER BY vr.priority DESC, mj.next_check_at ASC
    `);

    const night = isNightMsk();
    const jobs  = rows.map(j => {
      let effective_state = j.job_state || 'waiting';
      let skip_reason     = null;
      if (j.request_status === 'paused') {
        effective_state = 'paused'; skip_reason = 'на паузе';
      } else if (j.request_status === 'done') {
        effective_state = 'done';   skip_reason = 'завершено';
      } else if (j.request_status === 'error' || j.job_state === 'error') {
        effective_state = 'error';
        skip_reason = `постоянная ошибка (${j.retry_count || 0} попыток)`;
      } else if (j.job_state === 'retry') {
        effective_state = 'retry';
        const mins = Math.max(0, Math.round((j.seconds_until || 0) / 60));
        skip_reason = `retry #${j.retry_count} через ${mins} мин`;
      } else if (j.job_state === 'running' || j.job_status === 'running') {
        effective_state = 'running';
      } else if (night && !j.work_night) {
        skip_reason = 'ночной режим (23:00–07:00 МСК)';
      }
      return { ...j, effective_state, skip_reason };
    });

    const summary = {
      waiting: jobs.filter(j => j.effective_state === 'waiting').length,
      running: jobs.filter(j => j.effective_state === 'running').length,
      retry:   jobs.filter(j => j.effective_state === 'retry').length,
      paused:  jobs.filter(j => j.effective_state === 'paused').length,
      error:   jobs.filter(j => j.effective_state === 'error').length,
    };

    res.json({ night_mode: night, summary, jobs });
  } catch (e) { next(e); }
});

// ─────────────────────────────────────────────
// GET /api/jobs
// ─────────────────────────────────────────────

router.get('/jobs', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT vr.*, c.name AS client_name, c.phone AS client_phone,
             mj.id AS job_id, mj.status AS job_status, mj.state AS job_state,
             mj.last_check_at, mj.next_check_at,
             mj.error_count, mj.retry_count, mj.retry_at, mj.last_error,
             mj.total_checks, mj.check_interval_minutes,
             EXTRACT(EPOCH FROM (mj.next_check_at - NOW()))::int AS seconds_until,
             (SELECT COUNT(*) FROM slot_events  se WHERE se.request_id = vr.id) AS slots_found,
             (SELECT COUNT(*) FROM check_history ch WHERE ch.request_id = vr.id) AS checks_done
      FROM visa_requests vr
      JOIN clients c         ON c.id  = vr.client_id
      LEFT JOIN monitoring_jobs mj ON mj.request_id = vr.id
      ORDER BY vr.priority DESC, vr.created_at DESC
    `);
    res.json({ count: rows.length, jobs: rows });
  } catch (e) { next(e); }
});

module.exports = router;
k_at - NOW()))::int AS seconds_until,
        (SELECT COUNT(*) FROM slot_events  se WHERE se.request_id = vr.id) AS slots_found,
        (SELECT COUNT(*) FROM check_history ch WHERE ch.request_id = vr.id) AS checks_done
      FROM visa_requests vr
      JOIN clients c         ON c.id  = vr.client_id
      LEFT JOIN monitoring_jobs mj ON mj.request_id = vr.id
      ORDER BY vr.priority DESC, vr.created_at DESC
    `);
    res.json({ count: rows.length, jobs: rows });
  } catch (e) { next(e); }
});

module.exports = router;
