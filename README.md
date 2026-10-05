# Bream Bay Twilight Football

Fixtures, results, standings and knockout brackets for Bream Bay Twilight Football leagues.
Installable as a phone app (PWA). Node + Express + EJS + SQLite (built-in `node:sqlite`, nothing to compile).

## Run it locally

```bash
npm install
cp .env.example .env   # then edit ADMIN_PASSWORD and SESSION_SECRET
npm run dev
```

Needs **Node.js 22.13 or newer** (24 LTS recommended). Public site: `http://localhost:3000`, admin: `/admin`.
Tests: `npm test`.

## Deploying to a server

You need a Linux server with **Node 22.13+** (24 LTS is best), a domain or subdomain pointing at it,
and HTTPS (a Let's Encrypt certificate - the phone "install as app" feature only works over HTTPS).

1. **Upload the code** (the zip from `git archive`, or `git clone`) to e.g. `/home/APPUSER/bream-bay/app`.
   Don't upload `node_modules`, `.env` or `data/`.
2. **Install**: `cd app && npm ci --omit=dev`
3. **Create `/home/APPUSER/bream-bay/.env`** (outside the app folder) - see `.env.example`:
   ```
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   ADMIN_PASSWORD=<10+ characters>
   SESSION_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   DATABASE_PATH=/home/APPUSER/bream-bay/data/bream-bay.sqlite
   ```
   In production the app refuses to start with weak or placeholder secrets. The database lives
   outside the app folder so re-uploading new code never touches your data.
4. **Keep it running** with PM2 (or a systemd service / your panel's Node app feature):
   ```bash
   npm i -g pm2
   pm2 start src/server.js --name bb-twilight --node-args="--env-file=/home/APPUSER/bream-bay/.env"
   pm2 save && pm2 startup     # restart on reboot
   ```
   (`--env-file` needs Node 20.6+. Alternatively run from a folder containing the `.env`.)
5. **Reverse proxy**: point the domain at `http://127.0.0.1:3000` (Nginx `proxy_pass`), and make sure
   it sends `X-Forwarded-Proto` and `X-Forwarded-For` (the standard `proxy_set_header` lines).
   Enable HTTPS on that site. The app trusts one proxy hop.
6. **Backups**: nightly cron, e.g.
   `15 2 * * * cd /home/APPUSER/bream-bay/app && node --env-file=/home/APPUSER/bream-bay/.env scripts/backup.js`
   (writes dated snapshots to a `backups/` folder next to the database, keeping the latest 30; safe to
   run while the app is live). Copy that folder off the server occasionally.
7. **Updating later**: upload the new code, `npm ci --omit=dev`, `pm2 restart bb-twilight`.
   Phones pick up new CSS/JS on their next visit.

### First-night setup (in `/admin`)

1. Create the league (8 teams, 4 pitches, 3 rounds/week) - teams start as "Team 1-8"; rename them any time.
2. **Schedule** -> first match night, first kickoff time, minutes per round -> *Generate*.
   Renaming teams or adding players afterwards is fine; *regenerating* the schedule wipes results.
3. Enter results under **Results**; when the group stage is done, generate the Cup/Plate brackets.

### Good to know

- The admin is logged out when the app restarts (sessions are in memory). Ten wrong passwords locks
  an IP out of login for 15 minutes.
- Public pages show players as first name + last initial only.
