/**
 * src/web/server.js — Express admin panel
 */

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const ejsLayouts = require('express-ejs-layouts');
const path = require('path');
const { migrate } = require('../db');
const config = require('../config');
const logger = require('../logger');
const { requireAuth, handleLogin, handleLogout } = require('./middleware/auth');

const app = express();

// ─── Шаблонизатор ─────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');
app.use(ejsLayouts);

// ─── Middleware ───────────────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: config.admin.password + '_session_secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 часов
}));

// Текущий год + форматтер дат во все шаблоны
app.use((req, res, next) => {
  res.locals.year = new Date().getFullYear();
  res.locals.path = req.path;
  // fmt.date(d)  → "10.07.2026"  (UTC-safe для pg DATE колонок)
  // fmt.dt(d)    → "10.07.2026, 14:30"
  res.locals.fmt = {
    date: (d) => {
      if (!d) return '—';
      const dt = new Date(d);
      const day = String(dt.getUTCDate()).padStart(2, '0');
      const mon = String(dt.getUTCMonth() + 1).padStart(2, '0');
      return `${day}.${mon}.${dt.getUTCFullYear()}`;
    },
    dt: (d) => d ? new Date(d).toLocaleString('ru-RU') : '—',
  };
  next();
});

// ─── Публичные маршруты ───────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.render('login', { error: null });
});
app.post('/login', handleLogin);
app.post('/logout', handleLogout);

app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date() }));

// ─── Защищённые маршруты ─────────────────────────────────────
app.use(requireAuth);

app.use('/',         require('./routes/dashboard'));
app.use('/clients',  require('./routes/clients'));
app.use('/',         require('./routes/requests'));   // /clients/:id/requests/…  и /requests/:id

// ─── Обработка ошибок ─────────────────────────────────────────
app.use((req, res) => res.status(404).render('404'));

app.use((err, req, res, _next) => {
  logger.error('[web] ' + err.message);
  res.status(500).render('error', { message: err.message });
});

// ─── Старт ────────────────────────────────────────────────────
async function start() {
  await migrate();
  app.listen(config.admin.port, () => {
    logger.info(`[web] Admin panel → http://localhost:${config.admin.port}`);
  });
}

start().catch((e) => {
  logger.error('[web] Fatal: ' + e.message);
  process.exit(1);
});

module.exports = app;
