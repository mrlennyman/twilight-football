/*
 * "Get the app" helper. A website can't be installed in one click from a link - the phone only
 * allows it after a tap - so this makes that tap as short as possible:
 *   Android Chrome: real one-tap Install button    iPhone: shows the Share > Add to Home Screen steps
 *   Messenger/Facebook/Instagram mini-browsers: install is impossible there, so "Open in your browser"
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BBInstall = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DISMISS_KEY = 'bb-install-dismissed';
  var DISMISS_DAYS = 14;

  /** 'standalone' | 'inapp' | 'ios' | 'android' | 'other' */
  function detectPlatform(ua, opts) {
    opts = opts || {};
    if (opts.standalone) return 'standalone';
    ua = String(ua || '');
    // Mini-browsers inside messaging/social apps can't install anything.
    if (/FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram|Line\/|MicroMessenger|Snapchat|Twitter|TikTok|; wv\)/i.test(ua)) return 'inapp';
    if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && opts.touchPoints > 1)) return 'ios';
    if (/Android/i.test(ua)) return 'android';
    return 'other';
  }

  function isDismissed(storage, now) {
    try {
      var at = Number(storage.getItem(DISMISS_KEY));
      return !!at && now - at < DISMISS_DAYS * 24 * 3600 * 1000;
    } catch (err) {
      return false;
    }
  }

  function run() {
    var doc = document;
    var path = location.pathname;
    if (path.indexOf('/admin') === 0) return;

    var standalone =
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    var platform = detectPlatform(navigator.userAgent, { standalone: standalone, touchPoints: navigator.maxTouchPoints });
    var onInstallPage = path === '/install';
    var deferredPrompt = null;
    var banner = null;

    // The /install page shows only the instructions that fit this device (all show if scripts are off).
    doc.documentElement.setAttribute('data-install-platform', platform);
    doc.querySelectorAll('[data-show-for]').forEach(function (el) {
      var target = el.getAttribute('data-show-for');
      var unknownPhone = platform === 'inapp' && (target === 'ios' || target === 'android');
      el.hidden = !(target === platform || unknownPhone);
    });

    function remember() {
      try {
        localStorage.setItem(DISMISS_KEY, String(Date.now()));
      } catch (err) {
        /* private mode - the banner just comes back next visit */
      }
    }

    function closeBanner(rememberIt) {
      if (rememberIt) remember();
      if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
      banner = null;
    }

    function copyLink(button) {
      var url = location.origin + '/install';
      var done = function () {
        button.textContent = 'Link copied';
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () {
          window.prompt('Copy this link:', url);
        });
      } else {
        window.prompt('Copy this link:', url);
      }
    }

    function showBanner(kind) {
      if (banner || onInstallPage) return;
      if (isDismissed(window.localStorage, Date.now())) return;
      banner = doc.createElement('div');
      banner.className = 'install-banner';
      banner.setAttribute('role', 'region');
      banner.setAttribute('aria-label', 'Install the app');

      var text = doc.createElement('div');
      text.className = 'install-banner-text';
      var action = null;

      if (kind === 'prompt') {
        text.innerHTML = '<strong>Get the app</strong><span>Add Twilight Football to your home screen.</span>';
        action = doc.createElement('button');
        action.type = 'button';
        action.textContent = 'Install';
        action.addEventListener('click', function () {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function () {
            deferredPrompt = null;
            closeBanner(false);
          });
        });
      } else if (kind === 'ios') {
        text.innerHTML = '<strong>Get the app</strong><span>Tap <b>Share</b>, then <b>Add to Home Screen</b>.</span>';
        action = doc.createElement('a');
        action.href = '/install';
        action.textContent = 'Show me';
      } else if (kind === 'inapp') {
        text.innerHTML = '<strong>Get the app</strong><span>Open this page in Safari or Chrome to install it.</span>';
        action = doc.createElement('button');
        action.type = 'button';
        action.textContent = 'Copy link';
        action.addEventListener('click', function () {
          copyLink(action);
        });
      } else {
        text.innerHTML = '<strong>Get the app</strong><span>Add Twilight Football to your home screen.</span>';
        action = doc.createElement('a');
        action.href = '/install';
        action.textContent = 'How?';
      }

      var close = doc.createElement('button');
      close.type = 'button';
      close.className = 'install-banner-close';
      close.setAttribute('aria-label', 'Dismiss');
      close.innerHTML = '&times;';
      close.addEventListener('click', function () {
        closeBanner(true);
      });

      banner.appendChild(text);
      action.className = 'install-banner-action';
      banner.appendChild(action);
      banner.appendChild(close);
      doc.body.appendChild(banner);
    }

    // Android Chrome: the browser hands us a real install prompt we can trigger from our own button.
    window.addEventListener('beforeinstallprompt', function (event) {
      event.preventDefault();
      deferredPrompt = event;
      var button = doc.getElementById('install-now');
      if (button) button.hidden = false;
      closeBanner(false);
      showBanner('prompt');
    });
    window.addEventListener('appinstalled', function () {
      deferredPrompt = null;
      closeBanner(false);
      remember();
    });

    var installNow = doc.getElementById('install-now');
    if (installNow) {
      installNow.addEventListener('click', function () {
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function () {
            deferredPrompt = null;
          });
        }
      });
    }
    var copyButton = doc.getElementById('copy-install-link');
    if (copyButton) {
      copyButton.addEventListener('click', function () {
        copyLink(copyButton);
      });
    }

    if (platform === 'ios') showBanner('ios');
    else if (platform === 'inapp') showBanner('inapp');
    // Android shows its banner when the browser fires beforeinstallprompt (above); desktop shows none.
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
    else run();
  }

  return { detectPlatform: detectPlatform, isDismissed: isDismissed };
});
