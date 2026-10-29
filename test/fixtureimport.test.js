const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseFixtureCsv, parseDate, parseTime } = require('../src/lib/fixtureImport');
const { startApp } = require('./helpers/harness');

const REAL_CSV = fs.readFileSync(path.join(__dirname, '../twilight-2026-fixtures.csv'), 'utf8');

test('dates and times are read the way a draw sheet writes them', () => {
  assert.equal(parseDate('2026-10-28'), '2026-10-28');
  assert.equal(parseDate('28 Oct 2026'), '2026-10-28');
  assert.equal(parseDate('Wed 28 October 2026'), '2026-10-28');
  assert.equal(parseDate('28/10/2026'), '2026-10-28');
  assert.equal(parseDate('2 Dec 2026'), '2026-12-02');
  assert.equal(parseDate('31/02/2026'), null);
  assert.equal(parseDate('soon'), null);
  assert.equal(parseTime('17:30'), '17:30');
  assert.equal(parseTime('5:30 PM'), '17:30');
  assert.equal(parseTime('5.30pm'), '17:30');
  assert.equal(parseTime('12:05 AM'), '00:05');
  assert.equal(parseTime('6:40 PM'), '18:40');
  assert.equal(parseTime('25:00'), null);
  assert.equal(parseTime('5'), null);
});

test('the Twilight draw file parses to 108 matches', () => {
  const parsed = parseFixtureCsv(REAL_CSV);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows.length, 108);
});

test('headerless files and spreadsheet-style dates work, bad rows are named', () => {
  const ok = parseFixtureCsv('28 Oct 2026\t5:30 PM\t1\tRovers\tCity\t1\n28 Oct 2026\t5:30 PM\t2\tUnited\tTown\t2');
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.rows[1].home, 'United');
  assert.equal(ok.rows[0].time, '17:30');

  const bad = parseFixtureCsv('date,time,home,away\nsoon,17:30,A,B\n2026-10-28,noon,A,A');
  assert.match(bad.errors.join(' '), /Row 2: "soon" is not a date/);
  assert.match(bad.errors.join(' '), /Row 3: "noon" is not a time/);
  assert.match(bad.errors.join(' '), /Row 3: A can't play itself/);
});

let h;
let db;
test.before(async () => {
  h = await startApp();
  db = require('../src/db');
  await h.login();
});
test.after(async () => {
  await h.close();
});

const make = async (name, teams, pitches) => {
  await h.request('POST', '/admin/leagues', { name, season: 'Summer', num_teams: String(teams), num_pitches: String(pitches), rounds_per_week: '3' });
  return db.prepare('SELECT MAX(id) AS id FROM leagues').get().id;
};

test('importing the real draw fills a fresh 12-team league', async () => {
  const id = await make('Twilight Social', 12, 6);
  const preview = await h.request('POST', `/admin/league/${id}/fixture-import/preview`, { text: REAL_CSV });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /<strong>108<\/strong> in 18 rounds over 6 weeks \(3 rounds a week\)/);
  assert.match(preview.text, /2026-10-28 at 17:30, 35 minutes between rounds/);
  assert.match(preview.text, /renames Team 1/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE league_id = ?').get(id).n, 0, 'a preview changes nothing');

  const done = await h.request('POST', `/admin/league/${id}/fixture-import/confirm`, { text: REAL_CSV });
  assert.equal(done.status, 302);
  assert.equal(done.location, `/admin/league/${id}/schedule`);

  const rounds = db.prepare('SELECT * FROM rounds WHERE league_id = ? ORDER BY round_number').all(id);
  assert.equal(rounds.length, 18);
  assert.deepEqual([...new Set(rounds.map((r) => r.week_number))], [1, 2, 3, 4, 5, 6]);
  assert.equal(rounds[0].date, '2026-10-28');
  assert.equal(rounds[0].kickoff_time, '17:30');
  assert.equal(rounds[1].kickoff_time, '18:05');
  assert.equal(rounds[17].date, '2026-12-02');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE league_id = ?)').get(id).n, 108);

  const names = db.prepare('SELECT name FROM teams WHERE league_id = ? ORDER BY name').all(id).map((t) => t.name);
  assert.equal(names.length, 12);
  assert.ok(names.includes('2 Left Feet') && names.includes('Comebacks are Real') && names.includes('ST.NUC'));
  assert.ok(!names.some((n) => /^Team \d+$/.test(n)));

  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  assert.equal(league.status, 'in_progress');
  assert.equal(league.num_teams, 12);
  assert.equal(league.num_pitches, 6);
  assert.equal(league.slot_minutes, 35);
  assert.equal(league.start_date, '2026-10-28');

  // first match of the file: 2 Left Feet v Toe Hackers on pitch 1
  const first = db
    .prepare(
      `SELECT ht.name AS h, at.name AS a, p.label FROM matches m JOIN rounds r ON r.id = m.round_id
       JOIN teams ht ON ht.id = m.home_team_id JOIN teams at ON at.id = m.away_team_id JOIN pitches p ON p.id = m.pitch_id
       WHERE r.league_id = ? AND r.round_number = 1 ORDER BY m.id LIMIT 1`
    )
    .get(id);
  assert.deepEqual({ ...first }, { h: '2 Left Feet', a: 'Toe Hackers', label: 'Pitch 1' });

  // the public pages and the admin pages render with the imported draw
  for (const url of [`/league/${id}`, `/league/${id}/fixtures`, `/league/${id}/teams`, `/admin/league/${id}/schedule`, `/admin/league/${id}/results`]) {
    assert.equal((await h.request('GET', url)).status, 200, url);
  }
});

test('re-importing over results needs the league name, and a safety backup is taken', async () => {
  const id = db.prepare("SELECT id FROM leagues WHERE name = 'Twilight Social'").get().id;
  const match = db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id LIMIT 1').get(id);
  await h.request('POST', `/admin/league/${id}/results/match/${match.id}`, { home_score: '2', away_score: '1' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches WHERE status = 'played'").get().n >= 1, true);

  const refused = await h.request('POST', `/admin/league/${id}/fixture-import/confirm`, { text: REAL_CSV });
  assert.equal(refused.status, 400);
  assert.match(refused.text, /type the league name/i);

  const ok = await h.request('POST', `/admin/league/${id}/fixture-import/confirm`, { text: REAL_CSV, confirm_name: 'Twilight Social' });
  assert.equal(ok.status, 302);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND m.status = 'played'").get(id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(id).n, 12, 'no duplicate teams on a second import');
});

test('a draw that puts a team in two matches at once is refused', async () => {
  const id = await make('Bad Draw', 4, 2);
  const csv = 'date,time,home,away,pitch\n2026-10-28,17:30,A,B,1\n2026-10-28,17:30,A,C,2\n2026-10-28,18:05,B,C,1';
  const res = await h.request('POST', `/admin/league/${id}/fixture-import/preview`, { text: csv });
  assert.match(res.text, /A is in two matches at 2026-10-28 17:30/);
  assert.match(res.text, /Nothing was changed/);
  const go = await h.request('POST', `/admin/league/${id}/fixture-import/confirm`, { text: csv });
  assert.equal(go.status, 200, 'shows the problems instead of importing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE league_id = ?').get(id).n, 0);
});

test('a league team that is missing from the file blocks the import', async () => {
  const id = await make('Named Teams', 4, 2);
  await h.request('POST', `/admin/league/${id}/teams/${db.prepare('SELECT MIN(id) AS id FROM teams WHERE league_id = ?').get(id).id}`, { name: 'Real Name FC' });
  const csv = 'date,time,home,away,pitch\n2026-10-28,17:30,A,B,1\n2026-10-28,17:30,C,D,2';
  const res = await h.request('POST', `/admin/league/${id}/fixture-import/preview`, { text: csv });
  assert.match(res.text, /&#34;Real Name FC&#34; is in this league but not in the file|"Real Name FC" is in this league but not in the file/);
});

test('the schedule page links to the importer, which needs login', async () => {
  const id = db.prepare("SELECT id FROM leagues WHERE name = 'Twilight Social'").get().id;
  const page = await h.request('GET', `/admin/league/${id}/schedule`);
  assert.match(page.text, new RegExp(`href="/admin/league/${id}/fixture-import"`));
});

test('the "create a league from a CSV" page takes a fixture list and builds the whole league', async () => {
  const res = await h.request('POST', '/admin/import', { name: 'From Draw', season: 'Summer 2026', num_pitches: '4', rounds_per_week: '3', csv: REAL_CSV });
  assert.equal(res.status, 302);
  const id = Number(res.location.match(/league\/(\d+)\/schedule/)[1]);
  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  assert.equal(league.name, 'From Draw');
  assert.equal(league.num_teams, 12);
  assert.equal(league.num_pitches, 6, 'worked out from the file, not the form box');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rounds WHERE league_id = ?').get(id).n, 18);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE league_id = ?)').get(id).n, 108);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pages WHERE league_id = ?").get(id).n > 0, true, 'starter info pages are created');
});

test('a bad fixture file on that page creates nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n;
  const csv = 'date,time,home,away,pitch\n2026-10-28,17:30,A,B,1\n2026-10-28,17:30,A,C,2';
  const res = await h.request('POST', '/admin/import', { name: 'Nope', season: 'S', num_pitches: '2', rounds_per_week: '3', csv });
  assert.equal(res.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, before);
});

test('a fixture list pasted into the player-list importer points to the right page', async () => {
  const id = db.prepare("SELECT id FROM leagues WHERE name = 'Twilight Social'").get().id;
  const res = await h.request('POST', `/admin/league/${id}/roster-import/preview`, { format: 'csv', text: REAL_CSV });
  assert.match(res.text, /looks like a fixture list/);
  assert.match(res.text, /Import fixtures from a file/);
});
