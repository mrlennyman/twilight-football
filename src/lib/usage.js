/**
 * Anonymous install / usage counter. Each phone keeps a random id in its own storage and reports "opened as the
 * installed app" or "opened in a browser" at most once a day (plus an "installed" event where the browser sends
 * one). Nothing personal is stored: no names, no accounts, no IP addresses.
 */
const { detectPlatform, detectBrowser } = require('../public/js/install');

const ID_PATTERN = /^[A-Za-z0-9-]{16,64}$/;
const DAY_MS = 24 * 3600 * 1000;
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in New Zealand time. */
function nzDay(date) {
  return dayFormat.format(date);
}

/** Records one report; returns false when it was malformed and ignored. */
function recordUsage(db, { id, mode, event, userAgent, now = new Date() }) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
  if (mode !== 'app' && mode !== 'web') return false;
  const platform = detectPlatform(userAgent, { touchPoints: 0 });
  const browser = detectBrowser(userAgent);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO app_devices (id, platform, browser) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now'), platform = excluded.platform, browser = excluded.browser`
    ).run(id, platform, browser);
    if (mode === 'app') db.prepare("UPDATE app_devices SET app_first_open = COALESCE(app_first_open, datetime('now')) WHERE id = ?").run(id);
    if (event === 'installed') db.prepare("UPDATE app_devices SET installed_at = COALESCE(installed_at, datetime('now')) WHERE id = ?").run(id);
    db.prepare('INSERT OR IGNORE INTO app_daily (day, device_id, mode) VALUES (?, ?, ?)').run(nzDay(now), id, mode);
  })();
  return true;
}

/** Numbers for the admin "Installs & usage" page. */
function getUsageStats(db, now = new Date(), days = 14) {
  const today = nzDay(now);
  const [y, m, d] = today.split('-').map(Number);
  const noon = Date.UTC(y, m - 1, d, 12); // noon avoids day-skips around daylight saving
  const dayList = [];
  for (let i = 0; i < days; i += 1) dayList.push(new Date(noon - i * DAY_MS).toISOString().slice(0, 10));
  const since7 = new Date(noon - 6 * DAY_MS).toISOString().slice(0, 10);

  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const installed = '(installed_at IS NOT NULL OR app_first_open IS NOT NULL)';

  const perDay = new Map(dayList.map((day) => [day, { day, app: 0, web: 0, newApp: 0 }]));
  for (const row of db.prepare('SELECT day, mode, COUNT(*) AS n FROM app_daily WHERE day >= ? GROUP BY day, mode').all(dayList[dayList.length - 1])) {
    const entry = perDay.get(row.day);
    if (entry) entry[row.mode] = row.n;
  }
  for (const row of db
    .prepare(
      `SELECT first_day AS day, COUNT(*) AS n FROM
         (SELECT device_id, MIN(day) AS first_day FROM app_daily WHERE mode = 'app' GROUP BY device_id)
       GROUP BY first_day`
    )
    .all()) {
    const entry = perDay.get(row.day);
    if (entry) entry.newApp = row.n;
  }

  const breakdown = db
    .prepare(`SELECT COALESCE(platform, '?') AS platform, COALESCE(browser, '?') AS browser, COUNT(*) AS n FROM app_devices WHERE ${installed} GROUP BY 1, 2 ORDER BY n DESC`)
    .all();

  return {
    installedDevices: count(`SELECT COUNT(*) AS n FROM app_devices WHERE ${installed}`),
    installEvents: count('SELECT COUNT(*) AS n FROM app_devices WHERE installed_at IS NOT NULL'),
    appToday: count("SELECT COUNT(DISTINCT device_id) AS n FROM app_daily WHERE mode = 'app' AND day = ?", today),
    appWeek: count("SELECT COUNT(DISTINCT device_id) AS n FROM app_daily WHERE mode = 'app' AND day >= ?", since7),
    webOnlyDevices: count(`SELECT COUNT(*) AS n FROM app_devices WHERE NOT ${installed}`),
    totalDevices: count('SELECT COUNT(*) AS n FROM app_devices'),
    firstSeen: db.prepare('SELECT MIN(first_seen) AS t FROM app_devices').get().t,
    days: dayList.map((day) => perDay.get(day)),
    breakdown,
  };
}

module.exports = { recordUsage, getUsageStats, nzDay, ID_PATTERN };
