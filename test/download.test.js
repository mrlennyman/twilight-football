const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startApp } = require('./helpers/harness');

let h;
let cookie = '';
test.before(async () => {
  h = await startApp();
  await h.login();
  await h.createScheduledLeague({ name: 'Kids Twilight', teams: 8, pitches: 4 });
  // own cookie for binary downloads
  const res = await fetch(h.base + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'Goal-Keeper-Test-2026' }).toString(),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});
test.after(async () => {
  await h.close();
});

const tempDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('bb-download-'));

test('the backup page needs a login', async () => {
  const anon = await fetch(h.base + '/admin/backup/download', { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location'), /\/admin\/login/);
  assert.equal((await fetch(h.base + '/admin/backup', { redirect: 'manual' })).status, 302);
});

test('before any download the dashboard nags, and the page says nothing has been downloaded', async () => {
  const dash = (await h.request('GET', '/admin')).text;
  assert.match(dash, /You haven&#39;t downloaded a backup yet|You haven't downloaded a backup yet/);
  assert.match(dash, /href="\/admin\/backup"/);
  const page = (await h.request('GET', '/admin/backup')).text;
  assert.match(page, /Download a backup now/);
  assert.match(page, /You haven&#39;t downloaded a backup yet|You haven't downloaded a backup yet/);
  assert.match(page, /1 league/);
});

test('the download is a real, complete copy of the database', async () => {
  const before = tempDirs().length;
  const res = await fetch(h.base + '/admin/backup/download', { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="bream-bay-backup-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite"/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(bytes.subarray(0, 15).toString(), 'SQLite format 3');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbcheck-')), 'copy.sqlite');
  fs.writeFileSync(file, bytes);
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, 1);
  assert.equal(copy.prepare('SELECT name FROM leagues').get().name, 'Kids Twilight');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM teams').get().n, 8);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM matches').get().n, h.db.prepare('SELECT COUNT(*) AS n FROM matches').get().n);
  assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  copy.close();

  // the temporary copy on the server is cleaned up
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(tempDirs().length, before, 'no leftover temporary copy');
});

test('after a download the reminder goes away and the page shows today', async () => {
  const dash = (await h.request('GET', '/admin')).text;
  assert.doesNotMatch(dash, /downloaded a backup yet/);
  assert.doesNotMatch(dash, /days since you last downloaded/);
  assert.match((await h.request('GET', '/admin/backup')).text, /Last downloaded: today/);

  // a week later the dashboard nags again
  h.db.prepare("UPDATE app_meta SET value = ? WHERE key = 'last_backup_download'").run(new Date(Date.now() - 9 * 86400000).toISOString());
  assert.match((await h.request('GET', '/admin')).text, /It&#39;s been 9 days since you last downloaded a backup|It's been 9 days since you last downloaded a backup/);
});

test('a scorer cannot download a backup', async () => {
  await h.request('POST', '/admin/scorers', { name: 'Sam', password: 'sideline-1', league_id: '1' });
  const login = await fetch(h.base + '/admin/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'Sam', password: 'sideline-1' }).toString(),
  });
  const scorerCookie = login.headers.get('set-cookie').split(';')[0];
  for (const url of ['/admin/backup', '/admin/backup/download']) {
    const res = await fetch(h.base + url, { headers: { cookie: scorerCookie }, redirect: 'manual' });
    assert.equal(res.status, 403, url);
    assert.notEqual(res.headers.get('content-type'), 'application/octet-stream');
  }
});
