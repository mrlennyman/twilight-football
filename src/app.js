const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');

const { formatDate, formatTime } = require('./lib/format');
const { resolveNavTabs } = require('./lib/navTabs');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();

// Behind the host's reverse proxy (Nginx etc.) so req.ip / req.secure are the real client's.
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
      httpOnly: true,
      sameSite: 'lax', // also blocks cross-site form posts to the admin
      secure: 'auto', // Secure over HTTPS, still works on plain-HTTP localhost
    },
  })
);

app.locals.appName = 'Bream Bay Twilight Football';
app.locals.formatDate = formatDate;
app.locals.formatTime = formatTime;

// Stylesheet/script URLs carry a fingerprint of their contents, so after a deploy every browser
// (and Cloudflare) fetches the new file instead of reusing a copy cached for hours.
const publicDir = path.join(__dirname, 'public');
const fingerprint = crypto.createHash('md5');
for (const file of ['css/style.css', 'css/print.css', 'js/register-sw.js']) {
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
