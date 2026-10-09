const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { snapshot, nightly, newestBackup } = require('../src/lib/backup');

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.exec('INSERT INTO t VALUES (42)');
  return db;
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bbbk-'));

test('snapshot writes a restorable pre-<label> copy', () => {
  const dir = tmp();
  const file = snapshot(makeDb(), 'regenerate', { dir, now: new Date('2026-10-14T05:06:07Z') });
  assert.equal(path.basename(file), 'bream-bay-pre-regenerate-2026-10-14-050607.sqlite');
  const copy = new DatabaseSync(file);
  assert.equal(copy.prepare('SELECT x FROM t').get().x, 42);
  copy.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('snapshot keeps only the newest N pre- files and never touches nightly copies', () => {
  const dir = tmp();
  const db = makeDb();
  nightly(db, { dir, now: new Date('2026-10-01T03:00:00Z') });
  for (let i = 0; i < 5; i++) {
    snapshot(db, i % 2 ? 'delete' : 'regenerate', { dir, keep: 3, now: new Date(Date.UTC(2026, 9, 10, 12, 0, i)) });
  }
  const files = fs.readdirSync(dir).sort();
  const pre = files.filter((f) => f.startsWith('bream-bay-pre-'));
  assert.equal(pre.length, 3);
  assert.ok(pre.every((f) => /-1[0-9]{5}\.sqlite$/.test(f)));
  assert.deepEqual(pre.map((f) => f.slice(-13, -7)).sort(), ['120002', '120003', '120004']);
  assert.equal(files.filter((f) => !f.startsWith('bream-bay-pre-')).length, 1, 'nightly copy untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nightly prunes only nightly copies; same-second snapshots overwrite instead of failing', () => {
  const dir = tmp();
  const db = makeDb();
  snapshot(db, 'x', { dir, now: new Date('2026-10-10T00:00:00Z') });
  snapshot(db, 'x', { dir, now: new Date('2026-10-10T00:00:00Z') });
  for (let d = 1; d <= 4; d++) nightly(db, { dir, keep: 2, now: new Date(`2026-10-0${d}T03:00:00Z`) });
  const files = fs.readdirSync(dir);
  assert.equal(files.filter((f) => /^bream-bay-\d/.test(f)).length, 2);
  assert.equal(files.filter((f) => f.startsWith('bream-bay-pre-')).length, 1);
  assert.ok(newestBackup(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('label is sanitised so it cannot escape the backup folder', () => {
  const dir = tmp();
  const file = snapshot(makeDb(), '../../evil name', { dir });
  assert.equal(path.dirname(file), dir);
  assert.ok(!path.basename(file).includes('..'));
  fs.rmSync(dir, { recursive: true, force: true });
});
