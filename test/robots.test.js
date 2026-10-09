const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/harness');

let h;
test.before(async () => {
  h = await startApp();
  await h.login();
  await h.createScheduledLeague();
});
test.after(() => h.close());

test('every response carries X-Robots-Tag noindex, nofollow', async () => {
  for (const url of ['/', '/league/1', '/league/1/teams', '/league/1/fixtures', '/install', '/manifest.json', '/css/style.css', '/nope', '/admin/login']) {
    const res = await h.request('GET', url);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', url);
  }
});

test('public pages carry the robots meta tag', async () => {
  for (const url of ['/league/1/teams', '/league/1', '/install', '/admin/login']) {
    const res = await h.request('GET', url);
    assert.match(res.text, /<meta name="robots" content="noindex, nofollow">/, url);
  }
});
