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
 * Returns a check() function. Each call looks at the code on disk: onChange fires once, on the second
 * consecutive call that sees the same new state, so a deploy that is still copying files never triggers
 * a half-updated restart. (Separate from the timer so tests can call it directly - no timing involved.)
 */
function createUpdateChecker({ targets, onChange }) {
  const baseline = newestMtime(targets);
  let pending = null;
  let fired = false;
  return function check() {
    if (fired) return false;
    const now = newestMtime(targets);
    if (now === baseline) {
      pending = null;
      return false;
    }
    if (pending === now) {
      fired = true;
      onChange();
      return true;
    }
    pending = now; // changed since last look - wait one more check for it to settle
    return false;
  };
}

/** Runs the checker on a timer. Returns a function that stops watching. */
function watchForUpdates({ targets, onChange, intervalMs = 15000 }) {
  const check = createUpdateChecker({
    targets,
    onChange: () => {
      clearInterval(timer);
      onChange();
    },
  });
  const timer = setInterval(check, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { newestMtime, createUpdateChecker, watchForUpdates };
