require('dotenv').config();

if (!process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET) {
  console.error('ADMIN_PASSWORD and SESSION_SECRET must be set (see .env.example).');
  process.exit(1);
}

const app = require('./app');

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bream Bay Twilight Football running at http://localhost:${port}`);
});
