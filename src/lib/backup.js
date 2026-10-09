/**
 * Consistent snapshots of the live SQLite database (VACUUM INTO is safe while the app runs).
 *  - nightly(): the dated copies `npm run backup` / the cron job makes (kept: 30)
 *  - snapshot(): an automatic copy taken just before a destructive admin action (kept: 20)
 * VACUUM cannot run inside a transaction, so call these before opening one.
 */
const fs = require('fs');
const path = require('path');
const { resolveDbPath } = require('./paths');

const NIGHTLY_RE = /^bream-bay-\d{4}-.*\.sqlite$/;
const PRE_RE = /^bream-bay-pre-.*-(\d{4}-\d{2}-\d{2}-\d{6})\.sqlite$/;

function defaultBackupDir(env = process.env) {
  if (env.BACKUP_DIR) return path.resolve(env.BACKUP_DIR);
  return path.join(path.dirname(resolveDbPath(env.DATABASE_PATH)), 'backups');
}

function vacuumInto(db, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest); // VACUUM INTO refuses to overwrite
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** YYYY-MM-DD-HHmmss in UTC */
function stamp(date = new Date()) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function prune(dir, matches, sortKey, keep) {
  const files = fs.readdirSync(dir).filter(matches).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const old of files.slice(0, Math.max(0, files.length - keep))) {
    fs.unlinkSync(path.join(dir, old));
  }
}

/** Automatic safety copy before something destructive. Returns the file path. */
function snapshot(db, label, { dir = defaultBackupDir(), keep = 20, now = new Date() } = {}) {
  const safeLabel = String(label).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30) || 'manual';
  const dest = path.join(dir, `bream-bay-pre-${safeLabel}-${stamp(now)}.sqlite`);
  vacuumInto(db, dest);
  prune(dir, (f) => PRE_RE.test(f), (f) => PRE_RE.exec(f)[1], keep);
  return dest;
}

/** The dated nightly copy. Returns the file path. */
function nightly(db, { dir = defaultBackupDir(), keep = 30, now = new Date() } = {}) {
  const dest = path.join(dir, `bream-bay-${now.toISOString().slice(0, 16).replace(/[T:]/g, '-')}.sqlite`);
  vacuumInto(db, dest);
  prune(dir, (f) => NIGHTLY_RE.test(f), (f) => f, keep);
  return dest;
}

/** Newest backup of any kind in the folder: { name, mtimeMs } or null. */
function newestBackup(dir = defaultBackupDir()) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /^bream-bay-.*\.sqlite$/.test(f))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files[0] || null;
  } catch (err) {
    return null;
  }
}

module.exports = { defaultBackupDir, snapshot, nightly, newestBackup, stamp };
