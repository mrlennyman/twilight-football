const path = require('path');

// Anchored to the app folder (not the process's working directory) so it behaves
// the same however the app is started - a process manager may start it from anywhere.
const APP_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DB_PATH = path.join(APP_ROOT, 'data', 'bream-bay.sqlite');

function resolveDbPath(value) {
  return value ? path.resolve(value) : DEFAULT_DB_PATH;
}

module.exports = { APP_ROOT, DEFAULT_DB_PATH, resolveDbPath };
