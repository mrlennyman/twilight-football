const test = require('node:test');
const assert = require('node:assert/strict');
const {
  doubleRoundRobin,
  generateGroupStageSchedule,
  addDays,
  addMinutes,
} = require('../src/lib/schedule');

test('doubleRoundRobin: 8 teams produces 14 rounds of 4 matches each', () => {
  const teamIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const rounds = doubleRoundRobin(teamIds);
  assert.equal(rounds.length, 14);
  for (const round of rounds) {
    assert.equal(round.length, 4);
  }
});

test('doubleRoundRobin: every team plays every other team exactly twice, home and away once each', () => {
  const teamIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const rounds = doubleRoundRobin(teamIds);
  const pairCounts = new Map();
  for (const round of rounds) {
    for (const [home, away] of round) {
      const key = [home, away].sort((a, b) => a - b).join('-');
      pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    }
  }
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      const key = [teamIds[i], teamIds[j]].sort((a, b) => a - b).join('-');
      assert.equal(pairCounts.get(key), 2, `pair ${key} should meet exactly twice`);
    }
  }
});

test('doubleRoundRobin: no team appears twice within a single round', () => {
  const teamIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const rounds = doubleRoundRobin(teamIds);
  for (const round of rounds) {
    const teamsInRound = round.flat();
    const uniqueTeams = new Set(teamsInRound);
    assert.equal(uniqueTeams.size, teamsInRound.length, 'every team should play at most once per round');
    assert.equal(uniqueTeams.size, teamIds.length, 'every team should play exactly once per round');
  }
});

test('generateGroupStageSchedule: 56 total matches, correct pitch bounds, 5 weeks (last week short)', () => {
  const schedule = generateGroupStageSchedule({
    teamIds: [1, 2, 3, 4, 5, 6, 7, 8],
    pitchIds: [101, 102, 103, 104],
    roundsPerWeek: 3,
    startDate: '2026-11-03',
    kickoffStartTime: '17:30',
    slotMinutes: 45,
  });

  const totalMatches = schedule.reduce((sum, round) => sum + round.matches.length, 0);
  assert.equal(totalMatches, 56);
  assert.equal(schedule.length, 14);

  for (const round of schedule) {
    for (const match of round.matches) {
      assert.ok([101, 102, 103, 104].includes(match.pitchId));
    }
  }

  const weekNumbers = schedule.map((r) => r.weekNumber);
  assert.equal(Math.max(...weekNumbers), 5);
  const week5Rounds = schedule.filter((r) => r.weekNumber === 5);
  assert.equal(week5Rounds.length, 2, 'last week should have the remainder of 2 rounds');
});

test('generateGroupStageSchedule: kickoff times step within a week and dates step by 7 days between weeks', () => {
  const schedule = generateGroupStageSchedule({
    teamIds: [1, 2, 3, 4, 5, 6, 7, 8],
    pitchIds: [101, 102, 103, 104],
    roundsPerWeek: 3,
    startDate: '2026-11-03',
    kickoffStartTime: '17:30',
    slotMinutes: 45,
  });

  const week1 = schedule.filter((r) => r.weekNumber === 1);
  assert.deepEqual(week1.map((r) => r.kickoffTime), ['17:30', '18:15', '19:00']);
  assert.ok(week1.every((r) => r.date === '2026-11-03'));

  const week2 = schedule.filter((r) => r.weekNumber === 2);
  assert.ok(week2.every((r) => r.date === '2026-11-10'));
});

test('addDays and addMinutes handle rollover correctly', () => {
  assert.equal(addDays('2026-11-03', 7), '2026-11-10');
  assert.equal(addDays('2026-11-28', 7), '2026-12-05');
  assert.equal(addMinutes('23:30', 45), '00:15');
  assert.equal(addMinutes('17:30', 90), '19:00');
});

test('B6: pitches are spread fairly - 8 teams, 4 pitches, every team plays every pitch 3 or 4 times', () => {
  const teamIds = [1, 2, 3, 4, 5, 6, 7, 8];
  const pitchIds = [11, 12, 13, 14];
  const schedule = generateGroupStageSchedule({
    teamIds, pitchIds, roundsPerWeek: 3, startDate: '2026-10-14', kickoffStartTime: '17:00', slotMinutes: 15,
  });

  const counts = new Map();
  const fixtures = new Set();
  for (const round of schedule) {
    const teamsThisRound = round.matches.flatMap((m) => [m.homeTeamId, m.awayTeamId]);
    assert.equal(new Set(teamsThisRound).size, 8, 'no team plays twice in a round');
    assert.equal(new Set(round.matches.map((m) => m.pitchId)).size, round.matches.length, 'one match per pitch per round');
    for (const m of round.matches) {
      fixtures.add(`${m.homeTeamId}-${m.awayTeamId}`);
      for (const team of [m.homeTeamId, m.awayTeamId]) {
        counts.set(`${team}:${m.pitchId}`, (counts.get(`${team}:${m.pitchId}`) || 0) + 1);
      }
    }
  }
  assert.equal(fixtures.size, 56, 'every ordered fixture appears exactly once');
  for (const team of teamIds) {
    for (const pitch of pitchIds) {
      const n = counts.get(`${team}:${pitch}`) || 0;
      assert.ok(n === 3 || n === 4, `team ${team} played pitch ${pitch} ${n} times`);
    }
  }
});

test('B6: deterministic (same input, same schedule) and still valid when matches outnumber pitches', () => {
  const input = { teamIds: [1, 2, 3, 4, 5, 6, 7, 8], pitchIds: [1, 2, 3, 4], roundsPerWeek: 3, startDate: '2026-10-14', kickoffStartTime: '17:00', slotMinutes: 15 };
  assert.deepEqual(generateGroupStageSchedule(input), generateGroupStageSchedule(input));
  const few = generateGroupStageSchedule({ ...input, pitchIds: [1, 2] });
  assert.equal(few.reduce((n, r) => n + r.matches.length, 0), 56);
  assert.ok(few.every((r) => r.matches.every((m) => [1, 2].includes(m.pitchId))));
});
