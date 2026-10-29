const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { resolveDbPath } = require('../lib/paths');

const resolvedPath = resolveDbPath(process.env.DATABASE_PATH);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

const db = new DatabaseSync(resolvedPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3);
// polyfill the same call shape so the rest of the app can use it unchanged.
db.transaction = function transaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
};

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Databases created before a column existed: CREATE TABLE IF NOT EXISTS won't add it.
const leagueColumns = db.prepare('PRAGMA table_info(leagues)').all().map((c) => c.name);
if (!leagueColumns.includes('nav_tabs')) db.exec('ALTER TABLE leagues ADD COLUMN nav_tabs TEXT');
if (!leagueColumns.includes('standings_split')) db.exec('ALTER TABLE leagues ADD COLUMN standings_split TEXT');
if (!leagueColumns.includes('hidden')) db.exec('ALTER TABLE leagues ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
const playerColumns = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (!playerColumns.includes('is_captain')) db.exec('ALTER TABLE players ADD COLUMN is_captain INTEGER NOT NULL DEFAULT 0');
const matchColumns = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
if (!matchColumns.includes('updated_at')) db.exec('ALTER TABLE matches ADD COLUMN updated_at TEXT');

if (!leagueColumns.includes('finals_blurb')) db.exec('ALTER TABLE leagues ADD COLUMN finals_blurb TEXT');
if (!leagueColumns.includes('finals_format')) db.exec('ALTER TABLE leagues ADD COLUMN finals_format TEXT');

// Databases created before the Bowl existed have a CHECK on rounds.stage that only allows group/cup/plate. SQLite can't
// change a CHECK in place, so rebuild the table (same columns, same ids) - after taking a safety copy.
const roundsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rounds'").get().sql;
if (!roundsSql.includes("'bowl'")) {
  try {
    require('../lib/backup').snapshot(db, 'pre-bowl-migration');
  } catch (err) {
    console.error('Could not save a safety copy before the database update:', err.message);
  }
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`CREATE TABLE rounds_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id INTEGER NOT NULL REFERENCES leagues(id) ON DELETE CASCADE,
      round_number INTEGER NOT NULL,
      week_number INTEGER NOT NULL,
      stage TEXT NOT NULL DEFAULT 'group' CHECK (stage IN ('group', 'cup', 'plate', 'bowl')),
      date TEXT,
      kickoff_time TEXT
    )`);
    db.exec('INSERT INTO rounds_new (id, league_id, round_number, week_number, stage, date, kickoff_time) SELECT id, league_id, round_number, week_number, stage, date, kickoff_time FROM rounds');
    db.exec('DROP TABLE rounds');
    db.exec('ALTER TABLE rounds_new RENAME TO rounds');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rounds_league ON rounds(league_id)');
    if (db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('foreign key check failed after rebuilding rounds');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

const pitchCount = db.prepare('SELECT COUNT(*) AS count FROM pitches').get().count;
if (pitchCount === 0) {
  const insertPitch = db.prepare('INSERT INTO pitches (label) VALUES (?)');
  const seedPitches = db.transaction((labels) => {
    for (const label of labels) insertPitch.run(label);
  });
  seedPitches(['Pitch 1', 'Pitch 2', 'Pitch 3', 'Pitch 4']);
}

module.exports = db;
