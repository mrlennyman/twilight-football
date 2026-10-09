const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const { SqliteSessionStore } = require('./lib/sqliteSessionStore');
const { resolveDbPath } = require('./lib/paths');

const { formatDate, formatTime } = require('./lib/format');
const { resolveNavTabs } = require('./lib/navTabs');
const { parseTrustProxy } = require('./lib/proxy');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();

// Behind the host's reverse proxies so req.ip / req.secure are the real client's. The number is how many
// proxies sit in front of Node (OpenLiteSpeed = 1; Cloudflare + OpenLiteSpeed = 2). Check /admin/diagnostics
// and set TRUST_PROXY in .env if req.ip is not your own address.
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.disable('x-powered-by');

// Kids' first names are on public pages: keep search engines out. (Done with a header and a meta tag,
// not a robots.txt Disallow - a blocked crawler would never see the noindex.)
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  // Basic hardening headers. (No Content-Security-Policy yet: the admin error page uses a javascript: back link.)
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// Sessions live in data/sessions.sqlite (beside the database), so a restart or deploy doesn't log the admin out.
const sessionStore = new SqliteSessionStore({
  file: path.join(path.dirname(resolveDbPath(process.env.DATABASE_PATH)), 'sessions.sqlite'),
});
app.locals.sessionStore = sessionStore;

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    rolling: true, // each visit extends the 12 hours
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      httpOnly: true,
      sameSite: 'lax', // also blocks cross-site form posts to the admin
      secure: 'auto', // Secure over HTTPS, still works on plain-HTTP localhost
    },
  })
);

// Absolute address of this site (used for link previews in Messenger etc.); trust proxy makes it https.
app.use((req, res, next) => {
  res.locals.baseUrl = `${req.protocol}://${req.get('host')}`;
  res.locals.currentPath = req.path === '/' ? '' : req.path;
  next();
});

app.locals.appName = 'Bream Bay Twilight Football';
app.locals.formatDate = formatDate;
app.locals.formatTime = formatTime;

// Stylesheet/script URLs carry a fingerprint of their contents, so after a deploy every browser
// (and Cloudflare) fetches the new file instead of reusing a copy cached for hours.
const publicDir = path.join(__dirname, 'public');
const fingerprint = crypto.createHash('md5');
for (const file of ['css/style.css', 'css/print.css', 'js/register-sw.js', 'js/install.js']) {
  fingerprint.update(fs.readFileSync(path.join(publicDir, file)));
}
app.locals.assetVersion = fingerprint.digest('hex').slice(0, 10);
app.locals.resolveNavTabs = resolveNavTabs;

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500) console.error(err);
  const message =
    status === 413
      ? 'That is too much text to save in one go (the limit is about 100 KB). Please shorten it.'
      : status >= 500
        ? 'Something went wrong. Please try again.'
        : 'That request could not be understood. Please go back and try again.';
  res.status(status).send(message);
});

module.exports = app;
