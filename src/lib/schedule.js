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

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  items.forEach((item, i) => {
    for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) out.push([item, ...rest]);
  });
  return out;
}

const MAX_PITCHES_TO_PERMUTE = 6; // 6! = 720 options per round - instant; beyond that use the simple rotation

/**
 * Spreads pitches fairly: for each round, tries every way of putting that round's matches on distinct
 * pitches and keeps the one that adds the least "pitch repetition" for the teams involved (cost of a
 * team playing a pitch it has already played n times is 2n+1). Deterministic: same input, same schedule.
 * `state` carries the per-team pitch counts across rounds; `perms` is the cached permutation list.
 */
function assignPitchesBalanced(pairings, pitchIds, state) {
  const pitchCount = pitchIds.length;
  const countOf = (team, pitch) => state.counts.get(`${team}:${pitch}`) || 0;
  const bump = (team, pitch) => state.counts.set(`${team}:${pitch}`, countOf(team, pitch) + 1);

  let assignment; // pitchIds index per match
  if (pairings.length > pitchCount || pitchCount > MAX_PITCHES_TO_PERMUTE) {
    assignment = pairings.map((_, i) => i % pitchCount);
  } else {
    if (!state.perms) state.perms = permutations(pitchIds.map((_, i) => i));
    let best = null;
    for (const perm of state.perms) {
      let cost = 0;
      pairings.forEach(([home, away], i) => {
        cost += 2 * countOf(home, pitchIds[perm[i]]) + 1 + 2 * countOf(away, pitchIds[perm[i]]) + 1;
      });
      if (best === null || cost < best.cost) best = { cost, perm };
    }
    assignment = best.perm;
  }

  return pairings.map(([homeTeamId, awayTeamId], i) => {
    const pitchId = pitchIds[assignment[i]];
    bump(homeTeamId, pitchId);
    bump(awayTeamId, pitchId);
    return { homeTeamId, awayTeamId, pitchId };
  });
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
  const pitchState = { counts: new Map(), perms: null };
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
        matches: assignPitchesBalanced(pairings, pitchIds, pitchState),
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

/**
 * Cup (top 4) and Plate (bottom 4) brackets that never share a pitch at the same time.
 * 4+ pitches: both brackets run side by side (Cup on pitches 1-2, Plate on 3-4), same kickoff times.
 * 2-3 pitches: Plate starts two slots after the Cup, on the same two pitches.
 * Round numbers are distinct: Cup n, n+1; Plate n+2, n+3.
 */
function generateCupAndPlate({
  cupTeamIds,
  plateTeamIds,
  pitchIds,
  roundNumberStart,
  weekNumber,
  date,
  kickoffStartTime,
  slotMinutes,
}) {
  if (pitchIds.length < 2) throw new Error('Cup/Plate needs at least 2 pitches');
  const sideBySide = pitchIds.length >= 4;
  const common = { weekNumber, date, slotMinutes };

  const cup = generateKnockoutBracket({
    ...common,
    rankedTeamIds: cupTeamIds,
    stage: 'cup',
    pitchIds: pitchIds.slice(0, 2),
    roundNumberStart,
    kickoffStartTime,
  });
  const plate = generateKnockoutBracket({
    ...common,
    rankedTeamIds: plateTeamIds,
    stage: 'plate',
    pitchIds: sideBySide ? pitchIds.slice(2, 4) : pitchIds.slice(0, 2),
    roundNumberStart: roundNumberStart + 2,
    kickoffStartTime: sideBySide ? kickoffStartTime : addMinutes(kickoffStartTime, 2 * slotMinutes),
  });
  return [...cup, ...plate];
}

module.exports = {
  generateCupAndPlate,
  circleMethodRounds,
  doubleRoundRobin,
  assignPitches,
  assignPitchesBalanced,
  chunkIntoWeeks,
  addDays,
  addMinutes,
  generateGroupStageSchedule,
  generateKnockoutBracket,
};
