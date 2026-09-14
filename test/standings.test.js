const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { computeStandings, groupStageComplete } = require('../src/lib/standings');

function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return db;
}

function setupLeagueWithTeams(db, teamNames) {
  db.prepare("INSERT INTO leagues (id, name, season, num_teams) VALUES (1, 'Test League', '2026', ?)").run(
    teamNames.length
  );
  const insertTeam = db.prepare('INSERT INTO teams (league_id, name) VALUES (1, ?)');
  return teamNames.map((name) => insertTeam.run(name).lastInsertRowid);
}

function addPlayedMatch(db, teamIds, homeIdx, awayIdx, homeScore, awayScore) {
  const roundInfo = db
    .prepare("INSERT INTO rounds (league_id, round_number, week_number, stage) VALUES (1, 1, 1, 'group')")
    .run();
  db.prepare(
    `INSERT INTO matches (round_id, home_team_id, away_team_id, home_score, away_score, status)
     VALUES (?, ?, ?, ?, ?, 'played')`
  ).run(roundInfo.lastInsertRowid, teamIds[homeIdx], teamIds[awayIdx], homeScore, awayScore);
}

test('computeStandings: no ties flagged mid-season, even when some teams share 0 points', () => {
  const db = makeTestDb();
  const teamIds = setupLeagueWithTeams(db, ['A', 'B', 'C', 'D']);
  addPlayedMatch(db, teamIds, 0, 1, 2, 0); // A beats B; C and D haven't played

  const standings = computeStandings(db, 1);
  assert.ok(standings.every((row) => row.tied === false && row.tieResolved === true));
});

test('computeStandings: flags an unresolved tie once the group stage is complete', () => {
  const db = makeTestDb();
  const teamIds = setupLeagueWithTeams(db, ['A', 'B', 'C', 'D']);
  // Double round robin among 4 teams = 3 rounds * 2 legs = 6 matches/team-pairs *
  // but for this test we just need every team to have played (n-1)*2 = 6 matches.
  // Force A and B to finish level on points and goal difference.
  const pairs = [
    [0, 1, 1, 1], // A vs B draw
    [0, 2, 2, 0],
    [0, 3, 2, 0],
    [1, 2, 2, 0],
    [1, 3, 2, 0],
    [2, 3, 1, 1],
    [1, 0, 1, 1], // return leg A vs B draw
    [2, 0, 0, 2],
    [3, 0, 0, 2],
    [2, 1, 0, 2],
    [3, 1, 0, 2],
    [3, 2, 1, 1],
  ];
  for (const [h, a, hs, as] of pairs) addPlayedMatch(db, teamIds, h, a, hs, as);

  assert.equal(groupStageComplete(db, 1), true);
  const standings = computeStandings(db, 1);

  const a = standings.find((r) => r.name === 'A');
  const b = standings.find((r) => r.name === 'B');
  assert.equal(a.points, b.points);
  assert.equal(a.goalDifference, b.goalDifference);
  assert.equal(a.tied, true);
  assert.equal(a.tieResolved, false);
  assert.equal(b.tied, true);
  assert.equal(b.tieResolved, false);
});

test('computeStandings: a recorded shootout result resolves the tie and orders the winner first', () => {
  const db = makeTestDb();
  const teamIds = setupLeagueWithTeams(db, ['A', 'B', 'C', 'D']);
  const pairs = [
    [0, 1, 1, 1],
    [0, 2, 2, 0],
    [0, 3, 2, 0],
    [1, 2, 2, 0],
    [1, 3, 2, 0],
    [2, 3, 1, 1],
    [1, 0, 1, 1],
    [2, 0, 0, 2],
    [3, 0, 0, 2],
    [2, 1, 0, 2],
    [3, 1, 0, 2],
    [3, 2, 1, 1],
  ];
  for (const [h, a, hs, as] of pairs) addPlayedMatch(db, teamIds, h, a, hs, as);

  // B beats A on penalties to settle the tie.
  db.prepare('INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id) VALUES (1, ?, ?, ?)').run(
    teamIds[0],
    teamIds[1],
    teamIds[1]
  );

  const standings = computeStandings(db, 1);
  const a = standings.find((r) => r.name === 'A');
  const b = standings.find((r) => r.name === 'B');
  assert.equal(a.tieResolved, true);
  assert.equal(b.tieResolved, true);

  const bIndex = standings.findIndex((r) => r.name === 'B');
  const aIndex = standings.findIndex((r) => r.name === 'A');
  assert.ok(bIndex < aIndex, 'B should rank above A after winning the shootout');
});
