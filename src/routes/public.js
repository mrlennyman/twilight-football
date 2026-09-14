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
  getCurrentWeek,
  firstNameLastInitial,
} = require('../lib/queries');

const router = express.Router();

router.get('/', (req, res) => {
  const leagues = getAllLeagues(db).filter((l) => l.status !== 'setup');
  res.render('public/home', { leagues });
});

router.get('/league/:id', (req, res) => {
  const league = getLeague(db, req.params.id);
  if (!league) return res.status(404).render('404');

  const standings = computeStandings(db, league.id);
  const currentWeek = getCurrentWeek(db, league.id);
  const thisWeekRounds = currentWeek ? getRoundsForWeek(db, league.id, currentWeek) : [];

  res.render('public/league', { league, standings, currentWeek, thisWeekRounds });
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
  const selectedWeek = req.query.week ? Number(req.query.week) : weekNumbers[0];
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

module.exports = router;
