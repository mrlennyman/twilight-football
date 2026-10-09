const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { splitCaptain, parsePlayerList, planRosterImport, applyRosterImport, replaceRoster, playerLine } = require('../src/lib/rosterText');
const { startApp } = require('./helpers/harness');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

test('splitCaptain: "(c)" after a name marks a captain (any case, also (captain)); nothing else does', () => {
  assert.deepEqual(splitCaptain('Jack Brown (c)'), { name: 'Jack Brown', captain: true });
  assert.deepEqual(splitCaptain('Jack Brown (C)'), { name: 'Jack Brown', captain: true });
  assert.deepEqual(splitCaptain('Jack Brown(c)'), { name: 'Jack Brown', captain: true });
  assert.deepEqual(splitCaptain('  Jack   Brown  (captain) '), { name: 'Jack Brown', captain: true });
  assert.deepEqual(splitCaptain('Jack Brown'), { name: 'Jack Brown', captain: false });
  assert.deepEqual(splitCaptain('Chris (c) Brown'), { name: 'Chris (c) Brown', captain: false }, 'only at the end');
  assert.equal(playerLine({ name: 'Jack Brown', is_captain: 1 }), 'Jack Brown (c)');
  assert.equal(playerLine({ name: 'Mia Chen', is_captain: 0 }), 'Mia Chen');
});

test('parsePlayerList keeps the marker for later, drops lines that are only "(c)", and checks the real name length', () => {
  assert.deepEqual(parsePlayerList('1. Jack Brown (c)\nMia Chen\n(c)').names, ['Jack Brown (c)', 'Mia Chen']);
  assert.equal(parsePlayerList(`${'x'.repeat(60)} (c)`).errors.length, 0, 'the marker does not count towards the 60');
  assert.equal(parsePlayerList(`${'x'.repeat(61)} (c)`).errors.length, 1);
});

function league(rosters) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', 'S')").run();
  db.prepare("INSERT INTO teams (id, league_id, name) VALUES (1, 1, 'Rovers')").run();
  for (const [name, cap] of rosters) db.prepare('INSERT INTO players (team_id, name, is_captain) VALUES (1, ?, ?)').run(name, cap);
  return db;
}
const roster = (db) => db.prepare('SELECT name, is_captain FROM players WHERE team_id = 1 ORDER BY is_captain DESC, name').all().map((p) => `${p.name}${p.is_captain ? '*' : ''}`);

test('replaceRoster stores captains; plan/apply add mode promotes an existing player pasted with (c)', () => {
  const db = league([]);
  replaceRoster(db, 1, ['Zoe Park (c)', 'Ana Ngata', 'Mia Chen']);
  assert.deepEqual(roster(db), ['Zoe Park*', 'Ana Ngata', 'Mia Chen'], 'captain first, then A-Z');

  const plan = planRosterImport(db, 1, [{ name: 'Rovers', kit: '', players: ['ana ngata (c)', 'New Kid (c)', 'Mia Chen'] }]);
  assert.deepEqual(plan.items[0].adds, ['New Kid (c)']);
  assert.deepEqual(plan.items[0].promote, ['ana ngata']);
  assert.equal(plan.items[0].skipped, 2);
  applyRosterImport(db, plan);
  assert.deepEqual(roster(db), ['Ana Ngata*', 'New Kid*', 'Zoe Park*', 'Mia Chen'], 'a team can have more than one captain');
});

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
  await h.request('POST', '/admin/import', { name: 'Kids', season: 'S', num_pitches: '2', rounds_per_week: '3', csv: 'Rovers,Zoe Park (c),Red\nRovers,Ana Ngata\nWanderers,Mia Chen\nWanderers,Sam Lee (c)\nUnited,Jack Brown\nCity,Liam Walker' });
  h.db.exec("UPDATE leagues SET status = 'in_progress'");
});
test.after(() => h.close());
const get = async (url) => (await h.request('GET', url)).text;

test('a new league imported from CSV understands (c)', () => {
  const rows = h.db.prepare('SELECT p.name, p.is_captain FROM players p JOIN teams t ON t.id = p.team_id WHERE t.name = ? ORDER BY p.is_captain DESC, p.name').all('Rovers');
  assert.deepEqual(rows.map((r) => [r.name, r.is_captain]), [['Zoe Park', 1], ['Ana Ngata', 0]]);
});

test('admin: the roster box shows (c) and saving it keeps captains; captains list first', async () => {
  const page = await get('/admin/league/1/teams');
  assert.match(page, /<textarea name="players"[^>]*>Zoe Park \(c\)\nAna Ngata<\/textarea>/, 'captain first, marked (c)');
  assert.match(page, /type <strong>\(c\)<\/strong> after their name/);

  const teamId = h.db.prepare("SELECT id FROM teams WHERE name = 'Rovers'").get().id;
  await h.request('POST', `/admin/league/1/teams/${teamId}`, { name: 'Rovers', kit_colour: 'Red', players: 'Ana Ngata (c)\nZoe Park\nBen Hill' });
  const rows = h.db.prepare('SELECT name, is_captain FROM players WHERE team_id = ? ORDER BY is_captain DESC, name').all(teamId);
  assert.deepEqual(rows.map((r) => [r.name, r.is_captain]), [['Ana Ngata', 1], ['Ben Hill', 0], ['Zoe Park', 0]]);
});

test('paste all teams understands (c) in both layouts', async () => {
  await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'blocks', text: 'United\nJack Brown\nTe Rangi H. (c)\n\nCity\nLiam Walker (c)', replace: 'on' });
  const caps = h.db.prepare('SELECT p.name FROM players p JOIN teams t ON t.id = p.team_id WHERE p.is_captain = 1 AND t.name IN (?, ?) ORDER BY p.name').all('United', 'City').map((r) => r.name);
  assert.deepEqual(caps, ['Liam Walker', 'Te Rangi H.']);
  await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'csv', text: 'Wanderers\tMia Chen (c)', replace: 'on' });
  assert.deepEqual(h.db.prepare("SELECT p.name, p.is_captain FROM players p JOIN teams t ON t.id = p.team_id WHERE t.name = 'Wanderers'").all().map((r) => [r.name, r.is_captain]), [['Mia Chen', 1]]);
});

test('public Teams page: captains first, in their own font style, with (c); names are still first name + initial', async () => {
  const page = await get('/league/1/teams');
  const rovers = page.match(/<div class="team-card" data-team-id="\d+">\s*<h3><a [^>]*>Rovers<\/a>[\s\S]*?<\/ul>/)[0];
  assert.match(rovers, /<li class="is-captain"><span>Ana N\. <span class="cap-mark" title="Captain">\(c\)<\/span><\/span><\/li>/);
  assert.ok(rovers.indexOf('Ana N.') < rovers.indexOf('Zoe P.'), 'captain listed before Zoe, who is alphabetically later');
  assert.doesNotMatch(page, /Ana Ngata|Zoe Park/);
});

test('captain always tops the list even when alphabetically last', async () => {
  const teamId = h.db.prepare("SELECT id FROM teams WHERE name = 'Rovers'").get().id;
  await h.request('POST', `/admin/league/1/teams/${teamId}`, { name: 'Rovers', kit_colour: '', players: 'Aaron A\nBella B\nZed Zimmerman (c)' });
  const page = await get('/league/1/teams');
  const rovers = page.match(/<h3><a [^>]*>Rovers<\/a>[\s\S]*?<\/ul>/)[0];
  assert.ok(rovers.indexOf('Zed Z.') < rovers.indexOf('Aaron A.'));
  const team = await get(`/league/1/team/${teamId}`);
  const squad = team.match(/<ul class="squad">[\s\S]*?<\/ul>/)[0];
  assert.ok(squad.indexOf('Zed Z.') < squad.indexOf('Aaron A.'));
});

test('team page: squad (with count and captain) beside fixtures; standing chips only once games are played', async () => {
  const teamId = h.db.prepare("SELECT id FROM teams WHERE name = 'Rovers'").get().id;
  await h.request('POST', `/admin/league/1/schedule/generate`, { start_date: '2026-10-14', kickoff_start_time: '17:00', slot_minutes: '15' });
  const before = await get(`/league/1/team/${teamId}`);
  assert.match(before, /<h3 id="squad-title">Squad <span class="squad-count">\(3\)<\/span><\/h3>/);
  assert.match(before, /<li class="is-captain">Zed Z\. <span class="cap-mark" title="Captain">\(c\)<\/span><\/li>/);
  assert.match(before, /<h3 id="fixtures-title">Fixtures &amp; results<\/h3>/);
  assert.ok(before.indexOf('squad-card') < before.indexOf('team-fixtures'), 'squad comes first (left on a wide screen)');
  assert.doesNotMatch(before, /team-chip-strong/, 'no position before any game is played');
  assert.match(before, /id="follow-help"[^>]*hidden>Following highlights this team in gold on every page, on this phone only\./);

  const m = h.db.prepare('SELECT m.id FROM matches m WHERE m.home_team_id = ? OR m.away_team_id = ? ORDER BY m.id LIMIT 1').get(teamId, teamId);
  const isHome = h.db.prepare('SELECT home_team_id FROM matches WHERE id = ?').get(m.id).home_team_id === teamId;
  await h.request('POST', `/admin/league/1/results/match/${m.id}`, { home_score: isHome ? '3' : '0', away_score: isHome ? '0' : '3' });
  const after = await get(`/league/1/team/${teamId}`);
  assert.match(after, /<span class="team-chip team-chip-strong">1st &middot; 3 pts<\/span>/);
  assert.match(after, /W1 D0 L0/);
});

test('an empty squad says so; an old database gains the is_captain column on startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbcap-'));
  const file = path.join(dir, 'old.sqlite');
  const old = new DatabaseSync(file);
  old.exec(schema.replace(/,\s*is_captain INTEGER NOT NULL DEFAULT 0/, ''));
  old.exec("INSERT INTO leagues (name, season) VALUES ('Old', 'S'); INSERT INTO teams (league_id, name) VALUES (1, 'T'); INSERT INTO players (team_id, name) VALUES (1, 'Existing Player')");
  assert.ok(!old.prepare('PRAGMA table_info(players)').all().some((c) => c.name === 'is_captain'));
  old.close();
  const script = "const db=require('./src/db');console.log(JSON.stringify(db.prepare('SELECT name,is_captain FROM players').all()));";
  const res = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_PATH: file }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), [{ name: 'Existing Player', is_captain: 0 }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('home and login screens: <html> carries its own dark colour so no light sliver can show at the edge', async () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');
  assert.match(css, /html\.home-page-root,\s*html\.login-page-root\s*\{[^}]*background:\s*#240812/);
  assert.match(css, /\.home-page,\s*\.login-page\s*\{\s*min-height:\s*100vh;\s*min-height:\s*100lvh/);
  assert.match(css, /\.home-page \.site-footer\s*\{[^}]*position:\s*fixed/, 'footer text is kept, pinned');
  const login = await get('/admin/login');
  assert.match(login, /<html lang="en" class="login-page-root">/);
});
