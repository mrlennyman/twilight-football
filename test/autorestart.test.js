const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newestMtime, createUpdateChecker, watchForUpdates } = require('../src/lib/autoRestart');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bbar-'));
}

test('newestMtime finds the newest file, ignores missing paths', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'b');
  fs.utimesSync(path.join(dir, 'a.js'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'sub', 'b.js'), 2000, 2000);
  assert.equal(newestMtime([dir, path.join(dir, 'nope')]), 2000 * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restart fires once, only after a change has stayed the same for two checks (no timers involved)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, '1');
  fs.utimesSync(file, 1000, 1000);
  let fired = 0;
  const check = createUpdateChecker({ targets: [dir], onChange: () => fired++ });

  assert.equal(check(), false);
  assert.equal(check(), false);
  assert.equal(fired, 0, 'no change -> no restart');

  fs.utimesSync(file, 2000, 2000); // deploy starts
  assert.equal(check(), false);
  fs.utimesSync(file, 3000, 3000); // ...still copying files
  assert.equal(check(), false);
  assert.equal(fired, 0, 'must wait while files are still changing');

  assert.equal(check(), true, 'second look at the same new state fires');
  assert.equal(fired, 1);
  assert.equal(check(), false, 'never fires twice');
  assert.equal(fired, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a change that is reverted before it settles does not restart', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, '1');
  fs.utimesSync(file, 1000, 1000);
  let fired = 0;
  const check = createUpdateChecker({ targets: [dir], onChange: () => fired++ });
  fs.utimesSync(file, 2000, 2000);
  check();
  fs.utimesSync(file, 1000, 1000);
  check();
  check();
  assert.equal(fired, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchForUpdates wires the checker to a timer and can be stopped', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  const stop = watchForUpdates({ targets: [dir], onChange: () => {}, intervalMs: 1000 });
  assert.equal(typeof stop, 'function');
  stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
