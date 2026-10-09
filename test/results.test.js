const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStandings } = require('../src/lib/standings');
const { startApp } = require('./helpers/harness');

let h;
let leagueId;
let otherLeagueId;
test.before(async () => {
  h = await startApp();
  await h.login();
  leagueId = await h.createScheduledLeague({ name: 'Kids' });
  otherLeagueId = await h.createScheduledLeague({ name: 'Adults' });
});
test.after(() => h.close());

const roundMatches = (roundNumber, lid = leagueId) => {
  const round = h.db.prepare("SELECT * FROM rounds WHERE league_id = ? AND stage = 'group' AND round_number = ?").get(lid, roundNumber);
  const matches = h.db.prepare('SELECT * FROM matches WHERE round_id = ? ORDER BY pitch_id, id').all(round.id);
  return { round, matches };
};
const post = (round, form, lid = leagueId) => h.request('POST', `/admin/league/${lid}/results/round/${round.id}`, form);
const played = () => h.db.prepare("SELECT COUNT(*) c FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND m.status = 'played'").get(leagueId).c;

test('A5: one Save scores a whole round and lands back on that round', async () => {
  const { round, matches } = roundMatches(1);
  const form = {};
  matches.forEach((m, i) => { form[`home_${m.id}`] = String(i + 1); form[`away_${m.id}`] = '0'; });
  const res = await post(round, form);
  assert.equal(res.status, 302);
  assert.equal(res.location, `/admin/league/${leagueId}/results?week=${round.week_number}#round-${round.id}`);
  assert.equal(played(), 4);
  const rows = h.db.prepare('SELECT home_score, away_score, status FROM matches WHERE round_id = ? ORDER BY pitch_id, id').all(round.id);
  assert.deepEqual(rows.map((r) => [r.home_score, r.away_score, r.status]), [[1, 0, 'played'], [2, 0, 'played'], [3, 0, 'played'], [4, 0, 'played']]);
});

test('A5: the results page shows the count, tick, big numeric inputs and one Save round button per round', async () => {
  const res = await h.request('GET', `/admin/league/${leagueId}/results?week=1`);
  assert.equal(res.status, 200);
  assert.match(res.text, /4 of 4 scored/);
  assert.match(res.text, /0 of 4 scored/);
  assert.match(res.text, /class="match-card is-played"/);
  assert.match(res.text, /inputmode="numeric" pattern="\[0-9\]\*" min="0" max="99" name="home_/);
  assert.equal((res.text.match(/class="save-round"/g) || []).length, 3, 'one Save round per round of the week');
  assert.match(res.text, /id="round-\d+"/);
});

test('A5: blank pairs are skipped; saved results are not touched by blank boxes in the same form', async () => {
  const { round, matches } = roundMatches(2);
  const form = {};
  matches.forEach((m) => { form[`home_${m.id}`] = ''; form[`away_${m.id}`] = ''; });
  form[`home_${matches[0].id}`] = '5';
  form[`away_${matches[0].id}`] = '5';
  const res = await post(round, form);
  assert.equal(res.status, 302);
  const rows = h.db.prepare("SELECT status FROM matches WHERE round_id = ? ORDER BY pitch_id, id").all(round.id);
  assert.deepEqual(rows.map((r) => r.status), ['played', 'scheduled', 'scheduled', 'scheduled']);
});

test('A5: exactly one blank, or a bad number, rejects the whole round and names the match', async () => {
  const { round, matches } = roundMatches(3);
  const before = played();
  const half = { [`home_${matches[0].id}`]: '2', [`away_${matches[0].id}`]: '1', [`home_${matches[1].id}`]: '3', [`away_${matches[1].id}`]: '' };
  const r1 = await post(round, half);
  assert.equal(r1.status, 400);
  assert.match(r1.text, /enter both scores, or leave both blank/);
  assert.equal(played(), before, 'the valid first match was not saved either');

  for (const bad of ['abc', '-1', '100', '1.5']) {
    const r2 = await post(round, { [`home_${matches[0].id}`]: bad, [`away_${matches[0].id}`]: '1' });
    assert.equal(r2.status, 400, bad);
    assert.match(r2.text, /whole numbers between 0 and 99/);
  }
  assert.equal(played(), before);
});

test('A5: a round from another league or a knockout round is refused', async () => {
  const other = roundMatches(1, otherLeagueId);
  const res = await post(other.round, { [`home_${other.matches[0].id}`]: '1', [`away_${other.matches[0].id}`]: '1' });
  assert.equal(res.status, 404, 'round belongs to the other league');
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM matches WHERE status = 'played' AND round_id = ?").get(other.round.id).c, 0);
  const missing = await h.request('POST', `/admin/league/${leagueId}/results/round/99999`, { clear: '1' });
  assert.equal(missing.status, 404);
});

test('A2: Clear puts one match back to unplayed, drops its points, leaves its neighbours alone', async () => {
  const { round, matches } = roundMatches(1);
  const standingsBefore = computeStandings(h.db, leagueId);
  const target = matches[0]; // 1-0 to the home side
  const winnerBefore = standingsBefore.find((s) => s.teamId === target.home_team_id);
  assert.equal(winnerBefore.points, 3);

  const res = await post(round, { clear: String(target.id) });
  assert.equal(res.status, 302);
  const row = h.db.prepare('SELECT home_score, away_score, status, penalty_winner_id FROM matches WHERE id = ?').get(target.id);
  assert.deepEqual({ ...row }, { home_score: null, away_score: null, status: 'scheduled', penalty_winner_id: null });
  assert.equal(computeStandings(h.db, leagueId).find((s) => s.teamId === target.home_team_id).points, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM matches WHERE round_id = ? AND status = 'played'").get(round.id).c, 3);

  // public pages agree
  const home = await h.request('GET', `/league/${leagueId}`);
  assert.equal(home.status, 200);

  const wrongMatch = roundMatches(5).matches[0];
  assert.equal((await post(round, { clear: String(wrongMatch.id) })).status, 404, 'cannot clear a match from another round');
});

test('A2: a clear button posts to its own tiny form so Enter in a score box can never clear', async () => {
  const res = await h.request('GET', `/admin/league/${leagueId}/results?week=1`);
  const roundForm = res.text.match(/<form method="POST" action="[^"]*results\/round\/\d+" class="round-form"[\s\S]*?<\/form>/)[0];
  assert.ok(!/name="clear"/.test(roundForm), 'no clear input inside the round form');
  assert.match(res.text, /<button type="submit" form="clear-\d+"[^>]*formnovalidate/);
  assert.match(res.text, /<form id="clear-\d+" method="POST"[^>]*>\s*<input type="hidden" name="clear"/);
});

test('A2: knockout Clear - semi un-sets the final; refused while the final is played', async () => {
  // finish the group stage of the first league with a strict table (higher team id wins)
  const all = h.db.prepare("SELECT m.id, m.home_team_id AS hh, m.away_team_id AS aa FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND m.status = 'scheduled'").all(leagueId);
  for (const m of all) {
    await h.request('POST', `/admin/league/${leagueId}/results/match/${m.id}`, { home_score: m.hh > m.aa ? '2' : '0', away_score: m.hh > m.aa ? '0' : '2' });
  }
  // match 1 of round 1 was cleared above and re-played here; every group match is now played
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = 'group' AND m.status = 'scheduled'").get(leagueId).c, 0);
  await h.request('POST', `/admin/league/${leagueId}/generate-knockouts`);

  const slot = (stage, name) => h.db.prepare('SELECT m.* FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = ?').get(leagueId, stage, name);
  const ko = (id, form) => h.request('POST', `/admin/league/${leagueId}/knockout-results/match/${id}`, form);
  const clear = (id) => h.request('POST', `/admin/league/${leagueId}/knockout-results/match/${id}/clear`);

  const semi1 = slot('cup', 'semi_1');
  const semi2 = slot('cup', 'semi_2');
  await ko(semi1.id, { home_score: '2', away_score: '1' });
  await ko(semi2.id, { home_score: '1', away_score: '1', penalty_winner_id: String(semi2.away_team_id) });
  let final = slot('cup', 'final');
  assert.equal(final.home_team_id, semi1.home_team_id);
  assert.equal(final.away_team_id, semi2.away_team_id);

  await ko(final.id, { home_score: '3', away_score: '0' });
  const refused = await clear(semi1.id);
  assert.equal(refused.status, 400);
  assert.match(refused.text, /Clear the final first/);
  assert.equal(slot('cup', 'semi_1').status, 'played');

  assert.equal((await clear(final.id)).status, 302);
  final = slot('cup', 'final');
  assert.equal(final.status, 'scheduled');
  assert.equal(final.home_score, null);
  assert.ok(final.home_team_id && final.away_team_id, 'clearing the final keeps its teams');

  assert.equal((await clear(semi1.id)).status, 302);
  assert.equal(slot('cup', 'semi_1').status, 'scheduled');
  final = slot('cup', 'final');
  assert.equal(final.home_team_id, null);
  assert.equal(final.away_team_id, null);

  // a drawn semi's shootout winner is cleared too
  assert.equal((await clear(semi2.id)).status, 302);
  assert.equal(slot('cup', 'semi_2').penalty_winner_id, null);

  assert.equal((await h.request('POST', `/admin/league/${leagueId}/knockout-results/match/${roundMatches(1).matches[0].id}/clear`)).status, 404, 'a group match is not a knockout match');
});
