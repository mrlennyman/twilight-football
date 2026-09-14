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

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  return res.redirect('/admin/login');
}

module.exports = { checkPassword, requireAdmin };
