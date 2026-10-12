const test = require('node:test');
const assert = require('node:assert/strict');
const { detectPlatform, isDismissed } = require('../src/public/js/install');

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0 Mobile/15E148 Safari/604.1',
  iphoneMessenger: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/450.0;FBBV/1;FBDV/iPhone14,2]',
  iphoneFacebook: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]',
  iphoneInstagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  androidMessenger: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 [FB_IAB/Orca-Android;FBAV/450.0;]',
  androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
};

test('detects the right install path for each browser', () => {
  assert.equal(detectPlatform(UA.iphoneSafari), 'ios');
  assert.equal(detectPlatform(UA.iphoneChrome), 'ios');
  assert.equal(detectPlatform(UA.androidChrome), 'android');
  assert.equal(detectPlatform(UA.desktopChrome), 'other');
  assert.equal(detectPlatform(UA.ipadAsMac, { touchPoints: 5 }), 'ios');
  assert.equal(detectPlatform(UA.ipadAsMac, { touchPoints: 0 }), 'other');
});

test('messenger / facebook / instagram / webviews are flagged as in-app browsers', () => {
  for (const key of ['iphoneMessenger', 'iphoneFacebook', 'iphoneInstagram', 'androidMessenger', 'androidWebView']) {
    assert.equal(detectPlatform(UA[key]), 'inapp', key);
  }
});

test('an installed app (standalone) never shows install prompts', () => {
  assert.equal(detectPlatform(UA.iphoneSafari, { standalone: true }), 'standalone');
  assert.equal(detectPlatform(UA.androidChrome, { standalone: true }), 'standalone');
});

test('dismissal is remembered for 14 days and storage errors are harmless', () => {
  const now = Date.now();
  const store = (value) => ({ getItem: () => value });
  assert.equal(isDismissed(store(String(now - 3 * 24 * 3600 * 1000)), now), true);
  assert.equal(isDismissed(store(String(now - 15 * 24 * 3600 * 1000)), now), false);
  assert.equal(isDismissed(store(null), now), false);
  assert.equal(isDismissed({ getItem() { throw new Error('blocked'); } }, now), false);
});

const BROWSERS = {
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  androidDuckDuckGo: 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 DuckDuckGo/5',
  iphoneDuckDuckGo: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 Ddg/17.4',
  iphoneFirefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
};

test('Firefox and DuckDuckGo are treated as real browsers, not as in-app browsers', () => {
  const { detectBrowser } = require('../src/public/js/install');
  assert.equal(detectPlatform(BROWSERS.androidFirefox), 'android');
  assert.equal(detectPlatform(BROWSERS.androidDuckDuckGo), 'android');
  assert.equal(detectPlatform(BROWSERS.iphoneFirefox), 'ios');
  assert.equal(detectBrowser(BROWSERS.androidFirefox), 'firefox');
  assert.equal(detectBrowser(BROWSERS.iphoneFirefox), 'firefox');
  assert.equal(detectBrowser(BROWSERS.androidDuckDuckGo), 'duckduckgo');
  assert.equal(detectBrowser(BROWSERS.iphoneDuckDuckGo), 'duckduckgo');
  assert.equal(detectBrowser(BROWSERS.androidSamsung), 'samsung');
  assert.equal(detectBrowser(UA.androidChrome), 'chrome');
  assert.equal(detectBrowser(UA.iphoneChrome), 'chrome');
  assert.equal(detectBrowser(UA.iphoneSafari), 'safari');
  // genuine in-app browsers are still caught
  assert.equal(detectPlatform(UA.androidMessenger), 'inapp');
});
