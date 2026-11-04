const crypto = require('crypto');
const { scorerMayDo } = require('../lib/scorers');

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
  if (req.session && req.session.scorer) {
    const scorer = req.session.scorer;
    // Switched off or removed since they logged in: the session stops working straight away.
    const stillAllowed = require('../db').prepare('SELECT 1 FROM scorers WHERE id = ? AND active = 1 AND league_id = ?').get(scorer.id, scorer.leagueId);
    if (!stillAllowed) {
      return req.session.destroy(() => res.redirect('/admin/login?expired=1'));
    }
    // A scorer only ever sees their own league's results page (/admin is just a doorway to it).
    if (req.method === 'GET' && req.path === '/') return res.redirect(`/admin/league/${scorer.leagueId}/results`);
    if (scorerMayDo(req.method, req.path, scorer.leagueId)) return next();
    return res.status(403).render('admin/error', {
      message: 'Your login lets you enter scores for your league only. Ask the main admin if you need something else.',
    });
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
