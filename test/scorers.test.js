const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, scorerMayDo } = require('../src/lib/scorers');
const { startApp } = require('./helpers/harness');

test('passwords are stored as salted hashes and checked properly', () => {
  const a = hashPassword('goal-keeper-1');
  const b = hashPassword('goal-keeper-1');
  assert.notEqual(a, b, 'a fresh salt every time');
  assert.doesNotMatch(a, /goal-keeper/);
  assert.equal(verifyPassword('goal-keeper-1', a), true);
  assert.equal(verifyPassword('goal-keeper-2', a), false);
  assert.equal(verifyPassword('x', 'garbage'), false);
});

test('a scorer may only enter scores for their own league', () => {
  assert.equal(scorerMayDo('GET', '/league/3/results', 3), true);
  assert.equal(scorerMayDo('POST', '/league/3/results/match/9', 3), true);
  assert.equal(scorerMayDo('POST', '/league/3/results/round/9', 3), true);
  assert.equal(scorerMayDo('POST', '/league/3/knockout-results/match/9', 3), true);
  assert.equal(scorerMayDo('POST', '/league/3/knockout-results/match/9/clear', 3), true);
  assert.equal(scorerMayDo('POST', '/logout', 3), true);
  for (const [method, path] of [
    ['GET', '/league/4/results'],
    ['POST', '/league/4/results/match/9'],
    ['GET', '/league/3/teams'],
    ['GET', '/league/3/schedule'],
    ['POST', '/league/3/schedule/generate'],
    ['POST', '/league/3/generate-knockouts'],
    ['POST', '/league/3/knockouts/reset'],
    ['POST', '/league/3/tie-break'],
    ['POST', '/league/3/delete'],
    ['GET', '/league/3/log'],
    ['GET', '/scorers'],
    ['POST', '/scorers'],
    ['GET', '/diagnostics'],
    ['GET', '/import'],
    ['POST', '/leagues'],
    ['GET', '/league/3/results/../delete'],
  ]) {
    assert.equal(scorerMayDo(method, path, 3), false, `${method} ${path}`);
  }
});

let h;
let adults; // the league the scorer works on
let kids;
test.before(async () => {
  h = await startApp();
  await h.login();
  adults = await h.createScheduledLeague({ name: 'Adults', teams: 8, pitches: 4 });
  kids = await h.createScheduledLeague({ name: 'Kids', teams: 8, pitches: 4 });
});
test.after(async () => {
  await h.close();
});

/** A separate browser session (its own cookie) so the admin and the scorer don't share a login. */
function browser() {
  let cookie = '';
  return async function request(method, url, form) {
    const res = await fetch(h.base + url, {
      method,
      redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
}

test('the admin adds a scorer, with validation', async () => {
  const page = await h.request('GET', '/admin/scorers');
  assert.equal(page.status, 200);
  assert.match(page.text, /Add a scorer/);
  assert.match((await h.request('GET', '/admin')).text, /href="\/admin\/scorers"/);

  const bad = await h.request('POST', '/admin/scorers', { name: 'S', password: 'short', league_id: String(adults) });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /The name must be 2 to 30 characters/);
  assert.match(bad.text, /at least 8 characters/);
  assert.equal((await h.request('POST', '/admin/scorers', { name: 'Sam', password: 'longenough1', league_id: '9999' })).status, 400);

  const ok = await h.request('POST', '/admin/scorers', { name: 'Sam', password: 'sideline-1', league_id: String(adults) });
  assert.equal(ok.status, 302);
  const row = h.db.prepare('SELECT * FROM scorers WHERE name = ?').get('Sam');
  assert.equal(row.league_id, adults);
  assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes('sideline'));
  assert.match((await h.request('GET', '/admin/scorers')).text, /Sam/);
  assert.equal((await h.request('POST', '/admin/scorers', { name: 'sam', password: 'another-one1', league_id: String(adults) })).status, 400, 'names are unique, ignoring case');
});

test('a scorer logs in with a name and password, and lands on their league results', async () => {
  const b = browser();
  const wrong = await b('POST', '/admin/login', { name: 'Sam', password: 'not-the-password' });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /Incorrect name or password/);
  assert.equal((await b('POST', '/admin/login', { name: 'Nobody', password: 'sideline-1' })).status, 401);
  // the scorer's password is not the main admin password, and the main password with a name does not work
  assert.equal((await b('POST', '/admin/login', { name: 'Sam', password: 'Goal-Keeper-Test-2026' })).status, 401);

  const ok = await b('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' });
  assert.equal(ok.status, 302);
  assert.equal(ok.location, `/admin/league/${adults}/results`);
  const results = await b('GET', `/admin/league/${adults}/results`);
  assert.equal(results.status, 200);
  assert.match(results.text, /Adults/);
  assert.equal((await b('GET', '/admin')).location, `/admin/league/${adults}/results`, 'the dashboard is only a doorway');
  // a scorer can always log out: the button is on their results page and on the "not allowed" page
  assert.match(results.text, /action="\/admin\/logout"[\s\S]*?Signed in as Sam[\s\S]*?Log out/);
  assert.doesNotMatch(results.text, /&larr; Dashboard/);
  const refused = await b('GET', `/admin/league/${adults}/teams`);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Log out \(Sam\)/);
  const out = await b('POST', '/admin/logout');
  assert.equal(out.status, 302);
  assert.equal((await b('GET', `/admin/league/${adults}/results`)).status, 302, 'logged out after pressing the button');
  // and the main admin still sees the Dashboard link, not a scorer logout
  assert.match((await h.request('GET', `/admin/league/${adults}/results`)).text, /&larr; Dashboard/);
});

test('a scorer can enter and correct scores, and the log shows their name', async () => {
  const b = browser();
  await b('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' });
  const match = h.db.prepare('SELECT m.id, r.id AS rid FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id LIMIT 1').get(adults);

  assert.equal((await b('POST', `/admin/league/${adults}/results/match/${match.id}`, { home_score: '3', away_score: '1' })).status, 302);
  assert.equal(h.db.prepare('SELECT home_score, away_score, status FROM matches WHERE id = ?').get(match.id).status, 'played');
  assert.equal((await b('POST', `/admin/league/${adults}/results/match/${match.id}`, { home_score: '3', away_score: '2' })).status, 302);

  const round = h.db.prepare('SELECT m.id FROM matches m WHERE m.round_id = ? ORDER BY m.id').all(match.rid);
  const form = {};
  for (const m of round) {
    form[`home_${m.id}`] = '1';
    form[`away_${m.id}`] = '0';
  }
  assert.equal((await b('POST', `/admin/league/${adults}/results/round/${match.rid}`, form)).status, 302);

  const rows = h.db.prepare('SELECT by_name FROM result_log WHERE league_id = ?').all(adults);
  assert.ok(rows.length >= 3 && rows.every((r) => r.by_name === 'Sam'));
  // the admin's own change is logged as Admin, and the log page shows both
  const adminMatch = h.db.prepare('SELECT m.id FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? ORDER BY m.id DESC LIMIT 1').get(adults);
  await h.request('POST', `/admin/league/${adults}/results/match/${adminMatch.id}`, { home_score: '0', away_score: '0' });
  const log = (await h.request('GET', `/admin/league/${adults}/log`)).text;
  assert.match(log, /Sam \(/);
  assert.match(log, /Admin \(/);
});

test('a scorer is refused everything else', async () => {
  const b = browser();
  await b('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' });
  const forbidden = [
    ['GET', `/admin/league/${kids}/results`],
    ['GET', `/admin/league/${adults}/teams`],
    ['GET', `/admin/league/${adults}/schedule`],
    ['GET', `/admin/league/${adults}/finals-format`],
    ['GET', `/admin/league/${adults}/log`],
    ['GET', '/admin/scorers'],
    ['GET', '/admin/diagnostics'],
    ['GET', '/admin/usage'],
    ['GET', '/admin/import'],
    ['POST', `/admin/league/${adults}/schedule/generate`, { start_date: '2035-10-17', kickoff_start_time: '17:00', slot_minutes: '15', confirm_name: 'Adults' }],
    ['POST', `/admin/league/${adults}/knockouts/reset`, { confirm_name: 'Adults' }],
    ['POST', `/admin/league/${adults}/generate-knockouts`],
    ['POST', `/admin/league/${adults}/delete`, { confirm_name: 'Adults' }],
    ['POST', `/admin/league/${adults}/visibility`, { hidden: '1' }],
    ['POST', `/admin/league/${kids}/results/match/1`, { home_score: '5', away_score: '5' }],
    ['POST', '/admin/scorers', { name: 'Evil', password: 'eviller-pass', league_id: String(adults) }],
    ['POST', '/admin/leagues', { name: 'X', season: 'S', num_teams: '8', num_pitches: '4', rounds_per_week: '3' }],
  ];
  for (const [method, url, form] of forbidden) {
    const res = await b(method, url, form);
    assert.equal(res.status, 403, `${method} ${url}`);
  }
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM scorers').get().n, 1, 'no scorer was added');
  assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ? AND m.status = 'played'").get(kids).n, 0, 'the other league is untouched');
  assert.ok(h.db.prepare('SELECT 1 FROM leagues WHERE id = ?').get(adults), 'the league still exists');

  assert.equal((await b('POST', '/admin/logout')).status, 302);
  assert.equal((await b('GET', `/admin/league/${adults}/results`)).status, 302, 'logged out');
});

test('switching a scorer off, changing the password, and removing them', async () => {
  const sam = h.db.prepare('SELECT id FROM scorers').get().id;
  await h.request('POST', `/admin/scorers/${sam}/active`, { active: '0' });
  assert.equal((await browser()('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' })).status, 401, 'switched off');
  await h.request('POST', `/admin/scorers/${sam}/active`, { active: '1' });
  assert.equal((await browser()('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' })).status, 302);

  assert.equal((await h.request('POST', `/admin/scorers/${sam}/password`, { password: 'short' })).status, 400);
  await h.request('POST', `/admin/scorers/${sam}/password`, { password: 'new-sideline-2' });
  assert.equal((await browser()('POST', '/admin/login', { name: 'Sam', password: 'sideline-1' })).status, 401, 'old password no longer works');
  assert.equal((await browser()('POST', '/admin/login', { name: 'Sam', password: 'new-sideline-2' })).status, 302);

  // a scorer who is already logged in loses access the moment they are switched off or removed
  const live = browser();
  await live('POST', '/admin/login', { name: 'Sam', password: 'new-sideline-2' });
  assert.equal((await live('GET', `/admin/league/${adults}/results`)).status, 200);
  await h.request('POST', `/admin/scorers/${sam}/active`, { active: '0' });
  assert.equal((await live('GET', `/admin/league/${adults}/results`)).status, 302, 'switched off while logged in: out immediately');
  await h.request('POST', `/admin/scorers/${sam}/active`, { active: '1' });
  const live2 = browser();
  await live2('POST', '/admin/login', { name: 'Sam', password: 'new-sideline-2' });
  await h.request('POST', `/admin/scorers/${sam}/delete`);
  assert.equal((await live2('POST', `/admin/league/${adults}/results/match/1`, { home_score: '9', away_score: '9' })).status, 302, 'removed while logged in: refused');
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM scorers').get().n, 0);
  assert.equal((await browser()('POST', '/admin/login', { name: 'Sam', password: 'new-sideline-2' })).status, 401);
});

test('the main admin login still works exactly as before', async () => {
  const b = browser();
  assert.equal((await b('POST', '/admin/login', { password: 'wrong' })).status, 401);
  assert.equal((await b('POST', '/admin/login', { password: 'Goal-Keeper-Test-2026' })).status, 302);
  assert.equal((await b('GET', '/admin/scorers')).status, 200);
});

test('every public page has a quiet staff link that goes to the login, or to the right place once logged in', async () => {
  const anon = await (await fetch(h.base + '/leagues')).text();
  assert.match(anon, /<a class="staff-icon" href="\/admin\/login" aria-label="Staff login" title="Staff login"><svg/);
  const league = await (await fetch(h.base + `/league/${adults}`)).text();
  assert.match(league, /class="staff-icon" href="\/admin\/login"/);
  // admin pages themselves do not get it
  assert.doesNotMatch((await h.request('GET', '/admin')).text, /staff-icon/);
  // logged in as the admin on a public page: a link to the dashboard
  assert.match((await h.request('GET', `/league/${adults}`)).text, /class="staff-icon" href="\/admin" aria-label="Admin"/);
  // a scorer sees a link to their scoring page
  await h.request('POST', '/admin/scorers', { name: 'Pat', password: 'pitchside-1', league_id: String(adults) });
  const login = await fetch(h.base + '/admin/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ name: 'Pat', password: 'pitchside-1' }).toString() });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = await (await fetch(h.base + '/leagues', { headers: { cookie } })).text();
  assert.match(page, /class="staff-icon" href="\/admin" aria-label="My scoring page"/);
});
