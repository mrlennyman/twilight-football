const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp } = require('./helpers/harness');

let h;
let id;
test.before(async () => {
  h = await startApp();
  await h.login();
  id = await h.createScheduledLeague({ name: 'Kids' });
  // finish the group stage: the higher team id always wins, so the table is strict
  const all = h.db.prepare('SELECT m.id, m.home_team_id AS hh, m.away_team_id AS aa FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?').all(id);
  for (const m of all) {
    await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: m.hh > m.aa ? '2' : '0', away_score: m.hh > m.aa ? '0' : '2' });
  }
  await h.request('POST', `/admin/league/${id}/generate-knockouts`);
});
test.after(() => h.close());

const groupMatch = () => h.db.prepare("SELECT m.*, r.id AS rid FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = 'group' ORDER BY m.id LIMIT 1").get(id);
const slot = (stage, name) => h.db.prepare('SELECT m.* FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = ? AND m.bracket_slot = ?').get(id, stage, name);
const ko = (m, form) => h.request('POST', `/admin/league/${id}/knockout-results/match/${m.id}`, form);

test('B2: once the brackets exist, every way of editing a group result is refused', async () => {
  const m = groupMatch();
  const before = { ...h.db.prepare('SELECT home_score, away_score, status FROM matches WHERE id = ?').get(m.id) };

  const single = await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: '9', away_score: '9' });
  const round = await h.request('POST', `/admin/league/${id}/results/round/${m.rid}`, { [`home_${m.id}`]: '9', [`away_${m.id}`]: '9' });
  const clear = await h.request('POST', `/admin/league/${id}/results/round/${m.rid}`, { clear: String(m.id) });
  const tie = await h.request('POST', `/admin/league/${id}/tie-break`, { team_a_id: '1', team_b_id: '2', winner_team_id: '1' });
  for (const res of [single, round, clear, tie]) {
    assert.equal(res.status, 400);
    assert.match(res.text, /Group results are locked/);
  }
  assert.deepEqual({ ...h.db.prepare('SELECT home_score, away_score, status FROM matches WHERE id = ?').get(m.id) }, before);

  const page = await h.request('GET', `/admin/league/${id}/results?week=1`);
  assert.match(page.text, /Group results are <strong>locked/);
  assert.doesNotMatch(page.text, /class="save-round"/, 'no Save round buttons while locked');
});

test('B3: a semi-final cannot be edited once its final is played', async () => {
  const semi1 = slot('cup', 'semi_1');
  const semi2 = slot('cup', 'semi_2');
  await ko(semi1, { home_score: '2', away_score: '0' });
  await ko(semi2, { home_score: '2', away_score: '0' });
  const final = slot('cup', 'final');
  await ko(final, { home_score: '1', away_score: '0' });

  const blocked = await ko(semi1, { home_score: '0', away_score: '5' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.text, /Clear the final first/);
  assert.equal(slot('cup', 'semi_1').home_score, 2, 'semi untouched');

  // the other bracket is unaffected
  const plateSemi = slot('plate', 'semi_1');
  assert.equal((await ko(plateSemi, { home_score: '1', away_score: '0' })).status, 302);

  // once the final is cleared, the semi can be corrected and the final re-fills
  await h.request('POST', `/admin/league/${id}/knockout-results/match/${final.id}/clear`);
  assert.equal((await ko(semi1, { home_score: '0', away_score: '3' })).status, 302);
  assert.equal(slot('cup', 'final').home_team_id, semi1.away_team_id);
});

test('B2: reset needs the league name, saves a backup, removes the brackets and unlocks group results', async () => {
  const wrong = await h.request('POST', `/admin/league/${id}/knockouts/reset`, { confirm_name: 'nope' });
  assert.equal(wrong.status, 400);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).c, 4);

  const ok = await h.request('POST', `/admin/league/${id}/knockouts/reset`, { confirm_name: 'Kids' });
  assert.equal(ok.status, 302);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).c, 0);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage != 'group'").get(id).c, 0);
  assert.equal(h.db.prepare('SELECT status FROM leagues WHERE id = ?').get(id).status, 'in_progress');
  assert.ok(fs.readdirSync(path.join(h.dir, 'backups')).some((f) => f.includes('pre-reset-knockouts')));
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND r.stage = 'group' AND m.status = 'played'").get(id).c, 56, 'group results kept');

  // now a group score can be corrected, and the brackets drawn again
  const m = groupMatch();
  const edit = await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: m.home_team_id > m.away_team_id ? '4' : '0', away_score: m.home_team_id > m.away_team_id ? '0' : '4' });
  assert.equal(edit.status, 302);
  await h.request('POST', `/admin/league/${id}/generate-knockouts`);
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).c, 4);
});
