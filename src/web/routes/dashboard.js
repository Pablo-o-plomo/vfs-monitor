const express = require('express');
const { query } = require('../../db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const [clients, requests, slots, pending] = await Promise.all([
      query('SELECT COUNT(*) FROM clients'),
      query("SELECT COUNT(*) FROM visa_requests WHERE status = 'active'"),
      query('SELECT COUNT(*) FROM slot_events WHERE found_at > NOW() - INTERVAL \'24 hours\''),
      query("SELECT COUNT(*) FROM monitoring_jobs WHERE next_check_at <= NOW() AND status != 'running'"),
    ]);

    // Последние 10 найденных слотов с инфо о заявке и клиенте
    const recent = await query(`
      SELECT se.*, vr.center, vr.country_name, vr.category, vr.subcategory,
             c.name AS client_name
      FROM slot_events se
      JOIN visa_requests vr ON vr.id = se.request_id
      JOIN clients c ON c.id = vr.client_id
      ORDER BY se.found_at DESC
      LIMIT 10
    `);

    res.render('dashboard', {
      stats: {
        clients:  parseInt(clients.rows[0].count),
        active:   parseInt(requests.rows[0].count),
        slots24h: parseInt(slots.rows[0].count),
        pending:  parseInt(pending.rows[0].count),
      },
      recentSlots: recent.rows,
    });
  } catch (e) { next(e); }
});

module.exports = router;
