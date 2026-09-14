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
