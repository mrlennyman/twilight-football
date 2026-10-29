/**
 * An example league that is played all the way through - 12 teams, the 6 group weeks, the three finals round robins,
 * the semi-finals and the Grand Finals - so the finished app can be looked at. It is created HIDDEN, so the public
 * never sees it; only a logged-in admin can open it. Delete it from the dashboard when finished with.
 */
const fs = require('fs');
const path = require('path');
const { createLeagueFromRoster } = require('./rosterImport');
const { parseFixtureCsv, planFixtureImport, applyFixtureImport } = require('./fixtureImport');
const { saveScore } = require('./results');
const { computeStandings } = require('./standings');
const { tryFillFinal } = require('./knockoutResult');
const { planFinalsGroups, planFinalsKnockouts, insertFinalsRounds } = require('./finalsActions');
const { addDays } = require('./schedule');
const { todayNZ } = require('./queries');

const DEMO_NAME = 'Example: Cup, Plate & Bowl finals (demo)';
const DEMO_TEAMS = ['Falcons', 'Panthers', 'Rockets', 'Tigers', 'Sharks', 'Wolves', 'Eagles', 'Dragons', 'Comets', 'Phoenix', 'Titans', 'Rhinos'];
const SAMPLE_DRAW = path.join(__dirname, '../../twilight-2026-fixtures.csv');
const SAMPLE_TEAMS = ['2 Left Feet', 'Toe Hackers', 'ACC FC', 'Still Deciding!', 'Agent Orange', 'ST.NUC', 'Comebacks are Real', 'Old Gold', 'Fish n Kicks', 'Newey Nobs', 'Footloose', 'Kiss My Pass'];

/** A small repeatable pseudo-random number source, so the example is the same every time. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function findDemoLeague(db) {
  return db.prepare('SELECT * FROM leagues WHERE name = ?').get(DEMO_NAME) || null;
}

/** The Wednesday that is `weeksBack` weeks before the most recent Wednesday. */
function pastWednesday(weeksBack) {
  const today = todayNZ();
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay(); // 3 = Wednesday
  return addDays(today, -((dow - 3 + 7) % 7) - weeksBack * 7);
}

/** Builds the example. Returns the league id. Throws if the sample draw file is missing. */
function createDemoLeague(db) {
  if (!fs.existsSync(SAMPLE_DRAW)) throw new Error('The sample draw file (twilight-2026-fixtures.csv) is missing from the app folder.');
  const rand = seeded(2026);
  const strength = Object.fromEntries(DEMO_TEAMS.map((name, i) => [name, 0.4 + (rand() * 0.8) + (DEMO_TEAMS.length - i) * 0.04]));

  const leagueId = createLeagueFromRoster(
    db,
    { name: DEMO_NAME, season: 'Demo (not real results)', numPitches: 6, roundsPerWeek: 3 },
    DEMO_TEAMS.map((name) => ({ name, kit: '', players: [] }))
  );
  db.prepare("UPDATE leagues SET hidden = 1, finals_format = 'three_rr' WHERE id = ?").run(leagueId);
  let league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);

  // The group stage: the real 2026 draw with demo team names, on six Wednesdays that are already in the past.
  const parsed = parseFixtureCsv(fs.readFileSync(SAMPLE_DRAW, 'utf8'));
  const dates = [...new Set(parsed.rows.map((r) => r.date))].sort();
  const weeksBack = 9; // leaves the three finals weeks after it, all before today
  const dateMap = new Map(dates.map((d, i) => [d, pastWednesday(weeksBack - i)]));
  const nameMap = new Map(SAMPLE_TEAMS.map((name, i) => [name, DEMO_TEAMS[i]]));
  const rows = parsed.rows.map((r) => ({ ...r, date: dateMap.get(r.date), home: nameMap.get(r.home), away: nameMap.get(r.away) }));
  const plan = planFixtureImport(db, league, rows);
  if (plan.errors.length) throw new Error(`The sample draw would not import: ${plan.errors.join(' ')}`);
  applyFixtureImport(db, league, plan);
  league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(leagueId);

  const goals = (name) => Math.max(0, Math.round(strength[name] * 1.6 + (rand() - 0.5) * 3));
  const nameOf = new Map(db.prepare('SELECT id, name FROM teams WHERE league_id = ?').all(leagueId).map((t) => [t.id, t.name]));
  const scoreAll = (sql, drawsAllowed = true) => {
    for (const m of db.prepare(sql).all(leagueId)) {
      let home = goals(nameOf.get(m.home_team_id));
      let away = goals(nameOf.get(m.away_team_id));
      if (!drawsAllowed && home === away) home += 1;
      saveScore(db, m.id, home, away, null, { ip: 'demo' });
    }
  };
  const matchSql = (where) =>
    `SELECT m.id, m.home_team_id, m.away_team_id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND ${where} ORDER BY r.round_number, m.id`;

  scoreAll(matchSql("r.stage = 'group'"));

  // Finals week 1: the three round robins.
  const groups = planFinalsGroups(db, league);
  if (groups.error) throw new Error(groups.error);
  insertFinalsRounds(db, leagueId, groups.rounds);
  scoreAll(matchSql("r.stage IN ('cup', 'plate', 'bowl') AND m.bracket_slot = 'rr'"));

  // Make the mini tables settle cleanly: a tie would need shootouts recorded by hand.
  const stillTied = ['cup', 'plate', 'bowl'].some((stage) => computeStandings(db, leagueId, { stage }).some((s) => s.tied && !s.tieResolved));
  if (stillTied) {
    for (const stage of ['cup', 'plate', 'bowl']) {
      const rows2 = computeStandings(db, leagueId, { stage });
      const blocks = new Map();
      for (const s of rows2) if (s.tied && !s.tieResolved) blocks.set(s.tieBlock, [...(blocks.get(s.tieBlock) || []), s.teamId]);
      for (const ids of blocks.values()) {
        for (let x = 0; x < ids.length; x++) {
          for (let y = x + 1; y < ids.length; y++) {
            db.prepare('INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id, stage) VALUES (?, ?, ?, ?, ?)').run(leagueId, ids[x], ids[y], ids[x], stage);
          }
        }
      }
    }
  }

  // Finals week 2: semi-finals and the Grand Finals (one of them goes to a shootout).
  const knockouts = planFinalsKnockouts(db, league);
  if (knockouts.error) throw new Error(knockouts.error);
  insertFinalsRounds(db, leagueId, knockouts.rounds);
  const koMatch = (stage, slot) =>
    db.prepare("SELECT m.* FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = ?").get(leagueId, stage, slot);
  for (const stage of ['cup', 'plate', 'bowl']) {
    for (const slot of ['semi_1', 'semi_2', 'final']) {
      const m = koMatch(stage, slot);
      let home = goals(nameOf.get(m.home_team_id));
      let away = goals(nameOf.get(m.away_team_id));
      let pens = null;
      if (home === away) {
        if (stage === 'bowl' && slot === 'final') pens = rand() < 0.5 ? m.home_team_id : m.away_team_id; // shows a shootout result
        else home += 1;
      } else if (stage === 'bowl' && slot === 'final') {
        home = away = Math.max(home, away); // make the Bowl final a draw decided on penalties
        pens = rand() < 0.5 ? m.home_team_id : m.away_team_id;
      }
      saveScore(db, m.id, home, away, pens, { ip: 'demo' });
      tryFillFinal(db, leagueId, stage);
    }
  }
  db.prepare("UPDATE leagues SET status = 'complete' WHERE id = ?").run(leagueId);
  return leagueId;
}

module.exports = { DEMO_NAME, findDemoLeague, createDemoLeague };
