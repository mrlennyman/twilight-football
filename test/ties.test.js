const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { computeStandings, getOpenTieBlocks } = require('../src/lib/standings');
const { startApp } = require('./helpers/harness');

const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8');

function perms(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((x, i) => perms([...items.slice(0, i), ...items.slice(i + 1)]).map((p) => [x, ...p]));
}

/** n teams (ids 1..n), every match 1-1 (all level), plus the given shootout results [winner, loser]. */
function allLevelLeague(n, shootouts) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', 'S')").run();
  for (let t = 1; t <= n; t++) db.prepare('INSERT INTO teams (id, league_id, name) VALUES (?, 1, ?)').run(t, `T${t}`);
  db.prepare("INSERT INTO pitches (label) VALUES ('P1')").run();
  db.prepare("INSERT INTO rounds (id, league_id, round_number, week_number, stage) VALUES (1, 1, 1, 1, 'group')").run();
  for (let a = 1; a <= n; a++) {
    for (let b = 1; b <= n; b++) {
      if (a === b) continue;
      db.prepare("INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id, home_score, away_score, status) VALUES (1, 1, ?, ?, 1, 1, 'played')").run(a, b);
    }
  }
  for (const [winner, loser] of shootouts) {
    db.prepare('INSERT INTO tie_breaks (league_id, team_a_id, team_b_id, winner_team_id) VALUES (1, ?, ?, ?)').run(winner, loser, winner);
  }
  return db;
}

const pairsConsistentWith = (order) => {
  const out = [];
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) out.push([order[i], order[j]]);
  return out;
};

test('B4: 4 teams level - for all 24 orderings, recording all six pairs gives exactly that order, settled', () => {
  for (const order of perms([1, 2, 3, 4])) {
    const rows = computeStandings(allLevelLeague(4, pairsConsistentWith(order)), 1);
    assert.deepEqual(rows.map((r) => r.teamId), order, `order ${order}`);
    assert.ok(rows.every((r) => r.tied && r.tieResolved), `order ${order} should be settled`);
  }
});

test('B4: 3 teams level - all three shootouts recorded settles in all 6 orderings', () => {
  for (const order of perms([1, 2, 3])) {
    const rows = computeStandings(allLevelLeague(3, pairsConsistentWith(order)), 1);
    assert.deepEqual(rows.map((r) => r.teamId), order);
    assert.ok(rows.every((r) => r.tieResolved));
  }
});

test('B4: a cycle (A beat B, B beat C, C beat A) is NOT settled', () => {
  const rows = computeStandings(allLevelLeague(3, [[1, 2], [2, 3], [3, 1]]), 1);
  assert.ok(rows.every((r) => r.tied && !r.tieResolved));
});

test('B4: missing pairs keep the tie open (a partial chain is not enough), and are listed for the admin', () => {
  const db = allLevelLeague(4, [[1, 2], [2, 3], [3, 4]]); // only 3 of 6 pairs
  const rows = computeStandings(db, 1);
  assert.ok(rows.every((r) => !r.tieResolved));
  const [block] = getOpenTieBlocks(db, 1, rows);
  assert.equal(block.teams.length, 4);
  assert.equal(block.pairs.length, 6);
  assert.equal(block.pairs.filter((p) => p.winnerId === null).length, 3, 'three pairs still to record');
  assert.equal(block.pairs.find((p) => p.a.id === 1 && p.b.id === 2).winnerId, 1);
});

test('B4: a plain two-team tie settles with one shootout, and can be changed', () => {
  const unresolved = computeStandings(allLevelLeague(2, []), 1);
  assert.ok(unresolved.every((r) => r.tied && !r.tieResolved));
  assert.deepEqual(computeStandings(allLevelLeague(2, [[2, 1]]), 1).map((r) => r.teamId), [2, 1]);
  assert.deepEqual(computeStandings(allLevelLeague(2, [[1, 2]]), 1).map((r) => r.teamId), [1, 2]);
});

test('B4: a tie at the top blocks the brackets until it is settled (not only at the 4th/5th line)', async () => {
  const h = await startApp();
  try {
    await h.login();
    const id = await h.createScheduledLeague({ name: 'Kids' });
    const all = h.db.prepare('SELECT m.id, m.home_team_id AS hh, m.away_team_id AS aa FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?').all(id);
    const ids = h.db.prepare('SELECT id FROM teams WHERE league_id = ? ORDER BY id').all(id).map((t) => t.id);
    const top = ids.slice(-2); // the two highest ids draw with each other, and beat everyone else
    for (const m of all) {
      const bothTop = top.includes(m.hh) && top.includes(m.aa);
      const homeWins = m.hh > m.aa;
      const [hs, as] = bothTop ? ['1', '1'] : homeWins ? ['2', '0'] : ['0', '2'];
      await h.request('POST', `/admin/league/${id}/results/match/${m.id}`, { home_score: hs, away_score: as });
    }
    const standings = computeStandings(h.db, id);
    assert.deepEqual(standings.slice(0, 2).map((s) => s.teamId).sort(), [...top].sort());
    assert.ok(standings.slice(0, 2).every((s) => s.tied && !s.tieResolved), 'tied at ranks 1 and 2');

    const page = await h.request('GET', `/admin/league/${id}/results?week=1`);
    assert.match(page.text, /Record the shootout results/);
    assert.match(page.text, /<button type="button" disabled>Generate Cup/);
    assert.match(page.text, /won<\/button>/);

    const blocked = await h.request('POST', `/admin/league/${id}/generate-knockouts`);
    assert.equal(blocked.status, 400);
    assert.match(blocked.text, /still tied/);
    assert.equal(h.db.prepare("SELECT COUNT(*) c FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).c, 0);

    const tie = await h.request('POST', `/admin/league/${id}/tie-break`, { team_a_id: String(top[0]), team_b_id: String(top[1]), winner_team_id: String(top[0]) });
    assert.equal(tie.status, 302);
    const after = computeStandings(h.db, id);
    assert.deepEqual(after.slice(0, 2).map((s) => s.teamId), [top[0], top[1]]);
    assert.equal((await h.request('POST', `/admin/league/${id}/generate-knockouts`)).status, 302);
    assert.equal(h.db.prepare("SELECT COUNT(*) c FROM rounds WHERE league_id = ? AND stage != 'group'").get(id).c, 4);

    // changing the shootout after the draw is refused (brackets are seeded from it)
    const late = await h.request('POST', `/admin/league/${id}/tie-break`, { team_a_id: String(top[0]), team_b_id: String(top[1]), winner_team_id: String(top[1]) });
    assert.equal(late.status, 400);
  } finally {
    await h.close();
  }
});
