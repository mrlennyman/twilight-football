/**
 * Resolves a knockout match's winner (score, or penalty shootout if drawn) and fills the teams of the matches
 * that depend on it.
 *
 * 4-team bracket:  semi_1 (1v4) + semi_2 (2v3)  ->  final
 * 6-team bracket:  qf_1 (3v6) + qf_2 (4v5)  ->  semi_2 (2 v qf_1 winner) + semi_1 (1 v qf_2 winner)  ->  final
 */

function matchWinner(match) {
  if (match.status !== 'played') return null;
  if (match.home_score > match.away_score) return match.home_team_id;
  if (match.away_score > match.home_score) return match.away_team_id;
  return match.penalty_winner_id || null;
}

/** Which later match (and which side of it) a bracket slot feeds. Quarter-finals only exist in 6-team brackets. */
const FEEDS = {
  qf_1: { slot: 'semi_2', side: 'away_team_id' },
  qf_2: { slot: 'semi_1', side: 'away_team_id' },
  semi_1: { slot: 'final', side: 'home_team_id' },
  semi_2: { slot: 'final', side: 'away_team_id' },
};

/** "quarter-final", "semi-final" or "final" for a bracket slot. */
function slotName(slot) {
  if (slot === 'final') return 'final';
  if (slot && slot.startsWith('semi')) return 'semi-final';
  if (slot && slot.startsWith('qf')) return 'quarter-final';
  return 'match';
}

/** The plural heading for a round of a bracket, from the slot of its first match. */
function roundName(slot) {
  const name = slotName(slot);
  return name === 'final' ? 'Final' : name === 'match' ? 'Matches' : `${name.charAt(0).toUpperCase()}${name.slice(1)}s`;
}

/** How many teams go into each of the Cup and the Plate: 6 each from 12 teams up, otherwise 4 each. */
function bracketSize(numTeams) {
  return numTeams >= 12 ? 6 : 4;
}

function bracketMatches(db, leagueId, stage) {
  return db
    .prepare(
      `SELECT m.* FROM matches m
       JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot IS NOT NULL`
    )
    .all(leagueId, stage);
}

/**
 * Fills the matches that depend on earlier results. Re-run after each save so a corrected score flows through.
 * A semi-final waits for its quarter-final winner; the final waits for BOTH semi-final winners. A match that has
 * been played is never rewritten.
 */
function tryFillFinal(db, leagueId, stage) {
  const bySlot = new Map(bracketMatches(db, leagueId, stage).map((m) => [m.bracket_slot, m]));
  const set = (to, fields) => {
    if (!to || to.status === 'played') return;
    for (const [column, value] of Object.entries(fields)) {
      db.prepare(`UPDATE matches SET ${column} = ? WHERE id = ?`).run(value, to.id);
      to[column] = value;
    }
  };

  // Quarter-finals feed the semis (6-team brackets only).
  for (const slot of ['qf_1', 'qf_2']) {
    const from = bySlot.get(slot);
    const winner = from && matchWinner(from);
    if (winner) set(bySlot.get(FEEDS[slot].slot), { [FEEDS[slot].side]: winner });
  }

  // Semi-finals feed the final once both are decided.
  const semi1 = bySlot.get('semi_1');
  const semi2 = bySlot.get('semi_2');
  const w1 = semi1 && matchWinner(semi1);
  const w2 = semi2 && matchWinner(semi2);
  if (w1 && w2) set(bySlot.get('final'), { home_team_id: w1, away_team_id: w2 });
}

/** The match a slot feeds and the field it sets, or null for the final. */
function feedOf(slot) {
  return FEEDS[slot] || null;
}

module.exports = { matchWinner, tryFillFinal, feedOf, slotName, roundName, bracketSize };
