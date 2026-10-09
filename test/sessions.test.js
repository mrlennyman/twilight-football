const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const { SqliteSessionStore } = require('../src/lib/sqliteSessionStore');
const { safeReturnTo } = require('../src/middleware/auth');
const { startApp, PASSWORD } = require('./helpers/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bbss-'));
const call = (fn, ...args) => new Promise((resolve, reject) => fn(...args, (err, value) => (err ? reject(err) : resolve(value))));
const session = (ms, extra = {}) => ({ cookie: { expires: new Date(Date.now() + ms).toISOString(), originalMaxAge: ms }, ...extra });

test('A6 store: set/get/destroy, expiry, touch, prune, corrupt rows, and persistence across instances', async () => {
  const dir = tmp();
  const file = path.join(dir, 'sessions.sqlite');
  let clock = 1_000_000;
  const store = new SqliteSessionStore({ file, now: () => clock });

  await call(store.set.bind(store), 'a', session(5000, { isAdmin: true }));
  assert.equal((await call(store.get.bind(store), 'a')).isAdmin, true);
  assert.equal(await call(store.get.bind(store), 'nope'), null);

  // a second instance on the same file (= the app after a restart) still sees the session
  const reopened = new SqliteSessionStore({ file, now: () => clock });
  assert.equal((await call(reopened.get.bind(reopened), 'a')).isAdmin, true);
  reopened.close();

  // expiry is honoured, and touch pushes it out
  const realNow = Date.now();
  const store2 = new SqliteSessionStore({ file: path.join(dir, 's2.sqlite'), now: () => realNow });
  await call(store2.set.bind(store2), 'x', session(1000));
  await call(store2.touch.bind(store2), 'x', session(60_000));
  store2.now = () => realNow + 30_000;
  assert.ok(await call(store2.get.bind(store2), 'x'), 'touched session survives past its old expiry');
  store2.now = () => realNow + 120_000;
  assert.equal(await call(store2.get.bind(store2), 'x'), null, 'expired session is gone');
  store2.prune();
  assert.equal(store2.db.prepare('SELECT COUNT(*) c FROM sessions').get().c, 0);
  store2.close();

  await call(store.destroy.bind(store), 'a');
  assert.equal(await call(store.get.bind(store), 'a'), null);

  // a corrupt row never breaks a request - it just means "not logged in"
  store.db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)').run('bad', '{not json', clock + 5000);
  assert.equal(await call(store.get.bind(store), 'bad'), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('A6: safeReturnTo only ever returns pages inside /admin', () => {
  assert.equal(safeReturnTo('/admin/league/1/results?week=2'), '/admin/league/1/results?week=2');
  assert.equal(safeReturnTo('/admin'), '/admin');
  for (const bad of ['//evil.com', 'https://evil.com', '/admin/login', '/admin/login?x=1', '/administrator', '/admin/\\evil', '/admin/a\r\nSet-Cookie: x=1', '', undefined, null]) {
    assert.equal(safeReturnTo(bad), '/admin', String(bad));
  }
});

test('A6: an expired save says so; login returns to the page you were on', async () => {
  const h = await startApp();
  try {
    // a POST with no session never vanishes silently
    const lost = await h.request('POST', '/admin/league/1/results/round/1', { clear: '1' });
    assert.equal(lost.status, 302);
    assert.equal(lost.location, '/admin/login?expired=1');
    const page = await h.request('GET', '/admin/login?expired=1');
    assert.match(page.text, /You were logged out, so your last change was not saved/);
    assert.doesNotMatch((await h.request('GET', '/admin/login')).text, /last change was not saved/);

    // GET a protected page while logged out -> login -> straight back to it
    h.setCookie('');
    const bounce = await h.request('GET', '/admin/league/1/results?week=2');
    assert.equal(bounce.location, '/admin/login');
    const login = await h.request('POST', '/admin/login', { password: PASSWORD });
    assert.equal(login.location, '/admin/league/1/results?week=2');

    // a plain login goes to the dashboard
    h.setCookie('');
    const plain = await h.request('POST', '/admin/login', { password: PASSWORD });
    assert.equal(plain.location, '/admin');
  } finally {
    await h.close();
  }
});

test('A6: the admin stays logged in after the server process is restarted', async () => {
  const dir = tmp();
  const port = 38000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), AUTO_RESTART: '0',
    ADMIN_PASSWORD: PASSWORD, DATABASE_PATH: path.join(dir, 'real.sqlite'), BACKUP_DIR: path.join(dir, 'b'),
  };
  delete env.SESSION_SECRET; // the app creates one and keeps it in the data folder, as in production
  const base = `http://127.0.0.1:${port}`;

  const start = async () => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(base + '/admin/login');
        return child;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    child.kill();
    throw new Error('server did not start');
  };
  const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });

  let child = await start();
  try {
    const login = await fetch(base + '/admin/login', {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
    });
    assert.equal(login.status, 302);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(base + '/admin', { headers: { cookie }, redirect: 'manual' })).status, 200);

    await stop(child);
    child = await start();
    const after = await fetch(base + '/admin', { headers: { cookie }, redirect: 'manual' });
    assert.equal(after.status, 200, 'still logged in after a restart');
  } finally {
    await stop(child);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
