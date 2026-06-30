const express = require('express');
const { query } = require('../../db');
const config   = require('../../config');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [
      clientsRes, activeRes, pausedRes, errorRes, slots24hRes, pendingRes, workerRes, recentRes, checksRes,
    ] = await Promise.all([
      query('SELECT COUNT(*) FROM clients'),
      query("SELECT COUNT(*) FROM visa_requests WHERE status = 'active'"),
      query("SELECT COUNT(*) FROM visa_requests WHERE status = 'paused'"),
      query("SELECT COUNT(*) FROM visa_requests WHERE status = 'error'"),
      query("SELECT COUNT(*) FROM slot_events WHERE found_at > NOW() - INTERVAL '24 hours'"),
      query("SELECT COUNT(*) FROM monitoring_jobs WHERE next_check_at <= NOW() AND status != 'running'"),
      // Последняя активность worker: MAX(last_check_at)
      query("SELECT MAX(last_check_at) AS last_seen FROM monitoring_jobs"),
      // Последние 10 найденных слотов
      query(`
        SELECT se.*, vr.center, vr.country_name, vr.category, vr.subcategory,
               c.name AS client_name, vr.id AS vr_id
        FROM slot_events se
        JOIN visa_requests vr ON vr.id = se.request_id
        JOIN clients c ON c.id = vr.client_id
        ORDER BY se.found_at DESC
        LIMIT 10
      `),
      // Проверок за сегодня (из check_history, если существует)
      query("SELECT COUNT(*) FROM check_history WHERE checked_at > NOW() - INTERVAL '24 hours'")
        .catch(() => ({ rows: [{ count: '—' }] })),
    ]);

    // Статус worker: считаем живым если last_check_at < 10 мин назад
    const lastSeen   = workerRes.rows[0].last_seen;
    const workerAliveMs = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) : Infinity;
    const workerStatus  = !lastSeen             ? 'unknown'
                        : workerAliveMs < 10 * 60 * 1000 ? 'ok'
                        : workerAliveMs < 30 * 60 * 1000 ? 'warn'
                        : 'dead';

    // Статус Telegram: токен присутствует (runtime-проверка без HTTP-запроса)
    const telegramStatus = config.telegram.token ? 'ok' : 'dead';

    res.render('dashboard', {
      stats: {
        clients:  parseInt(clientsRes.rows[0].count),
        active:   parseInt(activeRes.rows[0].count),
        paused:   parseInt(pausedRes.rows[0].count),
        error:    parseInt(errorRes.rows[0].count),
        slots24h: parseInt(slots24hRes.rows[0].count),
        pending:  parseInt(pendingRes.rows[0].count),
        checks24h: checksRes.rows[0].count,
      },
      svc: {
        worker:   workerStatus,
        workerAt: lastSeen ? new Date(lastSeen).toLocaleString('ru-RU') : null,
        db:       'ok',       // мы уже сделали запрос — если дошли сюда, DB живёт
        telegram: telegramStatus,
      },
      recentSlots: recentRes.rows,
    });
  } catch (e) { next(e); }
});

module.exports = router;
