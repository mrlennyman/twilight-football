const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
});
test.after(() => h.close());

test('B5: creating, importing and generating refuse too few pitches', async () => {
  const create = await h.request('POST', '/admin/leagues', { name: 'X', season: 'S', num_teams: '8', num_pitches: '3', rounds_per_week: '3' });
  assert.equal(create.status, 400);
  assert.match(create.text, /needs at least 4 pitches/);

  const csv = Array.from({ length: 8 }, (_, i) => `Team ${i + 1},Player ${i}`).join('\n');
  const imp = await h.request('POST', '/admin/import', { name: 'X', season: 'S', num_pitches: '2', rounds_per_week: '3', csv });
  assert.equal(imp.status, 400);
  assert.match(imp.text, /needs at least 4 pitches/);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM leagues').get().c, 0);

  // A league that already exists with too few pitches (made before this rule) cannot generate either.
  h.db.exec("INSERT INTO leagues (name, season, num_teams, num_pitches) VALUES ('Old', 'S', 8, 3)");
  for (let t = 1; t <= 8; t++) h.db.prepare('INSERT INTO teams (league_id, name) VALUES (1, ?)').run(`T${t}`);
  const gen = await h.request('POST', '/admin/league/1/schedule/generate', { start_date: '2026-10-14', kickoff_start_time: '17:00', slot_minutes: '15' });
  assert.equal(gen.status, 400);
  assert.match(gen.text, /needs at least 4 pitches/);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM rounds').get().c, 0);
});
