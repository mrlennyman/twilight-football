const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrustProxy } = require('../src/lib/proxy');
const { startApp } = require('./helpers/harness');

test('parseTrustProxy: a small whole number of proxies, anything else falls back to 1', () => {
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy(' 0 '), 0);
  assert.equal(parseTrustProxy(undefined), 1);
  for (const bad of ['', 'abc', '-1', '2.5', '99', 'true']) assert.equal(parseTrustProxy(bad), 1, bad);
});

test('A7: /admin/diagnostics needs login and shows the address, headers and backup age', async () => {
  const h = await startApp({ TRUST_PROXY: '2' });
  try {
    const anon = await h.request('GET', '/admin/diagnostics');
    assert.equal(anon.status, 302);
    assert.match(anon.location, /\/admin\/login/);

    await h.login();
    const ok = await h.request('GET', '/admin/diagnostics', undefined, {
      headers: { 'x-forwarded-for': '203.0.113.9, 172.70.1.2', 'cf-connecting-ip': '203.0.113.9' },
    });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /X-Forwarded-For header<\/th><td>203\.0\.113\.9, 172\.70\.1\.2/);
    assert.match(ok.text, /CF-Connecting-IP header<\/th><td>203\.0\.113\.9/);
    assert.match(ok.text, /req\.ip\)<\/th><td><strong>203\.0\.113\.9<\/strong>/, 'two trusted proxies -> the real client address');
    assert.match(ok.text, /Trusted proxies \(TRUST_PROXY\)<\/th><td>2/);
    assert.match(ok.text, /No backup found/);
    assert.match(ok.text, /class="diag-bad"/, 'a missing backup is flagged');

    // a fresh backup clears the flag
    await h.createScheduledLeague();
    await h.request('POST', '/admin/league/1/schedule/generate', { start_date: '2026-10-21', kickoff_start_time: '17:00', slot_minutes: '15' });
    const after = await h.request('GET', '/admin/diagnostics');
    assert.match(after.text, /bream-bay-pre-regenerate-/);
    assert.doesNotMatch(after.text, /class="diag-bad"/);
  } finally {
    await h.close();
  }
});
