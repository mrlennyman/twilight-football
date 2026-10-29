const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveSplit, parseSplitInput, getSplitSettings } = require('../src/lib/standingsSplit');
const { startApp } = require('./helpers/harness');

test('resolveSplit: halfway by default, custom place and text honoured, off when there is nothing to mark', () => {
  assert.deepEqual(resolveSplit(null, 12), { mode: 'labels', cuts: [6], texts: ['Top 6', 'Bottom 6'] });
  assert.deepEqual(resolveSplit(null, 8), { mode: 'labels', cuts: [4], texts: ['Top 4', 'Bottom 4'] });
  assert.equal(resolveSplit(null, 10).mode, 'off', 'no automatic split for 10 teams');
  assert.equal(resolveSplit(null, 6).mode, 'off', 'too small to split');

  const custom = { standings_split: JSON.stringify({ mode: 'labels', after: 4, top: 'Championship', bottom: 'Challenge' }) };
  assert.deepEqual(resolveSplit(custom, 10), { mode: 'labels', cuts: [4], texts: ['Championship', 'Challenge'] });

  const line = { standings_split: JSON.stringify({ mode: 'line', after: null, top: 'ignored', bottom: '' }) };
  assert.equal(resolveSplit(line, 12).mode, 'line');
  assert.equal(resolveSplit({ standings_split: JSON.stringify({ mode: 'off' }) }, 12).mode, 'off');
  assert.equal(resolveSplit({ standings_split: 'not json' }, 12).mode, 'labels', 'bad data falls back to the default');
  assert.deepEqual(resolveSplit({ standings_split: JSON.stringify({ mode: 'line', after: 99 }) }, 12).cuts, [6], 'an out-of-range place falls back to halfway');
  assert.equal(getSplitSettings(null).mode, 'labels');
});

test('parseSplitInput validates the form', () => {
  assert.deepEqual(parseSplitInput({ mode: 'line', top: '', bottom: '', after: '' }, 12).errors, []);
  assert.match(parseSplitInput({ mode: 'sideways' }, 12).errors.join(' '), /Choose how/);
  assert.match(parseSplitInput({ mode: 'line', after: '12' }, 12).errors.join(' '), /1 to 11/);
  assert.match(parseSplitInput({ mode: 'line', after: 'x' }, 12).errors.join(' '), /1 to 11/);
  assert.match(parseSplitInput({ mode: 'labels', top: 'x'.repeat(31) }, 12).errors.join(' '), /at most 30/);
  assert.deepEqual(JSON.parse(parseSplitInput({ mode: 'labels', top: '  Top   Six ', bottom: 'B', after: '5' }, 12).value), { mode: 'labels', three: false, after: 5, after2: null, top: 'Top Six', middle: '', bottom: 'B' });
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

test('three groups: thirds by default, custom places, text, and sensible fallbacks', () => {
  const three = (extra) => ({ standings_split: JSON.stringify({ mode: 'labels', three: true, ...extra }) });
  assert.deepEqual(resolveSplit(three({}), 12), { mode: 'labels', cuts: [4, 8], texts: ['Top 4', 'Middle 4', 'Bottom 4'] });
  assert.deepEqual(resolveSplit(three({ top: 'Cup', middle: 'Plate', bottom: 'Bowl' }), 12).texts, ['Cup', 'Plate', 'Bowl']);
  assert.deepEqual(resolveSplit(three({ after: 5, after2: 9 }), 12), { mode: 'labels', cuts: [5, 9], texts: ['Top 5', 'Middle 4', 'Bottom 3'] });
  assert.deepEqual(resolveSplit(three({ after: 6 }), 12).cuts, [6, 9], 'a missing second line goes halfway through the rest');
  assert.deepEqual(resolveSplit(three({}), 10).cuts, [], '10 teams have no automatic thirds, and no automatic halves is not forced either');
  assert.deepEqual(resolveSplit(three({ after: 3, after2: 3 }), 12).cuts, [3, 7], 'a second line that is not after the first is replaced');
  assert.equal(resolveSplit(three({ mode: 'line' }), 12).cuts.length, 2);
  assert.deepEqual(resolveSplit(three({}), 12, { three: false }).cuts, [6], 'the override turns the second line off');

  assert.match(parseSplitInput({ mode: 'line', three: 'on' }, 10).errors.join(' '), /don't divide into three/);
  assert.deepEqual(parseSplitInput({ mode: 'line', three: 'on' }, 12).errors, []);
  assert.match(parseSplitInput({ mode: 'line', three: 'on', after: '8', after2: '4' }, 12).errors.join(' '), /second line has to come after/);
  assert.deepEqual(JSON.parse(parseSplitInput({ mode: 'labels', three: 'on', after: '4', after2: '8', middle: 'Plate' }, 12).value).after2, 8);
});

test('a league can show three groups on the public table', async () => {
  await save(a, { mode: 'labels', three: 'on', top: 'Cup', middle: 'Plate', bottom: 'Bowl', after: '', after2: '' });
  const page = await standings(a);
  for (const word of ['Cup', 'Plate', 'Bowl']) assert.match(page, new RegExp(`<td colspan="9">${word}</td>`));
  const order = [...page.matchAll(/class="split-label"|data-team-id="\d+"/g)].map((m) => (m[0].startsWith('class') ? 'L' : 't')).join('');
  assert.match(order, /^Lt{4}Lt{4}Lt{4}$/);

  await save(a, { mode: 'line', three: 'on', after: '', after2: '' });
  assert.equal(((await standings(a)).match(/class="split-row"/g) || []).length, 2, 'two lines');

  // the admin Results page still marks only the Cup/Plate cut
  assert.equal(((await h.request('GET', `/admin/league/${a}/results`)).text.match(/class="split-row"/g) || []).length, 1);
  assert.match((await h.request('GET', `/admin/league/${a}/standings-display`)).text, /name="three" checked/);
});
