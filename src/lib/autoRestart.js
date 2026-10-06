const fs = require('fs');
const path = require('path');

/** Newest modification time (ms) of any file under the given files/folders. */
function newestMtime(targets) {
  let newest = 0;
  const visit = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      return; // vanished mid-deploy; the next check will see the settled state
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  };
  targets.forEach(visit);
  return newest;
}

/**
 * Calls onChange once the code on disk has changed (a Git deploy) and then stayed quiet for a
 * full interval, so a deploy that is still copying files never triggers a half-updated restart.
 * Returns a function that stops watching.
 */
function watchForUpdates({ targets, onChange, intervalMs = 15000 }) {
  let baseline = newestMtime(targets);
  let pending = null;
  const timer = setInterval(() => {
    const now = newestMtime(targets);
    if (now === baseline) return;
    if (pending === now) {
      clearInterval(timer);
      onChange();
    } else {
      pending = now; // changed since last look - wait one more interval for it to settle
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { newestMtime, watchForUpdates };
