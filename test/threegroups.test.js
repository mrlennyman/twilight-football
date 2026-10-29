const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { generateCupPlateBowl } = require('../src/lib/schedule');
const { stageName, isThreeGroupFinals } = require('../src/lib/knockoutResult');
const { startApp } = require('./helpers/harness');

const base = {
  groups: [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12]],
  roundNumberStart: 19,
  weekNumber: 7,
  date: '2035-12-05',
  kickoffStartTime: '17:30',
  slotMinutes: 35,
};

const clashes = (rounds) => {
  const keys = rounds.flatMap((r) => r.matches.map((m) => `${r.date}|${r.kickoffTime}|${m.pitchId}`));
  return keys.length - new Set(keys).size;
};

test('Cup / Plate / Bowl on 6 pitches: all three groups side by side, semis then the final', () => {
  const rounds = generateCupPlateBowl({ ...base, pitchIds: [1, 2, 3, 4, 5, 6] });
  assert.equal(rounds.length, 6);
  assert.deepEqual(rounds.map((r) => r.stage), ['cup', 'cup', 'plate', 'plate', 'bowl', 'bowl']);
  assert.deepEqual(rounds.map((r) => r.roundNumber), [19, 20, 21, 22, 23, 24]);
  assert.deepEqual(rounds.map((r) => r.kickoffTime), ['17:30', '18:05', '17:30', '18:05', '17:30', '18:05']);
  assert.equal(clashes(rounds), 0);
  const pair = (m) => [m.homeTeamId, m.awayTeamId];
  assert.deepEqual(rounds[0].matches.map(pair), [[1, 4], [2, 3]], 'semi-finals: 1st v 4th, 2nd v 3rd');
  assert.deepEqual(rounds[2].matches.map(pair), [[5, 8], [6, 7]]);
  assert.deepEqual(rounds[4].matches.map(pair), [[9, 12], [10, 11]]);
  assert.deepEqual(rounds[1].matches.map(pair), [[null, null]], 'the final waits for the semis');
  assert.deepEqual(rounds.filter((r) => r.stage === 'cup').flatMap((r) => r.matches.map((m) => m.pitchId)), [1, 2, 1]);
  assert.deepEqual(rounds.filter((r) => r.stage === 'bowl').flatMap((r) => r.matches.map((m) => m.pitchId)), [5, 6, 5]);
});

test('Cup / Plate / Bowl on fewer pitches never double-books one', () => {
  const four = generateCupPlateBowl({ ...base, pitchIds: [1, 2, 3, 4] });
  assert.equal(clashes(four), 0);
  assert.deepEqual(four.map((r) => r.kickoffTime), ['17:30', '18:05', '17:30', '18:05', '18:40', '19:15'], 'the Bowl follows the Cup and Plate');
  const two = generateCupPlateBowl({ ...base, pitchIds: [1, 2] });
  assert.equal(clashes(two), 0);
  assert.deepEqual(two.map((r) => r.kickoffTime), ['17:30', '18:05', '18:40', '19:15', '19:50', '20:25']);
  assert.throws(() => generateCupPlateBowl({ ...base, pitchIds: [1] }), /at least 2 pitches/);
});

test('helpers', () => {
  assert.equal(stageName('bowl'), 'Bowl');
  assert.equal(stageName('cup'), 'Cup');
  assert.equal(isThreeGroupFinals({ finals_format: 'three' }), true);
  assert.equal(isThreeGroupFinals({ finals_format: null }), false);
});

let h;
let id; // 12 teams
let eight;
test.before(async () => {
  h = await startApp();
  await h.login();
  id = await h.createScheduledLeague({ name: 'Twelve', teams: 12, pitches: 6 });
  eight = await h.createScheduledLeague({ name: 'Eight', teams: 8, pitches: 4 });
});
test.after(async () => {
  await h.close();
});

const setFormat = (leagueId, format) => h.request('POST', `/admin/league/${leagueId}/finals-format`, { format });
const rowsOf = (stage) =>
  h.db
    .prepare(`SELECT m.*, r.round_number FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = ? ORDER BY r.round_number, m.id`)
    .all(id, stage);
const reload = (m) => h.db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
const ko = (m, home, away) => h.request('POST', `/admin/league/${id}/knockout-results/match/${m.id}`, { home_score: String(home), away_score: String(away) });

test('the Finals settings page loads, and Cup / Plate / Bowl needs exactly 12 teams', async () => {
  const page = await h.request('GET', `/admin/league/${id}/finals-format`);
  assert.equal(page.status, 200);
  assert.match(page.text, /How the finals work/);
  assert.match(page.text, /three groups of 4/);
  assert.match((await h.request('GET', '/admin')).text, new RegExp(`/admin/league/${id}/finals-format`));

  const refused = await setFormat(eight, 'three');
  assert.equal(refused.status, 200);
  assert.match(refused.text, /needs exactly 12 teams/);
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(eight).finals_format, null);

  assert.equal((await setFormat(id, 'three')).status, 302);
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(id).finals_format, 'three');
});

test('turning it on changes the public table, the menu tab and the finals page', async () => {
  const table = (await h.request('GET', `/league/${id}`)).text;
  for (const word of ['Cup', 'Plate', 'Bowl']) assert.match(table, new RegExp(`<td colspan="9">${word}</td>`));
  assert.match(table, /<span class="app-nav-label">Finals<\/span>/);

  const bracket = (await h.request('GET', `/league/${id}/bracket`)).text;
  assert.match(bracket, /How the finals work/);
  assert.match(bracket, /Grand Final/);
  assert.match(bracket, /haven't started yet/);

  // a league on the standard format is untouched
  const other = (await h.request('GET', `/league/${eight}/bracket`)).text;
  assert.doesNotMatch(other, /How the finals work/);
});

test('three groups of four are drawn from the final table, and play through to complete', async () => {
  const groupMatches = h.db
    .prepare('SELECT m.id, m.home_team_id AS h, m.away_team_id AS a FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?')
    .all(id);
  for (const m of groupMatches) {
    const homeWins = m.h > m.a; // the higher team id always wins, so the table is strict
    await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: homeWins ? '3' : '0', away_score: homeWins ? '0' : '3' });
  }
  const results = (await h.request('GET', `/admin/league/${id}/results`)).text;
  assert.match(results, /Generate the finals brackets/);
  assert.equal((results.match(/class="split-row"/g) || []).length, 2, 'the admin table marks both cuts (after 4th and 8th)');

  assert.equal((await h.request('POST', `/admin/league/${id}/generate-knockouts`)).status, 302);
  const order = h.db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id DESC').all(id).map((t) => t.id); // best team first: highest id wins
  const sets = { cup: order.slice(0, 4), plate: order.slice(4, 8), bowl: order.slice(8, 12) };
  for (const stage of ['cup', 'plate', 'bowl']) {
    const rows = rowsOf(stage);
    assert.deepEqual(rows.map((m) => m.bracket_slot), ['semi_1', 'semi_2', 'final']);
    const teams = new Set([rows[0].home_team_id, rows[0].away_team_id, rows[1].home_team_id, rows[1].away_team_id]);
    assert.deepEqual([...teams].sort((a, b) => a - b), [...sets[stage]].sort((a, b) => a - b), `${stage} holds the right four teams`);
    assert.deepEqual([rows[0].home_team_id, rows[0].away_team_id], [sets[stage][0], sets[stage][3]], '1st v 4th');
    assert.deepEqual([rows[1].home_team_id, rows[1].away_team_id], [sets[stage][1], sets[stage][2]], '2nd v 3rd');
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage != 'group' AND date = (SELECT MIN(date) FROM rounds WHERE league_id = ? AND stage != 'group')").get(id, id).n, 6, 'everything on one night');

  // locked once drawn
  const locked = await setFormat(id, 'standard');
  assert.match(locked.text, /locked/);
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(id).finals_format, 'three');

  const pub = (await h.request('GET', `/league/${id}/bracket`)).text;
  assert.match(pub, /<h2>Bowl<\/h2>/);
  const adminPage = (await h.request('GET', `/admin/league/${id}/results`)).text;
  assert.match(adminPage, /Bowl \(places 9 to 12\)/);

  // play every semi and final; the league is complete only when all three brackets are
  for (const stage of ['cup', 'plate']) {
    const [s1, s2, f] = rowsOf(stage);
    await ko(s1, 2, 0);
    await ko(s2, 1, 0);
    await ko(reload(f), 1, 0);
  }
  assert.notEqual(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'complete', 'the Bowl is still to play');
  const [b1, b2, bf] = rowsOf('bowl');
  await ko(b1, 3, 1);
  await ko(b2, 0, 2);
  assert.equal(reload(bf).home_team_id, b1.home_team_id);
  assert.equal(reload(bf).away_team_id, b2.away_team_id);
  await ko(reload(bf), 1, 1).then((r) => assert.equal(r.status, 400, 'a drawn final needs a shootout winner'));
  await h.request('POST', `/admin/league/${id}/knockout-results/match/${bf.id}`, { home_score: '1', away_score: '1', penalty_winner_id: String(b1.home_team_id) });
  assert.equal(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'complete');

  const log = (await h.request('GET', `/admin/league/${id}/log`)).text;
  assert.match(log, /Bowl final/);
  const team = (await h.request('GET', `/league/${id}/team/${b1.home_team_id}`)).text;
  assert.match(team, /Bowl semi-final/);
});

test('resetting the brackets removes the Bowl too and unlocks the format', async () => {
  const res = await h.request('POST', `/admin/league/${id}/knockouts/reset`, { confirm_name: 'Twelve' });
  assert.equal(res.status, 302);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage IN ('cup','plate','bowl')").get(id).n, 0);
  assert.equal((await setFormat(id, 'standard')).status, 302);
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(id).finals_format, null);
});

test('a database made before the Bowl existed is upgraded in place, keeping every row', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbold-'));
  const file = path.join(dir, 'old.sqlite');
  const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8').replace("'plate', 'bowl'", "'plate'");
  assert.ok(!schema.includes("'bowl'"), 'built the old schema');
  const old = new DatabaseSync(file);
  old.exec(schema);
  old.exec("INSERT INTO leagues (id, name, season) VALUES (1, 'Old League', 'S')");
  old.exec("INSERT INTO teams (id, league_id, name) VALUES (1, 1, 'A'), (2, 1, 'B')");
  old.exec("INSERT INTO rounds (id, league_id, round_number, week_number, stage, date, kickoff_time) VALUES (7, 1, 1, 1, 'group', '2026-10-14', '17:00'), (8, 1, 2, 2, 'cup', '2026-10-21', '17:00')");
  old.exec("INSERT INTO matches (id, round_id, home_team_id, away_team_id, home_score, away_score, status, bracket_slot) VALUES (3, 7, 1, 2, 2, 1, 'played', NULL), (4, 8, 1, 2, NULL, NULL, 'scheduled', 'final')");
  old.close();

  // a second app in the same process can't be started, so run the real db module in its own process
  const { execFileSync } = require('child_process');
  const script = `
    const db = require(${JSON.stringify(path.join(__dirname, '../src/db'))});
    const out = {
      sqlHasBowl: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'rounds'").get().sql.includes("'bowl'"),
      rounds: db.prepare('SELECT id, stage, date FROM rounds ORDER BY id').all(),
      matches: db.prepare('SELECT id, round_id, status, home_score FROM matches ORDER BY id').all(),
      fk: db.prepare('PRAGMA foreign_key_check').all().length,
      index: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_rounds_league'").get(),
      finals: db.prepare('PRAGMA table_info(leagues)').all().some((c) => c.name === 'finals_format'),
    };
    db.prepare("INSERT INTO rounds (league_id, round_number, week_number, stage) VALUES (1, 3, 3, 'bowl')").run();
    out.bowlInserted = db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE stage = 'bowl'").get().n;
    db.prepare('DELETE FROM leagues WHERE id = 1').run();
    out.afterDelete = { rounds: db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n, matches: db.prepare('SELECT COUNT(*) AS n FROM matches').get().n };
    console.log(JSON.stringify(out));
  `;
  const stdout = execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, DATABASE_PATH: file, BACKUP_DIR: path.join(dir, 'backups') },
    encoding: 'utf8',
  });
  const out = JSON.parse(stdout.trim().split('\n').pop());
  assert.equal(out.sqlHasBowl, true);
  assert.deepEqual(out.rounds, [{ id: 7, stage: 'group', date: '2026-10-14' }, { id: 8, stage: 'cup', date: '2026-10-21' }]);
  assert.deepEqual(out.matches, [{ id: 3, round_id: 7, status: 'played', home_score: 2 }, { id: 4, round_id: 8, status: 'scheduled', home_score: null }]);
  assert.equal(out.fk, 0, 'no broken references');
  assert.equal(out.index, true);
  assert.equal(out.finals, true);
  assert.equal(out.bowlInserted, 1);
  assert.deepEqual(out.afterDelete, { rounds: 0, matches: 0 }, 'cascading deletes still work through the rebuilt table');
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => /pre-bowl-migration/.test(f)), 'a safety copy was taken first');
});
