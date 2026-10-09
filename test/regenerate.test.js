const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
});
test.after(() => h.close());

const playedCount = () => h.db.prepare("SELECT COUNT(*) c FROM matches WHERE status = 'played'").get().c;
const backups = () => (fs.existsSync(path.join(h.dir, 'backups')) ? fs.readdirSync(path.join(h.dir, 'backups')) : []);
const regenForm = (extra = {}) => ({ start_date: '2026-10-21', kickoff_start_time: '17:00', slot_minutes: '15', ...extra });

test('first-time generate needs no confirmation and makes no backup', async () => {
  const id = await h.createScheduledLeague();
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM matches').get().c, 56);
  assert.equal(backups().length, 0);
  h.leagueId = id;
});

test('regenerating with no results needs no name, but still takes a safety copy', async () => {
  const res = await h.request('POST', `/admin/league/${h.leagueId}/schedule/generate`, regenForm());
  assert.equal(res.status, 302);
  assert.equal(backups().filter((f) => f.includes('pre-regenerate')).length, 1);
});

test('regenerating a league with results is refused without the league name, and changes nothing', async () => {
  const matches = h.db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id LIMIT 5').all(h.leagueId);
  for (const m of matches) {
    const r = await h.request('POST', `/admin/league/${h.leagueId}/results/match/${m.id}`, { home_score: '2', away_score: '1' });
    assert.equal(r.status, 302);
  }
  assert.equal(playedCount(), 5);
  const before = backups().length;

  for (const form of [regenForm(), regenForm({ confirm_name: 'wrong name' }), regenForm({ confirm_name: '' })]) {
    const res = await h.request('POST', `/admin/league/${h.leagueId}/schedule/generate`, form);
    assert.equal(res.status, 400);
    assert.match(res.text, /delete 5 results/);
  }
  assert.equal(playedCount(), 5, 'results untouched');
  assert.equal(h.db.prepare('SELECT start_date FROM leagues WHERE id = ?').get(h.leagueId).start_date, '2026-10-21');
  assert.equal(backups().length, before, 'no backup when nothing happened');
});

test('with the right name it regenerates and a pre-regenerate backup holds the old results', async () => {
  const res = await h.request('POST', `/admin/league/${h.leagueId}/schedule/generate`, regenForm({ confirm_name: 'Kids Twilight' }));
  assert.equal(res.status, 302);
  assert.equal(playedCount(), 0);
  const files = backups().filter((f) => f.includes('pre-regenerate'));
  assert.ok(files.length >= 1);
  const { DatabaseSync } = require('node:sqlite');
  const newest = files.sort().pop();
  const copy = new DatabaseSync(path.join(h.dir, 'backups', newest));
  assert.equal(copy.prepare("SELECT COUNT(*) c FROM matches WHERE status = 'played'").get().c, 5);
  copy.close();
});

test('deleting a league takes a safety copy first and needs the typed name', async () => {
  const wrong = await h.request('POST', `/admin/league/${h.leagueId}/delete`, { confirm_name: 'nope' });
  assert.equal(wrong.status, 400);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM leagues').get().c, 1);
  const ok = await h.request('POST', `/admin/league/${h.leagueId}/delete`, { confirm_name: 'Kids Twilight' });
  assert.equal(ok.status, 302);
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM leagues').get().c, 0);
  assert.ok(backups().some((f) => f.includes('pre-delete')));
});
