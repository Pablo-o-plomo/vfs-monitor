/**
 * src/web/routes/requests.js
 * Маршруты для заявок. Монтируется на app.use('/', router).
 * Все маршруты к заявкам используют префикс /requests/:id.
 */

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

// ─── Форма новой заявки ────────────────────────────────────────────────────────

router.get('/clients/:clientId/requests/new', async (req, res, next) => {
  try {
    const { rows: [client] } = await query('SELECT * FROM clients WHERE id = $1', [req.params.clientId]);
    if (!client) return res.status(404).render('404');
    res.render('requests/new', {
      client,
      countries: COUNTRIES,
      error: null,
      values: {},
    });
  } catch (e) { next(e); }
});

// ─── Создать заявку ────────────────────────────────────────────────────────────

router.post('/clients/:clientId/requests', async (req, res, next) => {
  const {
    country_code, country_name, center, category, subcategory,
    date_from, date_to, notes,
    interval_minutes, jitter_minutes, notify_limit_per_day,
    notify_client_telegram, work_night, priority,
  } = req.body;
  const clientId = req.params.clientId;

  const missing = [];
  if (!center)      missing.push('Визовый центр');
  if (!category)    missing.push('Категория');
  if (!subcategory) missing.push('Подкатегория');
  if (!date_from)   missing.push('Дата от');
  if (!date_to)     missing.push('Дата до');

  if (missing.length) {
    const { rows: [client] } = await query('SELECT * FROM clients WHERE id = $1', [clientId]);
    return res.render('requests/new', {
      client,
      countries: COUNTRIES,
      error: `Заполните: ${missing.join(', ')}`,
      values: req.body,
    });
  }

  try {
    const countryLabel = COUNTRIES.find(c => c.code === country_code)?.name || country_name || country_code;

    const { rows: [vr] } = await query(`
      INSERT INTO visa_requests
        (client_id, country_code, country_name, center, category, subcategory,
         date_from, date_to, notes,
         interval_minutes, jitter_minutes, notify_limit_per_day,
         notify_client_telegram, work_night, priority)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING id
    `, [
      clientId,
      country_code,
      countryLabel,
      center,
      category,
      subcategory,
      date_from,
      date_to,
      notes || null,
      parseInt(interval_minutes) || 7,
      parseInt(jitter_minutes)   || 3,
      parseInt(notify_limit_per_day) || 5,
      notify_client_telegram || null,
      work_night === 'on' || work_night === 'true' || false,
      parseInt(priority) || 0,
    ]);

    // Создаём monitoring_job
    await query(
      'INSERT INTO monitoring_jobs(request_id, next_check_at) VALUES($1, NOW())',
      [vr.id]
    );

    res.redirect(`/requests/${vr.id}`);
  } catch (e) { next(e); }
});

// ─── Детальная страница заявки ─────────────────────────────────────────────────

router.get('/requests/:id', async (req, res, next) => {
  try {
    const { rows: [vr] } = await query(`
      SELECT vr.*, c.name AS client_name, c.id AS client_id, c.phone AS client_phone,
             mj.id AS job_id, mj.status AS job_status,
             mj.last_check_at, mj.next_check_at,
             mj.error_count, mj.last_error, mj.check_interval_minutes, mj.total_checks
      FROM visa_requests vr
      JOIN clients c ON c.id = vr.client_id
      LEFT JOIN monitoring_jobs mj ON mj.request_id = vr.id
      WHERE vr.id = $1
    `, [req.params.id]);

    if (!vr) return res.status(404).render('404');

    const { rows: slots } = await query(`
      SELECT * FROM slot_events WHERE request_id = $1 ORDER BY found_at DESC LIMIT 50
    `, [req.params.id]);

    const { rows: history } = await query(`
      SELECT * FROM check_history WHERE request_id = $1 ORDER BY checked_at DESC LIMIT 30
    `, [req.params.id]).catch(() => ({ rows: [] }));  // таблица может не существовать на старых деплоях

    const { rows: notifications } = await query(`
      SELECT * FROM notifications WHERE request_id = $1 ORDER BY sent_at DESC LIMIT 20
    `, [req.params.id]);

    res.render('requests/show', { vr, slots, history, notifications });
  } catch (e) { next(e); }
});

// ─── Сохранить настройки мониторинга ──────────────────────────────────────────

router.post('/requests/:id/settings', async (req, res, next) => {
  try {
    const {
      interval_minutes, jitter_minutes, notify_limit_per_day,
      notify_client_telegram, work_night, priority,
    } = req.body;

    await query(`
      UPDATE visa_requests SET
        interval_minutes       = $1,
        jitter_minutes         = $2,
        notify_limit_per_day   = $3,
        notify_client_telegram = $4,
        work_night             = $5,
        priority               = $6,
        updated_at             = NOW()
      WHERE id = $7
    `, [
      parseInt(interval_minutes)     || 7,
      parseInt(jitter_minutes)       || 3,
      parseInt(notify_limit_per_day) || 5,
      notify_client_telegram || null,
      work_night === 'on' || work_night === 'true' || false,
      parseInt(priority) || 0,
      req.params.id,
    ]);

    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

// ─── Действия над статусом ─────────────────────────────────────────────────────

router.post('/requests/:id/pause', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='paused', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

router.post('/requests/:id/resume', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='active', updated_at=NOW() WHERE id=$1", [req.params.id]);
    await query(
      `UPDATE monitoring_jobs
         SET next_check_at = NOW(),
             status        = 'idle',
             state         = 'waiting',
             error_count   = 0,
             retry_count   = 0,
             retry_at      = NULL
       WHERE request_id = $1`,
      [req.params.id]
    );
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

router.post('/requests/:id/done', async (req, res, next) => {
  try {
    await query("UPDATE visa_requests SET status='done', updated_at=NOW() WHERE id=$1", [req.params.id]);
    res.redirect(`/requests/${req.params.id}`);
  } catch (e) { next(e); }
});

router.post('/requests/:id/clear-error', async (req, res, next) => {
  try {
    await query(`
      UPDATE monitoring_jobs
         SET last_error   = NULL,
      