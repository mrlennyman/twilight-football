const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSplit, parseSplitInput, getSplitSettings } = require('../src/lib/standingsSplit');
const { startApp } = require('./helpers/harness');

test('resolveSplit: halfway by default, custom place and text honoured, off when there is nothing to mark', () => {
  assert.deepEqual(resolveSplit(null, 12), { mode: 'labels', after: 6, topText: 'Top 6', bottomText: 'Bottom 6' });
  assert.deepEqual(resolveSplit(null, 8), { mode: 'labels', after: 4, topText: 'Top 4', bottomText: 'Bottom 4' });
  assert.equal(resolveSplit(null, 10).mode, 'off', 'no automatic split for 10 teams');
  assert.equal(resolveSplit(null, 6).mode, 'off', 'too small to split');

  const custom = { standings_split: JSON.stringify({ mode: 'labels', after: 4, top: 'Championship', bottom: 'Challenge' }) };
  assert.deepEqual(resolveSplit(custom, 10), { mode: 'labels', after: 4, topText: 'Championship', bottomText: 'Challenge' });

  const line = { standings_split: JSON.stringify({ mode: 'line', after: null, top: 'ignored', bottom: '' }) };
  assert.equal(resolveSplit(line, 12).mode, 'line');
  assert.equal(resolveSplit({ standings_split: JSON.stringify({ mode: 'off' }) }, 12).mode, 'off');
  assert.equal(resolveSplit({ standings_split: 'not json' }, 12).mode, 'labels', 'bad data falls back to the default');
  assert.equal(resolveSplit({ standings_split: JSON.stringify({ mode: 'line', after: 99 }) }, 12).after, 6, 'an out-of-range place falls back to halfway');
  assert.equal(getSplitSettings(null).mode, 'labels');
});

test('parseSplitInput validates the form', () => {
  assert.deepEqual(parseSplitInput({ mode: 'line', top: '', bottom: '', after: '' }, 12).errors, []);
  assert.match(parseSplitInput({ mode: 'sideways' }, 12).errors.join(' '), /Choose how/);
  assert.match(parseSplitInput({ mode: 'line', after: '12' }, 12).errors.join(' '), /1 to 11/);
  assert.match(parseSplitInput({ mode: 'line', after: 'x' }, 12).errors.join(' '), /1 to 11/);
  assert.match(parseSplitInput({ mode: 'labels', top: 'x'.repeat(31) }, 12).errors.join(' '), /at most 30/);
  assert.deepEqual(JSON.parse(parseSplitInput({ mode: 'labels', top: '  Top   Six ', bottom: 'B', after: '5' }, 12).value), { mode: 'labels', after: 5, top: 'Top Six', bottom: 'B' });
});

let h;
let a; // 12 teams
let b; // 10 teams
test.before(async () => {
  h = await startApp();
  await h.login();
  a = await h.createScheduledLeague({ name: 'Twelve', teams: 12, pitches: 6 });
  b = await h.createScheduledLeague({ name: 'Ten', teams: 10, pitches: 5 });
});
test.after(async () => {
  await h.close();
});

const standings = async (id) => (await h.request('GET', `/league/${id}`)).text;
const save = (id, form) => h.request('POST', `/admin/league/${id}/standings-display`, form);

test('the setting is per league: labels by default, then a line, custom text, or nothing', async () => {
  assert.match(await standings(a), /Top 6<\/td>/);
  assert.doesNotMatch(await standings(b), /split-label|split-row/, 'a 10-team league has no automatic split');

  const res = await save(a, { mode: 'line', top: '', bottom: '', after: '' });
  assert.equal(res.status, 302);
  const line = await standings(a);
  assert.doesNotMatch(line, /split-label/);
  assert.equal((line.match(/class="split-row"/g) || []).length, 1, 'one line');
  assert.match(line.split('class="split-row"')[1], /^[^]*?<td>6<\/td>/, 'the line is on the 6th row');

  await save(a, { mode: 'labels', top: 'Championship', bottom: 'Challenge', after: '' });
  const named = await standings(a);
  assert.match(named, /Championship<\/td>/);
  assert.match(named, /Challenge<\/td>/);
  assert.doesNotMatch(named, /Top 6/);

  await save(a, { mode: 'off', top: '', bottom: '', after: '' });
  assert.doesNotMatch(await standings(a), /split-label|split-row/);

  // another league is untouched, and can have its own place
  await save(b, { mode: 'labels', top: '', bottom: '', after: '4' });
  const ten = await standings(b);
  assert.match(ten, /Top 4<\/td>/);
  assert.match(ten, /Bottom 6<\/td>/);
});

test('the admin Results page keeps its own gold line whatever the public setting says', async () => {
  await save(a, { mode: 'off', top: '', bottom: '', after: '' });
  const page = (await h.request('GET', `/admin/league/${a}/results`)).text;
  assert.equal((page.match(/class="split-row"/g) || []).length, 1);
});

test('the settings page loads, needs login, and rejects bad input', async () => {
  const page = await h.request('GET', `/admin/league/${a}/standings-display`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Show the split as/);
  assert.equal((await h.request('GET', '/admin/league/9999/standings-display')).status, 404);
  const bad = await save(a, { mode: 'line', after: '40' });
  assert.equal(bad.status, 400);
  assert.match((await h.request('GET', '/admin')).text, new RegExp(`/admin/league/${a}/standings-display`));
});
