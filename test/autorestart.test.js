const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newestMtime, watchForUpdates } = require('../src/lib/autoRestart');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('newestMtime finds the newest file, ignores missing paths', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbar-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'sub', 'b.js'), 'b');
  fs.utimesSync(path.join(dir, 'a.js'), 1000, 1000);
  fs.utimesSync(path.join(dir, 'sub', 'b.js'), 2000, 2000);
  assert.equal(newestMtime([dir, path.join(dir, 'nope')]), 2000 * 1000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('fires once after a change has settled, not on quiet or still-changing code', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bbar-'));
  const file = path.join(dir, 'app.js');
  fs.writeFileSync(file, '1');
  fs.utimesSync(file, 1000, 1000);
  let fired = 0;
  const stop = watchForUpdates({ targets: [dir], intervalMs: 40, onChange: () => fired++ });

  await sleep(150);
  assert.equal(fired, 0, 'no change -> no restart');

  fs.utimesSync(file, 2000, 2000); // deploy starts
  await sleep(50);
  fs.utimesSync(file, 3000, 3000); // ...still copying files
  await sleep(50);
  assert.equal(fired, 0, 'must wait while files are still changing');

  await sleep(250);
  assert.equal(fired, 1, 'fires once the update has settled');
  stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
