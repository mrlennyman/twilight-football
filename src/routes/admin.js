const express = require('express');
const db = require('../db');
const { checkPassword, requireAdmin, safeReturnTo } = require('../middleware/auth');
const { createLimiter } = require('../middleware/loginLimiter');
const { computeStandings, groupStageComplete } = require('../lib/standings');
const { generateGroupStageSchedule, generateCupAndPlate, addDays } = require('../lib/schedule');
const { tryFillFinal } = require('../lib/knockoutResult');
const {
  parseScore,
  parseLeagueInput,
  parseScheduleInput,
  pitchShortfallMessage,
  parsePageInput,
} = require('../lib/validate');
const { createPage, seedStarterPages } = require('../lib/pages');
const { renderMarkup } = require('../lib/markup');
const fs = require('fs');
const { snapshot, newestBackup, defaultBackupDir } = require('../lib/backup');
const { resolveDbPath } = require('../lib/paths');
const { saveScore, clearScore } = require('../lib/results');
const {
  getPages,
  getPageById,
  getAllLeagues,
  getLeague,
  getTeams,
  getPlayers,
  getPitches,
  getRoundsWithMatches,
  getRoundsForWeek,
  getWeekNumbers,
  getNavCounts,
  getDefaultWeek,
} = require('../lib/queries');
const { getNavSettings, parseNavInput } = require('../lib/navTabs');
const { parseRosterCsv, createLeagueFromRoster, SAMPLE_CSV } = require('../lib/rosterImport');

const router = express.Router();

function fail(res, message, status = 400) {
  return res.status(status).render('admin/error', { message });
}

function pickWeek(queryWeek, weekNumbers, defaultWeek) {
  const w = Number.parseInt(queryWeek, 10);
  if (weekNumbers.includes(w)) return w;
  return weekNumbers.includes(defaultWeek) ? defaultWeek : weekNumbers[0];
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

/** What a (re)generate would destroy: played group/knockout results and Cup/Plate brackets. */
function scheduleStats(leagueId) {
  const row = db
    .prepare(
      `SELECT
         COUNT(DISTINCT r.id) AS rounds,
         COUNT(CASE WHEN m.status = 'played' THEN 1 END) AS played,
         COUNT(DISTINCT CASE WHEN r.stage IN ('cup', 'plate') THEN r.id END) AS knockout_rounds
       FROM rounds r LEFT JOIN matches m ON m.round_id = r.id
       WHERE r.league_id = ?`
    )
    .get(leagueId);
  return { rounds: row.rounds, played: row.played, knockoutRounds: row.knockout_rounds };
}

/** Takes an automatic safety copy of the database; on failure tells the admin and returns false. */
function safetyBackup(res, label) {
  try {
    snapshot(db, label);
    return true;
  } catch (err) {
    console.error('Safety backup failed:', err);
    fail(res, 'Could not save a safety backup first, so nothing was changed. Please try again.', 500);
    return false;
  }
}

function ensurePitches(count) {
  const have = db.prepare('SELECT COUNT(*) AS c FROM pitches').get().c;
  const insert = db.prepare('INSERT INTO pitches (label) VALUES (?)');
  for (let i = have + 1; i <= count; i++) insert.run(`Pitch ${i}`);
}

// ---------- Auth ----------

const loginLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

router.get('/login', (req, res) => {
  res.render('admin/login', {
    error: null,
    notice: req.query.expired
      ? 'You were logged out, so your last change was not saved. Log in and enter it again.'
      : null,
  });
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
  const returnTo = safeReturnTo(req.session && req.session.returnTo); // read before the session is replaced
  // New session id on login so a pre-login cookie can't be reused.
  req.session.regenerate((err) => {
    if (err) return fail(res, 'Could not start a session. Please try again.', 500);
    req.session.isAdmin = true;
    req.session.save(() => res.redirect(returnTo));
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

// What the server sees about this request and its own housekeeping (for checking the proxy set-up).
router.get('/diagnostics', (req, res) => {
  let dbBytes = null;
  try {
    dbBytes = fs.statSync(resolveDbPath(process.env.DATABASE_PATH)).size;
  } catch (err) {
    /* shown as unknown */
  }
  const newest = newestBackup(defaultBackupDir());
  const backupAgeHours = newest ? (Date.now() - newest.mtimeMs) / 3600000 : null;
  res.render('admin/diagnostics', {
    info: {
      ip: req.ip,
      ips: req.ips,
      forwardedFor: req.get('x-forwarded-for') || '',
      cfConnectingIp: req.get('cf-connecting-ip') || '',
      protocol: req.protocol,
      trustProxy: req.app.get('trust proxy'),
      nodeVersion: process.version,
      dbBytes,
      newestBackup: newest ? newest.name : null,
      backupAgeHours,
      backupStale: backupAgeHours === null || backupAgeHours > 36,
    },
  });
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
    seedStarterPages(db, Number(info.lastInsertRowid));
    return info.lastInsertRowid;
  });

  res.redirect(`/admin/league/${create()}/teams`);
});

// ---------- Import a league from a CSV ----------

router.get('/import', (req, res) => {
  res.render('admin/import');
});

router.get('/import/sample.csv', (req, res) => {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="league-teams-sample.csv"');
  res.send(SAMPLE_CSV);
});

router.post('/import', (req, res) => {
  const csv = parseRosterCsv(req.body.csv);
  const { errors: leagueErrors, value } = parseLeagueInput({ ...req.body, num_teams: String(csv.teams.length) });
  // The team-count message is already covered by the CSV check, so don't show it twice.
  const errors = [...csv.errors, ...leagueErrors.filter((e) => !/number of teams/i.test(e))];
  if (errors.length) return fail(res, errors.join(' '));
  res.redirect(`/admin/league/${createLeagueFromRoster(db, value, csv.teams)}/teams`);
});

// ---------- Delete a league ----------

router.get('/league/:id/delete', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  res.render('admin/delete-league', { league });
});

router.post('/league/:id/delete', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  if (String(req.body.confirm_name ?? '').trim() !== league.name) {
    return fail(res, 'The name you typed did not match, so nothing was deleted.');
  }
  if (!safetyBackup(res, 'delete')) return;
  db.prepare('DELETE FROM leagues WHERE id = ?').run(league.id); // teams, players, matches, pages cascade
  res.redirect('/admin');
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

  res.render('admin/schedule', { league, groupRounds, pitches, stats: scheduleStats(league.id) });
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
  const shortfall = pitchShortfallMessage(teams.length, pitches.length);
  if (shortfall) return fail(res, shortfall);

  // Regenerating wipes every match, result and bracket: needs the league name typed as confirmation.
  const existing = scheduleStats(league.id);
  if (existing.played > 0 || existing.knockoutRounds > 0) {
    if (String(req.body.confirm_name ?? '').trim() !== league.name) {
      return fail(
        res,
        `Regenerating would delete ${existing.played} result${existing.played === 1 ? '' : 's'}` +
          `${existing.knockoutRounds ? ' and the Cup/Plate brackets' : ''}. ` +
          'Nothing was changed. To go ahead, type the league name exactly in the confirmation box.'
      );
    }
  }
  if (existing.rounds > 0 && !safetyBackup(res, 'regenerate')) return;

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
  const selectedWeek = pickWeek(req.query.week, weekNumbers, getDefaultWeek(db, league.id));
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

  saveScore(db, match.id, homeScore, awayScore);
  res.redirect(`/admin/league/${req.params.id}/results?week=${match.week_number}#round-${match.round_id}`);
});

// One form per round: all of a round's scores in a single Save (and a per-match Clear).
router.post('/league/:id/results/round/:roundId', (req, res) => {
  const leagueId = Number(req.params.id);
  const round = db
    .prepare('SELECT * FROM rounds WHERE id = ? AND league_id = ?')
    .get(Number(req.params.roundId), leagueId);
  if (!round || round.stage !== 'group') return res.status(404).render('404');

  const matches = db
    .prepare(
      `SELECT m.*, ht.name AS home_name, at.name AS away_name
       FROM matches m
       LEFT JOIN teams ht ON ht.id = m.home_team_id
       LEFT JOIN teams at ON at.id = m.away_team_id
       WHERE m.round_id = ? ORDER BY m.pitch_id, m.id`
    )
    .all(round.id);
  const back = `/admin/league/${leagueId}/results?week=${round.week_number}#round-${round.id}`;

  // "Clear" on one match
  if (req.body.clear !== undefined && req.body.clear !== '') {
    const target = matches.find((m) => String(m.id) === String(req.body.clear));
    if (!target) return res.status(404).render('404');
    clearScore(db, target.id);
    return res.redirect(back);
  }

  // Validate the whole round before writing anything: both scores or neither, for every match.
  const toSave = [];
  const problems = [];
  for (const m of matches) {
    const rawHome = String(req.body[`home_${m.id}`] ?? '').trim();
    const rawAway = String(req.body[`away_${m.id}`] ?? '').trim();
    const label = `${m.home_name} v ${m.away_name}`;
    if (rawHome === '' && rawAway === '') continue; // nothing entered for this match
    if (rawHome === '' || rawAway === '') {
      problems.push(`${label}: enter both scores, or leave both blank.`);
      continue;
    }
    const homeScore = parseScore(rawHome);
    const awayScore = parseScore(rawAway);
    if (homeScore === null || awayScore === null) {
      problems.push(`${label}: scores must be whole numbers between 0 and 99.`);
      continue;
    }
    toSave.push({ id: m.id, homeScore, awayScore });
  }
  if (problems.length) return fail(res, `${problems.join(' ')} Nothing in this round was saved.`);

  db.transaction(() => {
    for (const s of toSave) saveScore(db, s.id, s.homeScore, s.awayScore);
  })();
  res.redirect(back);
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
  const pitchIds = getPitches(db)
    .slice(0, league.num_pitches)
    .map((p) => p.id);
  if (pitchIds.length < 2) return fail(res, 'Cup/Plate knockouts need at least 2 pitches.');

  const lastGroupRound = db
    .prepare("SELECT MAX(round_number) AS n FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id).n;
  const lastGroupWeek = db
    .prepare("SELECT MAX(week_number) AS n FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id).n;
  // The night after the last group night (follows the real round dates, not just start_date + weeks).
  const lastGroupDate = db
    .prepare("SELECT MAX(date) AS d FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id).d;
  const knockoutDate = addDays(lastGroupDate || league.start_date, 7);
  const kickoffTime = league.kickoff_start_time || '17:00';
  const slotMinutes = league.slot_minutes || 45;

  const knockoutRounds = generateCupAndPlate({
    cupTeamIds: top4,
    plateTeamIds: bottom4,
    pitchIds,
    roundNumberStart: lastGroupRound + 1,
    weekNumber: lastGroupWeek + 1,
    date: knockoutDate,
    kickoffStartTime: kickoffTime,
    slotMinutes,
  });

  if (!safetyBackup(res, 'knockouts')) return;

  const insertRound = db.prepare(
    `INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertMatch = db.prepare(
    `INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id, bracket_slot)
     VALUES (?, ?, ?, ?, ?)`
  );

  const persist = db.transaction(() => {
    for (const round of knockoutRounds) {
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

  saveScore(db, match.id, homeScore, awayScore, penaltyWinnerId);

  tryFillFinal(db, leagueId, match.stage);
  if (isBracketComplete(leagueId, 'cup') && isBracketComplete(leagueId, 'plate')) {
    db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(leagueId);
  }

  res.redirect(`/admin/league/${leagueId}/results#round-${match.round_id}`);
});

// Clear a knockout result. Clearing a semi also un-sets the (unplayed) final's teams.
router.post('/league/:id/knockout-results/match/:matchId/clear', (req, res) => {
  const leagueId = Number(req.params.id);
  const match = getMatchForLeague(Number(req.params.matchId), leagueId);
  if (!match || match.stage === 'group') return res.status(404).render('404');

  const final = db
    .prepare(
      `SELECT m.* FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = 'final'`
    )
    .get(leagueId, match.stage);
  const isSemi = match.bracket_slot === 'semi_1' || match.bracket_slot === 'semi_2';
  if (isSemi && final && final.status === 'played') {
    return fail(res, 'Clear the final first.');
  }

  db.transaction(() => {
    clearScore(db, match.id);
    if (isSemi && final) {
      db.prepare('UPDATE matches SET home_team_id = NULL, away_team_id = NULL WHERE id = ?').run(final.id);
    }
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ? AND status = 'complete'").run(leagueId);
  })();
  res.redirect(`/admin/league/${leagueId}/results#round-${match.round_id}`);
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

// ---------- Public menu (which tabs show, their names and order) ----------

router.get('/league/:id/navigation', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  res.render('admin/navigation', { league, tabs: getNavSettings(league), saved: req.query.saved === '1' });
});

router.post('/league/:id/navigation', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const { errors, value } = parseNavInput(req.body);
  if (errors.length) return fail(res, errors.join(' '));
  db.prepare('UPDATE leagues SET nav_tabs = ? WHERE id = ?').run(value, league.id);
  res.redirect(`/admin/league/${league.id}/navigation?saved=1`);
});

// ---------- Info pages (rules, referee guide, parents...) ----------

router.get('/league/:id/pages', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  res.render('admin/pages', { league, pages: getPages(db, league.id) });
});

router.post('/league/:id/pages/seed', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  if (getPages(db, league.id).length === 0) seedStarterPages(db, league.id);
  res.redirect(`/admin/league/${league.id}/pages`);
});

router.post('/league/:id/pages', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const { errors, value } = parsePageInput({ title: req.body.title });
  if (errors.length) return fail(res, errors.join(' '));

  const last = getPages(db, league.id).reduce((max, p) => Math.max(max, p.sort_order), 0);
  const pageId = createPage(db, league.id, { title: value.title, sortOrder: Math.min(last + 10, 999) });
  res.redirect(`/admin/league/${league.id}/pages/${pageId}/edit`);
});

router.get('/league/:id/pages/:pageId/edit', (req, res) => {
  const league = getLeague(db, req.params.id);
  const page = league && getPageById(db, league.id, Number(req.params.pageId));
  if (!page) return res.status(404).render('404');
  res.render('admin/page-edit', { league, page, saved: req.query.saved === '1' });
});

router.get('/league/:id/pages/:pageId/preview', (req, res) => {
  const league = getLeague(db, req.params.id);
  const page = league && getPageById(db, league.id, Number(req.params.pageId));
  if (!page) return res.status(404).render('404');
  res.locals.navCounts = { ...getNavCounts(db, league.id), info: 1 }; // so the Info tab shows while previewing a draft
  res.render('public/page', { league, page, html: renderMarkup(page.body), preview: true });
});

router.post('/league/:id/pages/:pageId', (req, res) => {
  const league = getLeague(db, req.params.id);
  const page = league && getPageById(db, league.id, Number(req.params.pageId));
  if (!page) return res.status(404).render('404');

  const { errors, value } = parsePageInput(req.body);
  if (errors.length) return fail(res, errors.join(' '));

  // The slug is left alone so a published page's link never changes.
  db.prepare(
    'UPDATE pages SET title = ?, body = ?, sort_order = ?, published = ? WHERE id = ? AND league_id = ?'
  ).run(value.title, value.body, value.sortOrder, value.published ? 1 : 0, page.id, league.id);
  res.redirect(`/admin/league/${league.id}/pages/${page.id}/edit?saved=1`);
});

router.post('/league/:id/pages/:pageId/delete', (req, res) => {
  db.prepare('DELETE FROM pages WHERE id = ? AND league_id = ?').run(
    Number(req.params.pageId),
    Number(req.params.id)
  );
  res.redirect(`/admin/league/${req.params.id}/pages`);
});

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
