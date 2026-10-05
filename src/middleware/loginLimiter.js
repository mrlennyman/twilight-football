/** In-memory throttle for failed admin logins, keyed by client IP. */

function createLimiter({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
  }

  return {
    check(key, now = Date.now()) {
      prune(now);
      const entry = entries.get(key);
      if (!entry || entry.count < max) return { blocked: false, retryAfterSec: 0 };
      return { blocked: true, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
    },
    recordFailure(key, now = Date.now()) {
      prune(now);
      const entry = entries.get(key) || { count: 0, resetAt: now + windowMs };
      entry.count += 1;
      entries.set(key, entry);
    },
    reset(key) {
      entries.delete(key);
    },
  };
}

module.exports = { createLimiter };
