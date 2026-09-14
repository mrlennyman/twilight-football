# Bream Bay Twilight Football

Fixtures, results, standings and knockout brackets for Bream Bay Twilight Football leagues.

## Setup

```bash
npm install
cp .env.example .env   # then edit ADMIN_PASSWORD and SESSION_SECRET
npm run dev
```

Requires Node.js 22.5+ (uses the built-in `node:sqlite` module — no native
dependencies to compile).

The app opens at `http://localhost:3000`. Public pages are at `/`, admin is
at `/admin` (password from `ADMIN_PASSWORD` in `.env`).

## Running the tests

```bash
npm test
```

Covers the round-robin schedule generator: every team plays every other team
home and away exactly once, no team is double-booked in a round, and weeks
split correctly.

## Data

SQLite file lives at the path in `DATABASE_PATH` (default `./data/bream-bay.sqlite`).
Back it up before any schema changes if this is running in production.

## Deploying

Any host that runs Node 22.5+ works (Vultr/RunCloud, a VPS, etc). Set
`ADMIN_PASSWORD` and `SESSION_SECRET` to real values in the server's
environment — don't reuse the ones generated for local development.
