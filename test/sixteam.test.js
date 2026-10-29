const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCupAndPlate } = require('../src/lib/schedule');
const { bracketSize, slotName, roundName } = require('../src/lib/knockoutResult');
const { startApp } = require('./helpers/harness');

test('bracket sizes: 4 each up to 11 teams, 6 each from 12', () => {
  assert.equal(bracketSize(8), 4);
  assert.equal(bracketSize(10), 4);
  assert.equal(bracketSize(12), 6);
  assert.equal(slotName('qf_1'), 'quarter-final');
  assert.equal(slotName('semi_2'), 'semi-final');
  assert.equal(slotName('final'), 'final');
  assert.equal(roundName('qf_2'), 'Quarter-finals');
  assert.equal(roundName('final'), 'Final');
});

test('a 6-team bracket: 3v6 and 4v5, then 1 and 2 join the semis, then the final', () => {
  const rounds = generateCupAndPlate({
    cupTeamIds: [1, 2, 3, 4, 5, 6],
    plateTeamIds: [7, 8, 9, 10, 11, 12],
    pitchIds: [1, 2, 3, 4, 5, 6],
    roundNumberStart: 19,
    weekNumber: 7,
    date: '2035-12-05',
    kickoffStartTime: '17:30',
    slotMinutes: 35,
  });
  assert.deepEqual(rounds.map((r) => r.roundNumber), [19, 20, 21, 22, 23, 24]);
  assert.deepEqual(rounds.map((r) => r.kickoffTime), ['17:30', '18:05', '18:40', '17:30', '18:05', '18:40'], 'Cup and Plate side by side');
  const cup = rounds.filter((r) => r.stage === 'cup');
  const pair = (m) => [m.homeTeamId, m.awayTeamId];
  assert.deepEqual(cup[0].matches.map(pair), [[3, 6], [4, 5]]);
  assert.deepEqual(cup[0].matches.map((m) => m.bracketSlot), ['qf_1', 'qf_2']);
  assert.deepEqual(cup[1].matches.map(pair), [[1, null], [2, null]]);
  assert.deepEqual(cup[2].matches.map(pair), [[null, null]]);
  const keys = rounds.flatMap((r) => r.matches.map((m) => `${r.kickoffTime}|${m.pitchId}`));
  assert.equal(new Set(keys).size, keys.length, 'no pitch used twice at the same time');
});

let h;
let id;
test.before(async () => {
  h = await startApp();
  await h.login();
  id = await h.createScheduledLeague({ name: 'Twelve', teams: 12, pitches: 6 });
});
test.after(async () => {
  await h.close();
});

const rowsOf = (stage) =>
  h.db
    .prepare(
      `SELECT m.*, r.round_number FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? ORDER BY r.round_number, m.id`
    )
    .all(id, stage);
const ko = (match, form) => h.request('POST', `/admin/league/${id}/knockout-results/match/${match.id}`, form);
const koClear = (match) => h.request('POST', `/admin/league/${id}/knockout-results/match/${match.id}/clear`);
const reload = (match) => h.db.prepare('SELECT * FROM matches WHERE id = ?').get(match.id);
const win = (match, homeWins = true) => ko(reload(match), { home_score: homeWins ? '2' : '0', away_score: homeWins ? '0' : '2' });

test('12 teams: the Cup is places 1-6, the Plate places 7-12, and the gold line sits under 6th', async () => {
  const groupMatches = h.db
    .prepare("SELECT m.id, m.home_team_id AS h, m.away_team_id AS a FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?")
    .all(id);
  for (const m of groupMatches) {
    const homeWins = m.h > m.a; // higher team id always wins, so the table is strict
    await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: homeWins ? '3' : '0', away_score: homeWins ? '0' : '3' });
  }

  const page = (await h.request('GET', `/admin/league/${id}/results`)).text;
  const rows = [...page.matchAll(/<tr class="([^"]*)" data-team-id="\d+">\s*<td>(\d+)<\/td>/g)];
  assert.deepEqual(rows.filter((r) => r[1].includes('split-row')).map((r) => r[2]), ['6']);

  const gen = await h.request('POST', `/admin/league/${id}/generate-knockouts`);
  assert.equal(gen.status, 302);

  const cup = rowsOf('cup');
  const plate = rowsOf('plate');
  assert.equal(cup.length, 5);
  assert.equal(plate.length, 5);
  const teamIds = (rs) => new Set(rs.flatMap((m) => [m.home_team_id, m.away_team_id]).filter(Boolean));
  assert.equal(teamIds(cup).size, 2 + 4, 'quarter-finalists 3-6 plus the two seeds waiting in the semis');
  assert.equal(new Set([...teamIds(cup), ...teamIds(plate)]).size, 12, 'every team is in a bracket');
  assert.deepEqual(cup.map((m) => m.bracket_slot), ['qf_1', 'qf_2', 'semi_1', 'semi_2', 'final']);

  const after = (await h.request('GET', `/admin/league/${id}/results`)).text;
  assert.match(after, /Cup \(top 6\)/);
  assert.match(after, /Plate \(places 7 to 12\)/);
  assert.match(after, /Quarter-finals/);
  const pub = (await h.request('GET', `/league/${id}/bracket`)).text;
  assert.match(pub, /Quarter-finals/);
  assert.match(pub, /Semi-finals/);
});

test('quarter-final winners go into the semis, semi winners into the final, and clears roll back', async () => {
  const [qf1, qf2, semi1, semi2, final] = rowsOf('cup');
  // a semi can't be played before its quarter-final winner is known
  assert.equal((await ko(semi1, { home_score: '1', away_score: '0' })).status, 400);

  await win(qf1); // 3 beat 6 (home)
  await win(qf2, false); // 5 beat 4 (away)
  assert.equal(reload(semi2).away_team_id, qf1.home_team_id, 'winner of 3v6 meets seed 2');
  assert.equal(reload(semi1).away_team_id, qf2.away_team_id, 'winner of 4v5 meets seed 1');
  assert.equal(reload(final).home_team_id, null);

  await win(semi1);
  assert.equal(reload(final).home_team_id, null, 'the final waits for both semis');
  await win(semi2, false);
  assert.equal(reload(final).home_team_id, semi1.home_team_id);
  assert.equal(reload(final).away_team_id, reload(semi2).away_team_id);

  // can't clear or change a match whose next match has been played
  await win(final);
  const blocked = await koClear(semi1);
  assert.equal(blocked.status, 400);
  assert.match(blocked.text, /Clear the final first/);
  await koClear(final);
  const blockedQf = await koClear(qf1);
  assert.match(blockedQf.text, /Clear the semi-final first/);

  // clearing semis then a quarter-final un-sets what it fed
  await koClear(semi2);
  assert.equal(reload(final).home_team_id, null);
  assert.equal(reload(final).away_team_id, null);
  await koClear(semi1);
  await koClear(qf1);
  assert.equal(reload(semi2).away_team_id, null, 'the semi loses its quarter-final winner');
  assert.equal(reload(semi1).away_team_id, qf2.away_team_id, 'the other quarter-final still feeds its semi');
});

test('the team page and the change log name quarter-finals', async () => {
  const [, , , , final] = rowsOf('cup');
  void final;
  const qf = rowsOf('cup')[0];
  const team = qf.home_team_id;
  const page = (await h.request('GET', `/league/${id}/team/${team}`)).text;
  assert.match(page, /Cup quarter-final/);
  const log = (await h.request('GET', `/admin/league/${id}/log`)).text;
  assert.match(log, /Cup quarter-final|Cup semi-final|Cup final/);
});

test('the public standings label the top and bottom halves (12 teams: Top 6 / Bottom 6)', async () => {
  const page = (await h.request('GET', `/league/${id}`)).text;
  assert.match(page, /<tr class="split-label"><td colspan="9">Top 6<\/td><\/tr>/);
  assert.match(page, /<tr class="split-label"><td colspan="9">Bottom 6<\/td><\/tr>/);
  const order = [...page.matchAll(/class="split-label"|data-team-id="\d+"/g)].map((m) => (m[0].startsWith('class') ? 'L' : 't')).join('');
  assert.match(order, /^Lt{6}Lt{6}/, 'a label above rows 1-6 and another above rows 7-12');
});
