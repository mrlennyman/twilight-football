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
  getPages,
  getPublishedPageBySlug,
  getNavCounts,
  firstNameLastInitial,
} = require('../lib/queries');
const { renderMarkup } = require('../lib/markup');

const router = express.Router();

// The menu needs to know whether Info pages / knockouts exist (see lib/navTabs.js).
router.param('id', (req, res, next, id) => {
  const leagueId = Number.parseInt(id, 10);
  res.locals.navCounts = Number.isInteger(leagueId) ? getNavCounts(db, leagueId) : {};
  next();
});

function renderLeagueHome(league, res) {
  res.locals.navCounts = getNavCounts(db, league.id);
  const standings = computeStandings(db, league.id);
  const currentWeek = getDefaultWeek(db, league.id);
  const thisWeekRounds = currentWeek ? getRoundsForWeek(db, league.id, currentWeek) : [];

  res.render('public/league', { league, standings, currentWeek, thisWeekRounds });
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
    players: getPlayers(db, team.id).map((p) => ({ ...p, displayName: firstNameLastInitial(p.name) })),
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

  res.render('public/fixtures', { league, weekNumbers, selectedWeek, rounds });
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
