const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/harness');

const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

let h;
let db;
test.before(async () => {
  h = await startApp();
  db = require('../src/db');
});
test.after(async () => {
  await h.close();
});

const report = (fields, ua = ANDROID_CHROME) =>
  h.request('POST', '/api/usage', fields, { headers: { 'user-agent': ua } });

test('usage reports are counted once per device per day and per mode', async () => {
  const id = 'a'.repeat(32);
  for (let i = 0; i < 3; i += 1) assert.equal((await report({ id, mode: 'web', event: 'open' })).status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_devices').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_daily').get().n, 1);

  await report({ id, mode: 'app', event: 'open' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_daily').get().n, 2, 'app and web are separate rows');
  const device = db.prepare('SELECT * FROM app_devices WHERE id = ?').get(id);
  assert.ok(device.app_first_open, 'first installed-app open is remembered');
  assert.equal(device.installed_at, null);
  assert.equal(device.browser, 'chrome');
  assert.equal(device.platform, 'android');

  await report({ id, mode: 'app', event: 'installed' });
  assert.ok(db.prepare('SELECT installed_at FROM app_devices WHERE id = ?').get(id).installed_at);
});

test('bad reports are ignored but still answer 204', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM app_devices').get().n;
  for (const bad of [{ id: 'short', mode: 'web' }, { id: 'b'.repeat(32), mode: 'hacked' }, { id: 'c'.repeat(32) + '<script>', mode: 'web' }, {}]) {
    assert.equal((await report(bad)).status, 204);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM app_devices').get().n, before);
});

test('the admin page shows installed phones, browser-only phones and the daily table', async () => {
  await report({ id: 'd'.repeat(32), mode: 'web', event: 'open' }, IPHONE_SAFARI);
  await report({ id: 'e'.repeat(32), mode: 'app', event: 'open' }, IPHONE_SAFARI);

  const anon = await h.request('GET', '/admin/usage');
  assert.equal(anon.status, 302, 'private to the admin');

  await h.login();
  const page = await h.request('GET', '/admin/usage');
  assert.equal(page.status, 200);
  // a (android: app + installed) and e (iphone: app) are installed; d is browser-only
  assert.match(page.text, /Phones with the app installed<\/th><td><strong>2<\/strong>/);
  assert.match(page.text, /Browser-only phones<\/th><td><strong>1<\/strong>/);
  assert.match(page.text, /Install confirmations<\/th><td><strong>1<\/strong>/);
  assert.match(page.text, /Opened the app today<\/th><td><strong>2<\/strong>/);
  assert.match(page.text, /<td>android<\/td><td>chrome<\/td><td>1<\/td>/);
  assert.match(page.text, /<td>ios<\/td><td>safari<\/td><td>1<\/td>/);
  assert.match(await h.request('GET', '/admin').then((r) => r.text), /href="\/admin\/usage"/);
});

test('the counter script is on public pages, not on admin pages', async () => {
  const pub = await h.request('GET', '/leagues');
  assert.match(pub.text, /<script src="\/js\/usage\.js\?v=/);
  const admin = await h.request('GET', '/admin/usage');
  assert.doesNotMatch(admin.text, /usage\.js/);
});

test('one address cannot flood the counter', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM app_devices').get().n;
  for (let i = 0; i < 80; i += 1) await report({ id: `flood${String(i).padStart(3, '0')}`.padEnd(20, 'z'), mode: 'web' });
  const added = db.prepare('SELECT COUNT(*) AS n FROM app_devices').get().n - before;
  assert.ok(added > 0 && added < 80, `capped, got ${added}`);
});
