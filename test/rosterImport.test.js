const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parseCsv, parseRosterCsv, createLeagueFromRoster, SAMPLE_CSV } = require('../src/lib/rosterImport');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  return db;
}

const eightTeams = (extra = '') =>
  Array.from({ length: 8 }, (_, i) => `Team ${i + 1},Player ${i + 1}`).join('\n') + extra;

test('parseCsv: quotes, escaped quotes, commas inside quotes, CRLF, BOM, blank lines', () => {
  const rows = parseCsv('﻿team,player\r\n"Rovers, FC","Jack ""JB"" Brown"\r\n\r\nWanderers,Mia\r\n');
  assert.deepEqual(rows, [
    ['team', 'player'],
    ['Rovers, FC', 'Jack "JB" Brown'],
    ['Wanderers', 'Mia'],
  ]);
});

test('parseCsv: semicolon and tab separated files (other spreadsheet locales)', () => {
  assert.deepEqual(parseCsv('team;player\nA;Sam'), [['team', 'player'], ['A', 'Sam']]);
  assert.deepEqual(parseCsv('team\tplayer\nA\tSam'), [['team', 'player'], ['A', 'Sam']]);
});

test('parseRosterCsv: groups rows by team (case-insensitive), keeps order, takes first kit', () => {
  const { errors, teams } = parseRosterCsv(
    'team,player,kit\nRovers,Jack Brown,Red\nWanderers,Mia Chen,Blue\nrovers,Sam  Lee,\nWanderers,,\n'
  );
  assert.deepEqual(teams, [
    { name: 'Rovers', kit: 'Red', players: ['Jack Brown', 'Sam Lee'] },
    { name: 'Wanderers', kit: 'Blue', players: ['Mia Chen'] },
  ]);
  assert.deepEqual(errors, []);
});

test('parseRosterCsv: header row is optional; team with no players is fine', () => {
  const noHeader = parseRosterCsv('A,Sam\nB,\n');
  assert.deepEqual(noHeader.errors, []);
  assert.deepEqual(noHeader.teams.map((t) => t.name), ['A', 'B']);
  assert.equal(noHeader.teams[1].players.length, 0);
});

test('parseRosterCsv: validation errors', () => {
  assert.match(parseRosterCsv('').errors[0], /empty/);
  assert.ok(parseRosterCsv('A,x\nB,y\nC,z\n').errors.some((e) => /even number/.test(e)), 'odd team count');
  assert.ok(parseRosterCsv('A,x\n,y\nB,z\n').errors.some((e) => /Row 2.*blank/.test(e)));
  assert.ok(parseRosterCsv(`A,${'x'.repeat(61)}\nB,y\n`).errors.some((e) => /Row 1.*player name/.test(e)));
  assert.ok(parseRosterCsv(`${'T'.repeat(61)},x\nB,y\n`).errors.some((e) => /team name is too long/.test(e)));
  const many = Array.from({ length: 41 }, (_, i) => `A,P${i}`).join('\n') + '\nB,y\n';
  assert.ok(parseRosterCsv(many).errors.some((e) => /41 players/.test(e)));
  const tooManyTeams = Array.from({ length: 34 }, (_, i) => `T${i},x`).join('\n');
  assert.ok(parseRosterCsv(tooManyTeams).errors.some((e) => /2 to 32/.test(e)));
});

test('the downloadable sample CSV is itself a valid 8-team import', () => {
  const { errors, teams } = parseRosterCsv(SAMPLE_CSV);
  assert.deepEqual(errors, []);
  assert.equal(teams.length, 8);
  assert.ok(teams.every((t) => t.players.length === 6 && t.kit));
});

test('hostile content is stored as plain text (views escape it)', () => {
  const { teams } = parseRosterCsv('<script>alert(1)</script>,<img src=x onerror=alert(1)>\nB,y\n');
  assert.equal(teams[0].name, '<script>alert(1)</script>');
});

test('createLeagueFromRoster builds league, teams, players, pitches and draft pages; delete cascades', () => {
  const db = makeDb();
  const { teams } = parseRosterCsv(eightTeams());
  const id = createLeagueFromRoster(db, { name: 'Adults Twilight', season: 'S', numPitches: 4, roundsPerWeek: 3 }, teams);

  const league = db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  assert.equal(league.name, 'Adults Twilight');
  assert.equal(league.num_teams, 8);
  assert.equal(league.status, 'setup');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams WHERE league_id = ?').get(id).c, 8);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM players').get().c, 8);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pitches').get().c, 4);
  assert.ok(db.prepare('SELECT COUNT(*) c FROM pages WHERE league_id = ?').get(id).c > 0);

  db.prepare('DELETE FROM leagues WHERE id = ?').run(id);
  for (const table of ['teams', 'players', 'pages']) {
    assert.equal(db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c, 0, `${table} should cascade`);
  }
});

test('createLeagueFromRoster rolls back completely on failure', () => {
  const db = makeDb();
  const teams = [
    { name: 'A', kit: '', players: ['x'] },
    { name: null, kit: '', players: ['y'] }, // NOT NULL violation part-way through
  ];
  assert.throws(() => createLeagueFromRoster(db, { name: 'L', season: 'S', numPitches: 4, roundsPerWeek: 3 }, teams));
  assert.equal(db.prepare('SELECT COUNT(*) c FROM leagues').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM teams').get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM pitches').get().c, 0);
});
