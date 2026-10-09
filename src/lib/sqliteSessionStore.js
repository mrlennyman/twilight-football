/**
 * express-session store backed by a small SQLite file, so an admin stays logged in across restarts
 * and deploys. Kept in its own file (not the main database) so backups of the results never contain
 * login tokens and session writes never touch the results database.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Store } = require('express-session');

const PRUNE_EVERY_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

class SqliteSessionStore extends Store {
  constructor({ file, now = () => Date.now() }) {
    super();
    this.now = now;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)'
    );
    this.getStmt = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)');
    this.touchStmt = this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.deleteStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.pruneStmt = this.db.prepare('DELETE FROM sessions WHERE expires <= ?');

    this.prune();
    this.timer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
    this.timer.unref();
  }

  expiryOf(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    const at = expires ? new Date(expires).getTime() : NaN;
    return Number.isFinite(at) ? at : this.now() + DEFAULT_TTL_MS;
  }

  prune() {
    this.pruneStmt.run(this.now());
  }

  // Callbacks are called asynchronously, as express-session expects of a store.
  get(sid, cb) {
    let result = null;
    let error = null;
    try {
      const row = this.getStmt.get(sid, this.now());
      if (row) result = JSON.parse(row.sess);
    } catch (err) {
      // A corrupt row is treated as "no session" rather than breaking the request.
      result = null;
      this.deleteStmt.run(sid);
    }
    setImmediate(() => cb(error, result));
  }

  set(sid, sess, cb) {
    let error = null;
    try {
      this.setStmt.run(sid, JSON.stringify(sess), this.expiryOf(sess));
    } catch (err) {
      error = err;
    }
    setImmediate(() => cb && cb(error));
  }

  touch(sid, sess, cb) {
    let error = null;
    try {
      this.touchStmt.run(this.expiryOf(sess), sid);
    } catch (err) {
      error = err;
    }
    setImmediate(() => cb && cb(error));
  }

  destroy(sid, cb) {
    let error = null;
    try {
      this.deleteStmt.run(sid);
    } catch (err) {
      error = err;
    }
    setImmediate(() => cb && cb(error));
  }

  close() {
    clearInterval(this.timer);
    this.db.close();
  }
}

module.exports = { SqliteSessionStore };
