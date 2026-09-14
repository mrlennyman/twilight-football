/**
 * Resolves a knockout match's winner (score, or penalty shootout if drawn)
 * and, once both semis in a bracket are played, fills in the final's teams.
 */

function matchWinner(match) {
  if (match.status !== 'played') return null;
  if (match.home_score > match.away_score) return match.home_team_id;
  if (match.away_score > match.home_score) return match.away_team_id;
  return match.penalty_winner_id || null;
}

function tryFillFinal(db, roundLeagueId, stage) {
  const semis = db
    .prepare(
      `SELECT m.* FROM matches m
       JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot IN ('semi_1', 'semi_2')`
    )
    .all(roundLeagueId, stage);

  if (semis.length !== 2) return;
  const winners = semis.map(matchWinner);
  if (winners.some((w) => !w)) return;

  const final = db
    .prepare(
      `SELECT m.* FROM matches m
       JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = 'final'`
    )
    .get(roundLeagueId, stage);

  if (!final || final.home_team_id) return; // already filled

  const semi1 = semis.find((m) => m.bracket_slot === 'semi_1');
  const semi2 = semis.find((m) => m.bracket_slot === 'semi_2');
  const homeTeamId = matchWinner(semi1);
  const awayTeamId = matchWinner(semi2);

  db.prepare('UPDATE matches SET home_team_id = ?, away_team_id = ? WHERE id = ?').run(
    homeTeamId,
    awayTeamId,
    final.id
  );
}

module.exports = { matchWinner, tryFillFinal };
