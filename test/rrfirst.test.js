const test = require('node:test');
const assert = require('node:assert/strict');
const { generateFinalsRoundRobins } = require('../src/lib/schedule');
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

test('round robins on 6 pitches: three groups side by side, 3 slots, everyone plays the other three once', () => {
  const rounds = generateFinalsRoundRobins({ ...base, pitchIds: [1, 2, 3, 4, 5, 6] });
  assert.equal(rounds.length, 9);
  assert.deepEqual(rounds.map((r) => r.roundNumber), [19, 20, 21, 22, 23, 24, 25, 26, 27]);
  assert.deepEqual(rounds.map((r) => r.stage), ['cup', 'cup', 'cup', 'plate', 'plate', 'plate', 'bowl', 'bowl', 'bowl']);
  assert.deepEqual(rounds.slice(0, 3).map((r) => r.kickoffTime), ['17:30', '18:05', '18:40']);
  assert.deepEqual(rounds.slice(3, 6).map((r) => r.kickoffTime), ['17:30', '18:05', '18:40']);
  assert.equal(clashes(rounds), 0);
  assert.ok(rounds.every((r) => r.matches.length === 2 && r.matches.every((m) => m.bracketSlot === 'rr')));
  for (const group of base.groups) {
    const seen = new Set();
    for (const r of rounds.filter((x) => x.matches.some((m) => group.includes(m.homeTeamId)))) {
      const teams = r.matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]);
      assert.equal(new Set(teams).size, 4, 'all four teams play in every round');
      for (const m of r.matches) {
        const pair = [m.homeTeamId, m.awayTeamId].sort((a, b) => a - b).join('-');
        assert.ok(!seen.has(pair), `${pair} plays only once`);
        seen.add(pair);
      }
    }
    assert.equal(seen.size, 6);
  }
  assert.deepEqual(rounds[0].matches.map((m) => [m.homeTeamId, m.awayTeamId]), [[1, 4], [2, 3]], 'round 1: 1st v 4th, 2nd v 3rd');
});

test('round robins on fewer pitches never double-book one', () => {
  const four = generateFinalsRoundRobins({ ...base, pitchIds: [1, 2, 3, 4] });
  assert.equal(clashes(four), 0);
  assert.deepEqual(four.slice(6).map((r) => r.kickoffTime), ['19:15', '19:50', '20:25'], 'the Bowl follows the Cup and Plate');
  const two = generateFinalsRoundRobins({ ...base, pitchIds: [1, 2] });
  assert.equal(clashes(two), 0);
  assert.throws(() => generateFinalsRoundRobins({ ...base, pitchIds: [1] }), /at least 2 pitches/);
});

let h;
let id;
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

const post = (url, form = {}) => h.request('POST', `/admin/league/${id}${url}`, form);
const get = async (url, leagueId = id) => (await h.request('GET', url.startsWith('/league') ? url.replace('/league', `/league/${leagueId}`) : `/admin/league/${leagueId}${url}`)).text;
const rowsOf = (stage, slot) =>
  h.db
    .prepare(
      `SELECT m.*, r.round_number, r.date, r.kickoff_time FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND ${slot === 'rr' ? "m.bracket_slot = 'rr'" : "m.bracket_slot != 'rr'"} ORDER BY r.round_number, m.id`
    )
    .all(id, stage);
const reload = (m) => h.db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
const score = (m, home, away, extra = {}) =>
  post(`/knockout-results/match/${m.id}`, { home_score: String(home), away_score: String(away), ...extra });
/** The higher team id wins every game, so the order of any group is simply highest id first. */
const higherWins = (m) => (m.home_team_id > m.away_team_id ? score(m, 1, 0) : score(m, 0, 1));

test('the option is chosen on the Finals page and needs exactly 12 teams', async () => {
  const page = await get('/finals-format');
  assert.match(page, /round robin first/);
  assert.match(page, /name="format" value="three_rr"/);
  const refused = await h.request('POST', `/admin/league/${eight}/finals-format`, { format: 'three_rr' });
  assert.match(refused.text, /needs exactly 12 teams/);
  assert.equal((await post('/finals-format', { format: 'three_rr' })).status, 302);
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(id).finals_format, 'three_rr');
  // the explanation, menu tab and table bands follow the choice
  const pub = await get('/league/bracket');
  assert.match(pub, /Finals week 1: round robin/);
  assert.match(await get('/league'), /<td colspan="9">Cup<\/td>/);
});

test('after the group stage the three groups are drawn, each with a round robin and a table starting at zero', async () => {
  const groupMatches = h.db
    .prepare('SELECT m.id, m.home_team_id AS h, m.away_team_id AS a FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?')
    .all(id);
  assert.match(await get('/results'), /Available once every group-stage match has a result/);
  for (const m of groupMatches) {
    const homeWins = m.h > m.a;
    await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: homeWins ? '3' : '0', away_score: homeWins ? '0' : '3' });
  }
  const results = await get('/results');
  assert.match(results, /Draw the Cup, Plate &amp; Bowl groups/);

  // the one-step route does nothing for this format
  await post('/generate-knockouts');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).n, 0);

  assert.equal((await post('/generate-finals-groups')).status, 302);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).n, 9);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage != 'group'").get(id).n, 18);

  const order = h.db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id DESC').all(id).map((t) => t.id); // best first
  const sets = { cup: order.slice(0, 4), plate: order.slice(4, 8), bowl: order.slice(8, 12) };
  for (const stage of ['cup', 'plate', 'bowl']) {
    const teams = new Set(rowsOf(stage, 'rr').flatMap((m) => [m.home_team_id, m.away_team_id]));
    assert.deepEqual([...teams].sort((x, y) => x - y), [...sets[stage]].sort((x, y) => x - y), `${stage} group`);
    assert.equal(rowsOf(stage, 'rr').length, 6);
  }
  const lastGroupDate = h.db.prepare("SELECT MAX(date) AS d FROM rounds WHERE league_id = ? AND stage = 'group'").get(id).d;
  const rrDate = rowsOf('cup', 'rr')[0].date;
  assert.equal((new Date(`${rrDate}T12:00:00Z`) - new Date(`${lastGroupDate}T12:00:00Z`)) / 86400000, 7, 'the Wednesday after the last group night');

  // one table per group, every team on zero, on the Finals page
  const finals = await get('/league/bracket');
  // one group at a time, with tabs: Cup first, the others a tap away
  assert.match(finals, /class="week-tabs finals-tabs"/);
  assert.match(finals, /<a href="\?group=cup" class="active">Cup<\/a>/);
  assert.match(finals, /<a href="\?group=bowl" class="">Bowl<\/a>/);
  assert.match(finals, /<h2>Cup <span/);
  assert.doesNotMatch(finals, /<h2>Plate <span/);
  assert.equal((finals.match(/<table class="standings-table">/g) || []).length, 1);
  for (const word of ['plate', 'bowl']) {
    const tab = await h.request('GET', `/league/${id}/bracket?group=${word}`);
    assert.match(tab.text, new RegExp(`<h2>${word[0].toUpperCase()}${word.slice(1)} <span`));
    assert.equal((tab.text.match(/<table class="standings-table">/g) || []).length, 1);
  }
  assert.match((await h.request('GET', `/league/${id}/bracket?group=nonsense`)).text, /<h2>Cup <span/, 'an unknown tab falls back to the Cup');
  // the Standings page stays just the group-stage table
  assert.doesNotMatch(await get('/league'), /Finals groups/);
  assert.equal((await get('/league')).match(/<table class="standings-table">/g).length, 1, 'only the group-stage table');

  // the format is locked now, and the knockouts can't be drawn early
  assert.match((await post('/finals-format', { format: 'standard' })).text, /locked/);
  await post('/generate-finals-knockouts');
  assert.equal(rowsOf('cup', 'ko').length, 0);
  assert.match(await get('/results'), /Available once every round-robin game has a result/);
});

test('round-robin games can be drawn, a table builds up, and ties are settled per group', async () => {
  // Cup: higher id always wins -> strict table. Plate: every game drawn -> four teams level, needs shootouts. Bowl: strict.
  for (const m of rowsOf('cup', 'rr')) await higherWins(m);
  for (const m of rowsOf('plate', 'rr')) assert.equal((await score(m, 2, 2)).status, 302, 'a drawn round-robin game needs no shootout');
  for (const m of rowsOf('bowl', 'rr')) await higherWins(m);

  const cupIds = [...new Set(rowsOf('cup', 'rr').flatMap((m) => [m.home_team_id, m.away_team_id]))].sort((x, y) => y - x);
  const cupTable = await get('/league/bracket');
  assert.match(cupTable, /data-team-id="\d+"/);

  // Plate is level: the knockouts are blocked until every pair has a shootout
  const results = await get('/results');
  assert.match(results, /Record the shootout results - Plate/);
  assert.match(results, /Settle the tied teams above first/);
  await post('/generate-finals-knockouts');
  assert.equal(rowsOf('cup', 'ko').length, 0, 'blocked while a finals group is level');

  const plateIds = [...new Set(rowsOf('plate', 'rr').flatMap((m) => [m.home_team_id, m.away_team_id]))].sort((x, y) => y - x);
  assert.equal((await post('/tie-break', { stage: 'plate', team_a_id: String(plateIds[0]), team_b_id: String(plateIds[1]), winner_team_id: String(plateIds[0]) })).status, 302);
  assert.match(await get('/results'), /Record the shootout results - Plate/, 'one pair is not enough');
  for (let x = 0; x < 4; x++) {
    for (let y = x + 1; y < 4; y++) {
      await post('/tie-break', { stage: 'plate', team_a_id: String(plateIds[x]), team_b_id: String(plateIds[y]), winner_team_id: String(plateIds[x]) });
    }
  }
  const settled = await get('/results');
  assert.doesNotMatch(settled, /Record the shootout results/);
  assert.match(settled, /Draw the knockouts/);
  // the main table's shootouts are separate from the finals ones
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM tie_breaks WHERE league_id = ? AND stage = 'group'").get(id).n, 0);
  void cupIds;
});

test('drawing the knockouts seeds each group from its own table: 1st v 4th, 2nd v 3rd, then a Grand Final', async () => {
  assert.equal((await post('/generate-finals-knockouts')).status, 302);
  const rrDate = rowsOf('cup', 'rr')[0].date;
  for (const stage of ['cup', 'plate', 'bowl']) {
    const ko = rowsOf(stage, 'ko');
    assert.deepEqual(ko.map((m) => m.bracket_slot), ['semi_1', 'semi_2', 'final']);
    const order = [...new Set(rowsOf(stage, 'rr').flatMap((m) => [m.home_team_id, m.away_team_id]))].sort((x, y) => y - x); // best first in all three groups
    assert.deepEqual([ko[0].home_team_id, ko[0].away_team_id], [order[0], order[3]], `${stage} semi 1: 1st v 4th`);
    assert.deepEqual([ko[1].home_team_id, ko[1].away_team_id], [order[1], order[2]], `${stage} semi 2: 2nd v 3rd`);
    assert.equal((new Date(`${ko[0].date}T12:00:00Z`) - new Date(`${rrDate}T12:00:00Z`)) / 86400000, 7, 'the week after the round robin');
  }
  const rounds = h.db.prepare("SELECT round_number FROM rounds WHERE league_id = ? AND stage != 'group'").all(id).map((r) => r.round_number);
  assert.equal(new Set(rounds).size, rounds.length, 'every finals round has its own number');

  // round-robin scores are locked while the knockouts stand
  const locked = await score(rowsOf('cup', 'rr')[0], 3, 3);
  assert.equal(locked.status, 400);
  assert.match(locked.text, /Reset the knockouts/);
  assert.equal((await post(`/knockout-results/match/${rowsOf('cup', 'rr')[0].id}/clear`)).status, 400);
  const cupPublic = await get('/league/bracket');
  assert.match(cupPublic, /<h3>Knockout<\/h3>/);
  assert.match(cupPublic, /Semi-finals/);
});

test('resetting only the knockouts keeps the round robins and unlocks their scores', async () => {
  assert.match((await post('/finals-knockouts/reset', { confirm_name: 'wrong' })).text, /did not match/);
  assert.equal((await post('/finals-knockouts/reset', { confirm_name: 'Twelve' })).status, 302);
  assert.equal(rowsOf('cup', 'ko').length, 0);
  assert.equal(rowsOf('cup', 'rr').length, 6);
  assert.equal(rowsOf('cup', 'rr').filter((m) => m.status === 'played').length, 6, 'round-robin results kept');
  const m = rowsOf('cup', 'rr')[0];
  assert.equal((await score(m, 1, 1)).status, 302, 'editable again');
  await higherWins(reload(m));
  assert.equal((await post('/generate-finals-knockouts')).status, 302);
  assert.equal(rowsOf('cup', 'ko').length, 3);
});

test('play through the knockouts; the league is complete only when all three finals are played', async () => {
  for (const stage of ['cup', 'plate']) {
    const [s1, s2, f] = rowsOf(stage, 'ko');
    await h.request('POST', `/admin/league/${id}/knockout-results/match/${s1.id}`, { home_score: '2', away_score: '0' });
    await h.request('POST', `/admin/league/${id}/knockout-results/match/${s2.id}`, { home_score: '1', away_score: '0' });
    await h.request('POST', `/admin/league/${id}/knockout-results/match/${f.id}`, { home_score: '1', away_score: '0' });
  }
  assert.notEqual(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'complete');
  const [b1, b2, bf] = rowsOf('bowl', 'ko');
  await h.request('POST', `/admin/league/${id}/knockout-results/match/${b1.id}`, { home_score: '2', away_score: '0' });
  await h.request('POST', `/admin/league/${id}/knockout-results/match/${b2.id}`, { home_score: '1', away_score: '0' });
  assert.notEqual(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'complete');
  await h.request('POST', `/admin/league/${id}/knockout-results/match/${bf.id}`, { home_score: '1', away_score: '0' });
  assert.equal(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'complete');

  // team pages and the log name the new stages
  const team = rowsOf('bowl', 'rr')[0].home_team_id;
  assert.match(await get(`/league/team/${team}`), /Bowl round-robin match/);
  assert.match(await get('/log'), /Bowl round-robin match|Bowl final/);
});

test('resetting everything removes the finals groups, their shootouts and unlocks the format', async () => {
  assert.equal((await post('/knockouts/reset', { confirm_name: 'Twelve' })).status, 302);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).n, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM tie_breaks WHERE league_id = ? AND stage != 'group'").get(id).n, 0);
  assert.equal((await post('/finals-format', { format: 'standard' })).status, 302);
});
