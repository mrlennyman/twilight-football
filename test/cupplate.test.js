const test = require('node:test');
const assert = require('node:assert/strict');
const { generateCupAndPlate } = require('../src/lib/schedule');
const { startApp } = require('./helpers/harness');

function clashes(rounds) {
  const seen = new Map();
  let clash = 0;
  for (const r of rounds) {
    for (const m of r.matches) {
      const key = `${r.date}|${r.kickoffTime}|${m.pitchId}`;
      if (seen.has(key)) clash++;
      seen.set(key, true);
    }
  }
  return clash;
}

const base = {
  cupTeamIds: [1, 2, 3, 4],
  plateTeamIds: [5, 6, 7, 8],
  roundNumberStart: 15,
  weekNumber: 6,
  date: '2026-11-18',
  kickoffStartTime: '17:00',
  slotMinutes: 15,
};

test('B1: 4 pitches - Cup and Plate run side by side on different pitches, distinct round numbers', () => {
  const rounds = generateCupAndPlate({ ...base, pitchIds: [1, 2, 3, 4] });
  assert.equal(clashes(rounds), 0);
  assert.deepEqual(rounds.map((r) => r.roundNumber), [15, 16, 17, 18]);
  const cupPitches = new Set(rounds.filter((r) => r.stage === 'cup').flatMap((r) => r.matches.map((m) => m.pitchId)));
  const platePitches = new Set(rounds.filter((r) => r.stage === 'plate').flatMap((r) => r.matches.map((m) => m.pitchId)));
  assert.deepEqual([...cupPitches].sort(), [1, 2]);
  assert.deepEqual([...platePitches].sort(), [3, 4]);
  assert.equal(rounds[1].matches[0].pitchId, 1, 'Cup final on pitch 1');
  assert.equal(rounds[3].matches[0].pitchId, 3, 'Plate final on pitch 3');
  assert.equal(rounds[0].kickoffTime, rounds[2].kickoffTime, 'both semi-finals start together');
});

test('B1: 2 pitches - the Plate starts after the Cup final on the same pitches, no clashes', () => {
  const rounds = generateCupAndPlate({ ...base, pitchIds: [1, 2] });
  assert.equal(clashes(rounds), 0);
  assert.deepEqual(rounds.map((r) => r.kickoffTime), ['17:00', '17:15', '17:30', '17:45']);
  assert.deepEqual(rounds.map((r) => r.roundNumber), [15, 16, 17, 18]);
  assert.throws(() => generateCupAndPlate({ ...base, pitchIds: [1] }), /at least 2 pitches/);
});

test('B1: a real league - generated brackets share no (date, time, pitch) with any other match', async () => {
  const h = await startApp();
  try {
    await h.login();
    const id = await h.createScheduledLeague();
    const matches = h.db
      .prepare('SELECT m.id, m.home_team_id AS h, m.away_team_id AS a FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id')
      .all(id);
    for (const m of matches) {
      // the higher team id always wins, so the table is strict (no ties) and fully determined
      const homeWins = m.h > m.a;
      await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, {
        home_score: homeWins ? '3' : '0',
        away_score: homeWins ? '0' : '3',
      });
    }
    const gen = await h.request('POST', `/admin/league/${id}/generate-knockouts`);
    assert.equal(gen.status, 302);

    const rows = h.db
      .prepare('SELECT r.date, r.kickoff_time, m.pitch_id, r.stage FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?')
      .all(id);
    const keys = rows.map((r) => `${r.date}|${r.kickoff_time}|${r.pitch_id}`);
    assert.equal(new Set(keys).size, keys.length, 'no two matches share date + time + pitch');

    const knockout = rows.filter((r) => r.stage !== 'group');
    assert.equal(knockout.length, 6);
    const roundNumbers = h.db.prepare("SELECT round_number FROM rounds WHERE league_id = ? AND stage != 'group'").all(id);
    assert.equal(new Set(roundNumbers.map((r) => r.round_number)).size, 4, 'four distinct knockout round numbers');
    assert.equal(knockout[0].date, '2026-11-18', 'the Wednesday after the last group night');
  } finally {
    await h.close();
  }
});
