const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { parsePlayerList, parseBlocks, planRosterImport, applyRosterImport } = require('../src/lib/rosterText');
const { parseRosterCsv } = require('../src/lib/rosterImport');
const { startApp } = require('./helpers/harness');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

function leagueWith(teamNames, rosters = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', 'S')").run();
  teamNames.forEach((name, i) => {
    db.prepare('INSERT INTO teams (id, league_id, name) VALUES (?, 1, ?)').run(i + 1, name);
    for (const p of rosters[name] || []) db.prepare('INSERT INTO players (team_id, name) VALUES (?, ?)').run(i + 1, p);
  });
  return db;
}
const rosterOf = (db, id) => db.prepare('SELECT name FROM players WHERE team_id = ? ORDER BY name').all(id).map((p) => p.name);
const teamName = (db, id) => db.prepare('SELECT name FROM teams WHERE id = ?').get(id).name;

// ---------- parsing
test('parsePlayerList: one per line, list markers and blanks removed, spaces tidied', () => {
  const text = '1. Jack Brown\n2) Mia   Chen\n\n- Sam Lee\n• Te Rangi H.\n  12 Ana Ngata  \n';
  assert.deepEqual(parsePlayerList(text).names, ['Jack Brown', 'Mia Chen', 'Sam Lee', 'Te Rangi H.', 'Ana Ngata']);
  assert.deepEqual(parsePlayerList('Jack\r\nMia\r\n').names, ['Jack', 'Mia']);
  assert.deepEqual(parsePlayerList('').names, []);
});

test('parsePlayerList: a single line of names split by commas/semicolons/tabs becomes a list', () => {
  assert.deepEqual(parsePlayerList('Jack B, Mia C; Sam L').names, ['Jack B', 'Mia C', 'Sam L']);
  assert.deepEqual(parsePlayerList('Jack B\tMia C').names, ['Jack B', 'Mia C']);
  assert.deepEqual(parsePlayerList('Jack B\nMia C, Sam L').names, ['Jack B', 'Mia C, Sam L'], 'several lines: each line is a name');
});

test('parsePlayerList: limits', () => {
  assert.equal(parsePlayerList('x'.repeat(61)).errors.length, 1);
  assert.equal(parsePlayerList(Array.from({ length: 41 }, (_, i) => `P${i}`).join('\n')).errors.length, 1);
  assert.deepEqual(parsePlayerList(Array.from({ length: 40 }, (_, i) => `P${i}`).join('\n')).errors, []);
});

test('parseBlocks: team name then players, blank line between teams (CRLF, colons, merged duplicates)', () => {
  const { errors, teams } = parseBlocks('Rovers:\r\nJack Brown\r\nSam Lee\r\n\r\n\r\nWanderers\r\n1. Mia Chen\r\nSmith, John\r\n\r\nrovers\r\nAna Ngata\r\n');
  assert.deepEqual(errors, []);
  assert.deepEqual(teams.map((t) => [t.name, t.players]), [
    ['Rovers', ['Jack Brown', 'Sam Lee', 'Ana Ngata']],
    ['Wanderers', ['Mia Chen', 'Smith, John']],
  ]);
  assert.equal(parseBlocks('   \n\n').errors.length, 1);
  assert.equal(parseBlocks(`${'T'.repeat(61)}\nJack`).errors.length, 1);
});

// ---------- planning and applying
test('plan: matches teams by name (any case), otherwise takes the next "Team N" in order', () => {
  const db = leagueWith(['Team 1', 'Team 2', 'Rovers', 'Team 4']);
  const { errors, items } = planRosterImport(db, 1, [
    { name: 'rovers', kit: 'Red', players: ['Jack B'] },
    { name: 'Wanderers', kit: '', players: ['Mia C'] },
    { name: 'United', kit: '', players: [] },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((i) => [i.newName, i.action, i.teamId]), [['rovers', 'update', 3], ['Wanderers', 'rename', 1], ['United', 'rename', 2]]);
});

test('plan: more pasted teams than free teams is refused with a clear reason', () => {
  const db = leagueWith(['Rovers', 'Team 2']);
  const { errors } = planRosterImport(db, 1, [
    { name: 'A', kit: '', players: [] }, { name: 'B', kit: '', players: [] },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"B" has no team to go in/);
});

test('plan/apply: add mode keeps existing players and skips ones already there; replace mode swaps the roster', () => {
  const db = leagueWith(['Rovers', 'Team 2'], { Rovers: ['Jack Brown', 'Sam Lee'] });
  const pasted = [{ name: 'Rovers', kit: 'Red', players: ['jack brown', 'Mia Chen', 'Mia Chen'] }];

  const add = planRosterImport(db, 1, pasted);
  assert.deepEqual([add.items[0].adds, add.items[0].skipped, add.items[0].keeps], [['Mia Chen'], 2, 2]);
  applyRosterImport(db, add);
  assert.deepEqual(rosterOf(db, 1), ['Jack Brown', 'Mia Chen', 'Sam Lee']);
  assert.equal(db.prepare('SELECT kit_colour FROM teams WHERE id = 1').get().kit_colour, 'Red');

  const replace = planRosterImport(db, 1, [{ name: 'Rovers', kit: '', players: ['Ana Ngata'] }], { replace: true });
  assert.equal(replace.items[0].removed, 3);
  applyRosterImport(db, replace);
  assert.deepEqual(rosterOf(db, 1), ['Ana Ngata']);
  assert.equal(db.prepare('SELECT kit_colour FROM teams WHERE id = 1').get().kit_colour, 'Red', 'a blank kit leaves the old one');
});

test('plan: a team that would end up with more than 40 players is refused', () => {
  const db = leagueWith(['Rovers'], { Rovers: Array.from({ length: 30 }, (_, i) => `Old ${i}`) });
  const { errors } = planRosterImport(db, 1, [{ name: 'Rovers', kit: '', players: Array.from({ length: 15 }, (_, i) => `New ${i}`) }]);
  assert.match(errors[0], /45 players/);
});

test('parseRosterCsv with checkTeamCount off accepts any number of teams (existing-league paste)', () => {
  assert.equal(parseRosterCsv('A,x\nB,y\nC,z', { checkTeamCount: false }).errors.length, 0);
  assert.equal(parseRosterCsv('A,x\nB,y\nC,z').errors.length, 1, 'a brand-new league still needs an even count');
});

// ---------- in the real app
let h;
test.before(async () => {
  h = await startApp();
  await h.login();
  await h.request('POST', '/admin/leagues', { name: 'Kids', season: 'S', num_teams: '4', num_pitches: '2', rounds_per_week: '3' });
  await h.request('POST', '/admin/leagues', { name: 'Other', season: 'S', num_teams: '4', num_pitches: '2', rounds_per_week: '3' });
});
test.after(() => h.close());
const roster = (id) => rosterOf(h.db, id);
const backups = () => (fs.existsSync(path.join(h.dir, 'backups')) ? fs.readdirSync(path.join(h.dir, 'backups')) : []);

test('one team: a pasted list saves the whole roster in one Save, name and kit too', async () => {
  const res = await h.request('POST', '/admin/league/1/teams/1', { name: 'Rovers', kit_colour: 'Red', players: '1. Jack Brown\n2. Mia Chen\n\nTe Rangi H.' });
  assert.equal(res.status, 302);
  assert.deepEqual(roster(1), ['Jack Brown', 'Mia Chen', 'Te Rangi H.']);
  assert.equal(teamName(h.db, 1), 'Rovers');

  const page = await h.request('GET', '/admin/league/1/teams');
  assert.match(page.text, /<textarea name="players"[^>]*>Jack Brown\nMia Chen\nTe Rangi H\.<\/textarea>/);
  assert.match(page.text, /Paste all teams at once/);

  // saving a shorter list removes the others; saving an empty box clears the roster
  await h.request('POST', '/admin/league/1/teams/1', { name: 'Rovers', kit_colour: 'Red', players: 'Jack Brown' });
  assert.deepEqual(roster(1), ['Jack Brown']);
  await h.request('POST', '/admin/league/1/teams/1', { name: 'Rovers', kit_colour: 'Red', players: '' });
  assert.deepEqual(roster(1), []);
});

test('one team: bad input saves nothing; another league\'s team is untouchable', async () => {
  await h.request('POST', '/admin/league/1/teams/1', { name: 'Rovers', kit_colour: '', players: 'Keep Me' });
  const tooLong = await h.request('POST', '/admin/league/1/teams/1', { name: 'Changed', kit_colour: '', players: 'x'.repeat(70) });
  assert.equal(tooLong.status, 400);
  assert.equal(teamName(h.db, 1), 'Rovers');
  assert.deepEqual(roster(1), ['Keep Me']);

  const otherTeam = h.db.prepare('SELECT id FROM teams WHERE league_id = 2 LIMIT 1').get().id;
  const before = teamName(h.db, otherTeam);
  const res = await h.request('POST', `/admin/league/1/teams/${otherTeam}`, { name: 'Hacked', kit_colour: '', players: 'Evil' });
  assert.equal(res.status, 404);
  assert.equal(teamName(h.db, otherTeam), before);
  assert.deepEqual(roster(otherTeam), []);

  // a form without the players box (old style) leaves the roster alone
  await h.request('POST', '/admin/league/1/teams/1', { name: 'Rovers', kit_colour: '' });
  assert.deepEqual(roster(1), ['Keep Me']);
});

test('paste all teams: preview changes nothing, confirm applies it (blocks format)', async () => {
  const text = 'Wanderers\nMia Chen\nSam Lee\n\nUnited\nAna Ngata\nTe Rangi H.\n\nCity\nLiam Walker';
  const preview = await h.request('POST', '/admin/league/1/roster-import/preview', { format: 'blocks', text });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Check this, then apply/);
  assert.match(preview.text, /Wanderers<\/strong>[\s\S]*?renames Team 2/);
  assert.match(preview.text, /Apply these changes/);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM teams WHERE league_id = 1 AND name = 'Wanderers'").get().c, 0, 'preview changes nothing');

  const before = backups().length;
  const ok = await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'blocks', text });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, '/admin/league/1/teams');
  const names = h.db.prepare('SELECT id, name FROM teams WHERE league_id = 1 ORDER BY id').all().map((t) => t.name);
  assert.deepEqual(names, ['Rovers', 'Wanderers', 'United', 'City']);
  assert.deepEqual(roster(2), ['Mia Chen', 'Sam Lee']);
  assert.deepEqual(roster(3), ['Ana Ngata', 'Te Rangi H.']);
  assert.deepEqual(roster(4), ['Liam Walker']);
  assert.ok(backups().length > before && backups().some((f) => f.includes('pre-roster-import')), 'safety copy taken');
});

test('paste all teams: spreadsheet format with kit colours; add mode skips duplicates, replace mode swaps', async () => {
  const tsv = 'Rovers\tKeep Me\tBlue\nRovers\tNew Kid\nWanderers\tMia Chen';
  const add = await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'csv', text: tsv });
  assert.equal(add.status, 302);
  assert.deepEqual(roster(1), ['Keep Me', 'New Kid']);
  assert.deepEqual(roster(2), ['Mia Chen', 'Sam Lee'], 'Mia was already there');
  assert.equal(h.db.prepare('SELECT kit_colour FROM teams WHERE id = 1').get().kit_colour, 'Blue');

  const replace = await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'csv', text: 'Rovers,Only One', replace: 'on' });
  assert.equal(replace.status, 302);
  assert.deepEqual(roster(1), ['Only One']);
  assert.deepEqual(roster(2), ['Mia Chen', 'Sam Lee'], 'teams not in the paste are untouched');
});

test('paste all teams: problems show a message and change nothing; wrong league is 404', async () => {
  const names = () => h.db.prepare('SELECT name FROM teams WHERE league_id = 1 ORDER BY id').all().map((t) => t.name).join('|');
  const before = names();
  const tooMany = await h.request('POST', '/admin/league/1/roster-import/preview', { format: 'blocks', text: 'A\n\nB\n\nC\n\nD\n\nE' });
  assert.equal(tooMany.status, 200);
  assert.match(tooMany.text, /Nothing was changed/);
  assert.match(tooMany.text, /has no team to go in/);
  assert.doesNotMatch(tooMany.text, /Apply these changes/);
  assert.match(tooMany.text, />A\n\nB\n\nC/, 'what you pasted is kept so you can fix it');

  const confirmBad = await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'blocks', text: 'A\n\nB\n\nC\n\nD\n\nE' });
  assert.equal(confirmBad.status, 200);
  assert.match(confirmBad.text, /Nothing was changed/);
  const empty = await h.request('POST', '/admin/league/1/roster-import/preview', { format: 'csv', text: '   ' });
  assert.match(empty.text, /Nothing to import|empty/i);
  assert.equal(names(), before);

  assert.equal((await h.request('GET', '/admin/league/999/roster-import')).status, 404);
  assert.equal((await h.request('POST', '/admin/league/999/roster-import/confirm', { format: 'csv', text: 'A,b' })).status, 404);
  assert.equal((await h.request('GET', '/admin/league/1/roster-import')).status, 200);
});

test('public Teams page still shows first name + last initial only after a paste', async () => {
  await h.request('POST', '/admin/league/1/roster-import/confirm', { format: 'blocks', text: 'Rovers\nJack Brown\nTe Rangi H.\nMia Chen' });
  h.db.exec("UPDATE leagues SET status = 'in_progress'");
  const page = await h.request('GET', '/league/1/teams');
  assert.match(page.text, /Jack B\./);
  assert.match(page.text, /Te Rangi H\./);
  assert.doesNotMatch(page.text, /Jack Brown|Mia Chen/);
});
