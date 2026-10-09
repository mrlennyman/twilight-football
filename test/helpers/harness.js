/**
 * Boots the real Express app against a throwaway database for integration tests.
 * Each test file runs in its own process, so the app's database singleton is safe to configure here.
 * Usage:  const h = await startApp();  await h.login();  const r = await h.request('POST', '/admin/...', { ... });
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PASSWORD = 'Goal-Keeper-Test-2026';

async function startApp(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbapp-'));
  Object.assign(process.env, {
    NODE_ENV: 'test',
    ADMIN_PASSWORD: PASSWORD,
    SESSION_SECRET: 'test-secret-'.padEnd(48, 'x'),
    DATABASE_PATH: path.join(dir, 'test.sqlite'),
    BACKUP_DIR: path.join(dir, 'backups'),
    AUTO_RESTART: '0',
    ...extraEnv,
  });

  const app = require('../../src/app');
  const db = require('../../src/db');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';

  async function request(method, urlPath, form, { headers = {}, followCookies = true } = {}) {
    const res = await fetch(base + urlPath, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (followCookies && setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, headers: res.headers, location: res.headers.get('location'), text: await res.text() };
  }

  async function login() {
    const res = await request('POST', '/admin/login', { password: PASSWORD });
    if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  }

  /** Creates an 8-team, 4-pitch league with a generated schedule; returns its id. */
  async function createScheduledLeague({ name = 'Kids Twilight', teams = 8, pitches = 4 } = {}) {
    await request('POST', '/admin/leagues', {
      name, season: 'Summer', num_teams: String(teams), num_pitches: String(pitches), rounds_per_week: '3',
    });
    const id = db.prepare('SELECT MAX(id) AS id FROM leagues').get().id;
    const res = await request('POST', `/admin/league/${id}/schedule/generate`, {
      start_date: '2026-10-14', kickoff_start_time: '17:00', slot_minutes: '15',
    });
    if (res.status !== 302) throw new Error(`generate failed: ${res.status} ${res.text.slice(0, 200)}`);
    return id;
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
    try {
      app.locals.sessionStore.close();
    } catch (err) {
      /* already closed */
    }
    try {
      db.close();
    } catch (err) {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { base, db, dir, request, login, createScheduledLeague, close, setCookie: (c) => { cookie = c; }, getCookie: () => cookie };
}

module.exports = { startApp, PASSWORD };
