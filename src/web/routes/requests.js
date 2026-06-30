const express = require('express');
const { query } = require('../../db');

const router = express.Router();

// Страны для формы
const COUNTRIES = [
  { code: 'hun', name: 'Венгрия' },
  { code: 'deu', name: 'Германия' },
  { code: 'fra', name: 'Франция' },
  { code: 'ita', name: 'Италия' },
  { code: 'esp', name: 'Испания' },
  { code: 'grc', name: 'Греция' },
  { code: 'cze', name: 'Чехия' },
  { code: 'aut', name: 'Австрия' },
  { code: 'pol', name: 'Польша' },
  { code: 'svk', name: 'Словакия' },
];

// Форма новой заявки (привязана к клиенту)
router.get('/clients/:clientId/requests/new', async (req, res, next) => {
  try {
    const client = await query('SELECT * FROM clients WHERE id = $1', [req.params.clientId]);
    if (!client.rows.length) return res.status(404).render('404');
    res.render('requests/new', {
      client: client.rows[0],
      countries: COUNTRIES,
      error: null,
      values: {},
    });
  } catch (e) { next(e); }
});

// Создать заявку
router.post('/clients/:clientId/requests', async (req, res, next) => {
  const {
    country_code, country_name, center, category, subcategory,
    date_from, date_to, notes,
  } = req.body;
  const clientId = req.params.clientId;

  const missing = [];
  if (!center)      missing.push('Визовый центр');
  if (!category)    missing.push('Категория');
  if (!subcategory) missing.push('Подкатегория');
  if (!date_from)   missing.push('Дата от');
  if (!date_to)     missing.push('Дата до');

  if (missing.length) {
    const client = await query('SELECT * FROM clients WHERE id = $1', [clientId]);
    return res.render('requests/new', {
      client: client.rows[0],
      countries: COUNTRIES,
      error: `Заполните: ${missing.join(', ')}`,
      values: req.body,
    });
  }

  try {
    const countryLabel = COUNTRIES.find(c => c.code === country_code)?.name || country_name || country_code;

    // Создаём заявку
    const { rows: [vr] } = await query(`
      INSERT INTO visa_requests
        (client_id, country_code, country_name, center, category, subcategory, date_from, date_to, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
    `, [clientId, country_code, countryLabel, center, category, subcategory, date_from, date_to, notes || null]);

    // Сразу создаём monitoring_job
    await query(
      'INSERT INTO monitoring_jobs(request_id, next_check_at) VALUES($1, NOW())',
      [vr.id]
    );

    res.redirect(`/requests/${vr.id}`);
  } catch (e) { next(e); }
});

// Детальная страница заявки
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: [vr] } = await query(`
      SELECT vr.*, c.name AS client_name, c.id AS client_id,
             mj.id AS job_id, mj.status AS job_status,
             mj.last_check_at, mj.next_check_at,
             mj.error_count, mj.last_error, mj.check_interval_minutes
      FROM visa_requests vr
      JOIN clients c ON c.id = vr.client_id
      LEFT JOIN monitoring_jobs mj ON mj.request_id = vr.id
      WHERE vr.id = $1
    `, [req.params.id]);

    if (!vr) return res.status(404).render('404');

    const { rows: slots } = await query(`
      SELECT * FROM slot_events WHERE request_id = $1 ORDER BY found_at DESC LIMIT 50
    `, [req.params.id]);

    const { rows: notifications } = await query(`
      SELECT * FROM notifications WHERE request_id = $1 ORDER BY sent_at DESC LIMIT 20
    `, [req.params.id]);

    res.render('requests/show', { vr, slots, notifications });
  } catch (e) { next(e); }
});

// Пауза
router.post('/:id/pause', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='paused', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

// Возобновить
router.post('/:id/resume', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='active', updated_at=NOW() WHERE id=$1", [req.params.id]);
    // Сбросить next_check_at на NOW() чтобы worker подхватил немедленно
    await query(
      "UPDATE monitoring_jobs SET next_check_at=NOW(), status='idle', error_count=0 WHERE request_id=$1",
      [req.params.id]
    );
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

// Завершить (done)
router.post('/:id/done', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='done', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

// Удалить заявку
router.post('/:id/delete', async (req, res, next) => {
  try {
    const { rows: [vr] } = await query('SELECT client_id FROM visa_requests WHERE id=$1', [req.params.id]);
    await query('DELETE FROM visa_requests WHERE id=$1', [req.params.id]);
    res.redirect(vr ? `/clients/${vr.client_id}` : '/clients');
  } catch (e) { next(e); }
});

module.exports = router;
