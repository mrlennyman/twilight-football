/** Pure helpers for scripts/setup-production.js (kept separate so they can be unit tested). */

const crypto = require('crypto');

const SERVICE_NAME = 'bb-twilight';

// Letters, digits, dot, underscore, hyphen only: safe in a shell, a .env file and systemd.
function isValidPassword(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{10,64}$/.test(value);
}

function isValidUser(value) {
  return typeof value === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value);
}

function isValidPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}

function generateSecret() {
  return crypto.randomBytes(32).toString('hex');
}

function buildEnvFile({ password, sessionSecret, dataDir, port }) {
  return [
    'NODE_ENV=production',
    'HOST=127.0.0.1',
    `PORT=${port}`,
    `ADMIN_PASSWORD=${password}`,
    `SESSION_SECRET=${sessionSecret}`,
    `DATABASE_PATH=${dataDir}/bream-bay.sqlite`,
    '',
  ].join('\n');
}

function buildServiceUnit({ user, appDir, envPath, nodePath }) {
  return [
    '[Unit]',
    'Description=Bream Bay Twilight Football',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `WorkingDirectory=${appDir}`,
    `EnvironmentFile=${envPath}`,
    `ExecStart=${nodePath} src/server.js`,
    'Restart=always',
    'RestartSec=3',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { password: null, user: null, port: 3000, force: false, errors: [] };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') out.force = true;
    else if (arg === '--user') out.user = argv[++i];
    else if (arg === '--port') out.port = Number(argv[++i]);
    else if (arg.startsWith('--')) out.errors.push(`Unknown option ${arg}`);
    else rest.push(arg);
  }
  out.password = rest[0] ?? null;
  if (!isValidPassword(out.password)) {
    out.errors.push('Password must be 10-64 characters: letters, numbers, dot, dash or underscore only.');
  }
  if (!isValidUser(out.user)) out.errors.push('Add --user followed by the web app\'s system user name.');
  if (!isValidPort(out.port)) out.errors.push('Port must be a number between 1024 and 65535.');
  return out;
}

module.exports = {
  SERVICE_NAME,
  isValidPassword,
  isValidUser,
  isValidPort,
  generateSecret,
  buildEnvFile,
  buildServiceUnit,
  parseArgs,
};
