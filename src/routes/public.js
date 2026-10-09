const express = require('express');
const db = require('../db');
const { computeStandings } = require('../lib/standings');
const {
  getAllLeagues,
  getLeague,
  getTeams,
  getPlayers,
  getRoundsForWeek,
  getRoundsWithMatches,
  getWeekNumbers,
  getDefaultWeek,
  getLastUpdated,
  getPages,
  getPublishedPageBySlug,
  getNavCounts,
  firstNameLastInitial,
} = require('../lib/queries');
const { renderMarkup } = require('../lib/markup');
const { formatUpdated } = require('../lib/format');

const router = express.Router();

// The menu needs to know whether Info pages / knockouts exist (see lib/navTabs.js).
router.param('id', (req, res, next, id) => {
  const leagueId = Number.parseInt(id, 10);
  res.locals.navCounts = Number.isInteger(leagueId) ? getNavCounts(db, leagueId) : {};
  // "Other leagues" link on the league pages once there is more than one running league.
  res.locals.hasOtherLeagues = getAllLeagues(db).filter((l) => l.status !== 'setup').length > 1;
  next();
});

function renderLeagueHome(league, res) {
  res.locals.navCounts = getNavCounts(db, league.id);
  const standings = computeStandings(db, league.id);
  const currentWeek = getDefaultWeek(db, league.id);
  const thisWeekRounds = currentWeek ? getRoundsForWeek(db, league.id, currentWeek) : [];

  res.render('public/league', {
    league,
    standings,
    currentWeek,
    thisWeekRounds,
    updatedText: formatUpdated(getLastUpdated(db, league.id)),
  });
}

router.get('/install', (req, res) => {
  res.render('public/install');
});

router.get('/', (req, res) => {
  const leagues = getAllLeagues(db).filter((l) => l.status !== 'setup');

  // With a single active league, skip the "list of leagues" screen entirely
  // and land straight on its standings - the leagues list is only useful
  // once there's actually a choice to make.
  if (leagues.length === 1) {
    return renderLeagueHome(leagues[0], res);
  }

  res.render('public/home', { leagues });
});

router.get('/league/:id', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  renderLeagueHome(league, res);
});

router.get('/league/:id/teams', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const teams = getTeams(db, league.id).map((team) => ({
    ...team,
    players: getPlayers(db, team.id).map((p) => ({ ...p, displayName: firstNameLastInitial(p.name), isCaptain: p.is_captain === 1 })),
  }));

  res.render('public/teams', { league, teams });
});

router.get('/league/:id/fixtures', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const weekNumbers = getWeekNumbers(db, league.id);
  const requestedWeek = Number.parseInt(req.query.week, 10);
  const selectedWeek = weekNumbers.includes(requestedWeek) ? requestedWeek : getDefaultWeek(db, league.id);
  const rounds = selectedWeek ? getRoundsForWeek(db, league.id, selectedWeek) : [];

  res.render('public/fixtures', {
    league,
    weekNumbers,
    selectedWeek,
    rounds,
    updatedText: formatUpdated(getLastUpdated(db, league.id)),
  });
});

// One team's own games, in order - so a parent finds their child's pitch without scanning every match.
router.get('/league/:id/team/:teamId', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');
  const team = db
    .prepare('SELECT * FROM teams WHERE id = ? AND league_id = ?')
    .get(Number.parseInt(req.params.teamId, 10), league.id);
  if (!team) return res.status(404).render('404');

  const rows = db
    .prepare(
      `SELECT m.*, r.round_number, r.stage, r.date, ht.name AS home_name, at.name AS away_name, p.label AS pitch_label
       FROM matches m
       JOIN rounds r ON r.id = m.round_id
       LEFT JOIN teams ht ON ht.id = m.home_team_id
       LEFT JOIN teams at ON at.id = m.away_team_id
       LEFT JOIN pitches p ON p.id = m.pitch_id
       WHERE r.league_id = ? AND (m.home_team_id = ? OR m.away_team_id = ?)
       ORDER BY r.round_number, m.id`
    )
    .all(league.id, team.id, team.id);

  const matches = rows.map((m) => {
    const isHome = m.home_team_id === team.id;
    const mine = isHome ? m.home_score : m.away_score;
    const theirs = isHome ? m.away_score : m.home_score;
    let resultText = '';
    if (m.status === 'played') {
      if (mine > theirs) resultText = 'Won';
      else if (mine < theirs) resultText = 'Lost';
      else resultText = m.penalty_winner_id === team.id ? 'Won on pens' : m.penalty_winner_id ? 'Lost on pens' : 'Draw';
    }
    return {
      ...m,
      opponent_id: isHome ? m.away_team_id : m.home_team_id,
      opponent_name: (isHome ? m.away_name : m.home_name) || 'TBD',
      my_score: mine,
      their_score: theirs,
      result_text: resultText,
    };
  });

  // Squad (captains first, names as first name + initial) and, once games are played, where the team stands.
  const players = getPlayers(db, team.id).map((pl) => ({ ...pl, displayName: firstNameLastInitial(pl.name) }));
  const table = computeStandings(db, league.id);
  const index = table.findIndex((row) => row.teamId === team.id);
  const row = index >= 0 ? table[index] : null;
  const ordinal = (n) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
  const standing = row && row.played > 0 ? { ...row, position: ordinal(index + 1) } : null;

  res.render('public/team', { league, team, matches, players, standing });
});

router.get('/league/:id/bracket', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const cupRounds = getRoundsWithMatches(db, league.id, 'cup');
  const plateRounds = getRoundsWithMatches(db, league.id, 'plate');

  res.render('public/bracket', { league, cupRounds, plateRounds });
});

router.get('/league/:id/info', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const pages = getPages(db, league.id, { publishedOnly: true });
  res.render('public/info', { league, pages });
});

router.get('/league/:id/info/:slug', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const page = getPublishedPageBySlug(db, league.id, req.params.slug);
  if (!page) return res.status(404).render('404');

  res.render('public/page', { league, page, html: renderMarkup(page.body), preview: false });
});

module.exports = router;
