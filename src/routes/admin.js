const express = require('express');
const db = require('../db');
const { checkPassword, requireAdmin, safeReturnTo } = require('../middleware/auth');
const { createLimiter } = require('../middleware/loginLimiter');
const { computeStandings, getOpenTieBlocks, groupStageComplete } = require('../lib/standings');
const { generateGroupStageSchedule, generateCupAndPlate, generateCupPlateBowl, generateFinalsRoundRobins, addDays } = require('../lib/schedule');
const { tryFillFinal, feedOf, slotName, bracketSize, stageName, isThreeGroupFinals, isRoundRobinFirst } = require('../lib/knockoutResult');
const { getFinalsGroups, getFinalsState } = require('../lib/finalsGroups');
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
const { formatNzDateTime } = require('../lib/format');
const { resolveDbPath } = require('../lib/paths');
const { getUsageStats } = require('../lib/usage');
const { getSplitSettings, resolveSplit, parseSplitInput } = require('../lib/standingsSplit');
const { DEFAULT_BLURB, MAX_LENGTH: BLURB_MAX, getFinalsBlurb, parseBlurbInput } = require('../lib/finalsBlurb');
const { parseFixtureCsv, planFixtureImport, applyFixtureImport, looksLikeFixtureCsv } = require('../lib/fixtureImport');
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
  todayNZ,
} = require('../lib/queries');
const { getNavSettings, parseNavInput } = require('../lib/navTabs');
const { parseRosterCsv, createLeagueFromRoster, SAMPLE_CSV } = require('../lib/rosterImport');
const { parsePlayerList, parseBlocks, planRosterImport, applyRosterImport, replaceRoster, splitCaptain, playerLine } = require('../lib/rosterText');

const router = express.Router();

// Marks every admin page so the footer leaves out the public-only scripts (auto-refresh, follow-a-team).
router.use((req, res, next) => {
  res.locals.adminPage = true;
  next();
});

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
         COUNT(DISTINCT CASE WHEN r.stage IN ('cup', 'plate', 'bowl') THEN r.id END) AS knockout_rounds
       FROM rounds r LEFT JOIN matches m ON m.round_id = r.id
       WHERE r.league_id = ?`
    )
    .get(leagueId);
  return { rounds: row.rounds, played: row.played, knockoutRounds: row.knockout_rounds };
}

const GROUP_LOCKED_MESSAGE =
  'Group results are locked because the finals brackets have been drawn. ' +
  'Reset the brackets first if a group score was wrong.';

function groupResultsLocked(leagueId) {
  return scheduleStats(leagueId).knockoutRounds > 0;
}

/** Group matches from earlier match nights that still have no result (forgotten scores). */
function missedResults(leagueId) {
  const rows = db
    .prepare(
      `SELECT r.id AS round_id, r.week_number, r.round_number
       FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = 'group' AND m.status = 'scheduled' AND r.date < ?
       ORDER BY r.round_number`
    )
    .all(leagueId, todayNZ());
  if (rows.length === 0) return null;
  return { count: rows.length, week: rows[0].week_number, roundId: rows[0].round_id, round: rows[0].round_number };
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

router.get('/usage', (req, res) => {
  res.render('admin/usage', { stats: getUsageStats(db) });
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

// A fixture list (date, time, home, away, pitch) sets up the whole league in one go: teams, pitches and schedule.
function createLeagueFromFixtures(req, res) {
  const parsed = parseFixtureCsv(req.body.csv);
  const preview = parsed.errors.length ? null : planFixtureImport(db, { id: 0, num_pitches: 4, slot_minutes: 35 }, parsed.rows);
  const errors = [...parsed.errors, ...(preview ? preview.errors : [])];
  let value = null;
  if (preview && errors.length === 0) {
    const checked = parseLeagueInput({
      ...req.body,
      num_teams: String(preview.teams.length),
      num_pitches: String(preview.pitchCount),
      rounds_per_week: String(preview.roundsPerWeek),
    });
    errors.push(...checked.errors);
    value = checked.value;
  }
  if (errors.length) return fail(res, errors.join(' '));
  const leagueId = createLeagueFromRoster(db, value, preview.teams.map((t) => ({ name: t.name, kit: '', players: [] })));
  const league = getLeague(db, leagueId);
  applyFixtureImport(db, league, planFixtureImport(db, league, parsed.rows));
  res.redirect(`/admin/league/${leagueId}/schedule`);
}

router.post('/import', (req, res) => {
  if (looksLikeFixtureCsv(req.body.csv)) return createLeagueFromFixtures(req, res);
  const csv = parseRosterCsv(req.body.csv);
  const { errors: leagueErrors, value } = parseLeagueInput({ ...req.body, num_teams: String(csv.teams.length) });
  // The team-count message is already covered by the CSV check, so don't show it twice.
  const errors = [...csv.errors, ...leagueErrors.filter((e) => !/number of teams/i.test(e))];
  if (errors.length) return fail(res, errors.join(' '));
  res.redirect(`/admin/league/${createLeagueFromRoster(db, value, csv.teams)}/teams`);
});

// ---------- Hide / show a league on the public site ----------

router.post('/league/:id/visibility', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  db.prepare('UPDATE leagues SET hidden = ? WHERE id = ?').run(req.body.hidden === '1' ? 1 : 0, league.id);
  res.redirect('/admin');
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

  res.render('admin/teams', { league, teams, playerLine });
});

router.post('/league/:id/teams/:teamId', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  const kit = String(req.body.kit_colour ?? '').trim();
  if (!name || name.length > 60) return fail(res, 'Team name is required (max 60 characters).');
  if (kit.length > 30) return fail(res, 'Kit colour is too long (max 30 characters).');

  // The whole roster can be saved in one go: one name per line (a pasted list works).
  let players = null;
  if (req.body.players !== undefined) {
    const parsed = parsePlayerList(req.body.players);
    if (parsed.errors.length) return fail(res, `${name}: ${parsed.errors.join(' ')} Nothing was saved.`);
    players = parsed.names;
  }

  const teamId = Number(req.params.teamId);
  const leagueId = Number(req.params.id);
  if (!teamInLeague(teamId, leagueId)) return res.status(404).render('404');

  db.prepare('UPDATE teams SET name = ?, kit_colour = ? WHERE id = ? AND league_id = ?').run(
    name,
    kit || null,
    teamId,
    leagueId
  );
  if (players) replaceRoster(db, teamId, players);
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

// ---------- Paste every team at once (with a preview before anything changes) ----------

function readRosterPaste(body) {
  const format = body.format === 'blocks' ? 'blocks' : 'csv';
  const text = String(body.text ?? '');
  const replace = body.replace === 'on';
  if (format === 'csv' && looksLikeFixtureCsv(text)) {
    return {
      form: { text, format, replace },
      teams: [],
      errors: ['This looks like a fixture list (dates, times, home and away), not a list of players. Load it from the league\'s Schedule page with "Import fixtures from a file".'],
    };
  }
  const parsed = format === 'blocks' ? parseBlocks(text) : parseRosterCsv(text, { checkTeamCount: false });
  const errors = [...parsed.errors];
  if (errors.length === 0 && parsed.teams.length === 0) errors.push('Nothing to import - paste at least one team.');
  return { form: { text, format, replace }, teams: parsed.teams, errors };
}

router.get('/league/:id/roster-import', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  res.render('admin/roster-import', { league, form: { text: '', format: 'csv', replace: false }, errors: [], plan: null });
});

router.post('/league/:id/roster-import/preview', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const paste = readRosterPaste(req.body);
  const plan = paste.errors.length ? null : planRosterImport(db, league.id, paste.teams, { replace: paste.form.replace });
  const errors = [...paste.errors, ...(plan ? plan.errors : [])];
  res.render('admin/roster-import', { league, form: paste.form, errors, plan: errors.length ? null : plan });
});

router.post('/league/:id/roster-import/confirm', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  // The plan is worked out again here from the pasted text - the browser's idea of it is never trusted.
  const paste = readRosterPaste(req.body);
  const plan = paste.errors.length ? null : planRosterImport(db, league.id, paste.teams, { replace: paste.form.replace });
  const errors = [...paste.errors, ...(plan ? plan.errors : [])];
  if (errors.length) return res.render('admin/roster-import', { league, form: paste.form, errors, plan: null });
  if (!safetyBackup(res, 'roster-import')) return;
  applyRosterImport(db, plan);
  res.redirect(`/admin/league/${league.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (name.length > 60) return fail(res, 'Player name is too long (max 60 characters).');
  if (name && teamInLeague(Number(req.params.teamId), Number(req.params.id))) {
    const { name: base, captain } = splitCaptain(name);
    db.prepare('INSERT INTO players (team_id, name, is_captain) VALUES (?, ?, ?)').run(
      Number(req.params.teamId),
      base,
      captain ? 1 : 0
    );
  }
  res.redirect(`/admin/league/${req.params.id}/teams`);
});

router.post('/league/:id/teams/:teamId/players/:playerId', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (!name) return fail(res, 'A player needs a name (use remove to delete them).');
  if (name.length > 60) return fail(res, 'Player name is too long (max 60 characters).');
  if (teamInLeague(Number(req.params.teamId), Number(req.params.id))) {
    const { name: base, captain } = splitCaptain(name);
    db.prepare('UPDATE players SET name = ?, is_captain = ? WHERE id = ? AND team_id = ?').run(
      base,
      captain ? 1 : 0,
      Number(req.params.playerId),
      Number(req.params.teamId)
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
          `${existing.knockoutRounds ? ' and the finals brackets' : ''}. ` +
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
    db.prepare('DELETE FROM result_log WHERE league_id = ?').run(league.id);

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

// ---------- Load a ready-made draw (fixture list) ----------

function readFixturePaste(body, league) {
  const text = String(body.text ?? '');
  const parsed = parseFixtureCsv(text);
  const plan = parsed.errors.length ? null : planFixtureImport(db, league, parsed.rows);
  const errors = [...parsed.errors, ...(plan ? plan.errors : [])];
  return { form: { text }, errors, plan: errors.length ? null : plan };
}

router.get('/league/:id/fixture-import', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  res.render('admin/fixture-import', { league, form: { text: '' }, errors: [], plan: null, stats: scheduleStats(league.id) });
});

router.post('/league/:id/fixture-import/preview', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const result = readFixturePaste(req.body, league);
  res.render('admin/fixture-import', { league, ...result, stats: scheduleStats(league.id) });
});

router.post('/league/:id/fixture-import/confirm', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  // Worked out again from the pasted text - the browser's idea of the plan is never trusted.
  const result = readFixturePaste(req.body, league);
  const stats = scheduleStats(league.id);
  if (result.errors.length) return res.render('admin/fixture-import', { league, ...result, stats });
  if (stats.played > 0 || stats.knockoutRounds > 0) {
    if (String(req.body.confirm_name ?? '').trim() !== league.name) {
      return fail(
        res,
        `Importing would delete ${stats.played} result${stats.played === 1 ? '' : 's'}` +
          `${stats.knockoutRounds ? ' and the finals brackets' : ''}. ` +
          'Nothing was changed. To go ahead, type the league name exactly in the confirmation box.'
      );
    }
  }
  if (stats.rounds > 0 && !safetyBackup(res, 'fixture-import')) return;
  applyFixtureImport(db, league, result.plan);
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
  const bowlRounds = getRoundsWithMatches(db, league.id, 'bowl');
  const finalsGroups = isRoundRobinFirst(league) ? getFinalsGroups(db, league.id) : [];
  const finalsState = isRoundRobinFirst(league) ? getFinalsState(db, league.id, finalsGroups) : null;

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
    bowlRounds,
    finalsGroups,
    finalsState,
    tieBlocks: getOpenTieBlocks(db, league.id, standings),
    missed: missedResults(league.id),
    groupLocked: cupRounds.length > 0 || plateRounds.length > 0 || bowlRounds.length > 0,
  });
});

router.post('/league/:id/results/match/:matchId', (req, res) => {
  const match = getMatchForLeague(Number(req.params.matchId), Number(req.params.id));
  if (!match || match.stage !== 'group') return res.status(404).render('404');
  if (groupResultsLocked(Number(req.params.id))) return fail(res, GROUP_LOCKED_MESSAGE);

  const homeScore = parseScore(req.body.home_score);
  const awayScore = parseScore(req.body.away_score);
  if (homeScore === null || awayScore === null) {
    return fail(res, 'Scores must be whole numbers between 0 and 99.');
  }

  saveScore(db, match.id, homeScore, awayScore, null, { ip: req.ip });
  res.redirect(`/admin/league/${req.params.id}/results?week=${match.week_number}#round-${match.round_id}`);
});

// One form per round: all of a round's scores in a single Save (and a per-match Clear).
router.post('/league/:id/results/round/:roundId', (req, res) => {
  const leagueId = Number(req.params.id);
  const round = db
    .prepare('SELECT * FROM rounds WHERE id = ? AND league_id = ?')
    .get(Number(req.params.roundId), leagueId);
  if (!round || round.stage !== 'group') return res.status(404).render('404');
  if (groupResultsLocked(leagueId)) return fail(res, GROUP_LOCKED_MESSAGE);

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
    clearScore(db, target.id, { ip: req.ip });
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
    for (const s of toSave) saveScore(db, s.id, s.homeScore, s.awayScore, null, { ip: req.ip });
  })();
  res.redirect(back);
});

router.post('/league/:id/tie-break', (req, res) => {
  const stage = ['cup', 'plate', 'bowl'].includes(req.body.stage) ? req.body.stage : 'group';
  if (stage === 'group' && groupResultsLocked(Number(req.params.id))) return fail(res, GROUP_LOCKED_MESSAGE);
  if (stage !== 'group' && finalsKnockoutsDrawn(Number(req.params.id))) {
    return fail(res, 'The knockouts have been drawn from this table, so its order is locked. Use "Reset the knockouts" first.');
  }
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
    `DELETE FROM tie_breaks WHERE league_id = ? AND stage = ?
       AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))`
  ).run(leagueId, stage, a, b, b, a);
  db.prepare(
    'INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id, stage) VALUES (?, ?, ?, ?, ?)'
  ).run(leagueId, a, b, winner, stage);
  res.redirect(`/admin/league/${leagueId}/results`);
});

// ---------- Knockouts ----------

router.post('/league/:id/generate-knockouts', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  if (isRoundRobinFirst(league)) return res.redirect(`/admin/league/${league.id}/results`);

  const alreadyGenerated = db
    .prepare("SELECT COUNT(*) AS c FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')")
    .get(league.id).c;
  if (alreadyGenerated > 0 || !groupStageComplete(db, league.id)) {
    return res.redirect(`/admin/league/${league.id}/results`);
  }

  const standings = computeStandings(db, league.id);
  // 4 teams in each bracket (8 to 11 teams in the league), or 6 in each from 12 teams up.
  const threeGroups = isThreeGroupFinals(league);
  const size = bracketSize(standings.length);
  if (threeGroups && standings.length !== 12) {
    return fail(res, 'Cup / Plate / Bowl finals need exactly 12 teams in the league (three groups of 4).');
  }
  if (!threeGroups && standings.length < 2 * size) {
    return fail(res, 'Cup/Plate knockouts need at least 8 teams in the league.');
  }

  // Any open tie changes who is seeded where (not just the Cup/Plate split), so settle them all first.
  const openTies = standings.filter((s) => s.tied && !s.tieResolved);
  if (openTies.length > 0) {
    return fail(
      res,
      `${openTies.length} teams are still tied on points and goal difference (${openTies.map((t) => t.name).join(', ')}). ` +
        'Record the shootout results on the Results page first, then draw the brackets.'
    );
  }

  const cupTeams = standings.slice(0, size).map((s) => s.teamId);
  const plateTeams = standings.slice(size, size * 2).map((s) => s.teamId);
  const groupsOfFour = [0, 4, 8].map((from) => standings.slice(from, from + 4).map((s) => s.teamId));
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

  const when = {
    roundNumberStart: lastGroupRound + 1,
    weekNumber: lastGroupWeek + 1,
    date: knockoutDate,
    kickoffStartTime: kickoffTime,
    slotMinutes,
  };
  const knockoutRounds = threeGroups
    ? generateCupPlateBowl({ groups: groupsOfFour, pitchIds, ...when })
    : generateCupAndPlate({ cupTeamIds: cupTeams, plateTeamIds: plateTeams, pitchIds, ...when });

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

// Round-robin-first finals, step 1: draw the three groups of 4 from the final group-stage table.
router.post('/league/:id/generate-finals-groups', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const back = `/admin/league/${league.id}/results`;
  if (!isRoundRobinFirst(league)) return res.redirect(back);
  const already = db.prepare("SELECT COUNT(*) AS c FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')").get(league.id).c;
  if (already > 0 || !groupStageComplete(db, league.id)) return res.redirect(back);

  const standings = computeStandings(db, league.id);
  if (standings.length !== 12) return fail(res, 'Cup / Plate / Bowl finals need exactly 12 teams in the league (three groups of 4).');
  const openTies = standings.filter((s) => s.tied && !s.tieResolved);
  if (openTies.length > 0) {
    return fail(res, `${openTies.length} teams are still tied on points and goal difference (${openTies.map((t) => t.name).join(', ')}). Record the shootout results on the Results page first, then draw the groups.`);
  }
  const pitchIds = getPitches(db).slice(0, league.num_pitches).map((p) => p.id);
  if (pitchIds.length < 2) return fail(res, 'The finals need at least 2 pitches.');

  const last = db
    .prepare("SELECT MAX(round_number) AS n, MAX(week_number) AS w, MAX(date) AS d FROM rounds WHERE league_id = ? AND stage = 'group'")
    .get(league.id);
  const rounds = generateFinalsRoundRobins({
    groups: [0, 4, 8].map((from) => standings.slice(from, from + 4).map((s) => s.teamId)),
    pitchIds,
    roundNumberStart: last.n + 1,
    weekNumber: last.w + 1,
    date: addDays(last.d || league.start_date, 7),
    kickoffStartTime: league.kickoff_start_time || '17:00',
    slotMinutes: league.slot_minutes || 45,
  });
  if (!safetyBackup(res, 'finals-groups')) return;
  insertFinalsRounds(league.id, rounds);
  res.redirect(back);
});

// Round-robin-first finals, step 2: the knockouts (1v4, 2v3, then the Grand Final) from the three mini tables.
router.post('/league/:id/generate-finals-knockouts', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const back = `/admin/league/${league.id}/results`;
  if (!isRoundRobinFirst(league)) return res.redirect(back);
  const groups = getFinalsGroups(db, league.id);
  const state = getFinalsState(db, league.id, groups);
  if (state.knockoutsDrawn || !state.roundRobinsComplete) return res.redirect(back);
  if (state.openTies) return fail(res, 'Some teams in the finals groups are still level. Record the shootout results first, then draw the knockouts.');

  const pitchIds = getPitches(db).slice(0, league.num_pitches).map((p) => p.id);
  const last = db
    .prepare("SELECT MAX(round_number) AS n, MAX(week_number) AS w, MAX(date) AS d FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')")
    .get(league.id);
  const rounds = generateCupPlateBowl({
    groups: groups.map((g) => g.standings.map((s) => s.teamId)),
    pitchIds,
    roundNumberStart: last.n + 1,
    weekNumber: last.w + 1,
    date: addDays(last.d, 7),
    kickoffStartTime: league.kickoff_start_time || '17:00',
    slotMinutes: league.slot_minutes || 45,
  });
  if (!safetyBackup(res, 'finals-knockouts')) return;
  insertFinalsRounds(league.id, rounds);
  res.redirect(back);
});

function insertFinalsRounds(leagueId, rounds) {
  const insertRound = db.prepare(
    "INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time) VALUES (?, ?, ?, ?, ?, ?)"
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

/** True once the knockouts (semi-finals / final) of a round-robin-first league have been drawn. */
function finalsKnockoutsDrawn(leagueId) {
  return !!db
    .prepare(
      `SELECT 1 FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage IN ('cup', 'plate', 'bowl') AND m.bracket_slot IN ('semi_1', 'semi_2', 'final')`
    )
    .get(leagueId);
}

// Throw only the knockouts away (a round-robin score was wrong), keeping the round-robin results.
router.post('/league/:id/finals-knockouts/reset', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  if (String(req.body.confirm_name ?? '').trim() !== league.name) {
    return fail(res, 'The name you typed did not match, so the knockouts were not reset.');
  }
  if (!finalsKnockoutsDrawn(league.id)) return res.redirect(`/admin/league/${league.id}/results`);
  if (!safetyBackup(res, 'reset-finals-knockouts')) return;
  db.transaction(() => {
    db.prepare(
      `DELETE FROM matches WHERE bracket_slot IN ('semi_1', 'semi_2', 'final')
         AND round_id IN (SELECT id FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl'))`
    ).run(league.id);
    db.prepare(
      `DELETE FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')
         AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.round_id = rounds.id)`
    ).run(league.id);
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ?").run(league.id);
  })();
  res.redirect(`/admin/league/${league.id}/results`);
});

router.post('/league/:id/knockout-results/match/:matchId', (req, res) => {
  const leagueId = Number(req.params.id);
  const match = getMatchForLeague(Number(req.params.matchId), leagueId);
  if (!match || match.stage === 'group') return res.status(404).render('404');
  if (!match.home_team_id || !match.away_team_id) {
    return fail(res, 'This match is not set yet - enter the results of the round before it first.');
  }

  const isRoundRobinMatch = match.bracket_slot === 'rr';
  if (isRoundRobinMatch && finalsKnockoutsDrawn(leagueId)) {
    return fail(res, 'The knockouts have been drawn from the round-robin results, so they are locked. Use "Reset the knockouts" on the Results page first.');
  }
  const laterPlayed = playedMatchFedBy(leagueId, match);
  if (laterPlayed) return fail(res, `Clear the ${slotName(laterPlayed.bracket_slot)} first.`);

  const homeScore = parseScore(req.body.home_score);
  const awayScore = parseScore(req.body.away_score);
  if (homeScore === null || awayScore === null) {
    return fail(res, 'Scores must be whole numbers between 0 and 99.');
  }

  let penaltyWinnerId = null;
  if (homeScore === awayScore && !isRoundRobinMatch) {
    const picked = Number(req.body.penalty_winner_id);
    if (picked !== match.home_team_id && picked !== match.away_team_id) {
      return fail(res, 'A drawn knockout match needs a shootout winner - pick one and save again.');
    }
    penaltyWinnerId = picked;
  }

  saveScore(db, match.id, homeScore, awayScore, penaltyWinnerId, { ip: req.ip });

  tryFillFinal(db, leagueId, match.stage);
  if (allBracketsComplete(leagueId)) {
    db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(leagueId);
  }

  res.redirect(`/admin/league/${leagueId}/results#round-${match.round_id}`);
});

// Read-only history of score changes (latest 100).
router.get('/league/:id/log', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const entries = db
    .prepare(
      `SELECT l.*, r.round_number, r.stage, m.bracket_slot, ht.name AS home_name, at.name AS away_name
       FROM result_log l
       JOIN matches m ON m.id = l.match_id
       JOIN rounds r ON r.id = m.round_id
       LEFT JOIN teams ht ON ht.id = m.home_team_id
       LEFT JOIN teams at ON at.id = m.away_team_id
       WHERE l.league_id = ?
       ORDER BY l.id DESC LIMIT 100`
    )
    .all(league.id)
    .map((e) => ({
      ...e,
      when: formatNzDateTime(e.at),
      where:
        e.stage === 'group'
          ? `Round ${e.round_number}`
          : `${stageName(e.stage)} ${slotName(e.bracket_slot)}`,
      oldText: e.old_status === 'played' ? `${e.old_home}-${e.old_away}` : 'no result',
      newText: e.new_status === 'played' ? `${e.new_home}-${e.new_away}` : 'cleared',
    }));
  res.render('admin/log', { league, entries });
});

// Throw the finals brackets away (e.g. a group score turns out to be wrong) so they can be drawn again.
router.post('/league/:id/knockouts/reset', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  if (String(req.body.confirm_name ?? '').trim() !== league.name) {
    return fail(res, 'The name you typed did not match, so the brackets were not reset.');
  }
  if (!groupResultsLocked(league.id)) return res.redirect(`/admin/league/${league.id}/results`);
  if (!safetyBackup(res, 'reset-knockouts')) return;

  db.transaction(() => {
    db.prepare(
      "DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl'))"
    ).run(league.id);
    db.prepare("DELETE FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate', 'bowl')").run(league.id);
    db.prepare("DELETE FROM tie_breaks WHERE league_id = ? AND stage != 'group'").run(league.id);
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ?").run(league.id);
  })();
  res.redirect(`/admin/league/${league.id}/results`);
});

/** The knockout match that a match feeds its winner into (quarter -> semi, semi -> final), if any. */
function matchFedBy(leagueId, match) {
  const feed = feedOf(match.bracket_slot);
  if (!feed) return null;
  return db
    .prepare(
      `SELECT m.* FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = ?`
    )
    .get(leagueId, match.stage, feed.slot) || null;
}

function playedMatchFedBy(leagueId, match) {
  const later = matchFedBy(leagueId, match);
  return later && later.status === 'played' ? later : null;
}

// Clear a knockout result. Clearing a quarter or semi also un-sets the (unplayed) match it fed.
router.post('/league/:id/knockout-results/match/:matchId/clear', (req, res) => {
  const leagueId = Number(req.params.id);
  const match = getMatchForLeague(Number(req.params.matchId), leagueId);
  if (!match || match.stage === 'group') return res.status(404).render('404');

  if (match.bracket_slot === 'rr' && finalsKnockoutsDrawn(leagueId)) {
    return fail(res, 'The knockouts have been drawn from the round-robin results, so they are locked. Use "Reset the knockouts" on the Results page first.');
  }
  const later = matchFedBy(leagueId, match);
  if (later && later.status === 'played') {
    return fail(res, `Clear the ${slotName(later.bracket_slot)} first.`);
  }

  db.transaction(() => {
    clearScore(db, match.id, { ip: req.ip });
    if (later) {
      // A quarter-final feeds one side of its semi; a semi-final feeds both sides of the final.
      const feed = feedOf(match.bracket_slot);
      const clearColumns = later.bracket_slot === 'final' ? 'home_team_id = NULL, away_team_id = NULL' : `${feed.side} = NULL`;
      db.prepare(`UPDATE matches SET ${clearColumns} WHERE id = ?`).run(later.id);
    }
    db.prepare("UPDATE leagues SET status = 'in_progress' WHERE id = ? AND status = 'complete'").run(leagueId);
  })();
  res.redirect(`/admin/league/${leagueId}/results#round-${match.round_id}`);
});

/** True once there are finals brackets and every match in every one of them (Cup, Plate, Bowl) has been played. */
function allBracketsComplete(leagueId) {
  const rows = db
    .prepare(
      `SELECT r.stage, SUM(CASE WHEN m.status = 'played' THEN 1 ELSE 0 END) AS played, COUNT(*) AS total,
              SUM(CASE WHEN m.bracket_slot = 'final' THEN 1 ELSE 0 END) AS finals
       FROM matches m JOIN rounds r ON r.id = m.round_id
       WHERE r.league_id = ? AND r.stage IN ('cup', 'plate', 'bowl')
       GROUP BY r.stage`
    )
    .all(leagueId);
  // (a round-robin-first league has not finished until its knockouts are drawn and played too)
  return rows.length > 0 && rows.every((row) => row.total > 0 && row.played === row.total && row.finals > 0);
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

// ---------- Finals format (Cup & Plate, or Cup / Plate / Bowl) ----------

function renderFinalsForm(res, league, { saved = false, errors = [] } = {}) {
  const numTeams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(league.id).n;
  res.render('admin/finals-format', {
    league,
    numTeams,
    saved,
    errors,
    drawn: scheduleStats(league.id).knockoutRounds > 0,
    blurbText: getFinalsBlurb(league),
    blurbMax: BLURB_MAX,
    blurbIsDefault: !league.finals_blurb,
    defaultBlurb: DEFAULT_BLURB,
  });
}

router.get('/league/:id/finals-format', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  renderFinalsForm(res, league, { saved: req.query.saved === '1' });
});

router.post('/league/:id/finals-format', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const wanted = ['three', 'three_rr'].includes(req.body.format) ? req.body.format : 'standard';
  const numTeams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(league.id).n;
  if (scheduleStats(league.id).knockoutRounds > 0) {
    return renderFinalsForm(res, league, { errors: ['The finals have already been drawn, so the format is locked. Reset the brackets on the Results page first if you need to change it.'] });
  }
  if (wanted !== 'standard' && numTeams !== 12) {
    return renderFinalsForm(res, league, { errors: [`Cup / Plate / Bowl needs exactly 12 teams (three groups of 4). This league has ${numTeams}.`] });
  }
  db.prepare('UPDATE leagues SET finals_format = ? WHERE id = ?').run(wanted === 'standard' ? null : wanted, league.id);
  res.redirect(`/admin/league/${league.id}/finals-format?saved=1`);
});

router.post('/league/:id/finals-blurb', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const { errors, value } = parseBlurbInput(req.body, league);
  if (errors.length) return fail(res, errors.join(' '));
  db.prepare('UPDATE leagues SET finals_blurb = ? WHERE id = ?').run(value, league.id);
  res.redirect(`/admin/league/${league.id}/finals-format?saved=1`);
});

// ---------- Standings display (the top / bottom split marker) ----------

function renderSplitForm(res, league, saved, status = 200) {
  const numTeams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(league.id).n;
  res.status(status).render('admin/standings-display', {
    league,
    numTeams,
    settings: getSplitSettings(league),
    preview: resolveSplit(league, numTeams, { mode: 'labels', three: false, after: null }),
    previewThirds: resolveSplit(league, numTeams, { mode: 'labels', three: true, after: null, after2: null }),
    saved,
  });
}

router.get('/league/:id/standings-display', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  renderSplitForm(res, league, req.query.saved === '1');
});

router.post('/league/:id/standings-display', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const numTeams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(league.id).n;
  const { errors, value } = parseSplitInput(req.body, numTeams);
  if (errors.length) return fail(res, errors.join(' '));
  db.prepare('UPDATE leagues SET standings_split = ? WHERE id = ?').run(value, league.id);
  res.redirect(`/admin/league/${league.id}/standings-display?saved=1`);
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
