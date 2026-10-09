const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { formatNzTime, formatNzDateTime, formatUpdated, parseUtc } = require('../src/lib/format');
const { startApp } = require('./helpers/harness');

let h;
let id;
test.before(async () => {
  h = await startApp();
  await h.login();
  id = await h.createScheduledLeague({ name: 'Kids Twilight' });
  h.db.prepare('UPDATE pages SET published = 1 WHERE league_id = ?').run(id);
});
test.after(() => h.close());

const get = async (url) => (await h.request('GET', url)).text;
const firstMatch = () => h.db.prepare('SELECT m.*, r.id AS rid FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id LIMIT 1').get(id);

// ---------- formatting
test('C3: NZ time formatting from SQLite UTC timestamps', () => {
  assert.equal(parseUtc('2026-10-14 04:42:10').toISOString(), '2026-10-14T04:42:10.000Z');
  assert.equal(parseUtc('garbage'), null);
  assert.equal(formatNzTime('2026-10-14 04:42:10'), '5:42pm'); // NZDT is UTC+13
  assert.equal(formatNzTime('2026-10-14 12:05:00'), '1:05am');
  assert.equal(formatNzTime('2026-06-30 04:00:00'), '4:00pm'); // winter, UTC+12
  assert.equal(formatNzDateTime('2026-10-14 04:42:10'), 'Wed 14 Oct, 5:42pm');
  const now = new Date('2026-10-14T06:00:00Z');
  assert.equal(formatUpdated('2026-10-14 04:42:10', now), 'Updated 5:42pm');
  assert.equal(formatUpdated('2026-10-13 04:42:10', now), 'Updated Tue 13 Oct, 5:42pm');
  assert.equal(formatUpdated(null, now), '');
});

// ---------- C1
test('C1: every public league page says which league it is', async () => {
  for (const url of [`/league/${id}`, `/league/${id}/teams`, `/league/${id}/fixtures`, `/league/${id}/bracket`, `/league/${id}/info`]) {
    const text = await get(url);
    assert.match(text, /<h1 class="league-title">Kids Twilight<\/h1>/, url);
    assert.match(text, /<p class="league-season">Summer/, url);
  }
  const slug = h.db.prepare('SELECT slug FROM pages WHERE league_id = ? LIMIT 1').get(id).slug;
  assert.match(await get(`/league/${id}/info/${slug}`), /<h1 class="league-title">Kids Twilight<\/h1>/);
  assert.doesNotMatch(await get(`/league/${id}`), /home-btn/, 'no Home button with a single league');
});

test('C1: a shiny Home button, opposite the title, appears once a second league is running', async () => {
  const second = await h.createScheduledLeague({ name: 'Adults' });
  assert.ok(second > id);
  for (const url of [`/league/${id}`, `/league/${id}/teams`, `/league/${id}/fixtures`]) {
    const text = await get(url);
    assert.match(text, /<a class="home-btn" href="\/" aria-label="Home - all leagues">[\s\S]*?<span>Home<\/span>/, url);
    assert.ok(text.indexOf('league-head-text') < text.indexOf('home-btn'), 'title first, button opposite it');
    assert.doesNotMatch(text, /Other leagues/);
  }
});

// ---------- C2
test('C2: team page lists that team\'s games in order with opponent, pitch and result', async () => {
  const m = firstMatch();
  const team = h.db.prepare('SELECT * FROM teams WHERE id = ?').get(m.home_team_id);
  await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: '3', away_score: '1' });

  const text = await get(`/league/${id}/team/${team.id}`);
  assert.match(text, new RegExp(`<h2 class="team-name">${team.name}</h2>`));
  assert.equal((text.match(/class="match-card team-match"/g) || []).length, 14, 'a team plays 14 group games');
  assert.match(text, /3 - 1/);
  assert.match(text, /Won/);
  assert.match(text, /Pitch \d/);
  assert.match(text, /Round 1/);
  assert.match(text, /id="follow-team"[^>]*hidden/, 'follow button is hidden until the script reveals it');
  assert.ok(text.indexOf('Round 1') < text.indexOf('Round 14'), 'in round order');
});

test('C2: unknown team, another league\'s team, or junk id are 404', async () => {
  const otherTeam = h.db.prepare('SELECT t.id FROM teams t WHERE t.league_id != ? LIMIT 1').get(id);
  for (const url of [`/league/${id}/team/${otherTeam.id}`, `/league/${id}/team/999999`, `/league/${id}/team/abc`, `/league/999/team/1`]) {
    assert.equal((await h.request('GET', url)).status, 404, url);
  }
});

test('C2: team names link to the team page and carry the data the highlighting script needs', async () => {
  const team = h.db.prepare('SELECT * FROM teams WHERE league_id = ? ORDER BY id LIMIT 1').get(id);
  const link = `href="/league/${id}/team/${team.id}"`;
  for (const url of [`/league/${id}`, `/league/${id}/teams`, `/league/${id}/fixtures`]) {
    assert.ok((await get(url)).includes(link), `${url} links ${team.name}`);
  }
  const home = await get(`/league/${id}`);
  assert.match(home, new RegExp(`<tr class="[^"]*" data-team-id="${team.id}">`));
  assert.match(await get(`/league/${id}/fixtures`), /class="match-card[^"]*" data-team-ids="\d+ \d+"/);
  assert.match(await get(`/league/${id}/teams`), new RegExp(`class="team-card" data-team-id="${team.id}"`));
  assert.match(home, /<html lang="en" data-league-id="\d+">/);
});

test('C2/C3: public pages load the follow + auto-refresh scripts; admin pages never do', async () => {
  for (const url of [`/league/${id}`, `/league/${id}/team/1`, '/install', '/nope']) {
    const text = await get(url);
    assert.match(text, /\/js\/auto-refresh\.js\?v=/, url);
    assert.match(text, /\/js\/my-team\.js\?v=/, url);
  }
  for (const url of ['/admin', `/admin/league/${id}/results`, '/admin/diagnostics']) {
    const text = await get(url);
    assert.doesNotMatch(text, /auto-refresh\.js/, url);
    assert.doesNotMatch(text, /my-team\.js/, url);
  }
  assert.doesNotMatch(await get('/admin/login'), /auto-refresh\.js/);
});

// ---------- C3
test('C3: freshness note - only "Refresh" before any result, "Updated <time>" after', async () => {
  const fresh = await h.createScheduledLeague({ name: 'Fresh League' });
  const before = await get(`/league/${fresh}/fixtures`);
  assert.match(before, /<p class="updated-note"><a href="" class="refresh-link">Refresh<\/a><\/p>/);
  assert.doesNotMatch(before, /Updated /);

  const m = h.db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? LIMIT 1').get(fresh);
  await h.request('POST', `/admin/league/${fresh}/results/match/${m.id}`, { home_score: '1', away_score: '0' });
  const after = await get(`/league/${fresh}`);
  assert.match(after, /<p class="updated-note">Updated \d{1,2}:\d{2}(am|pm) &middot; <a href="" class="refresh-link">Refresh<\/a>/);
  assert.match(await get(`/league/${fresh}/fixtures`), /Updated \d{1,2}:\d{2}(am|pm)/);
  assert.ok(h.db.prepare('SELECT updated_at FROM matches WHERE id = ?').get(m.id).updated_at);
});

test('C3: an existing database gains the updated_at column and result_log table on startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbmig-'));
  const file = path.join(dir, 'old.sqlite');
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(file);
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8')
    .replace(/,\s*updated_at TEXT/, '')
    .replace(/-- Who changed[\s\S]*$/, '')
    .replace(/,\s*nav_tabs TEXT/, '');
  old.exec(schema);
  old.exec("INSERT INTO leagues (name, season) VALUES ('Old', 'S')");
  assert.ok(!old.prepare('PRAGMA table_info(matches)').all().some((c) => c.name === 'updated_at'));
  old.close();

  const script = "const db=require('./src/db');" +
    "const cols=db.prepare('PRAGMA table_info(matches)').all().map(c=>c.name);" +
    "const logs=db.prepare(\"SELECT name FROM sqlite_master WHERE name='result_log'\").all().length;" +
    "const leagues=db.prepare('SELECT COUNT(*) c FROM leagues').get().c;" +
    "console.log(JSON.stringify({u:cols.includes('updated_at'),logs,leagues}));";
  const res = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: file }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { u: true, logs: 1, leagues: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------- C4
test('C4: admin sees a warning for forgotten results from earlier nights, and not for tonight or the future', async () => {
  await h.request('POST', '/admin/leagues', { name: 'Old Season', season: 'S', num_teams: '8', num_pitches: '4', rounds_per_week: '3' });
  const old = h.db.prepare('SELECT MAX(id) AS id FROM leagues').get().id;
  await h.request('POST', `/admin/league/${old}/schedule/generate`, { start_date: '2020-01-08', kickoff_start_time: '17:00', slot_minutes: '15' });

  const page = await get(`/admin/league/${old}/results?week=5`);
  assert.match(page, /56 matches in earlier weeks have no result/);
  assert.match(page, /href="\?week=1#round-\d+"/, 'links to the first forgotten round');

  // score everything in week 1 -> the count drops and the link moves on
  const wk1 = h.db.prepare("SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.week_number = 1").all(old);
  for (const m of wk1) await h.request('POST', `/admin/league/${old}/results/match/${m.id}`, { home_score: '1', away_score: '0' });
  const after = await get(`/admin/league/${old}/results?week=5`);
  assert.match(after, /44 matches in earlier weeks have no result/);
  assert.match(after, /href="\?week=2#round-\d+"/);

  // a league whose nights are all in the future never warns
  assert.doesNotMatch(await get(`/admin/league/${id}/results`), /in earlier weeks/);
});

// ---------- C6
test('C6: every save and clear is logged with old and new score; the log page lists them', async () => {
  const lg = await h.createScheduledLeague({ name: 'Logged' });
  const m = h.db.prepare('SELECT m.id, r.id AS rid FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id LIMIT 1').get(lg);
  await h.request('POST', `/admin/league/${lg}/results/match/${m.id}`, { home_score: '2', away_score: '1' });
  await h.request('POST', `/admin/league/${lg}/results/match/${m.id}`, { home_score: '2', away_score: '2' });
  await h.request('POST', `/admin/league/${lg}/results/round/${m.rid}`, { clear: String(m.id) });

  const rows = h.db.prepare('SELECT * FROM result_log WHERE league_id = ? ORDER BY id').all(lg);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.old_status, r.old_home, r.old_away, r.new_status, r.new_home, r.new_away]), [
    ['scheduled', null, null, 'played', 2, 1],
    ['played', 2, 1, 'played', 2, 2],
    ['played', 2, 2, 'scheduled', null, null],
  ]);
  assert.ok(rows.every((r) => r.ip), 'the address is recorded');

  const page = await get(`/admin/league/${lg}/log`);
  assert.match(page, /Change log/);
  assert.match(page, /Round 1: .* v /);
  assert.match(page, /no result<\/td>\s*<td><strong>2-1/);
  assert.match(page, /<strong>cleared<\/strong>/);
  assert.match(page, /\d{1,2} \w{3}, \d{1,2}:\d{2}(am|pm)/, 'NZ time');
  assert.equal((await h.request('GET', '/admin/league/9999/log')).status, 404);

  // regenerating starts a fresh history
  await h.request('POST', `/admin/league/${lg}/schedule/generate`, { start_date: '2026-10-21', kickoff_start_time: '17:00', slot_minutes: '15', confirm_name: 'Logged' });
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM result_log WHERE league_id = ?').get(lg).c, 0);
});

test('C6: a failed save leaves neither a half-written result nor a log row', () => {
  const { saveScore } = require('../src/lib/results');
  const m = firstMatch();
  const before = h.db.prepare('SELECT COUNT(*) c FROM result_log').get().c;
  assert.throws(() => saveScore(h.db, m.id, 1, 1, 424242)); // penalty winner is not a real team -> FK failure
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM result_log').get().c, before);
  assert.equal(h.db.prepare('SELECT status FROM matches WHERE id = ?').get(m.id).status, m.status);
});
