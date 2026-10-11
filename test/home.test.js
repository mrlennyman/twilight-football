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

test('home: with a single running league the home page still shows the league card (the app opens here)', async () => {
  h.db.exec("UPDATE leagues SET status = 'setup' WHERE id = 2");
  const res = await h.request('GET', '/');
  assert.match(res.text, /<body class="home-page">/);
  assert.equal((res.text.match(/class="home-card"/g) || []).length, 1);
  assert.doesNotMatch(res.text, /class="league-title"/, 'not skipped straight to the standings');
});

test('footer: the "Get the app" link is wrapped so it can be hidden once the app is installed; home footer is pinned', async () => {
  for (const url of ['/', '/league/1', '/install']) {
    const res = await h.request('GET', url);
    assert.match(res.text, /<span class="install-link"><a class="footer-btn" href="\/install">Get the app<\/a><\/span>/, url);
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
  assert.equal(manifest.theme_color, '#3d0f1c', 'status bar = the header colour, so there is no separate band above it');
});

test('footer: "Sponsored by websitealchemy.com" is a real link with the logo beside it, on every page', async () => {
  for (const url of ['/', '/league/1', '/install', '/admin/login', '/nope']) {
    const res = await h.request('GET', url);
    if (url === '/admin/login') continue; // the login screen has no footer
    assert.match(res.text, /<a class="sponsor" href="https:\/\/websitealchemy\.com\/" target="_blank" rel="noopener sponsored">/, url);
    assert.match(res.text, /<img src="\/img\/websitealchemy-logo\.png" alt="" width="\d+" height="\d+"/, url);
    assert.match(res.text, /Sponsored by <strong>websitealchemy\.com<\/strong>/, url);
  }
  const logo = await fetch(`${h.base}/img/websitealchemy-logo.png`);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
});

test('sponsor bar: full width, square corners, nothing underneath it (CSS rules)', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');
  const bar = css.match(/\n\.sponsor\s*\{[^}]*\}/)[0];
  assert.match(bar, /width:\s*100%/);
  assert.match(bar, /border-radius:\s*0/);
  const footer = css.match(/\.site-footer\s*\{[^}]*\}/)[0];
  assert.match(footer, /padding:\s*20px 0 0/, 'no padding below the footer');
});

test('home screen: the small "Bream Bay Twilight Football" footer text is hidden; other pages keep it', async () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '../src/public/css/style.css'), 'utf8');
  assert.match(css, /\.home-page \.footer-name\s*\{\s*display:\s*none/);
  const page = await h.request('GET', '/league/1');
  assert.match(page.text, /<span class="footer-name">Bream Bay Twilight Football<\/span>/);
});

test('Home button goes to /leagues, which always shows the league cards - even with a single league', async () => {
  // earlier tests left league 2 in "setup", so exactly one league is listed
  const league = await h.request('GET', '/league/1');
  assert.match(league.text, /<a class="home-btn" href="\/leagues"/);
  const root = await h.request('GET', '/');
  assert.equal((root.text.match(/class="home-card"/g) || []).length, 1, '"/" shows the cards too');

  const cards = await h.request('GET', '/leagues');
  assert.equal(cards.status, 200);
  assert.match(cards.text, /<body class="home-page">/);
  assert.equal((cards.text.match(/class="home-card"/g) || []).length, 1, 'the single league shown as a card');
  assert.match(cards.text, /Choose your league/);
  assert.match(cards.text, /Kids <\/b>|Kids &lt;b&gt;Twilight/, 'the league name is on the card');

  h.db.exec('UPDATE leagues SET hidden = 1');
  const none = await h.request('GET', '/leagues');
  assert.match(none.text, /No leagues are running yet/);
});

test('status bar colour: matches the header on content pages, the top of the gradient on the home and login screens', async () => {
  for (const url of ['/league/1', '/install', '/nope']) {
    const res = await h.request('GET', url);
    assert.match(res.text, /<meta name="theme-color" content="#3d0f1c">/, url);
  }
  for (const url of ['/leagues', '/admin/login']) {
    const res = await h.request('GET', url);
    assert.match(res.text, /<meta name="theme-color" content="#6e1b2e">/, url);
  }
});

test('screen edge test page exists, is public, and uses loud layer colours; admin dashboard links to it', async () => {
  const page = await h.request('GET', '/edge-test');
  assert.equal(page.status, 200);
  assert.match(page.text, /Screen edge test/);
  assert.match(page.text, /edge-test-root/);
  assert.match(page.text, /background: #ff00ff/);
  assert.match(page.text, /devicePixelRatio/);
  await h.login();
  assert.match((await h.request('GET', '/admin')).text, /href="\/edge-test"/);
});
