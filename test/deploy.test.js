const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidPassword,
  isValidUser,
  isValidPort,
  buildEnvFile,
  buildServiceUnit,
  parseArgs,
  generateSecret,
} = require('../scripts/deploy-helpers');

test('password rules keep it safe for shells, .env files and systemd', () => {
  assert.ok(isValidPassword('Goal-Keeper.2026'));
  for (const bad of ['short1', 'has space 12345', 'quote"12345678', "it's-a-pass-1234", 'dollar$1234567', 'hash#1234567', '', null]) {
    assert.ok(!isValidPassword(bad), `should reject ${JSON.stringify(bad)}`);
  }
});

test('user and port validation', () => {
  assert.ok(isValidUser('bayfootball'));
  assert.ok(!isValidUser('Root User'));
  assert.ok(!isValidUser('../etc'));
  assert.ok(isValidPort(3000));
  assert.ok(!isValidPort(80));
  assert.ok(!isValidPort(NaN));
});

test('env file has everything the production start-up check needs', () => {
  const secret = generateSecret();
  assert.equal(secret.length, 64);
  const env = buildEnvFile({ password: 'Goal-Keeper.2026', sessionSecret: secret, dataDir: '/home/u/bream-bay-data', port: 3010 });
  assert.match(env, /^NODE_ENV=production$/m);
  assert.match(env, /^HOST=127\.0\.0\.1$/m);
  assert.match(env, /^PORT=3010$/m);
  assert.match(env, /^ADMIN_PASSWORD=Goal-Keeper\.2026$/m);
  assert.match(env, new RegExp(`^SESSION_SECRET=${secret}$`, 'm'));
  assert.match(env, /^DATABASE_PATH=\/home\/u\/bream-bay-data\/bream-bay\.sqlite$/m);
});

test('service unit runs as the app user from the app folder and restarts on failure', () => {
  const unit = buildServiceUnit({ user: 'u', appDir: '/home/u/webapps/app', envPath: '/home/u/bream-bay-data/.env', nodePath: '/usr/bin/node' });
  assert.match(unit, /^User=u$/m);
  assert.match(unit, /^WorkingDirectory=\/home\/u\/webapps\/app$/m);
  assert.match(unit, /^EnvironmentFile=\/home\/u\/bream-bay-data\/\.env$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node src\/server\.js$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^WantedBy=multi-user\.target$/m);
});

test('parseArgs reads password, --user and --port, and explains what is missing', () => {
  const ok = parseArgs(['Goal-Keeper.2026', '--user', 'bayfootball', '--port', '3010']);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.user, 'bayfootball');
  assert.equal(ok.port, 3010);

  const noUser = parseArgs(['Goal-Keeper.2026']);
  assert.equal(noUser.errors.length, 1);
  assert.equal(parseArgs(['weak']).errors.length, 2);
  assert.equal(parseArgs(['Goal-Keeper.2026', '--user', 'u', '--bogus']).errors.length, 1);
});
