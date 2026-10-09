/** Shared read queries used by both the public and admin routes. */

function getAllLeagues(db) {
  return db.prepare('SELECT * FROM leagues ORDER BY created_at DESC').all();
}

function getLeague(db, id) {
  return db.prepare('SELECT * FROM leagues WHERE id = ?').get(id);
}

function getTeams(db, leagueId) {
  return db.prepare('SELECT * FROM teams WHERE league_id = ? ORDER BY name').all(leagueId);
}

function getPlayers(db, teamId) {
  return db.prepare('SELECT * FROM players WHERE team_id = ? ORDER BY name').all(teamId);
}

function getPitches(db) {
  return db.prepare('SELECT * FROM pitches ORDER BY label').all();
}

const matchSelect = `
  SELECT m.*,
    ht.name AS home_team_name, at.name AS away_team_name,
    p.label AS pitch_label
  FROM matches m
  LEFT JOIN teams ht ON ht.id = m.home_team_id
  LEFT JOIN teams at ON at.id = m.away_team_id
  LEFT JOIN pitches p ON p.id = m.pitch_id
  WHERE m.round_id = ?
  ORDER BY m.pitch_id, m.id
`;

function getRoundsWithMatches(db, leagueId, stage) {
  const rounds = db
    .prepare('SELECT * FROM rounds WHERE league_id = ? AND stage = ? ORDER BY round_number')
    .all(leagueId, stage);
  const matchStmt = db.prepare(matchSelect);
  return rounds.map((round) => ({ ...round, matches: matchStmt.all(round.id) }));
}

function getRoundsForWeek(db, leagueId, weekNumber) {
  const rounds = db
    .prepare(
      "SELECT * FROM rounds WHERE league_id = ? AND stage = 'group' AND week_number = ? ORDER BY round_number"
    )
    .all(leagueId, weekNumber);
  const matchStmt = db.prepare(matchSelect);
  return rounds.map((round) => ({ ...round, matches: matchStmt.all(round.id) }));
}

function getWeekNumbers(db, leagueId) {
  return db
    .prepare(
      "SELECT DISTINCT week_number FROM rounds WHERE league_id = ? AND stage = 'group' ORDER BY week_number"
    )
    .all(leagueId)
    .map((r) => r.week_number);
}

function getCurrentWeek(db, leagueId) {
  const nextUnplayed = db
    .prepare(
      `SELECT r.week_number FROM rounds r
       JOIN matches m ON m.round_id = r.id
       WHERE r.league_id = ? AND r.stage = 'group' AND m.status = 'scheduled'
       ORDER BY r.round_number LIMIT 1`
    )
    .get(leagueId);
  if (nextUnplayed) return nextUnplayed.week_number;

  const lastWeek = db
    .prepare(
      "SELECT MAX(week_number) AS week FROM rounds WHERE league_id = ? AND stage = 'group'"
    )
    .get(leagueId);
  return lastWeek ? lastWeek.week : null;
}

/** Newest result save/clear in the league (SQLite UTC text), or null. */
function getLastUpdated(db, leagueId) {
  return db
    .prepare(
      `SELECT MAX(m.updated_at) AS at FROM matches m JOIN rounds r ON r.id = m.round_id WHERE r.league_id = ?`
    )
    .get(leagueId).at;
}

/** Today's date (YYYY-MM-DD) in New Zealand, whatever time zone the server runs in. */
function todayNZ(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland' }).format(now);
}

/**
 * The week to open by default: tonight's match night, or the next one coming up; once the group stage
 * is over, the last week. Chosen by calendar date, so a forgotten score never pins everyone to an old week.
 */
function getDefaultWeek(db, leagueId, today = todayNZ()) {
  const weeks = db
    .prepare(
      `SELECT week_number, MIN(date) AS date FROM rounds
       WHERE league_id = ? AND stage = 'group' GROUP BY week_number ORDER BY week_number`
    )
    .all(leagueId);
  if (weeks.length === 0) return null;
  const upcoming = weeks.find((w) => w.date >= today);
  return (upcoming || weeks[weeks.length - 1]).week_number;
}

function getPages(db, leagueId, { publishedOnly = false } = {}) {
  return db
    .prepare(
      `SELECT * FROM pages WHERE league_id = ? ${publishedOnly ? 'AND published = 1' : ''}
       ORDER BY sort_order, id`
    )
    .all(leagueId);
}

function getPageById(db, leagueId, pageId) {
  return db.prepare('SELECT * FROM pages WHERE id = ? AND league_id = ?').get(pageId, leagueId);
}

function getPublishedPageBySlug(db, leagueId, slug) {
  return db
    .prepare('SELECT * FROM pages WHERE league_id = ? AND slug = ? AND published = 1')
    .get(leagueId, slug);
}

function countPublishedPages(db, leagueId) {
  return db.prepare('SELECT COUNT(*) AS c FROM pages WHERE league_id = ? AND published = 1').get(leagueId).c;
}

function countKnockoutRounds(db, leagueId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM rounds WHERE league_id = ? AND stage IN ('cup', 'plate')")
    .get(leagueId).c;
}

/** What the public menu needs to decide which tabs to show. */
function getNavCounts(db, leagueId) {
  return { info: countPublishedPages(db, leagueId), knockouts: countKnockoutRounds(db, leagueId) };
}

/**
 * "Jack Brown" -> "Jack B." for the public roster page. A name already ending in a single letter keeps
 * all its first names: "Te Rangi H" -> "Te Rangi H.".
 */
function firstNameLastInitial(fullName) {
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];

  // Already typed as "first name(s) + initial" (e.g. "Te Rangi H" or "Te Rangi H."): keep every first name.
  const alreadyInitial = /^(\p{L})\.?$/u.exec(last);
  if (alreadyInitial) {
    return `${parts.slice(0, -1).join(' ')} ${alreadyInitial[1].toLocaleUpperCase()}.`;
  }

  // Otherwise "First Last..." -> "First L." (initial taken by code point, not UTF-16 unit)
  return `${parts[0]} ${Array.from(last)[0]}.`;
}

module.exports = {
  getAllLeagues,
  getLeague,
  getTeams,
  getPlayers,
  getPitches,
  getRoundsWithMatches,
  getRoundsForWeek,
  getWeekNumbers,
  getCurrentWeek,
  getDefaultWeek,
  getLastUpdated,
  todayNZ,
  getPages,
  getPageById,
  getPublishedPageBySlug,
  countPublishedPages,
  countKnockoutRounds,
  getNavCounts,
  firstNameLastInitial,
};
