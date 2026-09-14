const path = require('path');
const express = require('express');
const session = require('express-session');

const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 12 }, // 12 hours
  })
);

app.locals.appName = 'Bream Bay Twilight Football';

app.use('/', publicRoutes);
app.use('/admin', adminRoutes);

app.use((req, res) => {
  res.status(404).render('404');
});

module.exports = app;
