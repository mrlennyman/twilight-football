const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureSessionSecret } = require('../src/lib/secrets');
const { resolveDbPath, DEFAULT_DB_PATH, APP_ROOT } = require('../src/lib/paths');

test('an explicit SESSION_SECRET is used untouched and nothing is written', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const env = { SESSION_SECRET: 'x'.repeat(40) };
  assert.equal(ensureSessionSecret(env, path.join(dir, 'db.sqlite')), 'x'.repeat(40));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a missing secret is generated once, stored next to the database, and reused on restart', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-')), 'data');
  const dbPath = path.join(dir, 'db.sqlite');

  const env1 = {};
  const first = ensureSessionSecret(env1, dbPath);
  assert.equal(first.length, 64);
  assert.equal(env1.SESSION_SECRET, first);
  assert.ok(fs.existsSync(path.join(dir, 'session-secret')));

  const env2 = {};
  assert.equal(ensureSessionSecret(env2, dbPath), first, 'same secret after a restart, so admin sessions survive');
});

test('a corrupt or too-short stored secret is replaced', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  fs.writeFileSync(path.join(dir, 'session-secret'), 'short');
  assert.equal(ensureSessionSecret({}, path.join(dir, 'db.sqlite')).length, 64);
});

test('database path defaults to the app folder, not the working directory', () => {
  assert.equal(DEFAULT_DB_PATH, path.join(APP_ROOT, 'data', 'bream-bay.sqlite'));
  assert.equal(resolveDbPath(undefined), DEFAULT_DB_PATH);
  assert.equal(resolveDbPath('/srv/x/db.sqlite'), path.resolve('/srv/x/db.sqlite'));
});
