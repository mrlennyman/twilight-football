const path = require('path');
// Read settings from the app folder's .env whatever directory the app was started from.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { resolveDbPath } = require('./lib/paths');
const { ensureSessionSecret } = require('./lib/secrets');

if (!process.env.ADMIN_PASSWORD) {
  console.error('ADMIN_PASSWORD must be set (see .env.example).');
  process.exit(1);
}
ensureSessionSecret(process.env, resolveDbPath(process.env.DATABASE_PATH));

const { ADMIN_PASSWORD, SESSION_SECRET, NODE_ENV } = process.env;

if (NODE_ENV === 'production') {
  const placeholders = ['change-me', 'change-me-too'];
  if (placeholders.includes(ADMIN_PASSWORD) || placeholders.includes(SESSION_SECRET)) {
    console.error('Refusing to start in production with the placeholder secrets from .env.example.');
    process.exit(1);
  }
  if (ADMIN_PASSWORD.length < 10 || SESSION_SECRET.length < 32) {
    console.error('In production ADMIN_PASSWORD needs 10+ characters and SESSION_SECRET 32+.');
    process.exit(1);
  }
}

const app = require('./app');

const port = process.env.PORT || 3000;
// 0.0.0.0 keeps the LAN/phone preview working in dev; set HOST=127.0.0.1 in
// production so only the reverse proxy can reach the app.
const host = process.env.HOST || '0.0.0.0';

app.listen(port, host, () => {
  console.log(`Bream Bay Twilight Football running at http://${host}:${port}`);
});
