const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
});
test.after(async () => {
  await h.close();
});

const anonymous = (url) => fetch(h.base + url, { redirect: 'manual' });

test('creating the example league needs a login', async () => {
  const res = await h.request('POST', '/admin/demo-league');
  assert.equal(res.status, 302);
  assert.match(res.location, /\/admin\/login/);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, 0);
});

test('the example league is played all the way through and hidden from the public', async () => {
  await h.login();
  const res = await h.request('POST', '/admin/demo-league');
  assert.equal(res.status, 302);
  const id = Number(res.location.match(/league\/(\d+)\/bracket/)[1]);

  const league = h.db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
  assert.equal(league.hidden, 1);
  assert.equal(league.status, 'complete');
  assert.equal(league.finals_format, 'three_rr');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM teams WHERE league_id = ?').get(id).n, 12);

  const counts = h.db
    .prepare(
      `SELECT r.stage, m.bracket_slot AS slot, COUNT(*) AS total, SUM(CASE WHEN m.status = 'played' THEN 1 ELSE 0 END) AS played
       FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? GROUP BY r.stage, m.bracket_slot`
    )
    .all(id);
  assert.ok(counts.every((c) => c.total === c.played), 'every match has a result');
  const total = (stage, slot) => counts.filter((c) => c.stage === stage && (slot === undefined || c.slot === slot)).reduce((n, c) => n + c.total, 0);
  assert.equal(total('group'), 108);
  for (const stage of ['cup', 'plate', 'bowl']) {
    assert.equal(total(stage, 'rr'), 6, `${stage} round robin`);
    assert.equal(total(stage, 'semi_1') + total(stage, 'semi_2'), 2);
    assert.equal(total(stage, 'final'), 1);
  }
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM matches WHERE penalty_winner_id IS NOT NULL").get().n, 1, 'one final goes to a shootout');

  // everything happened in the past
  const latest = h.db.prepare('SELECT MAX(date) AS d FROM rounds WHERE league_id = ?').get(id).d;
  assert.ok(latest < new Date().toISOString().slice(0, 10), `last finals night ${latest} is past`);

  // hidden from the public everywhere, visible to the logged-in admin
  for (const url of [`/league/${id}`, `/league/${id}/bracket`, `/league/${id}/fixtures`, `/league/${id}/teams`]) {
    assert.equal((await anonymous(url)).status, 404, `${url} is not public`);
    assert.equal((await h.request('GET', url)).status, 200, `${url} works for the admin`);
  }
  assert.doesNotMatch(await (await anonymous('/leagues')).text(), /Example: Cup/);
  assert.match((await h.request('GET', '/admin')).text, /Example: Cup, Plate &amp; Bowl finals \(demo\)/);
  assert.match((await h.request('GET', '/admin')).text, /hidden/);

  // the finals page shows the tabs and the finished knockouts
  const cup = (await h.request('GET', `/league/${id}/bracket`)).text;
  assert.match(cup, /class="week-tabs finals-tabs"/);
  assert.match(cup, /<h3>Knockout<\/h3>/);
  assert.match(cup, /Grand Final|Final/);
  const bowl = (await h.request('GET', `/league/${id}/bracket?group=bowl`)).text;
  assert.match(bowl, /won on pens/);

  // doing it again opens the same league instead of making another
  const again = await h.request('POST', '/admin/demo-league');
  assert.equal(again.location, res.location);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, 1);
});

test('the example can be deleted like any other league', async () => {
  const id = h.db.prepare('SELECT id FROM leagues').get().id;
  const del = await h.request('POST', `/admin/league/${id}/delete`, { confirm_name: 'Example: Cup, Plate & Bowl finals (demo)' });
  assert.equal(del.status, 302);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM leagues').get().n, 0);
});
