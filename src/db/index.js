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
const playerColumns = db.prepare('PRAGMA table_info(players)').all().map((c) => c.name);
if (!playerColumns.includes('is_captain')) db.exec('ALTER TABLE players ADD COLUMN is_captain INTEGER NOT NULL DEFAULT 0');
const matchColumns = db.prepare('PRAGMA table_info(matches)').all().map((c) => c.name);
if (!matchColumns.includes('updated_at')) db.exec('ALTER TABLE matches ADD COLUMN updated_at TEXT');

const pitchCount = db.prepare('SELECT COUNT(*) AS count FROM pitches').get().count;
if (pitchCount === 0) {
  const insertPitch = db.prepare('INSERT INTO pitches (label) VALUES (?)');
  const seedPitches = db.transaction((labels) => {
    for (const label of labels) insertPitch.run(label);
  });
  seedPitches(['Pitch 1', 'Pitch 2', 'Pitch 3', 'Pitch 4']);
}

module.exports = db;
