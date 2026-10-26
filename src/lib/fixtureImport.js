/**
 * Load a ready-made draw (fixture list) into a league instead of letting the app generate one.
 *
 *   date,time,match,home,away,pitch
 *   2026-10-28,17:30,1,Rovers,Wanderers,1
 *
 * One row per match. Matches with the same date and time are one round; each new date is a new week. The header row
 * is optional, "match" and "pitch" may be left out, and dates/times can be written the way a draw sheet writes them
 * ("28 Oct 2026", "28/10/2026", "5:30 PM").
 */
const { parseCsv } = require('./rosterImport');

const MAX_ROWS = 2000;
const MAX_ROUNDS = 100;
const MAX_TEAMS = 32;
const MAX_PITCHES = 16;
const PLACEHOLDER = /^team\s*\d+$/i;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** "2026-10-28", "28 Oct 2026", "Wed 28 October 2026", "28/10/2026" -> "2026-10-28" (or null). */
function parseDate(raw) {
  const s = clean(raw).replace(/^[A-Za-z]{3,9},?\s+(?=\d)/, '');
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y, mo, d;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/))) {
    [d, mo, y] = [Number(m[1]), MONTHS[m[2].slice(0, 3).toLowerCase()], Number(m[3])];
  } else return null;
  return mo && validYmd(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
}

/** "17:30", "5:30 PM", "5.30pm", "5pm" -> "17:30" (or null). */
function parseTime(raw) {
  const m = clean(raw).match(/^(\d{1,2})(?:[:.](\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0);
  } else if (!m[2]) return null; // a bare "5" is ambiguous
  return h <= 23 && min <= 59 ? `${pad(h)}:${pad(min)}` : null;
}

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Finds which column holds what: from the header row when there is one, else date,time,match,home,away,pitch. */
function readColumns(headerRow) {
  const names = headerRow.map((c) => clean(c).toLowerCase());
  const find = (...options) => names.findIndex((n) => options.includes(n));
  const cols = {
    date: find('date', 'day', 'week'),
    time: find('time', 'slot', 'kickoff', 'kick off', 'start'),
    match: find('match', 'match #', 'match no', 'game'),
    home: find('home', 'home team'),
    away: find('away', 'away team'),
    pitch: find('pitch', 'pitch #', 'field', 'ground'),
  };
  return cols.home >= 0 && cols.away >= 0 && cols.date >= 0 && cols.time >= 0 ? cols : null;
}

/** CSV text -> { errors, rows: [{ line, date, time, home, away, pitch }] }. */
function parseFixtureCsv(text) {
  const errors = [];
  const table = parseCsv(text);
  if (table.length === 0) return { errors: ['The file is empty.'], rows: [] };
  if (table.length > MAX_ROWS) return { errors: [`That file has more than ${MAX_ROWS} rows - is it the right one?`], rows: [] };

  let cols = readColumns(table[0]);
  let start = 1;
  if (!cols) {
    if (/home|away|date/i.test(table[0].join(' ')) && !parseDate(table[0][0])) {
      return { errors: ['The header row needs these columns: date, time, home, away (and optionally match, pitch).'], rows: [] };
    }
    cols = { date: 0, time: 1, match: 2, home: 3, away: 4, pitch: 5 };
    start = 0;
  }

  const rows = [];
  for (let i = start; i < table.length; i++) {
    const line = i + 1;
    const cell = (c) => (c >= 0 ? clean(table[i][c]) : '');
    const date = parseDate(cell(cols.date));
    const time = parseTime(cell(cols.time));
    const home = cell(cols.home);
    const away = cell(cols.away);
    const pitchRaw = cell(cols.pitch);
    const pitchNum = pitchRaw ? Number((pitchRaw.match(/\d+/) || [])[0]) : null;
    if (!date) errors.push(`Row ${line}: "${cell(cols.date)}" is not a date I can read (try 2026-10-28 or 28 Oct 2026).`);
    if (!time) errors.push(`Row ${line}: "${cell(cols.time)}" is not a time I can read (try 17:30 or 5:30 PM).`);
    if (!home || !away) errors.push(`Row ${line}: the home and away team names can't be blank.`);
    else if (home.toLowerCase() === away.toLowerCase()) errors.push(`Row ${line}: ${home} can't play itself.`);
    if (home.length > 60 || away.length > 60) errors.push(`Row ${line}: a team name is too long (max 60 characters).`);
    if (pitchRaw && !(pitchNum >= 1 && pitchNum <= MAX_PITCHES)) errors.push(`Row ${line}: pitch "${pitchRaw}" should be a number from 1 to ${MAX_PITCHES}.`);
    rows.push({ line, date, time, home, away, pitch: pitchRaw ? pitchNum : null });
  }
  if (rows.length === 0) errors.push('The file has no matches in it.');
  return { errors, rows };
}

/**
 * Works out what importing would do, without changing anything.
 * Returns { errors, warnings, rounds, teams, pitchCount, ... } - pass it to applyFixtureImport when there are no errors.
 */
function planFixtureImport(db, league, rows) {
  const errors = [];
  const warnings = [];

  // ---- rounds: matches sharing a date and time; weeks: one per distinct date
  const slots = new Map();
  for (const row of rows) {
    if (!row.date || !row.time) continue;
    const key = `${row.date} ${row.time}`;
    if (!slots.has(key)) slots.set(key, { date: row.date, time: row.time, matches: [] });
    slots.get(key).matches.push(row);
  }
  const rounds = [...slots.values()].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
  if (rounds.length > MAX_ROUNDS) errors.push(`That is ${rounds.length} rounds - the most one league can have is ${MAX_ROUNDS}.`);
  const dates = [...new Set(rounds.map((r) => r.date))];
  rounds.forEach((round, i) => {
    round.roundNumber = i + 1;
    round.weekNumber = dates.indexOf(round.date) + 1;
  });

  // ---- sanity checks inside each round
  for (const round of rounds) {
    const label = `${round.date} ${round.time}`;
    const seenTeams = new Set();
    const seenPitches = new Set();
    for (const m of round.matches) {
      for (const name of [m.home, m.away]) {
        const key = name.toLowerCase();
        if (seenTeams.has(key)) errors.push(`${name} is in two matches at ${label} (row ${m.line}).`);
        seenTeams.add(key);
      }
      if (m.pitch) {
        if (seenPitches.has(m.pitch)) errors.push(`Pitch ${m.pitch} is used twice at ${label} (row ${m.line}).`);
        seenPitches.add(m.pitch);
      }
    }
  }

  // ---- the teams in the file, and which of the league's teams they go into
  const fileTeams = new Map(); // lower-case name -> { name, matches }
  for (const row of rows) {
    for (const name of [row.home, row.away]) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (!fileTeams.has(key)) fileTeams.set(key, { name, matches: 0 });
      fileTeams.get(key).matches += 1;
    }
  }
  if (fileTeams.size > MAX_TEAMS) errors.push(`The file has ${fileTeams.size} teams - the most one league can have is ${MAX_TEAMS}.`);
  if (fileTeams.size < 2) errors.push('The file needs at least two teams.');

  const existing = db
    .prepare(
      `SELECT t.id, t.name, (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS players
       FROM teams t WHERE t.league_id = ? ORDER BY t.id`
    )
    .all(league.id);
  const byName = new Map(existing.map((t) => [t.name.toLowerCase(), t]));
  const used = new Set();
  const teams = []; // { name, teamId|null, action: 'keep'|'rename'|'create', oldName, matches }
  const pending = [];
  for (const [key, ft] of fileTeams) {
    const hit = byName.get(key);
    if (hit) {
      used.add(hit.id);
      teams.push({ name: ft.name, teamId: hit.id, action: 'keep', oldName: hit.name, matches: ft.matches });
    } else pending.push(ft);
  }
  const spare = existing.filter((t) => PLACEHOLDER.test(t.name) && !used.has(t.id));
  for (const ft of pending) {
    const next = spare.shift();
    if (next) {
      used.add(next.id);
      teams.push({ name: ft.name, teamId: next.id, action: 'rename', oldName: next.name, matches: ft.matches });
    } else {
      teams.push({ name: ft.name, teamId: null, action: 'create', oldName: null, matches: ft.matches });
    }
  }

  // Teams in the league that the file doesn't mention: unused placeholders are removed, anything else blocks the import.
  const removals = [];
  for (const t of existing) {
    if (used.has(t.id)) continue;
    if (PLACEHOLDER.test(t.name) && t.players === 0) removals.push(t);
    else errors.push(`"${t.name}" is in this league but not in the file${t.players ? ` (it has ${t.players} player${t.players === 1 ? '' : 's'})` : ''}. Rename or remove it first, or check the spelling in the file.`);
  }

  // ---- pitches, timing
  const pitchNumbers = rows.map((r) => r.pitch).filter(Boolean);
  const pitchCount = pitchNumbers.length ? Math.max(...pitchNumbers) : league.num_pitches;
  const missingPitch = rows.filter((r) => !r.pitch).length;
  if (missingPitch && missingPitch !== rows.length) errors.push('Some matches have a pitch and some do not - give every match a pitch, or none.');
  if (pitchNumbers.length && pitchCount * 2 < fileTeams.size) errors.push(`${fileTeams.size} teams need at least ${Math.ceil(fileTeams.size / 2)} pitches, but the file only uses ${pitchCount}.`);

  const gaps = [];
  for (let i = 1; i < rounds.length; i++) {
    if (rounds[i].date === rounds[i - 1].date) gaps.push(minutesOf(rounds[i].time) - minutesOf(rounds[i - 1].time));
  }
  gaps.sort((a, b) => a - b);
  const slotMinutes = gaps.length ? Math.min(240, Math.max(10, gaps[Math.floor(gaps.length / 2)])) : league.slot_minutes;
  const roundsPerWeek = Math.max(1, ...dates.map((d) => rounds.filter((r) => r.date === d).length));

  // ---- friendly warnings
  const perTeam = teams.map((t) => t.matches);
  if (perTeam.length && Math.min(...perTeam) !== Math.max(...perTeam)) {
    warnings.push(`Teams don't all play the same number of matches (${Math.min(...perTeam)} to ${Math.max(...perTeam)}).`);
  }
  const weeksOfDay = new Set(dates.map((d) => new Date(`${d}T12:00:00Z`).getUTCDay()));
  if (weeksOfDay.size > 1) warnings.push('The match dates fall on different days of the week - check the dates are right.');

  return {
    errors,
    warnings,
    rounds,
    teams,
    removals,
    matchCount: rows.length,
    pitchCount,
    slotMinutes,
    roundsPerWeek,
    startDate: rounds[0] ? rounds[0].date : null,
    kickoffStartTime: rounds[0] ? rounds[0].time : null,
    weeks: dates.length,
  };
}

/** Writes a plan (with no errors) to the database in one transaction. Replaces the league's whole schedule. */
function applyFixtureImport(db, league, plan) {
  db.exec('BEGIN');
  try {
    const havePitches = db.prepare('SELECT COUNT(*) AS c FROM pitches').get().c;
    const insertPitch = db.prepare('INSERT INTO pitches (label) VALUES (?)');
    for (let i = havePitches + 1; i <= plan.pitchCount; i++) insertPitch.run(`Pitch ${i}`);
    const pitchIds = new Map(db.prepare('SELECT id, label FROM pitches').all().map((p) => [p.label, p.id]));

    // Wipe the old schedule, results, tie-breaks and change log (the caller has taken a safety backup).
    db.prepare('DELETE FROM matches WHERE round_id IN (SELECT id FROM rounds WHERE league_id = ?)').run(league.id);
    db.prepare('DELETE FROM rounds WHERE league_id = ?').run(league.id);
    db.prepare('DELETE FROM tie_breaks WHERE league_id = ?').run(league.id);
    db.prepare('DELETE FROM result_log WHERE league_id = ?').run(league.id);

    for (const t of plan.removals) db.prepare('DELETE FROM teams WHERE id = ? AND league_id = ?').run(t.id, league.id);
    const idByName = new Map();
    for (const t of plan.teams) {
      let id = t.teamId;
      if (t.action === 'create') id = db.prepare('INSERT INTO teams (league_id, name) VALUES (?, ?)').run(league.id, t.name).lastInsertRowid;
      else if (t.action === 'rename') db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(t.name, id);
      idByName.set(t.name.toLowerCase(), Number(id));
    }

    const insertRound = db.prepare(
      "INSERT INTO rounds (league_id, round_number, week_number, stage, date, kickoff_time) VALUES (?, ?, ?, 'group', ?, ?)"
    );
    const insertMatch = db.prepare('INSERT INTO matches (round_id, pitch_id, home_team_id, away_team_id) VALUES (?, ?, ?, ?)');
    for (const round of plan.rounds) {
      const info = insertRound.run(league.id, round.roundNumber, round.weekNumber, round.date, round.time);
      for (const m of round.matches) {
        insertMatch.run(
          info.lastInsertRowid,
          m.pitch ? pitchIds.get(`Pitch ${m.pitch}`) : null,
          idByName.get(m.home.toLowerCase()),
          idByName.get(m.away.toLowerCase())
        );
      }
    }

    db.prepare(
      `UPDATE leagues SET status = 'in_progress', num_teams = ?, num_pitches = ?, rounds_per_week = ?,
         start_date = ?, kickoff_start_time = ?, slot_minutes = ? WHERE id = ?`
    ).run(plan.teams.length, plan.pitchCount, plan.roundsPerWeek, plan.startDate, plan.kickoffStartTime, plan.slotMinutes, league.id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { parseFixtureCsv, planFixtureImport, applyFixtureImport, parseDate, parseTime };
