/**
 * Round-robin + knockout schedule generation.
 * Config-driven (team count, pitch count, rounds/week are parameters) so any
 * league, present or future, reuses this unchanged.
 */

function circleMethodRounds(teamIds) {
  const n = teamIds.length;
  if (n < 2 || n % 2 !== 0) {
    throw new Error('circleMethodRounds requires an even number of teams');
  }
  const fixed = teamIds[0];
  let rotating = teamIds.slice(1);
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const arrangement = [fixed, ...rotating];
    const pairings = [];
    for (let i = 0; i < n / 2; i++) {
      pairings.push([arrangement[i], arrangement[n - 1 - i]]);
    }
    rounds.push(pairings);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, rotating.length - 1)];
  }
  return rounds;
}

function doubleRoundRobin(teamIds) {
  const leg1 = circleMethodRounds(teamIds);
  const leg2 = leg1.map((pairings) => pairings.map(([a, b]) => [b, a]));
  return [...leg1, ...leg2];
}

function assignPitches(pairings, pitchIds) {
  return pairings.map(([homeTeamId, awayTeamId], i) => ({
    homeTeamId,
    awayTeamId,
    pitchId: pitchIds[i % pitchIds.length],
  }));
}

function chunkIntoWeeks(rounds, roundsPerWeek) {
  const weeks = [];
  for (let i = 0; i < rounds.length; i += roundsPerWeek) {
    weeks.push(rounds.slice(i, i + roundsPerWeek));
  }
  return weeks;
}

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function addMinutes(timeStr, minutes) {
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + minutes;
  const hh = Math.floor(((total % 1440) + 1440) % 1440 / 60);
  const mm = ((total % 60) + 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Generates the full group-stage schedule for a league.
 * @returns {Array<{roundNumber, weekNumber, stage, date, kickoffTime, matches}>}
 */
function generateGroupStageSchedule({
  teamIds,
  pitchIds,
  roundsPerWeek,
  startDate,
  kickoffStartTime,
  slotMinutes,
}) {
  const rounds = doubleRoundRobin(teamIds);
  const weeks = chunkIntoWeeks(rounds, roundsPerWeek);

  const schedule = [];
  let roundNumber = 0;
  weeks.forEach((weekRounds, weekIndex) => {
    const weekNumber = weekIndex + 1;
    const date = addDays(startDate, weekIndex * 7);
    weekRounds.forEach((pairings, positionInWeek) => {
      roundNumber += 1;
      schedule.push({
        roundNumber,
        weekNumber,
        stage: 'group',
        date,
        kickoffTime: addMinutes(kickoffStartTime, positionInWeek * slotMinutes),
        matches: assignPitches(pairings, pitchIds),
      });
    });
  });
  return schedule;
}

/**
 * Generates a 4-team knockout bracket (2 semis + 1 final).
 * rankedTeamIds must be ordered 1st..4th (by standings) within this bracket.
 * The final's teams are left null until both semis are resolved.
 */
function generateKnockoutBracket({
  rankedTeamIds,
  pitchIds,
  roundNumberStart,
  weekNumber,
  stage,
  date,
  kickoffStartTime,
  slotMinutes,
}) {
  const [seed1, seed2, seed3, seed4] = rankedTeamIds;

  const semis = {
    roundNumber: roundNumberStart,
    weekNumber,
    stage,
    date,
    kickoffTime: kickoffStartTime,
    matches: [
      { homeTeamId: seed1, awayTeamId: seed4, pitchId: pitchIds[0], bracketSlot: 'semi_1' },
      { homeTeamId: seed2, awayTeamId: seed3, pitchId: pitchIds[1 % pitchIds.length], bracketSlot: 'semi_2' },
    ],
  };

  const final = {
    roundNumber: roundNumberStart + 1,
    weekNumber,
    stage,
    date,
    kickoffTime: addMinutes(kickoffStartTime, slotMinutes),
    matches: [
      { homeTeamId: null, awayTeamId: null, pitchId: pitchIds[0], bracketSlot: 'final' },
    ],
  };

  return [semis, final];
}

module.exports = {
  circleMethodRounds,
  doubleRoundRobin,
  assignPitches,
  chunkIntoWeeks,
  addDays,
  addMinutes,
  generateGroupStageSchedule,
  generateKnockoutBracket,
};
