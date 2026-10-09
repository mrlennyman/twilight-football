const crypto = require('crypto');

function checkPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD || '';
  const candidateBuf = Buffer.from(String(candidate || ''));
  const expectedBuf = Buffer.from(expected);
  if (candidateBuf.length !== expectedBuf.length) {
    // Still run a comparison so failure timing doesn't leak length.
    crypto.timingSafeEqual(candidateBuf, candidateBuf);
    return false;
  }
  return crypto.timingSafeEqual(candidateBuf, expectedBuf);
}

const ANONYMOUS_SESSION_MS = 30 * 60 * 1000;

/** Only ever send the admin back to a page inside /admin (never off-site). */
function safeReturnTo(value) {
  const target = String(value ?? '');
  const ok =
    (target === '/admin' || target.startsWith('/admin/')) &&
    !target.startsWith('//') &&
    !target.startsWith('/admin/login') &&
    !/[\\\r\n]/.test(target);
  return ok ? target : '/admin';
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  if (req.method === 'GET') {
    // Remember the page so login can bring them straight back. Keep this throw-away session short.
    req.session.returnTo = req.originalUrl;
    req.session.cookie.maxAge = ANONYMOUS_SESSION_MS;
    return res.redirect('/admin/login');
  }
  // A save that arrives with no valid login (session expired / cleared): never lose it silently.
  return res.redirect('/admin/login?expired=1');
}

module.exports = { checkPassword, requireAdmin, safeReturnTo };
