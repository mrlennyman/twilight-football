const express = require('express');
const db = require('../db');
const { checkPassword, requireAdmin } = require('../middleware/auth');
const { createLimiter } = require('../middleware/loginLimiter');
const { computeStandings, groupStageComplete } = require('../lib/standings');
const { generateGroupStageSchedule, generateKnockoutBracket, addDays } = require('../lib/schedule');
const { tryFillFinal } = require('../lib/knockoutResult');
const { parseScore, parseLeagueInput, parseScheduleInput } = require('../lib/validate');
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

function fail(res, message, status = 400) {
  return res.status(status).render('admin/error', { message });
}

function pickWeek(queryWeek, weekNumbers) {
  const w = Number.parseInt(queryWeek, 10);
  return weekNumbers.includes(w) ? w : weekNumbers[0];
}

function teamInLeague(teamId, leagueId) {
  return db.prepare('SELECT 1 FROM teams WHERE id = ? AND league_id = ?').get(teamId, leagueId);
}

function getMatchForLeague(matchId, leagueId) {
  return db
    .prepare(
      `SELECT m.*, r.stage, r.week_number
       FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE m.id = ? AND r.league_id = ?`
    )
    .get(matchId, leagueId);
}

function ensurePitches(count) {
  const have = db.prepare('SELECT COUNT(*) AS c FROM pitches').get().c;
  const insert = db.prepare('INSERT INTO pitches (label) VALUES (?)');
  for (let i = have + 1; i <= count; i++) insert.run(`Pitch ${i}`);
}

// ---------- Auth ----------

const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

router.get('/login', (req, res) => {
  res.render('admin/login', { error: null });
});

router.post('/login', (req, res) => {
  const gate = loginLimiter.check(req.ip);
  if (gate.blocked) {
    const mins = Math.ceil(gate.retryAfterSec / 60);
    return res.status(429).render('admin/login', {
      error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
    });
  }

  if (!checkPassword(req.body.password)) {
    loginLimiter.recordFailure(req.ip);
    return res.status(401).render('admin/login', { error: 'Incorrect password.' });
  }

  loginLimiter.reset(req.ip);
  // New session id on login so a pre-login cookie can't be reused.
  req.session.regenerate((err) => {
    if (err) return fail(res, 'Could not start a session. Please try again.', 500);
    req.session.isAdmin = true;
    req.session.save(() => res.redirect('/admin'));
  });
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
  const { errors, value } = parseLeagueInput(req.body);
  if (errors.length) return fail(res, errors.join(' '));

  const create = db.transaction(() => {
    ensurePitches(value.numPitches);
    const info = db
      .prepare(
        `INSERT INTO leagues (name, season, num_teams, num_pitches, rounds_per_week)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(value.name, value.season, value.numTeams, value.numPitches, value.roundsPerWeek);
    const insertTeam = db.prepare('INSERT INTO teams (league_id, name) VALUES (?, ?)');
    for (let i = 1; i <= value.numTeams; i++) {
      insertTeam.run(info.lastInsertRowid, `Team ${i}`);
    }
    return info.lastInsertRowid;
  });

  res.redirect(`/admin/league/${create()}/teams`);
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
  const name = String(req.body.name ?? '').trim();
  const kit = String(req.body.kit_colour ?? '').trim();
  if (!name || name.length > 60) return fail(res, 'Team name is required (max 60 characters).');
  if (kit.length > 30) return fail(res, 'Kit colour is too long (max 30 characters).');

  db.prepare('UPDATE teams SET name = ?, kit_colour = ? WHERE id = ? AND league_id = ?').run(
    name,
    kit || null,
    Number(req.params.teamId),
    Number(req.params.id)
  );
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (name.length > 60) return fail(res, 'Player name is too long (max 60 characters).');
  if (name && teamInLeague(Number(req.params.teamId), Number(req.params.id))) {
    db.prepare('INSERT INTO players (team_id, name) VALUES (?, ?)').run(
      Number(req.params.teamId),
      name
    );
  }
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players/:playerId/delete', (req, res) => {
  if (teamInLeague(Number(req.params.teamId), Number(req.params.id))) {
    db.prepare('DELETE FROM players WHERE id = ? AND team_id = ?').run(
      Number(req.params.playerId),
      Number(req.params.teamId)
    );
  }
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

  const { errors, value } = parseScheduleInput(req.body);
  if (errors.length) return fail(res, errors.join(' '));

  const teams = getTeams(db, league.id);
  const pitches = getPitches(db).slice(0, league.num_pitches);
  if (teams.length < 2 || teams.length % 2 !== 0) {
    return fail(res, 'A schedule needs an even number of teams (at least 2).');
  }
  if (pitches.length === 0) return fail(res, 'No pitches are set up.');

  const schedule = generateGroupStageSchedule({
    teamIds: teams.map((t) => t.id),
    pitchIds: pitches.map((p) => p.id),
    roundsPerWeek: league.rounds_per_week,
    startDate: value.startDate,
    kickoffStartTime: value.kickoffStartTime,
    slotMinutes: value.slotMinutes,
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
    // Clear any previously generated schedule (e.g. re-generating), knockouts included.
    db.prepare(
      `DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE league_id = ?)`
    ).run(league.id);
    db.prepare('DELETE FROM rounds WHERE league_id = ?').run(league.id);
    db.prepare('DELETE FROM tie_breaks WHERE league_id = ?').run(league.id);

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
    ).run(value.startDate, value.kickoffStartTime, value.slotMinutes, league.id);
  });
  persist();

  res.redirect(`/admin/league/${league.id}/schedule`);
});

// ---------- Results entry ----------

router.get('/league/:id/results', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const weekNumbers = getWeekNumbers(db, league.id);
  const selectedWeek = pickWeek(req.query.week, weekNumbers);
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
  const match = getMatchForLeague(Number(req.params.matchId), Number(req.params.id));
  if (!match || match.stage !== 'group') return res.status(404).render('404');

  const homeScore = parseScore(req.body.home_score);
  const awayScore = parseScore(req.body.away_score);
  if (homeScore === null || awayScore === null) {
    return fail(res, 'Scores must be whole numbers between 0 and 99.');
  }

  db.prepare(
    "UPDATE matches SET home_score = ?, away_score = ?, status = 'played' WHERE id = ?"
  ).run(homeScore, awayScore, match.id);
  res.redirect(`/admin/league/${req.params.id}/results?week=${match.week_number}`);
});

router.post('/league/:id/tie-break', (req, res) => {
  const leagueId = Number(req.params.id);
  const a = Number(req.body.team_a_id);
  const b = Number(req.body.team_b_id);
  const winner = Number(req.body.winner_team_id);

  if (!teamInLeague(a, leagueId) || !teamInLeague(b, leagueId) || a === b) {
    return fail(res, 'Pick two different teams from this league.');
  }
  if (winner !== a && winner !== b) {
    return fail(res, 'The shootout winner must be one of the two teams.');
  }

  db.prepare(
    `DELETE FROM tie_breaks WHERE league_id = ?
       AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))`
  ).run(leagueId, a, b, b, a);
  db.prepare(
    'INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id) VALUES (?, ?, ?, ?)'
  ).run(leagueId, a, b, winner);
  res.redirect(`/admin/league/${leagueId}/results`);
});

// ---------- Knockouts ----------

router.post('/league/:id/generate-knockouts', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const alreadyGenerated = db
    .prepare("SELECT COUNT(*) AS c FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate')")
    .get(league.id).c;
  if (alreadyGenerated > 0 || !groupStageComplete(db, league.id)) {
    return res.redirect(`/admin/league/${league.id}/results`);
  }

  const standings = computeStandings(db, league.id);
  if (standings.length !== 8) {
    return fail(res, 'Cup/Plate knockouts currently need exactly 8 teams in the league.');
  }

  // Block only if the split point itself (rank 4 vs 5) is an unresolved tie.
  const boundaryTied =
    standings[3].points === standings[4].points &&
    standings[3].goalDifference === standings[4].goalDifference &&
    !standings[3].tieResolved;
  if (boundaryTied) {
    return res.redirect(`/admin/league/${league.id}/results`);
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
  const kickoffTime = league.kickoff_start_time || '17:00';
  const slotMinutes = league.slot_minutes || 45;

  const bracketConfig = {
    pitchIds,
    roundNumberStart: lastGroupRound + 1,
    weekNumber: lastGroupWeek + 1,
    date: knockoutDate,
    kickoffStartTime: kickoffTime,
    slotMinutes,
  };
  const cup = generateKnockoutBracket({ ...bracketConfig, rankedTeamIds: top4, stage: 'cup' });
  const plate = generateKnockoutBracket({ ...bracketConfig, rankedTeamIds: bottom4, stage: 'plate' });

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
  const leagueId = Number(req.params.id);
  const match = getMatchForLeague(Number(req.params.matchId), leagueId);
  if (!match || match.stage === 'group') return res.status(404).render('404');
  if (!match.home_team_id || !match.away_team_id) {
    return fail(res, 'This match is not set yet - enter the semi-final results first.');
  }

  const homeScore = parseScore(req.body.home_score);
  const awayScore = parseScore(req.body.away_score);
  if (homeScore === null || awayScore === null) {
    return fail(res, 'Scores must be whole numbers between 0 and 99.');
  }

  let penaltyWinnerId = null;
  if (homeScore === awayScore) {
    const picked = Number(req.body.penalty_winner_id);
    if (picked !== match.home_team_id && picked !== match.away_team_id) {
      return fail(res, 'A drawn knockout match needs a shootout winner - pick one and save again.');
    }
    penaltyWinnerId = picked;
  }

  db.prepare(
    `UPDATE matches SET home_score = ?, away_score = ?, status = 'played', penalty_winner_id = ?
     WHERE id = ?`
  ).run(homeScore, awayScore, penaltyWinnerId, match.id);

  tryFillFinal(db, leagueId, match.stage);
  if (isBracketComplete(leagueId, 'cup') && isBracketComplete(leagueId, 'plate')) {
    db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(leagueId);
  }

  res.redirect(`/admin/league/${leagueId}/results`);
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
  const weekNumber = Number.parseInt(req.params.n, 10) || 1;
  const rounds = getRoundsForWeek(db, league.id, weekNumber);
  res.render('admin/print-fixtures', { league, rounds, weekNumber });
});

router.get('/league/:id/print/standings', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const standings = computeStandings(db, league.id);
  res.render('admin/print-standings', { league, standings });
});

module.exports = router;
