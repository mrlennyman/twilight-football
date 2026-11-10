const test = require('node:test');
const assert = require('node:assert/strict');
const { generatePlacementRound } = require('../src/lib/schedule');
const { placeLabel, finalPlacings, matchLabel, isPlacementFinal } = require('../src/lib/knockoutResult');
const { startApp } = require('./helpers/harness');

test('the final round pairs the table off from the top, one match per pitch', () => {
  const [round] = generatePlacementRound({
    rankedTeamIds: [11, 12, 13, 14, 15, 16, 17, 18],
    pitchIds: [1, 2, 3, 4],
    roundNumber: 15,
    weekNumber: 5,
    date: '2026-11-11',
    kickoffTime: '17:30',
  });
  assert.equal(round.roundNumber, 15);
  assert.equal(round.kickoffTime, '17:30');
  assert.deepEqual(round.matches.map((m) => [m.homeTeamId, m.awayTeamId, m.pitchId, m.bracketSlot]), [
    [11, 12, 1, 'place_1'],
    [13, 14, 2, 'place_2'],
    [15, 16, 3, 'place_3'],
    [17, 18, 4, 'place_4'],
  ]);
  assert.throws(() => generatePlacementRound({ rankedTeamIds: [1, 2, 3], pitchIds: [1, 2], roundNumber: 1, weekNumber: 1, date: 'x', kickoffTime: '17:00' }), /even number/);
  assert.throws(() => generatePlacementRound({ rankedTeamIds: [1, 2, 3, 4, 5, 6], pitchIds: [1, 2], roundNumber: 1, weekNumber: 1, date: 'x', kickoffTime: '17:00' }), /needs 3 pitches/);
});

test('labels and final placings', () => {
  assert.equal(placeLabel('place_1'), 'The final: 1st & 2nd place');
  assert.equal(placeLabel('place_2'), '3rd & 4th place');
  assert.equal(placeLabel('place_3'), '5th & 6th place');
  assert.equal(placeLabel('place_6'), '11th & 12th place');
  assert.equal(placeLabel('semi_1'), '');
  assert.equal(matchLabel('cup', 'place_2'), 'Final round');
  assert.equal(matchLabel('cup', 'semi_1'), 'Cup semi-final');
  assert.equal(isPlacementFinal({ finals_format: 'placement' }), true);

  const m = (slot, h, a, hs, as, status = 'played', pens = null) => ({ bracket_slot: slot, status, home_team_id: h, away_team_id: a, home_team_name: `T${h}`, away_team_name: `T${a}`, home_score: hs, away_score: as, penalty_winner_id: pens });
  assert.equal(finalPlacings([m('place_1', 1, 2, 1, 0), m('place_2', 3, 4, null, null, 'scheduled')]), null, 'not until every match is played');
  const placings = finalPlacings([m('place_2', 3, 4, 0, 2), m('place_1', 1, 2, 2, 2, 'played', 2), m('place_3', 5, 6, 1, 1)]);
  assert.deepEqual(placings.map((p) => [p.place, p.teamId]), [[1, 2], [2, 1], [3, 4], [4, 3], [5, 5], [6, 6]], 'a shootout decides a drawn final; an unexplained draw keeps the higher seed');
});

let h;
let kids; // 8 teams, the league that gets a final round
let twelve;
test.before(async () => {
  h = await startApp();
  await h.login();
  kids = await h.createScheduledLeague({ name: 'Kids', teams: 8, pitches: 4 });
  twelve = await h.createScheduledLeague({ name: 'Twelve', teams: 12, pitches: 6 });
});
test.after(async () => {
  await h.close();
});

const post = (url, form = {}) => h.request('POST', `/admin/league/${kids}${url}`, form);
const get = async (url) => (await h.request('GET', url.startsWith('/league') ? url.replace('/league', `/league/${kids}`) : `/admin/league/${kids}${url}`)).text;
const finalMatches = () =>
  h.db
    .prepare(
      `SELECT m.*, r.round_number, r.date, r.kickoff_time, r.week_number FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = 'cup' ORDER BY m.bracket_slot`
    )
    .all(kids);
const reload = (m) => h.db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
const ko = (m, home, away, extra = {}) => post(`/knockout-results/match/${m.id}`, { home_score: String(home), away_score: String(away), ...extra });

test('the option is on the Finals page, with sensible limits', async () => {
  const page = await get('/finals-format');
  assert.match(page, /value="placement"/);
  assert.match(page, /A final round/);

  // needs an even number of teams and a pitch for every pair
  const odd = await post('/finals-format', { format: 'placement' });
  assert.equal(odd.status, 302, '8 teams on 4 pitches is fine');
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(kids).finals_format, 'placement');
  assert.equal(h.db.prepare('SELECT finals_format FROM leagues WHERE id = ?').get(twelve).finals_format, null);
  h.db.prepare('UPDATE leagues SET num_pitches = 3 WHERE id = ?').run(twelve);
  const tooFew = await h.request('POST', `/admin/league/${twelve}/finals-format`, { format: 'placement' });
  assert.match(tooFew.text, /a pitch for every pair/);
  h.db.prepare('UPDATE leagues SET num_pitches = 6 WHERE id = ?').run(twelve);

  // the menu tab, table bands and public explanation follow the choice
  const pub = await get('/league/bracket');
  assert.match(pub, /The final round/);
  assert.match(pub, /1st v 2nd/);
  assert.match(pub, /will appear here once the last group game has been played/);
  assert.match(await get('/league'), /<span class="app-nav-label">Final round<\/span>/);
  assert.doesNotMatch(await get('/league'), /split-label|split-row/, 'no Top 4 / Bottom 4 bands for a final-round league');
});

test('after the last group game the final round is drawn from the table, on the same night', async () => {
  const groupMatches = h.db
    .prepare('SELECT m.id, m.home_team_id AS h, m.away_team_id AS a FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?')
    .all(kids);
  assert.match(await get('/results'), /Available once every group-stage match has a result/);
  for (const m of groupMatches) {
    const homeWins = m.h > m.a; // the higher team id always wins: a strict table, best team = highest id
    await h.request('POST', `/admin/league/${kids}/results/match/${m.id}`, { home_score: homeWins ? '3' : '0', away_score: homeWins ? '0' : '3' });
  }
  assert.match(await get('/results'), /Draw the final round/);
  assert.doesNotMatch(await get('/results'), /Generate Cup/);

  // the old one-step button does nothing for this format
  await post('/generate-knockouts');
  assert.equal(finalMatches().length, 0);

  assert.equal((await post('/generate-final-round')).status, 302);
  const matches = finalMatches();
  assert.equal(matches.length, 4);
  const best = h.db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id DESC').all(kids).map((t) => t.id);
  assert.deepEqual(matches.map((m) => [m.bracket_slot, m.home_team_id, m.away_team_id]), [
    ['place_1', best[0], best[1]],
    ['place_2', best[2], best[3]],
    ['place_3', best[4], best[5]],
    ['place_4', best[6], best[7]],
  ]);
  const lastGroup = h.db.prepare("SELECT round_number, week_number, date, kickoff_time FROM rounds WHERE league_id = ? AND stage = 'group' ORDER BY round_number DESC LIMIT 1").get(kids);
  assert.equal(matches[0].date, lastGroup.date, 'the same night as the last group round');
  assert.equal(matches[0].week_number, lastGroup.week_number);
  assert.equal(matches[0].round_number, lastGroup.round_number + 1);
  const [hh, mm] = lastGroup.kickoff_time.split(':').map(Number);
  const expected = `${String(Math.floor((hh * 60 + mm + 15) / 60)).padStart(2, '0')}:${String((hh * 60 + mm + 15) % 60).padStart(2, '0')}`;
  assert.equal(matches[0].kickoff_time, expected, 'one slot after the last group round');
  assert.deepEqual([...new Set(matches.map((m) => m.pitch_id))].length, 4, 'a pitch each');

  // group results are locked now, the format is locked, and drawing again does nothing
  const locked = await h.request('POST', `/admin/league/${kids}/results/match/${groupMatches[0].id}`, { home_score: '9', away_score: '9' });
  assert.equal(locked.status, 400);
  assert.match((await post('/finals-format', { format: 'standard' })).text, /locked/);
  await post('/generate-final-round');
  assert.equal(finalMatches().length, 4);
});

test('the final round shows on the Finals page with what each match is for', async () => {
  const pub = await get('/league/bracket');
  assert.match(pub, /The final: 1st &amp; 2nd place/);
  assert.match(pub, /3rd &amp; 4th place/);
  assert.match(pub, /7th &amp; 8th place/);
  assert.doesNotMatch(pub, /Final placings/, 'not until the matches are played');
  const adminPage = await get('/results');
  assert.match(adminPage, /The final round/);
  assert.match(adminPage, /Reset the final round/);
  // the team page names it
  const team = finalMatches()[0].home_team_id;
  assert.match((await h.request('GET', `/league/${kids}/team/${team}`)).text, /Final round/);
});

test('a scorer can enter the final-round scores, a draw is allowed, and the league completes', async () => {
  await h.request('POST', '/admin/scorers', { name: 'Sam', password: 'sideline-1', league_id: String(kids) });
  let cookie = '';
  const scorer = async (method, url, form) => {
    const res = await fetch(h.base + url, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res;
  };
  await scorer('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' });
  const [one, two, three, four] = finalMatches();

  assert.equal((await scorer('POST', `/admin/league/${kids}/knockout-results/match/${one.id}`, { home_score: '2', away_score: '1' })).status, 302);
  assert.equal(reload(one).status, 'played');
  assert.equal((await ko(two, 1, 1)).status, 302, 'a plain draw needs no shootout winner');
  assert.equal(reload(two).penalty_winner_id, null);
  assert.notEqual(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(kids).status, 'complete', 'two matches still to play');
  assert.equal((await ko(three, 0, 0, { penalty_winner_id: String(three.away_team_id) })).status, 302, 'a shootout winner can be recorded');
  assert.equal(reload(three).penalty_winner_id, three.away_team_id);
  assert.equal((await ko(four, 0, 3)).status, 302);
  assert.equal(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(kids).status, 'complete');

  // the final placings
  const pub = await get('/league/bracket');
  assert.match(pub, /Final placings/);
  const order = [...pub.split('Final placings')[1].matchAll(/data-team-id="(\d+)"/g)].map((x) => Number(x[1]));
  assert.deepEqual(order, [one.home_team_id, one.away_team_id, two.home_team_id, two.away_team_id, three.away_team_id, three.home_team_id, four.away_team_id, four.home_team_id], 'winners take the higher place; a drawn match goes to the shootout winner or the higher seed');

  // the change log names the final round
  assert.match(await get('/log'), /Final round/);
});

test('resetting the final round unlocks the group results', async () => {
  assert.equal((await post('/knockouts/reset', { confirm_name: 'Kids' })).status, 302);
  assert.equal(finalMatches().length, 0);
  assert.notEqual(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(kids).status, 'complete');
  const group = h.db.prepare("SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = 'group' LIMIT 1").get(kids);
  assert.equal((await h.request('POST', `/admin/league/${kids}/results/match/${group.id}`, { home_score: '1', away_score: '1' })).status, 302);
});

test('a tied table must be settled before the final round can be drawn', async () => {
  const tie = await h.createScheduledLeague({ name: 'Tied', teams: 4, pitches: 2 });
  await h.request('POST', `/admin/league/${tie}/finals-format`, { format: 'placement' });
  const all = h.db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?').all(tie);
  for (const m of all) await h.request('POST', `/admin/league/${tie}/results/match/${m.id}`, { home_score: '1', away_score: '1' }); // everyone level
  const res = await h.request('POST', `/admin/league/${tie}/generate-final-round`);
  assert.equal(res.status, 400);
  assert.match(res.text, /still tied/);
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM rounds WHERE league_id = ? AND stage = 'cup'").get(tie).n, 0);
});
