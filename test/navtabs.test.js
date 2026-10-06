const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { getNavSettings, resolveNavTabs, parseNavInput } = require('../src/lib/navTabs');
const { getNavCounts } = require('../src/lib/queries');

const keys = (tabs) => tabs.map((t) => t.key);
const form = (over = {}) => ({
  mode_standings: 'show', label_standings: 'Standings', order_standings: '1',
  mode_teams: 'show', label_teams: 'Teams', order_teams: '2',
  mode_fixtures: 'show', label_fixtures: 'Fixtures', order_fixtures: '3',
  mode_bracket: 'show', label_bracket: 'Cup/Plate', order_bracket: '4',
  mode_info: 'auto', label_info: 'Info', order_info: '5',
  ...over,
});

test('defaults match the old fixed menu (Info only with published pages)', () => {
  const league = { id: 3, nav_tabs: null };
  assert.deepEqual(keys(resolveNavTabs(league, { info: 0, knockouts: 0 })), ['standings', 'teams', 'fixtures', 'bracket']);
  assert.deepEqual(keys(resolveNavTabs(league, { info: 2, knockouts: 0 })), ['standings', 'teams', 'fixtures', 'bracket', 'info']);
  assert.equal(resolveNavTabs(league, {})[1].href, '/league/3/teams');
});

test('hide, rename, reorder and auto modes', () => {
  const { errors, value } = parseNavInput(
    form({ mode_teams: 'hide', label_fixtures: 'Games', order_fixtures: '1', order_standings: '2', mode_bracket: 'auto' })
  );
  assert.deepEqual(errors, []);
  const league = { id: 1, nav_tabs: value };
  const before = resolveNavTabs(league, { info: 0, knockouts: 0 });
  assert.deepEqual(keys(before), ['fixtures', 'standings']);
  assert.equal(before[0].label, 'Games');
  assert.deepEqual(keys(resolveNavTabs(league, { info: 1, knockouts: 6 })), ['fixtures', 'standings', 'bracket', 'info']);
});

test('validation: bad mode, long name, bad position, everything hidden', () => {
  assert.ok(parseNavInput(form({ mode_info: 'show' })).errors.length, 'info cannot be forced on');
  assert.ok(parseNavInput(form({ mode_standings: 'auto' })).errors.length);
  assert.ok(parseNavInput(form({ label_teams: 'x'.repeat(21) })).errors.length);
  assert.ok(parseNavInput(form({ order_teams: 'abc' })).errors.length);
  const allHidden = form({ mode_standings: 'hide', mode_teams: 'hide', mode_fixtures: 'hide', mode_bracket: 'hide', mode_info: 'hide' });
  assert.ok(parseNavInput(allHidden).errors.length);
});

test('corrupt saved JSON falls back to defaults; blank name falls back to default', () => {
  assert.equal(getNavSettings({ id: 1, nav_tabs: '{not json' }).length, 5);
  assert.equal(getNavSettings({ id: 1, nav_tabs: '[1]' })[0].label, 'Standings');
  assert.equal(parseNavInput(form({ label_teams: '  ' })).errors.length, 0);
});

test('getNavCounts counts published pages and cup/plate rounds', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '../src/db/schema.sql'), 'utf8'));
  db.prepare("INSERT INTO leagues (id, name, season) VALUES (1, 'L', '2026')").run();
  assert.deepEqual(getNavCounts(db, 1), { info: 0, knockouts: 0 });
  db.prepare("INSERT INTO rounds (league_id, round_number, week_number, stage) VALUES (1,1,1,'group'),(1,15,6,'cup')").run();
  assert.equal(getNavCounts(db, 1).knockouts, 1);
});
