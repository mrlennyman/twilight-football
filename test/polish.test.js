const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { renderMarkup } = require('../src/lib/markup');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
});
test.after(() => h.close());

const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (name) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)[1];

test('C7: muted text reaches 4.5:1 on cream and on the white panel; the "v" badge text too', () => {
  const muted = token('muted');
  assert.ok(contrast(muted, token('cream')) >= 4.5, `muted on cream ${contrast(muted, token('cream')).toFixed(2)}`);
  assert.ok(contrast(muted, token('panel')) >= 4.5, `muted on panel ${contrast(muted, token('panel')).toFixed(2)}`);
  const badge = /\.score-badge-pending\s*\{[^}]*color:\s*(#[0-9a-fA-F]{6})/.exec(css)[1];
  assert.ok(contrast(badge, token('border')) >= 4.5, `badge text ${contrast(badge, token('border')).toFixed(2)}`);
  assert.match(css, /\.match-meta\s*\{[^}]*font-size:\s*0\.85rem;[^}]*font-weight:\s*600/);
});

test('C9: ** inside a link address cannot mangle the markup; normal links and bold still work', () => {
  const html = renderMarkup('[x](https://a.com/**) and **y**');
  assert.ok(!/href="[^"]*<strong>/.test(html), 'no <strong> inside an href');
  assert.match(html, /<strong>y<\/strong>|<strong>\) and <\/strong>y/);
  assert.match(renderMarkup('[NZ Football](https://www.nzfootball.co.nz/a?b=1) and **bold**'), /<a href="https:\/\/www\.nzfootball\.co\.nz\/a\?b=1" target="_blank" rel="noopener noreferrer">NZ Football<\/a> and <strong>bold<\/strong>/);
  assert.ok(!renderMarkup('[bad](javascript:alert(1))').includes('<a '));
});

test('C5: security headers on every response', async () => {
  for (const url of ['/', '/league/1', '/install', '/css/style.css', '/admin/login', '/nope']) {
    const res = await h.request('GET', url);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', url);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', url);
  }
});

test('C8: rename a player (ownership and length checked); other leagues are untouchable', async () => {
  const csv = (p) => Array.from({ length: 4 }, (_, i) => `Team ${i + 1},${p} ${i}`).join('\n');
  for (const name of ['One', 'Two']) {
    await h.request('POST', '/admin/import', { name, season: 'S', num_pitches: '2', rounds_per_week: '3', csv: csv(name) });
  }
  const one = h.db.prepare("SELECT p.id AS pid, t.id AS tid FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = 1 ORDER BY p.id LIMIT 1").get();
  const ok = await h.request('POST', `/admin/league/1/teams/${one.tid}/players/${one.pid}`, { name: 'Te Rangi H.' });
  assert.equal(ok.status, 302);
  assert.equal(h.db.prepare('SELECT name FROM players WHERE id = ?').get(one.pid).name, 'Te Rangi H.');

  assert.equal((await h.request('POST', `/admin/league/1/teams/${one.tid}/players/${one.pid}`, { name: 'x'.repeat(61) })).status, 400);
  assert.equal((await h.request('POST', `/admin/league/1/teams/${one.tid}/players/${one.pid}`, { name: '  ' })).status, 400);

  // league 2's team id used under league 1 -> nothing changes
  const other = h.db.prepare("SELECT p.id AS pid, t.id AS tid FROM players p JOIN teams t ON t.id = p.team_id WHERE t.league_id = 2 LIMIT 1").get();
  const before = h.db.prepare('SELECT name FROM players WHERE id = ?').get(other.pid).name;
  await h.request('POST', `/admin/league/1/teams/${other.tid}/players/${other.pid}`, { name: 'Hacked' });
  assert.equal(h.db.prepare('SELECT name FROM players WHERE id = ?').get(other.pid).name, before);
  // player id from another team under the right team -> nothing changes
  await h.request('POST', `/admin/league/1/teams/${one.tid}/players/${other.pid}`, { name: 'Hacked' });
  assert.equal(h.db.prepare('SELECT name FROM players WHERE id = ?').get(other.pid).name, before);

  const page = await h.request('GET', '/admin/league/1/teams');
  assert.match(page.text, /<textarea name="players"[^>]*>[^<]*Te Rangi H\.[^<]*<\/textarea>/);
});
