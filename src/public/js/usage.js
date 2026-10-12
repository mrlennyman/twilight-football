/*
 * Anonymous install / usage counter. Tells the server, at most once a day, whether this phone opened the site as
 * the installed app or in a browser, using a random id stored on the phone itself - no names, no accounts.
 */
(function () {
  if (location.pathname.indexOf('/admin') === 0) return;
  var ID_KEY = 'bb-device';
  var SENT_KEY = 'bb-usage-sent';

  function randomId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function read(key) {
    try { return window.localStorage.getItem(key); } catch (err) { return null; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (err) { /* private mode: counted again next visit */ }
  }

  var id = read(ID_KEY);
  if (!id) {
    id = randomId();
    write(ID_KEY, id);
  }

  var standalone =
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  var mode = standalone ? 'app' : 'web';

  function send(event) {
    var body = new URLSearchParams({ id: id, mode: mode, event: event }).toString();
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/api/usage', new Blob([body], { type: 'application/x-www-form-urlencoded' }))) return;
    } catch (err) { /* fall through to fetch */ }
    try {
      fetch('/api/usage', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body, keepalive: true });
    } catch (err) { /* counting is best-effort */ }
  }

  // One "open" report per mode per local day.
  var today = new Date().toISOString().slice(0, 10) + ':' + mode;
  if (read(SENT_KEY) !== today) {
    write(SENT_KEY, today);
    send('open');
  }

  // Android Chrome and friends tell us the moment the app is installed.
  window.addEventListener('appinstalled', function () {
    send('installed');
  });
})();
