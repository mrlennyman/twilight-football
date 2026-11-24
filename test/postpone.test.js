const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { startApp } = require('./helpers/harness');
const { scorerMayDo } = require('../src/lib/scorers');

let h;
let id;
test.before(async () => {
  h = await startApp();
  await h.login();
  id = await h.createScheduledLeague({ name: 'Rainy', teams: 8, pitches: 4 }); // 14 rounds, 3 a night from 2035-10-17
});
test.after(async () => {
  await h.close();
});

const rounds = () =>
  h.db.prepare("SELECT id, round_number, week_number, date, kickoff_time FROM rounds WHERE league_id = ? AND stage = 'group' ORDER BY round_number").all(id);
const nights = () => [...new Set(rounds().map((r) => r.date))].sort();

test('scorers cannot postpone a night', () => {
  assert.equal(scorerMayDo('GET', `/league/${id}/postpone`, id), false);
  assert.equal(scorerMayDo('POST', `/league/${id}/postpone`, id), false);
  assert.equal(scorerMayDo('POST', `/league/${id}/postpone/undo`, id), false);
});

test('postponing a night: preview changes nothing, apply squeezes rounds in, undo puts everything back', async () => {
  // Play the whole first night.
  const firstNight = nights()[0];
  const played = h.db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.date = ?').all(id, firstNight);
  for (const m of played) h.db.prepare("UPDATE matches SET home_score = 2, away_score = 1, status = 'played' WHERE id = ?").run(m.id);

  const original = rounds();
  const matchCount = () => h.db.prepare('SELECT COUNT(*) AS c FROM matches').get().c;
  const originalMatches = matchCount();
  const [, rainNight, ...later] = nights(); // 14 rounds over 5 nights: 3,3,3,3,2 - 3 a night after the rain leaves 2 that don't fit
  assert.equal(later.length, 3);

  // A night that already has results can't be postponed.
  const bad = await h.request('GET', `/admin/league/${id}/postpone?night=${firstNight}&per_night=4`);
  assert.match(bad.text, /Nothing was changed/);

  const preview = await h.request('GET', `/admin/league/${id}/postpone?night=${rainNight}&per_night=3`);
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Cancelled \(doesn't fit\): Round 13, Round 14/);
  assert.deepEqual(rounds(), original, 'preview changes nothing');

  const apply = await h.request('POST', `/admin/league/${id}/postpone`, { night: rainNight, per_night: '3' });
  assert.equal(apply.status, 302);
  assert.ok(fs.readdirSync(`${h.dir}/backups`).some((f) => f.startsWith('bream-bay-pre-postpone-')), 'safety copy saved');

  const after = rounds();
  assert.equal(after.length, 12, 'rounds 13 and 14 cancelled');
  assert.ok(!after.some((r) => r.date === rainNight), 'the rained-off night is gone');
  for (const [i, date] of later.entries()) {
    const on = after.filter((r) => r.date === date);
    assert.deepEqual(on.map((r) => r.round_number), [4 + i * 3, 5 + i * 3, 6 + i * 3]);
    assert.deepEqual(on.map((r) => r.kickoff_time), ['17:00', '17:15', '17:30']);
    assert.ok(on.every((r) => r.week_number === i + 2), 'weeks renumbered with no gap');
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS c FROM matches WHERE status = 'played'").get().c, played.length, 'results kept');

  const undo = await h.request('POST', `/admin/league/${id}/postpone/undo`, {});
  assert.equal(undo.status, 302);
  assert.deepEqual(rounds(), original, 'every round back where it was');
  assert.equal(matchCount(), originalMatches, 'cancelled matches back');
  const page = await h.request('GET', `/admin/league/${id}/postpone`);
  assert.doesNotMatch(page.text, /Undo the postponement/, 'nothing left to undo');
});
