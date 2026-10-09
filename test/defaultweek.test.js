const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getDefaultWeek, todayNZ } = require('../src/lib/queries');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', 'S'), (2, 'Empty', 'S')").run();
  // five Wednesdays from 14 Oct, 3 rounds a night
  const insert = db.prepare("INSERT INTO rounds (league_id, round_number, week_number, stage, date) VALUES (1, ?, ?, 'group', ?)");
  const dates = ['2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04', '2026-11-11'];
  let n = 0;
  dates.forEach((d, w) => { for (let i = 0; i < 3; i++) insert.run(++n, w + 1, d); });
  return db;
}

test('A4: opens on tonight\'s match night, or the next one coming up', () => {
  const db = makeDb();
  assert.equal(getDefaultWeek(db, 1, '2026-10-09'), 1, 'before the season: week 1');
  assert.equal(getDefaultWeek(db, 1, '2026-10-14'), 1, 'on the night itself');
  assert.equal(getDefaultWeek(db, 1, '2026-10-15'), 2, 'the day after: the next night');
  assert.equal(getDefaultWeek(db, 1, '2026-10-28'), 3);
  assert.equal(getDefaultWeek(db, 1, '2026-11-05'), 5);
});

test('A4: after the last night the last week stays open; a league with no rounds has no week', () => {
  const db = makeDb();
  assert.equal(getDefaultWeek(db, 1, '2027-02-01'), 5);
  assert.equal(getDefaultWeek(db, 2, '2026-10-14'), null);
});

test('A4: a forgotten score never pins the page to an old week (date decides, not results)', () => {
  const db = makeDb();
  db.prepare("INSERT INTO teams (id, league_id, name) VALUES (1, 1, 'A'), (2, 1, 'B')").run();
  db.prepare("INSERT INTO matches (round_id, home_team_id, away_team_id, status) SELECT id, 1, 2, 'scheduled' FROM rounds WHERE week_number = 1").run();
  assert.equal(getDefaultWeek(db, 1, '2026-11-04'), 4);
});

test('todayNZ gives the New Zealand calendar date, not the server\'s', () => {
  assert.equal(todayNZ(new Date('2026-10-14T05:00:00Z')), '2026-10-14'); // 6pm NZDT same day
  assert.equal(todayNZ(new Date('2026-10-14T12:30:00Z')), '2026-10-15'); // 1:30am NZDT next day
  assert.equal(todayNZ(new Date('2026-06-30T12:30:00Z')), '2026-07-01'); // winter time (NZST, UTC+12)
});
