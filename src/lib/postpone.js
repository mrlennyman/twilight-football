/**
 * A rained-off (postponed) match night: squeeze its unplayed group rounds into the remaining nights by playing
 * more rounds per night. Rounds that still don't fit are cancelled (every team plays one game fewer).
 *
 * Nothing is lost for good: before changing anything, applyPostpone() saves every group round's date, kickoff and
 * week, plus every cancelled round with its matches, in app_meta. undoPostpone() puts all of that back.
 * Played results are never touched - a night with any result can't be postponed.
 */
const { addMinutes } = require('./schedule');

const undoKey = (leagueId) => `postpone_undo_${leagueId}`;

function groupRounds(db, leagueId) {
  return db
    .prepare(
      `SELECT r.*, COUNT(m.id) AS matches, SUM(CASE WHEN m.status = 'played' THEN 1 ELSE 0 END) AS played
       FROM rounds r LEFT JOIN matches m ON m.round_id = r.id
       WHERE r.league_id = ? AND r.stage = 'group'
       GROUP BY r.id ORDER BY r.round_number`
    )
    .all(leagueId)
    .map((r) => ({ ...r, played: r.played || 0 }));
}

function finalsDrawn(db, leagueId) {
  return db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE league_id = ? AND stage != 'group'").get(leagueId).c > 0;
}

/** Group nights that could be postponed: no result entered on that night or any later one. */
function postponableNights(db, leagueId) {
  const rounds = groupRounds(db, leagueId);
  const nights = [...new Set(rounds.map((r) => r.date).filter(Boolean))].sort();
  return nights.filter((night) => rounds.filter((r) => r.date >= night).every((r) => r.played === 0));
}

/**
 * Works out the new layout without changing anything.
 * Returns { error } or { night, perNight, nights: [{ date, rounds: [{ id, round_number, kickoff }] }], cancelled: [round] }.
 */
function planPostpone(db, league, night, perNight) {
  if (finalsDrawn(db, league.id)) return { error: 'The finals have already been drawn, so the group nights can no longer be moved.' };
  if (!postponableNights(db, league.id).includes(night)) {
    return { error: 'Pick a match night that has no results entered on it or on any later night.' };
  }
  if (!Number.isInteger(perNight) || perNight < 1 || perNight > 8) return { error: 'Rounds per night must be between 1 and 8.' };

  const rounds = groupRounds(db, league.id);
  const toPlace = rounds.filter((r) => r.date >= night); // the postponed night and every later one, in round order
  const laterNights = [...new Set(toPlace.map((r) => r.date).filter((d) => d > night))].sort();
  if (laterNights.length === 0) return { error: 'There are no later match nights to move these rounds to.' };

  const slot = league.slot_minutes || 35;
  const nights = laterNights.map((date) => {
    const first = rounds.filter((r) => r.date === date).map((r) => r.kickoff_time).filter(Boolean).sort()[0] || league.kickoff_start_time || '17:30';
    return { date, first, rounds: [] };
  });
  const cancelled = [];
  toPlace.forEach((round, i) => {
    const n = nights[Math.floor(i / perNight)];
    if (!n) return cancelled.push(round);
    n.rounds.push({ id: round.id, round_number: round.round_number, kickoff: addMinutes(n.first, slot * n.rounds.length), from: round.date });
  });
  return { night, perNight, nights, cancelled };
}

function applyPostpone(db, league, plan) {
  const before = groupRounds(db, league.id);
  const removed = plan.cancelled.map((r) => ({
    round: db.prepare('SELECT * FROM rounds WHERE id = ?').get(r.id),
    matches: db.prepare('SELECT * FROM matches WHERE round_id = ? ORDER BY id').all(r.id),
  }));
  const undo = {
    at: new Date().toISOString(),
    night: plan.night,
    rounds: before.map((r) => ({ id: r.id, date: r.date, kickoff_time: r.kickoff_time, week_number: r.week_number })),
    removed,
  };

  db.transaction(() => {
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      undoKey(league.id),
      JSON.stringify(undo)
    );
    const move = db.prepare('UPDATE rounds SET date = ?, kickoff_time = ? WHERE id = ?');
    for (const n of plan.nights) for (const r of n.rounds) move.run(n.date, r.kickoff, r.id);
    const del = db.prepare('DELETE FROM rounds WHERE id = ?'); // its (unplayed) matches go with it
    for (const r of plan.cancelled) del.run(r.id);
    renumberWeeks(db, league.id);
  })();
}

/** Week numbers follow the match nights in date order (1, 2, 3 ...), so a removed night leaves no gap. */
function renumberWeeks(db, leagueId) {
  const dates = db
    .prepare("SELECT DISTINCT date FROM rounds WHERE league_id = ? AND stage = 'group' ORDER BY date")
    .all(leagueId)
    .map((r) => r.date);
  const set = db.prepare("UPDATE rounds SET week_number = ? WHERE league_id = ? AND stage = 'group' AND date = ?");
  dates.forEach((d, i) => set.run(i + 1, leagueId, d));
}

function getUndo(db, leagueId) {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(undoKey(leagueId));
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch (err) {
    return null;
  }
}

/** Puts every date, kickoff and week back and re-creates the cancelled rounds (same ids). Results stay as they are. */
function undoPostpone(db, league) {
  const undo = getUndo(db, league.id);
  if (!undo) return { error: 'There is nothing to undo.' };
  if (finalsDrawn(db, league.id)) return { error: 'The finals have been drawn since, so this can no longer be undone. Reset the brackets on the Results page first.' };

  db.transaction(() => {
    for (const { round, matches } of undo.removed) {
      if (db.prepare('SELECT 1 FROM rounds WHERE id = ?').get(round.id)) continue; // already back
      const cols = Object.keys(round);
      db.prepare(`INSERT INTO rounds (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => round[c]));
      for (const m of matches) {
        const mc = Object.keys(m);
        db.prepare(`INSERT INTO matches (${mc.join(', ')}) VALUES (${mc.map(() => '?').join(', ')})`).run(...mc.map((c) => m[c]));
      }
    }
    const put = db.prepare('UPDATE rounds SET date = ?, kickoff_time = ?, week_number = ? WHERE id = ? AND league_id = ?');
    for (const r of undo.rounds) put.run(r.date, r.kickoff_time, r.week_number, r.id, league.id);
    db.prepare('DELETE FROM app_meta WHERE key = ?').run(undoKey(league.id));
  })();
  return { ok: true };
}

module.exports = { postponableNights, planPostpone, applyPostpone, undoPostpone, getUndo };
