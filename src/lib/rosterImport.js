/**
 * Create a whole league from a CSV: one row per player, with the team in the first column.
 *
 *   team,player,kit
 *   Rovers,Jack Brown,Red
 *   Rovers,Sam Lee,
 *   Wanderers,Mia Chen,Blue
 *
 * The header row is optional. "player" and "kit" may be left blank (a team with no players yet).
 */
const { seedStarterPages } = require('./pages');

const MAX_TEAMS = 32;
const MAX_PLAYERS_PER_TEAM = 40;
const MAX_ROWS = 2000;

/** Minimal CSV reader: quoted fields, "" escapes, CRLF/LF, BOM, comma/semicolon/tab separated. */
function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0];
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  const delimiter = Object.keys(counts).reduce((best, d) => (counts[d] > counts[best] ? d : best), ',');

  const rows = [];
  let row = [];
  let field = '';
  inQuotes = false;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.some((cell) => cell.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      endField();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  endRow();
  return rows;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Turns CSV text into { errors, teams: [{ name, kit, players: [] }] }. */
function parseRosterCsv(text, { checkTeamCount = true } = {}) {
  const errors = [];
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { errors: ['The CSV is empty. Add a row for each player, with the team name first.'], teams: [] };
  }
  if (rows.length > MAX_ROWS) {
    return { errors: [`That CSV has more than ${MAX_ROWS} rows - is it the right file?`], teams: [] };
  }

  let start = 0;
  if (/^(team|team name|teams)$/i.test(clean(rows[0][0]))) start = 1; // header row

  const byKey = new Map();
  for (let i = start; i < rows.length; i++) {
    const line = i + 1;
    const teamName = clean(rows[i][0]);
    const player = clean(rows[i][1]);
    const kit = clean(rows[i][2]);
    if (!teamName) {
      errors.push(`Row ${line}: the team name (first column) is blank.`);
      continue;
    }
    if (teamName.length > 60) errors.push(`Row ${line}: team name is too long (max 60 characters).`);
    if (player.length > 60) errors.push(`Row ${line}: player name is too long (max 60 characters).`);
    if (kit.length > 30) errors.push(`Row ${line}: kit colour is too long (max 30 characters).`);

    const key = teamName.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { name: teamName, kit: '', players: [] });
    const team = byKey.get(key);
    if (kit && !team.kit) team.kit = kit;
    if (player) team.players.push(player);
  }

  const teams = [...byKey.values()];
  for (const team of teams) {
    if (team.players.length > MAX_PLAYERS_PER_TEAM) {
      errors.push(`${team.name} has ${team.players.length} players (max ${MAX_PLAYERS_PER_TEAM}).`);
    }
  }
  if (checkTeamCount && (teams.length < 2 || teams.length > MAX_TEAMS || teams.length % 2 !== 0)) {
    errors.push(`The CSV has ${teams.length} team(s); a league needs an even number of teams from 2 to ${MAX_TEAMS}.`);
  }
  return { errors, teams };
}

/** Creates the league, its teams, players and starter Info pages in one transaction. Returns the league id. */
function createLeagueFromRoster(db, { name, season, numPitches, roundsPerWeek }, teams) {
  db.exec('BEGIN');
  try {
    const have = db.prepare('SELECT COUNT(*) AS c FROM pitches').get().c;
    const insertPitch = db.prepare('INSERT INTO pitches (label) VALUES (?)');
    for (let i = have + 1; i <= numPitches; i++) insertPitch.run(`Pitch ${i}`);

    const info = db
      .prepare(
        `INSERT INTO leagues (name, season, num_teams, num_pitches, rounds_per_week)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, season, teams.length, numPitches, roundsPerWeek);
    const leagueId = Number(info.lastInsertRowid);

    const insertTeam = db.prepare('INSERT INTO teams (league_id, name, kit_colour) VALUES (?, ?, ?)');
    const insertPlayer = db.prepare('INSERT INTO players (team_id, name) VALUES (?, ?)');
    for (const team of teams) {
      const teamId = Number(insertTeam.run(leagueId, team.name, team.kit || null).lastInsertRowid);
      for (const player of team.players) insertPlayer.run(teamId, player);
    }
    seedStarterPages(db, leagueId);
    db.exec('COMMIT');
    return leagueId;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

const KITS = ['Red', 'Blue', 'Green', 'Yellow', 'Black', 'White', 'Orange', 'Purple'];
const sampleRows = [];
for (let t = 0; t < 8; t++) {
  for (let p = 0; p < 6; p++) {
    sampleRows.push(`Team ${t + 1},Player ${p + 1} ${String.fromCharCode(65 + t)}.,${p === 0 ? KITS[t] : ''}`);
  }
}
const SAMPLE_CSV = ['team,player,kit', ...sampleRows].join('\r\n') + '\r\n';

module.exports = { parseCsv, parseRosterCsv, createLeagueFromRoster, SAMPLE_CSV, MAX_TEAMS };
