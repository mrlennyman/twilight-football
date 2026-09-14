const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.DATABASE_PATH || './data/bream-bay.sqlite';
const resolvedPath = path.resolve(dbPath);
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

const pitchCount = db.prepare('SELECT COUNT(*) AS count FROM pitches').get().count;
if (pitchCount === 0) {
  const insertPitch = db.prepare('INSERT INTO pitches (label) VALUES (?)');
  const seedPitches = db.transaction((labels) => {
    for (const label of labels) insertPitch.run(label);
  });
  seedPitches(['Pitch 1', 'Pitch 2', 'Pitch 3', 'Pitch 4']);
}

module.exports = db;
