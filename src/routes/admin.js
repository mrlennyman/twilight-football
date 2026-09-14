const express = require('express');
const db = require('../db');
const { checkPassword, requireAdmin } = require('../middleware/auth');
const { computeStandings, groupStageComplete } = require('../lib/standings');
const { generateGroupStageSchedule, generateKnockoutBracket, addDays } = require('../lib/schedule');
const { tryFillFinal } = require('../lib/knockoutResult');
const {
  getAllLeagues,
  getLeague,
  getTeams,
  getPlayers,
  getPitches,
  getRoundsWithMatches,
  getRoundsForWeek,
  getWeekNumbers,
} = require('../lib/queries');

const router = express.Router();

// ---------- Auth ----------

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  if (checkPassword(req.body.password)) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin/login', { error: 'Incorrect password.' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(requireAdmin);

// ---------- Dashboard / league setup ----------

router.get('/', (req, res) => {
  const leagues = getAllLeagues(db);
  res.render('admin/dashboard', { leagues });
});

router.post('/leagues', (req, res) => {
  const { name, season, num_teams, num_pitches, rounds_per_week } = req.body;
  const numTeams = Number(num_teams) || 8;

  const insertLeague = db.prepare(
    `INSERT INTO leagues (name, season, num_teams, num_pitches, rounds_per_week)
     VALUES (?, ?, ?, ?, ?)`
  );
  const info = insertLeague.run(
    name,
    season,
    numTeams,
    Number(num_pitches) || 4,
    Number(rounds_per_week) || 3
  );
  const leagueId = info.lastInsertRowid;

  const insertTeam = db.prepare('INSERT INTO teams (league_id, name) VALUES (?, ?)');
  for (let i = 1; i <= numTeams; i++) {
    insertTeam.run(leagueId, `Team ${i}`);
  }

  res.redirect(`/admin/league/${leagueId}/teams`);
});

// ---------- Teams & rosters ----------

router.get('/league/:id/teams', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const teams = getTeams(db, league.id).map((team) => ({
    ...team,
    players: getPlayers(db, team.id),
  }));

  res.render('admin/teams', { league, teams });
});

router.post('/league/:id/teams/:teamId', (req, res) => {
  db.prepare('UPDATE teams SET name = ?, kit_colour = ? WHERE id = ? AND league_id = ?').run(
    req.body.name,
    req.body.kit_colour || null,
    req.params.teamId,
    req.params.id
  );
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players', (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    db.prepare('INSERT INTO players (team_id, name) VALUES (?, ?)').run(req.params.teamId, name);
  }
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players/:playerId/delete', (req, res) => {
  db.prepare('DELETE FROM players WHERE id = ? AND team_id = ?').run(
    req.params.playerId,
    req.params.teamId
  );
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

// ---------- Schedule generation ----------

router.get('/league/:id/schedule', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const groupRounds = getRoundsWithMatches(db, league.id, 'group');
  const pitches = getPitches(db);

  res.render('admin/schedule', { league, groupRounds, pitches });
});

router.post('/league/:id/schedule/generate', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const { start_date, kickoff_start_time, slot_minutes } = req.body;
  const slotMinutes = Number(slot_minutes) || 45;

  const teams = getTeams(db, league.id);
  const pitches = getPitches(db).slice(0, league.num_pitches);
  const teamIds = teams.map((t) => t.id);
  const pitchIds = pitches.map((p) => p.id);

  const schedule = generateGroupStageSchedule({
    teamIds,
    pitchIds,
    roundsPerWeek: league.rounds_per_week,
    startDate: start_date,
    kickoffStartTime: kickoff_start_time,
    slotMinutes,
  });

  const insertRound = db.prepare(
    `INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time)
     VALUES (?, ?, ?, 'group', ?, ?)`
  );
  const insertMatch = db.prepare(
    `INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id)
     VALUES (?, ?, ?, ?)`
  );

  const persist = db.transaction(() => {
    // Clear any previously generated group-stage schedule (e.g. re-generating).
    db.prepare(
      `DELETE FROM matches WHERE round_id IN (
         SELECT id FROM rounds WHERE league_id = ? AND stage = 'group'
       )`
    ).run(league.id);
    db.prepare("DELETE FROM rounds WHERE league_id = ? AND stage = 'group'").run(league.id);

    for (const round of schedule) {
      const roundInfo = insertRound.run(
        league.id,
        round.roundNumber,
        round.weekNumber,
        round.date,
        round.kickoffTime
      );
      for (const match of round.matches) {
        insertMatch.run(roundInfo.lastInsertRowid, match.pitchId, match.homeTeamId, match.awayTeamId);
      }
    }

    db.prepare(
      `UPDATE leagues SET status = 'in_progress', start_date = ?, kickoff_start_time = ?, slot_minutes = ?
       WHERE id = ?`
    ).run(start_date, kickoff_start_time, slotMinutes, league.id);
  });
  persist();

  res.redirect(`/admin/league/${league.id}/schedule`);
});

// ---------- Results entry ----------

router.get('/league/:id/results', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const weekNumbers = getWeekNumbers(db, league.id);
  const selectedWeek = req.query.week ? Number(req.query.week) : weekNumbers[0];
  const rounds = selectedWeek ? getRoundsForWeek(db, league.id, selectedWeek) : [];
  const standings = computeStandings(db, league.id);
  const stageComplete = groupStageComplete(db, league.id);
  const teams = getTeams(db, league.id);

  const cupRounds = getRoundsWithMatches(db, league.id, 'cup');
  const plateRounds = getRoundsWithMatches(db, league.id, 'plate');

  res.render('admin/results', {
    league,
    weekNumbers,
    selectedWeek,
    rounds,
    standings,
    stageComplete,
    teams,
    cupRounds,
    plateRounds,
  });
});

router.post('/league/:id/results/match/:matchId', (req, res) => {
  const homeScore = Number(req.body.home_score);
  const awayScore = Number(req.body.away_score);
  db.prepare(
    "UPDATE matches SET home_score = ?, away_score = ?, status = 'played' WHERE id = ?"
  ).run(homeScore, awayScore, req.params.matchId);
  res.redirect(req.get('referer') || `/admin/league/${req.params.id}/results`);
});

router.post('/league/:id/tie-break', (req, res) => {
  const { team_a_id, team_b_id, winner_team_id } = req.body;
  db.prepare(
    'INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id) VALUES (?, ?, ?, ?)'
  ).run(req.params.id, team_a_id, team_b_id, winner_team_id);
  res.redirect(`/admin/league/${req.params.id}/results`);
});

// ---------- Knockouts ----------

router.post('/league/:id/generate-knockouts', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  if (!groupStageComplete(db, league.id)) {
    return res.redirect(`/admin/league/${league.id}/results`);
  }

  const standings = computeStandings(db, league.id);
  // Block only if the split point itself (rank 4 vs 5) is an unresolved tie.
  if (standings[3] && standings[4]) {
    const boundaryTied =
      standings[3].points === standings[4].points &&
      standings[3].goalDifference === standings[4].goalDifference &&
      !standings[3].tieResolved;
    if (boundaryTied) {
      return res.redirect(`/admin/league/${league.id}/results`);
    }
  }

  const top4 = standings.slice(0, 4).map((s) => s.teamId);
  const bottom4 = standings.slice(4, 8).map((s) => s.teamId);
  const pitchIds = getPitches(db).map((p) => p.id);

  const lastGroupRound = db
    .prepare("SELECT MAX(round_number) AS n FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id).n;
  const lastGroupWeek = db
    .prepare("SELECT MAX(week_number) AS n FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id).n;
  const knockoutDate = addDays(league.start_date, lastGroupWeek * 7);
  const kickoffTime = league.kickoff_start_time || '17:30';
  const slotMinutes = league.slot_minutes || 45;

  const cup = generateKnockoutBracket({
    rankedTeamIds: top4,
    pitchIds,
    roundNumberStart: lastGroupRound + 1,
    weekNumber: lastGroupWeek + 1,
    stage: 'cup',
    date: knockoutDate,
    kickoffStartTime: kickoffTime,
    slotMinutes,
  });
  const plate = generateKnockoutBracket({
    rankedTeamIds: bottom4,
    pitchIds,
    roundNumberStart: lastGroupRound + 1,
    weekNumber: lastGroupWeek + 1,
    stage: 'plate',
    date: knockoutDate,
    kickoffStartTime: kickoffTime,
    slotMinutes,
  });

  const insertRound = db.prepare(
    `INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertMatch = db.prepare(
    `INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id, bracket_slot)
     VALUES (?, ?, ?, ?, ?)`
  );

  const persist = db.transaction(() => {
    for (const round of [...cup, ...plate]) {
      const roundInfo = insertRound.run(
        league.id,
        round.roundNumber,
        round.weekNumber,
        round.stage,
        round.date,
        round.kickoffTime
      );
      for (const match of round.matches) {
        insertMatch.run(
          roundInfo.lastInsertRowid,
          match.pitchId,
          match.homeTeamId,
          match.awayTeamId,
          match.bracketSlot
        );
      }
    }
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ?").run(league.id);
  });
  persist();

  res.redirect(`/admin/league/${league.id}/results`);
});

router.post('/league/:id/knockout-results/match/:matchId', (req, res) => {
  const homeScore = Number(req.body.home_score);
  const awayScore = Number(req.body.away_score);
  const penaltyWinnerId = req.body.penalty_winner_id || null;

  db.prepare(
    `UPDATE matches SET home_score = ?, away_score = ?, status = 'played', penalty_winner_id = ?
     WHERE id = ?`
  ).run(homeScore, awayScore, penaltyWinnerId, req.params.matchId);

  const match = db.prepare('SELECT r.stage, r.league_id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE m.id = ?').get(req.params.matchId);
  if (match) {
    tryFillFinal(db, match.league_id, match.stage);

    const cupDone = isBracketComplete(match.league_id, 'cup');
    const plateDone = isBracketComplete(match.league_id, 'plate');
    if (cupDone && plateDone) {
      db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(match.league_id);
    }
  }

  res.redirect(`/admin/league/${req.params.id}/results`);
});

function isBracketComplete(leagueId, stage) {
  const counts = db
    .prepare(
      `SELECT SUM(CASE WHEN m.status = 'played' THEN 1 ELSE 0 END) AS played, COUNT(*) AS total
       FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ?`
    )
    .get(leagueId, stage);
  return counts.total > 0 && counts.played === counts.total;
}

// ---------- Print views ----------

router.get('/league/:id/print/week/:n', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const rounds = getRoundsForWeek(db, league.id, Number(req.params.n));
  res.render('admin/print-fixtures', { league, rounds, weekNumber: Number(req.params.n) });
});

router.get('/league/:id/print/standings', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const standings = computeStandings(db, league.id);
  res.render('admin/print-standings', { league, standings });
});

module.exports = router;
