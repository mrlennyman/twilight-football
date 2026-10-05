const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { tryFillFinal, matchWinner } = require('../src/lib/knockoutResult');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', '2026')").run();
  const team = db.prepare('INSERT INTO teams (league_id, name) VALUES (1, ?)');
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => Number(team.run(n).lastInsertRowid));
  const round = Number(
    db.prepare("INSERT INTO rounds (league_id, round_number, week_number, stage) VALUES (1, 1, 1, 'cup')").run()
      .lastInsertRowid
  );
  const match = db.prepare(
    'INSERT INTO matches (round_id, home_team_id, away_team_id, bracket_slot) VALUES (?, ?, ?, ?)'
  );
  const semi1 = Number(match.run(round, a, d, 'semi_1').lastInsertRowid);
  const semi2 = Number(match.run(round, b, c, 'semi_2').lastInsertRowid);
  const final = Number(match.run(round, null, null, 'final').lastInsertRowid);
  const play = (id, h, aw, pens = null) =>
    db
      .prepare("UPDATE matches SET home_score=?, away_score=?, penalty_winner_id=?, status='played' WHERE id=?")
      .run(h, aw, pens, id);
  const getFinal = () => db.prepare('SELECT * FROM matches WHERE id = ?').get(final);
  return { db, teams: { a, b, c, d }, semi1, semi2, final, play, getFinal };
}

test('final is filled once both semis are played, using shootout winners for draws', () => {
  const { db, teams, semi1, semi2, play, getFinal } = setup();
  play(semi1, 2, 2, teams.d); // A v D drawn, D wins on pens
  tryFillFinal(db, 1, 'cup');
  assert.equal(getFinal().home_team_id, null, 'not filled until both semis are done');

  play(semi2, 3, 1); // B beats C
  tryFillFinal(db, 1, 'cup');
  assert.equal(getFinal().home_team_id, teams.d);
  assert.equal(getFinal().away_team_id, teams.b);
});

test('correcting a semi-final result updates the final until the final is played', () => {
  const { db, teams, semi1, semi2, final, play, getFinal } = setup();
  play(semi1, 1, 0);
  play(semi2, 2, 0);
  tryFillFinal(db, 1, 'cup');
  assert.equal(getFinal().home_team_id, teams.a);

  play(semi1, 0, 1); // typo fixed: D actually won
  tryFillFinal(db, 1, 'cup');
  assert.equal(getFinal().home_team_id, teams.d, 'correction flows into the final');

  play(final, 1, 0);
  play(semi1, 3, 0); // changing a semi after the final is played must not rewrite it
  tryFillFinal(db, 1, 'cup');
  assert.equal(getFinal().home_team_id, teams.d);
});

test('matchWinner ignores unplayed matches', () => {
  assert.equal(matchWinner({ status: 'scheduled', home_team_id: 1, away_team_id: 2 }), null);
});
