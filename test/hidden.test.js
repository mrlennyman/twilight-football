const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startApp } = require('./helpers/harness');

let h;
let a;
let b;
let c;
test.before(async () => {
  h = await startApp();
  await h.login();
  a = await h.createScheduledLeague({ name: 'Kids Twilight' });
  b = await h.createScheduledLeague({ name: 'Adults Twilight' });
  c = await h.createScheduledLeague({ name: 'Juniors' });
  h.db.prepare('UPDATE pages SET published = 1 WHERE league_id = ?').run(b);
});
test.after(() => h.close());

const asPublic = async (fn) => {
  const saved = h.getCookie();
  h.setCookie('');
  try {
    return await fn();
  } finally {
    h.setCookie(saved);
  }
};
const get = (url) => h.request('GET', url);
const publicUrls = (id, teamId, slug) => [`/league/${id}`, `/league/${id}/teams`, `/league/${id}/fixtures`, `/league/${id}/bracket`, `/league/${id}/info`, `/league/${id}/info/${slug}`, `/league/${id}/team/${teamId}`];

test('hide: a hidden league leaves the public home list; the others stay', async () => {
  const hide = await h.request('POST', `/admin/league/${b}/visibility`, { hidden: '1' });
  assert.equal(hide.status, 302);
  assert.equal(h.db.prepare('SELECT hidden FROM leagues WHERE id = ?').get(b).hidden, 1);

  const home = await asPublic(() => get('/'));
  assert.match(home.text, /Kids Twilight/);
  assert.match(home.text, /Juniors/);
  assert.doesNotMatch(home.text, /Adults Twilight/);
  assert.equal((home.text.match(/class="home-card"/g) || []).length, 2);
});

test('hide: every public page of a hidden league is a 404 for the public, even with the link', async () => {
  const teamId = h.db.prepare('SELECT id FROM teams WHERE league_id = ? LIMIT 1').get(b).id;
  const slug = h.db.prepare('SELECT slug FROM pages WHERE league_id = ? LIMIT 1').get(b).slug;
  await asPublic(async () => {
    for (const url of publicUrls(b, teamId, slug)) assert.equal((await get(url)).status, 404, url);
    // visible leagues are unaffected
    const otherTeam = h.db.prepare('SELECT id FROM teams WHERE league_id = ? LIMIT 1').get(a).id;
    assert.equal((await get(`/league/${a}/team/${otherTeam}`)).status, 200);
    assert.equal((await get(`/league/${a}`)).status, 200);
  });
});

test('hide: the logged-in admin can still open a hidden league, with a clear notice', async () => {
  const page = await get(`/league/${b}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /class="hidden-notice"/);
  assert.match(page.text, /Only you can see this league/);
  assert.doesNotMatch((await get(`/league/${a}`)).text, /hidden-notice/);
});

test('hide: the dashboard marks it hidden and offers Show; the Home button no longer counts it', async () => {
  const dash = await get('/admin');
  assert.match(dash.text, /<span class="tag tag-hidden"[^>]*>hidden<\/span>/);
  assert.match(dash.text, /Show on public site/);
  assert.match(dash.text, /Hide from public/);
  const withButton = await asPublic(() => get(`/league/${a}`));
  assert.match(withButton.text, /class="home-btn"/, 'two visible leagues remain');

  await h.request('POST', `/admin/league/${c}/visibility`, { hidden: '1' });
  const single = await asPublic(() => get(`/league/${a}`));
  assert.match(single.text, /class="home-btn"/, 'the Home button stays even with one visible league');
  const home = await asPublic(() => get('/'));
  assert.match(home.text, /Kids Twilight/);
  assert.equal((home.text.match(/class="home-card"/g) || []).length, 1, 'a single visible league is shown as a card');
});

test('hide: with every league hidden the home page says nothing is running; Show brings one back', async () => {
  await h.request('POST', `/admin/league/${a}/visibility`, { hidden: '1' });
  const none = await asPublic(() => get('/'));
  assert.match(none.text, /No leagues are running yet/);

  const show = await h.request('POST', `/admin/league/${b}/visibility`, { hidden: '0' });
  assert.equal(show.status, 302);
  assert.equal((await asPublic(() => get(`/league/${b}`))).status, 200);
  assert.match((await asPublic(() => get('/'))).text, /Adults Twilight/);
  assert.equal((await h.request('POST', '/admin/league/9999/visibility', { hidden: '1' })).status, 404);
  assert.equal((await asPublic(() => h.request('POST', `/admin/league/${b}/visibility`, { hidden: '1' }))).status, 302, 'a logged-out request is bounced to login');
  assert.equal(h.db.prepare('SELECT hidden FROM leagues WHERE id = ?').get(b).hidden, 0, '...and changes nothing');
});

test('hide: an existing database gains the hidden column (all leagues stay visible)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbhid-'));
  const file = path.join(dir, 'old.sqlite');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8').replace(/,\s*hidden INTEGER NOT NULL DEFAULT 0/, '');
  const old = new DatabaseSync(file);
  old.exec(schema);
  old.exec("INSERT INTO leagues (name, season, status) VALUES ('Old', 'S', 'in_progress')");
  assert.ok(!old.prepare('PRAGMA table_info(leagues)').all().some((col) => col.name === 'hidden'));
  old.close();
  const script = "const db=require('./src/db');console.log(JSON.stringify(db.prepare('SELECT name,hidden FROM leagues').all()));";
  const res = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: file }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), [{ name: 'Old', hidden: 0 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});
