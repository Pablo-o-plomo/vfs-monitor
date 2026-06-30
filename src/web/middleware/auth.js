/**
 * Простая защита паролем через сессию
 */
const config = require('../../config');

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/login');
}

function handleLogin(req, res) {
  const { password } = req.body;
  if (password === config.admin.password) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.render('login', { error: 'Неверный пароль' });
}

function handleLogout(req, res) {
  req.session.destroy(() => res.redirect('/login'));
}

module.exports = { requireAuth, handleLogin, handleLogout };
