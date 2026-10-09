/**
 * Consistent snapshot of the SQLite database (safe while the app is running).
 * Usage: npm run backup        (cron it nightly - see README)
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { DatabaseSync } = require('node:sqlite');
const { resolveDbPath } = require('../src/lib/paths');
const { nightly, defaultBackupDir } = require('../src/lib/backup');

const dbPath = resolveDbPath(process.env.DATABASE_PATH);
const keep = Number(process.env.BACKUP_KEEP) || 30;

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const dest = nightly(db, { dir: defaultBackupDir(), keep });
db.close();

console.log(`Backup written: ${dest} (keeping the latest ${keep})`);
