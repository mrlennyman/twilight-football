/**
 * Scorer logins: a person with their own name and password who can enter and correct scores for ONE league and
 * nothing else. The main admin login (the ADMIN_PASSWORD) is unchanged and can do everything.
 * Passwords are stored only as salted scrypt hashes.
 */
const crypto = require('crypto');

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 .'-]{1,29}$/;
const MIN_PASSWORD = 8;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const cleanName = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Checks a scorer's name and password; returns the scorer row, or null. Always does the hashing work. */
function authenticateScorer(db, name, password) {
  const row = db.prepare('SELECT * FROM scorers WHERE name = ? AND active = 1').get(cleanName(name));
  // Hash something even for an unknown name, so a missing name takes as long as a wrong password.
  const stored = row ? row.password_hash : hashPassword('not-a-real-password');
  const ok = verifyPassword(password, stored);
  return row && ok ? row : null;
}

/** Form -> { errors, value } for adding a scorer. */
function parseScorerInput(db, body) {
  const errors = [];
  const name = cleanName(body.name);
  const password = String(body.password ?? '');
  const leagueId = Number.parseInt(body.league_id, 10);
  if (!NAME_PATTERN.test(name)) errors.push("The name must be 2 to 30 characters: letters, numbers, spaces, full stops, apostrophes or hyphens.");
  if (password.length < MIN_PASSWORD) errors.push(`The password needs at least ${MIN_PASSWORD} characters.`);
  if (!Number.isInteger(leagueId) || !db.prepare('SELECT 1 FROM leagues WHERE id = ?').get(leagueId)) errors.push('Choose a league.');
  if (errors.length === 0 && db.prepare('SELECT 1 FROM scorers WHERE name = ?').get(name)) errors.push(`There is already a scorer called "${name}".`);
  return { errors, value: { name, password, leagueId } };
}

/**
 * What a scorer may do (paths are relative to /admin). Everything else is refused.
 * { method, path } -> true when it is score entry for their own league.
 */
function scorerMayDo(method, path, leagueId) {
  const own = String(leagueId);
  if (method === 'POST' && path === '/logout') return true;
  const m = /^\/league\/(\d+)\/(.*)$/.exec(path);
  if (!m || m[1] !== own) return false;
  const rest = m[2];
  if (method === 'GET') return rest === 'results';
  if (method === 'POST') {
    return (
      /^results\/match\/\d+$/.test(rest) ||
      /^results\/round\/\d+$/.test(rest) ||
      /^knockout-results\/match\/\d+$/.test(rest) ||
      /^knockout-results\/match\/\d+\/clear$/.test(rest)
    );
  }
  return false;
}

module.exports = { hashPassword, verifyPassword, authenticateScorer, parseScorerInput, scorerMayDo, cleanName, MIN_PASSWORD };
