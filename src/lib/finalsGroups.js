/**
 * The three finals groups (Cup, Plate, Bowl) when the league plays a round robin first: each group's table, its
 * round-robin rounds and its knockout rounds, for the admin Results page and the public Finals / Standings pages.
 */
const { computeStandings, getOpenTieBlocks, finalsGroupComplete } = require('./standings');
const { getRoundsWithMatches } = require('./queries');
const { stageName } = require('./knockoutResult');

const STAGES = ['cup', 'plate', 'bowl'];
const isRoundRobinRound = (round) => round.matches.length > 0 && round.matches.every((m) => m.bracket_slot === 'rr');

/** One entry per finals stage that has been drawn. Empty before the round robins are drawn. */
function getFinalsGroups(db, leagueId) {
  return STAGES.map((stage, index) => {
    const rounds = getRoundsWithMatches(db, leagueId, stage);
    const rrRounds = rounds
      .filter(isRoundRobinRound)
      .map((round, i) => ({ ...round, label: `Round ${i + 1}` }));
    const koRounds = rounds.filter((round) => !isRoundRobinRound(round));
    return { stage, name: stageName(stage), index, rrRounds, koRounds };
  })
    .filter((group) => group.rrRounds.length > 0 || group.koRounds.length > 0)
    .map((group) => {
      const standings = group.rrRounds.length ? computeStandings(db, leagueId, { stage: group.stage }) : [];
      return {
        ...group,
        standings,
        complete: group.rrRounds.length > 0 && finalsGroupComplete(db, leagueId, group.stage),
        tieBlocks: group.rrRounds.length ? getOpenTieBlocks(db, leagueId, standings, group.stage) : [],
        places: [group.index * 4 + 1, group.index * 4 + 4],
      };
    });
}

/** Where a round-robin-first league has got to. */
function getFinalsState(db, leagueId, groups = getFinalsGroups(db, leagueId)) {
  const drawn = groups.some((g) => g.rrRounds.length > 0);
  const roundRobinsComplete = drawn && groups.length === 3 && groups.every((g) => g.complete);
  const openTies = groups.some((g) => g.tieBlocks.length > 0);
  const knockoutsDrawn = groups.some((g) => g.koRounds.length > 0);
  return { drawn, roundRobinsComplete, openTies, knockoutsDrawn, canDrawKnockouts: roundRobinsComplete && !openTies && !knockoutsDrawn };
}

module.exports = { getFinalsGroups, getFinalsState, isRoundRobinRound };
