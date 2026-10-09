const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
});
test.after(() => h.close());

test('home: with no running leagues the animated stage shows a friendly message', async () => {
  const res = await h.request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<body class="home-page">/);
  assert.match(res.text, /class="home-stage"/);
  assert.match(res.text, /No leagues are running yet/);
  assert.doesNotMatch(res.text, /class="home-card"/);
});

test('home: with two or more leagues every league is one whole-card link, in order, with its status', async () => {
  const a = await h.createScheduledLeague({ name: 'Kids <b>Twilight</b>' });
  const b = await h.createScheduledLeague({ name: 'Adults Twilight' });
  const res = await h.request('GET', '/');
  const cards = [...res.text.matchAll(/<a class="home-card" href="\/league\/(\d+)" style="--i: (\d+)">([\s\S]*?)<\/a>/g)];
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => Number(c[2])), [0, 1], 'staggered animation index follows card order');
  assert.deepEqual(cards.map((c) => c[1]).sort(), [String(a), String(b)].sort());
  assert.ok(cards.every((c) => /in progress/.test(c[3])), 'status tag shown');
  assert.doesNotMatch(res.text, /Kids <b>Twilight/, 'league names are escaped');
  assert.match(res.text, /Kids &lt;b&gt;Twilight&lt;\/b&gt;/);
  assert.match(res.text, /class="home-wheel"/);
  assert.match(res.text, /pointermove/, 'pointer glow script present');
});

test('home: a single running league still goes straight to its standings', async () => {
  h.db.exec("UPDATE leagues SET status = 'setup' WHERE id = 2");
  const res = await h.request('GET', '/');
  assert.match(res.text, /class="league-title"/);
  assert.doesNotMatch(res.text, /class="home-card"/);
});

test('footer: the "Get the app" link is wrapped so it can be hidden once the app is installed; home footer is pinned', async () => {
  for (const url of ['/', '/league/1', '/install']) {
    const res = await h.request('GET', url);
    assert.match(res.text, /<span class="install-link"> &middot; <a href="\/install">Get the app<\/a><\/span>/, url);
  }
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');
  assert.match(css, /@media \(display-mode: standalone\)\s*\{\s*\.install-link\s*\{\s*display:\s*none/);
  assert.match(css, /\.home-page \.site-footer\s*\{[^}]*position:\s*fixed/);
  const js = fs.readFileSync(path.join(__dirname, '../src/public/js/install.js'), 'utf8');
  assert.match(js, /querySelectorAll\('\.install-link'\)/);
});

test('app window colour is the dark wine, so a sub-pixel gap at the screen edge is never a light line', async () => {
  const res = await h.request('GET', '/manifest.json');
  const manifest = JSON.parse(res.text);
  assert.equal(manifest.background_color, '#240812');
  assert.equal(manifest.theme_color, '#6e1b2e');
});
