/**
 * The only place that writes or clears a match result, so anything that must happen on every change
 * (here: nothing extra yet) happens for group and knockout matches alike. Callers own the transaction.
 */

function saveScore(db, matchId, homeScore, awayScore, penaltyWinnerId = null) {
  db.prepare(
    `UPDATE matches SET home_score = ?, away_score = ?, status = 'played', penalty_winner_id = ?
     WHERE id = ?`
  ).run(homeScore, awayScore, penaltyWinnerId, matchId);
}

/** Back to an unplayed match: no score, no shootout winner. */
function clearScore(db, matchId) {
  db.prepare(
    `UPDATE matches SET home_score = NULL, away_score = NULL, status = 'scheduled', penalty_winner_id = NULL
     WHERE id = ?`
  ).run(matchId);
}

module.exports = { saveScore, clearScore };
