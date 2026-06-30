const express = require('express');
const { query } = require('../../db');

const router = express.Router();

// Список клиентов
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.*,
        COUNT(vr.id) FILTER (WHERE vr.status = 'active') AS active_requests,
        COUNT(vr.id) AS total_requests
      FROM clients c
      LEFT JOIN visa_requests vr ON vr.client_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.render('clients/index', { clients: rows });
  } catch (e) { next(e); }
});

// Форма создания
router.get('/new', (req, res) => {
  res.render('clients/new', { error: null, values: {} });
});

// Создать клиента
router.post('/', async (req, res, next) => {
  const { name, phone, email, notes } = req.body;
  if (!name || !name.trim()) {
    return res.render('clients/new', {
      error: 'Имя обязательно',
      values: req.body,
    });
  }
  try {
    const { rows } = await query(
      'INSERT INTO clients(name, phone, email, notes) VALUES($1,$2,$3,$4) RETURNING id',
      [name.trim(), phone || null, email || null, notes || null]
    );
    res.redirect(`/clients/${rows[0].id}`);
  } catch (e) { next(e); }
});

// Карточка клиента
router.get('/:id', async (req, res, next) => {
  try {
    const client = await query('SELECT * FROM clients WHERE id = $1', [req.params.id]);
    if (!client.rows.length) return res.status(404).render('404');

    const requests = await query(`
      SELECT vr.*, mj.status AS job_status, mj.last_check_at, mj.next_check_at,
             mj.error_count, mj.last_error, mj.id AS job_id,
             (SELECT COUNT(*) FROM slot_events se WHERE se.request_id = vr.id) AS slots_found
      FROM visa_requests vr
      LEFT JOIN monitoring_jobs mj ON mj.request_id = vr.id
      WHERE vr.client_id = $1
      ORDER BY vr.created_at DESC
    `, [req.params.id]);

    res.render('clients/show', {
      client: client.rows[0],
      requests: requests.rows,
    });
  } catch (e) { next(e); }
});

// Удалить клиента
router.post('/:id/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM clients WHERE id = $1', [req.params.id]);
    res.redirect('/clients');
  } catch (e) { next(e); }
});

module.exports = router;
