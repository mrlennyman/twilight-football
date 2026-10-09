/**
 * The only place that writes or clears a match result, so everything that must happen on every change
 * (time-stamp for "Updated 5:42pm", the change log) happens for group and knockout matches alike.
 * Each function is atomic on its own (a SAVEPOINT), and also safe inside a caller's transaction.
 */

function atomically(db, fn) {
  db.exec('SAVEPOINT result_change');
  try {
    fn();
    db.exec('RELEASE result_change');
  } catch (err) {
    db.exec('ROLLBACK TO result_change');
    db.exec('RELEASE result_change');
    throw err;
  }
}

function logChange(db, matchId, before, after, ip) {
  db.prepare(
    `INSERT INTO result_log (league_id, match_id, old_home, old_away, old_status, new_home, new_away, new_status, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    before.league_id,
    matchId,
    before.home_score,
    before.away_score,
    before.status,
    after.home,
    after.away,
    after.status,
    ip || null
  );
}

function currentRow(db, matchId) {
  return db
    .prepare(
      `SELECT m.home_score, m.away_score, m.status, r.league_id
       FROM matches m JOIN rounds r ON r.id = m.round_id WHERE m.id = ?`
    )
    .get(matchId);
}

function saveScore(db, matchId, homeScore, awayScore, penaltyWinnerId = null, { ip = null } = {}) {
  atomically(db, () => {
    const before = currentRow(db, matchId);
    db.prepare(
      `UPDATE matches SET home_score = ?, away_score = ?, status = 'played', penalty_winner_id = ?,
         updated_at = datetime('now') WHERE id = ?`
    ).run(homeScore, awayScore, penaltyWinnerId, matchId);
    logChange(db, matchId, before, { home: homeScore, away: awayScore, status: 'played' }, ip);
  });
}

/** Back to an unplayed match: no score, no shootout winner. */
function clearScore(db, matchId, { ip = null } = {}) {
  atomically(db, () => {
    const before = currentRow(db, matchId);
    db.prepare(
      `UPDATE matches SET home_score = NULL, away_score = NULL, status = 'scheduled', penalty_winner_id = NULL,
         updated_at = datetime('now') WHERE id = ?`
    ).run(matchId);
    logChange(db, matchId, before, { home: null, away: null, status: 'scheduled' }, ip);
  });
}

module.exports = { saveScore, clearScore };
