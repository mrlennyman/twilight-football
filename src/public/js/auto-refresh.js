/*
 * iPhone home-screen apps have no refresh button, so scores can look stale. When the app comes back to the
 * foreground after more than a minute away, reload the page. Public pages only (never loaded in admin).
 */
(function () {
  var AWAY_MS = 60 * 1000;
  var hiddenAt = null;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null) {
      var away = Date.now() - hiddenAt;
      hiddenAt = null;
      if (away > AWAY_MS) window.location.reload();
    }
  });
})();
