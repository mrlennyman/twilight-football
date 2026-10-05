/**
 * Consistent snapshot of the SQLite database (safe while the app is running).
 * Usage: npm run backup        (cron it nightly - see README)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dbPath = path.resolve(process.env.DATABASE_PATH || './data/bream-bay.sqlite');
const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(path.dirname(dbPath), 'backups'));
const keep = Number(process.env.BACKUP_KEEP) || 30;

if (!fs.existsSync(dbPath)) {
  console.error(`No database found at ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
const dest = path.join(backupDir, `bream-bay-${stamp}.sqlite`);
if (fs.existsSync(dest)) fs.unlinkSync(dest); // VACUUM INTO refuses to overwrite

const db = new DatabaseSync(dbPath);
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();

const backups = fs
  .readdirSync(backupDir)
  .filter((f) => /^bream-bay-.*\.sqlite$/.test(f))
  .sort();
for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
  fs.unlinkSync(path.join(backupDir, old));
}

console.log(`Backup written: ${dest} (keeping the latest ${keep})`);
