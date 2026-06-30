/**
 * src/web/routes/api.js — JSON API для live-обновлений дашборда
 * Монтируется на /api (под requireAuth).
 */

const express = require('express');
const { query } = require('../../db');

const router = express.Router();

// GET /api/live  — всё состояние системы одним запросом
router.get('/live', async (req, res, next) => {
  try {
    const [wsRes, queueRes, historyRes, countsRes] = await Promise.all([

      // Состояние worker (singleton)
      query('SELECT * FROM worker_status WHERE id = 1'),

      // Очередь: все активные заявки, отсортированные по next_check_at
      query(`
        SELECT
          vr.id         AS request_id,
          vr.country_name,
          vr.center,
          c.name        AS client_name,
          mj.status     AS job_status,
          mj.next_check_at,
          mj.last_check_at,
          mj.error_count,
          EXTRACT(EPOCH FROM (mj.next_check_at - NOW()))::int AS seconds_until
        FROM visa_requests vr
        JOIN clients c        ON c.id  = vr.client_id
        JOIN monitoring_jobs mj ON mj.request_id = vr.id
        WHERE vr.status = 'active'
        ORDER BY mj.status = 'running' DESC, mj.next_check_at ASC
        LIMIT 10
      `),

      // Последние 12 записей журнала
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
      `).catch(() => ({ rows: [] })),   // таблица могла не существовать (старый деплой)

      // Агрегаты
      query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'active') AS active,
          COUNT(*) FILTER (WHERE status = 'paused') AS paused,
          COUNT(*) FILTER (WHERE status = 'error')  AS error
        FROM visa_requests
      `),
    ]);

    const ws = wsRes.rows[0] || {};
    const beatAgeMs  = ws.last_beat ? (Date.now() - new Date(ws.last_beat).getTime()) : null;
    const beatAgeSec = beatAgeMs !== null ? Math.floor(beatAgeMs / 1000) : null;

    // Живой = последний бит < 90 сек (3 пропущенных интервала по 30 сек)
    const workerAlive = beatAgeSec !== null && beatAgeSec < 90;

    res.json({
      ts: new Date(),
      worker: {
        alive:       workerAlive,
        pid:         ws.pid || null,
        started_at:  ws.started_at || null,
        last_beat:   ws.last_beat  || null,
        beat_age_s:  beatAgeSec,
        beat_count:  ws.beat_count || 0,
        current_job: ws.current_job_id
          ? { id: ws.current_job_id, desc: ws.current_job_desc }
          : null,
      },
      queue:   queueRes.rows,
      history: historyRes.rows,
      counts:  countsRes.rows[0] || {},
    });

  } catch (e) { next(e); }
});

module.exports = router;
