const path = require('path');
const express = require('express');
const session = require('express-session');

const { formatDate, formatTime } = require('./lib/format');
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

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('404');
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).send('Something went wrong. Please try again.');
});

module.exports = app;
