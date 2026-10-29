/**
 * Drawing the round-robin-first finals, shared by the admin routes and the example league:
 *   planFinalsGroups(db, league)    - the three round-robin groups of 4, from the finished group-stage table
 *   planFinalsKnockouts(db, league) - the knockouts, from the three finished mini tables
 *   insertFinalsRounds(db, leagueId, rounds)
 * The plan functions return { error } (a plain-English reason) or { rounds }.
 */
const { computeStandings } = require('./standings');
const { generateFinalsRoundRobins, generateCupPlateBowl, addDays } = require('./schedule');
const { getFinalsGroups, getFinalsState } = require('./finalsGroups');
const { getPitches } = require('./queries');

const pitchIdsFor = (db, league) => getPitches(db).slice(0, league.num_pitches).map((p) => p.id);

function planFinalsGroups(db, league) {
  const standings = computeStandings(db, league.id);
  if (standings.length !== 12) return { error: 'Cup / Plate / Bowl finals need exactly 12 teams in the league (three groups of 4).' };
  const openTies = standings.filter((s) => s.tied && !s.tieResolved);
  if (openTies.length > 0) {
    return {
      error:
        `${openTies.length} teams are still tied on points and goal difference (${openTies.map((t) => t.name).join(', ')}). ` +
        'Record the shootout results on the Results page first, then draw the groups.',
    };
  }
  const pitchIds = pitchIdsFor(db, league);
  if (pitchIds.length < 2) return { error: 'The finals need at least 2 pitches.' };

  const last = db
    .prepare("SELECT MAX(round_number) AS n, MAX(week_number) AS w, MAX(date) AS d FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id);
  return {
    rounds: generateFinalsRoundRobins({
      groups: [0, 4, 8].map((from) => standings.slice(from, from + 4).map((s) => s.teamId)),
      pitchIds,
      roundNumberStart: last.n + 1,
      weekNumber: last.w + 1,
      date: addDays(last.d || league.start_date, 7),
      kickoffStartTime: league.kickoff_start_time || '17:00',
      slotMinutes: league.slot_minutes || 45,
    }),
  };
}

function planFinalsKnockouts(db, league) {
  const groups = getFinalsGroups(db, league.id);
  const state = getFinalsState(db, league.id, groups);
  if (state.openTies) return { error: 'Some teams in the finals groups are still level. Record the shootout results first, then draw the knockouts.' };
  if (!state.roundRobinsComplete) return { error: 'Every round-robin game needs a result first.' };
  const last = db
    .prepare("SELECT MAX(round_number) AS n, MAX(week_number) AS w, MAX(date) AS d FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')")
    .get(league.id);
  return {
    rounds: generateCupPlateBowl({
      groups: groups.map((g) => g.standings.map((s) => s.teamId)),
      pitchIds: pitchIdsFor(db, league),
      roundNumberStart: last.n + 1,
      weekNumber: last.w + 1,
      date: addDays(last.d, 7),
      kickoffStartTime: league.kickoff_start_time || '17:00',
      slotMinutes: league.slot_minutes || 45,
    }),
  };
}

function insertFinalsRounds(db, leagueId, rounds) {
  const insertRound = db.prepare(
    'INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertMatch = db.prepare(
    'INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id, bracket_slot) VALUES (?, ?, ?, ?, ?)'
  );
  db.transaction(() => {
    for (const round of rounds) {
      const info = insertRound.run(leagueId, round.roundNumber, round.weekNumber, round.stage, round.date, round.kickoffTime);
      for (const m of round.matches) insertMatch.run(info.lastInsertRowid, m.pitchId, m.homeTeamId, m.awayTeamId, m.bracketSlot);
    }
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ?").run(leagueId);
  })();
}

module.exports = { planFinalsGroups, planFinalsKnockouts, insertFinalsRounds };
