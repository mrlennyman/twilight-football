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

const SAME_PITCH_BACK_TO_BACK = 1000; // a team on the same pitch in two rounds in a row (almost never allowed)
const SAME_PITCH_SAME_NIGHT = 60; // a team on the same pitch twice in one night (avoided where possible)
const MAX_NIGHT_COMBINATIONS = 60000; // upper limit on perms^rounds searched exhaustively for one night

/**
 * Chooses pitches for every round of one match night together, so that:
 *   1. no team is on the same pitch two rounds running (every team moves at least once, usually twice),
 *   2. teams get as many different pitches as possible within the night,
 *   3. over the whole season every team plays each pitch about equally often.
 * Tries every combination for the night (cheap: 4 pitches x 3 rounds = 13,824) and keeps the lowest cost;
 * the same input always gives the same schedule. `state.counts` carries season totals between nights.
 * Returns one assignment (pitchIds index per match) for each round of the night.
 */
function assignWeekPitches(weekRounds, pitchIds, state) {
  const pitchCount = pitchIds.length;
  const countOf = (team, pitch) => state.counts.get(`${team}:${pitch}`) || 0;
  const tooBig =
    weekRounds.some((pairings) => pairings.length > pitchCount) ||
    pitchCount > MAX_PITCHES_TO_PERMUTE ||
    Math.pow(factorial(pitchCount), weekRounds.length) > MAX_NIGHT_COMBINATIONS;

  if (tooBig) {
    // Fall back: round by round, still avoiding back-to-back repeats where it can.
    const last = new Map();
    return weekRounds.map((pairings) => {
      const assignment = assignRoundGreedy(pairings, pitchIds, state, last);
      pairings.forEach(([home, away], i) => {
        last.set(home, pitchIds[assignment[i]]);
        last.set(away, pitchIds[assignment[i]]);
      });
      return assignment;
    });
  }

  if (!state.perms) state.perms = permutations(pitchIds.map((_, i) => i));
  const perms = state.perms;
  const counts = new Map(state.counts); // working copy for the search
  const key = (team, pitch) => `${team}:${pitch}`;
  const last = new Map(); // team -> pitch it played in the previous round of this night
  const usedTonight = new Map(); // `${team}:${pitch}` -> 1 when already played tonight
  let best = null;
  const chosen = [];

  function search(roundIndex, cost) {
    if (best !== null && cost >= best.cost) return;
    if (roundIndex === weekRounds.length) {
      best = { cost, chosen: chosen.slice() };
      return;
    }
    const pairings = weekRounds[roundIndex];
    for (const perm of perms) {
      let roundCost = 0;
      for (let i = 0; i < pairings.length; i++) {
        const pitch = pitchIds[perm[i]];
        for (const team of pairings[i]) {
          roundCost += 2 * (counts.get(key(team, pitch)) || 0) + 1;
          if (last.get(team) === pitch) roundCost += SAME_PITCH_BACK_TO_BACK;
          else if (usedTonight.has(key(team, pitch))) roundCost += SAME_PITCH_SAME_NIGHT;
        }
      }
      if (best !== null && cost + roundCost >= best.cost) continue;

      // apply, recurse, undo
      const previousLast = [];
      pairings.forEach((pair, i) => {
        const pitch = pitchIds[perm[i]];
        for (const team of pair) {
          previousLast.push([team, last.get(team)]);
          counts.set(key(team, pitch), (counts.get(key(team, pitch)) || 0) + 1);
          last.set(team, pitch);
          usedTonight.set(key(team, pitch), (usedTonight.get(key(team, pitch)) || 0) + 1);
        }
      });
      chosen.push(perm);
      search(roundIndex + 1, cost + roundCost);
      chosen.pop();
      pairings.forEach((pair, i) => {
        const pitch = pitchIds[perm[i]];
        for (const team of pair) {
          counts.set(key(team, pitch), counts.get(key(team, pitch)) - 1);
          const left = usedTonight.get(key(team, pitch)) - 1;
          if (left === 0) usedTonight.delete(key(team, pitch));
          else usedTonight.set(key(team, pitch), left);
        }
      });
      for (let n = previousLast.length - 1; n >= 0; n--) {
        const [team, pitch] = previousLast[n];
        if (pitch === undefined) last.delete(team);
        else last.set(team, pitch);
      }
    }
  }
  search(0, 0);

  // commit the winning night to the season totals
  best.chosen.forEach((perm, r) => {
    weekRounds[r].forEach((pair, i) => {
      for (const team of pair) state.counts.set(key(team, pitchIds[perm[i]]), (state.counts.get(key(team, pitchIds[perm[i]])) || 0) + 1);
    });
  });
  return best.chosen;
}

function factorial(n) {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/** One round, greedy (used only when a night is too big to search whole): balance + avoid repeating the last round's pitch. */
function assignRoundGreedy(pairings, pitchIds, state, last) {
  const pitchCount = pitchIds.length;
  const countOf = (team, pitch) => state.counts.get(`${team}:${pitch}`) || 0;
  let assignment;
  if (pairings.length > pitchCount) {
    assignment = pairings.map((_, i) => i % pitchCount); // more matches than pitches: some must share
  } else if (pitchCount > MAX_PITCHES_TO_PERMUTE) {
    // Many pitches: give each match, in order, the cheapest pitch still free (balance + not the last round's pitch).
    const taken = new Set();
    assignment = pairings.map((pair) => {
      let bestIndex = -1;
      let bestCost = Infinity;
      for (let index = 0; index < pitchCount; index++) {
        if (taken.has(index)) continue;
        let cost = 0;
        for (const team of pair) {
          cost += 2 * countOf(team, pitchIds[index]) + 1;
          if (last.get(team) === pitchIds[index]) cost += SAME_PITCH_BACK_TO_BACK;
        }
        if (cost < bestCost) {
          bestCost = cost;
          bestIndex = index;
        }
      }
      taken.add(bestIndex);
      return bestIndex;
    });
  } else {
    if (!state.perms) state.perms = permutations(pitchIds.map((_, i) => i));
    let best = null;
    for (const perm of state.perms) {
      let cost = 0;
      pairings.forEach((pair, i) => {
        for (const team of pair) {
          cost += 2 * countOf(team, pitchIds[perm[i]]) + 1;
          if (last.get(team) === pitchIds[perm[i]]) cost += SAME_PITCH_BACK_TO_BACK;
        }
      });
      if (best === null || cost < best.cost) best = { cost, perm };
    }
    assignment = best.perm;
  }
  pairings.forEach(([home, away], i) => {
    for (const team of [home, away]) {
      const k = `${team}:${pitchIds[assignment[i]]}`;
      state.counts.set(k, (state.counts.get(k) || 0) + 1);
    }
  });
  return assignment;
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
    const nightPitches = assignWeekPitches(weekRounds, pitchIds, pitchState);
    weekRounds.forEach((pairings, positionInWeek) => {
      roundNumber += 1;
      schedule.push({
        roundNumber,
        weekNumber,
        stage: 'group',
        date,
        kickoffTime: addMinutes(kickoffStartTime, positionInWeek * slotMinutes),
        matches: pairings.map(([homeTeamId, awayTeamId], i) => ({
          homeTeamId,
          awayTeamId,
          pitchId: pitchIds[nightPitches[positionInWeek][i]],
        })),
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
  if (rankedTeamIds.length === 6) {
    return generateSixTeamBracket({ rankedTeamIds, pitchIds, roundNumberStart, weekNumber, stage, date, kickoffStartTime, slotMinutes });
  }
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
 * A 6-team bracket: seeds 1 and 2 wait in the semi-finals while 3v6 and 4v5 play the quarter-finals.
 *   quarter-finals: 3v6 (qf_1), 4v5 (qf_2)    semi-finals: 1 v winner(4v5) (semi_1), 2 v winner(3v6) (semi_2)    final
 * Later rounds' teams are left null until the matches before them are played.
 */
function generateSixTeamBracket({ rankedTeamIds, pitchIds, roundNumberStart, weekNumber, stage, date, kickoffStartTime, slotMinutes }) {
  const [seed1, seed2, seed3, seed4, seed5, seed6] = rankedTeamIds;
  const pitch = (i) => pitchIds[i % pitchIds.length];
  const round = (offset, matches) => ({
    roundNumber: roundNumberStart + offset,
    weekNumber,
    stage,
    date,
    kickoffTime: addMinutes(kickoffStartTime, offset * slotMinutes),
    matches,
  });
  return [
    round(0, [
      { homeTeamId: seed3, awayTeamId: seed6, pitchId: pitch(0), bracketSlot: 'qf_1' },
      { homeTeamId: seed4, awayTeamId: seed5, pitchId: pitch(1), bracketSlot: 'qf_2' },
    ]),
    round(1, [
      { homeTeamId: seed1, awayTeamId: null, pitchId: pitch(0), bracketSlot: 'semi_1' },
      { homeTeamId: seed2, awayTeamId: null, pitchId: pitch(1), bracketSlot: 'semi_2' },
    ]),
    round(2, [{ homeTeamId: null, awayTeamId: null, pitchId: pitch(0), bracketSlot: 'final' }]),
  ];
}

/**
 * Cup (top 4, or top 6) and Plate (the next 4 or 6) brackets that never share a pitch at the same time.
 * 4+ pitches: both brackets run side by side (Cup on pitches 1-2, Plate on 3-4), same kickoff times.
 * 2-3 pitches: Plate starts two slots after the Cup, on the same two pitches.
 * Round numbers are distinct: Cup n, n+1; Plate n+2, n+3 (a 6-team bracket has three rounds: n..n+2, then n+3..n+5).
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
  const bracketRounds = cupTeamIds.length === 6 ? 3 : 2;

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
    roundNumberStart: roundNumberStart + bracketRounds,
    kickoffStartTime: sideBySide ? kickoffStartTime : addMinutes(kickoffStartTime, bracketRounds * slotMinutes),
  });
  return [...cup, ...plate];
}

module.exports = {
  generateCupAndPlate,
  circleMethodRounds,
  doubleRoundRobin,
  assignPitches,
  assignPitchesBalanced,
  assignWeekPitches,
  chunkIntoWeeks,
  addDays,
  addMinutes,
  generateGroupStageSchedule,
  generateKnockoutBracket,
};
