const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Uses SESSION_SECRET from the environment when set. Otherwise creates a random one
 * once and keeps it in a file next to the database, so the person deploying only has
 * to choose an admin password.
 */
function ensureSessionSecret(env, dbPath) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;

  const dir = path.dirname(dbPath);
  const file = path.join(dir, 'session-secret');
  fs.mkdirSync(dir, { recursive: true });

  let secret = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  if (secret.length < 32) {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  env.SESSION_SECRET = secret;
  return secret;
}

module.exports = { ensureSessionSecret };
