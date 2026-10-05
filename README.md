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

## Deploying on RunCloud

You need a RunCloud-managed server, a domain or subdomain pointing at it, and SSH access.
HTTPS matters: the phone "install as app" feature only works over HTTPS.

Throughout, `APPUSER` is the system user the web app runs as and `APP` is the web app's folder.

1. **Create the web application** in RunCloud: *Web Applications -> Create*, choose the stack
   **Native NGINX + Custom Config**, set the domain and user, mode *Production*. Leave it empty.
2. **Install Node 22.13 or newer over SSH** (24 LTS is best). RunCloud documents the NodeSource method:
   <https://runcloud.io/docs/install-and-run-nodejs> - their example installs Node 20, so set
   `NODE_MAJOR=24` instead. Check with `node -v`.
3. **Upload the code**: unzip `bream-bay-twilight-football-deploy.zip` into the web app's folder
   (File Manager or SFTP). It contains no passwords, no data and no `node_modules`.
4. **Install**: `cd APP && npm ci --omit=dev`
5. **Create `/home/APPUSER/bream-bay/.env`** (outside the app folder - `mkdir -p /home/APPUSER/bream-bay/data`):
   ```
   NODE_ENV=production
   HOST=127.0.0.1
   PORT=3000
   ADMIN_PASSWORD=<10+ characters>
   SESSION_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
   DATABASE_PATH=/home/APPUSER/bream-bay/data/bream-bay.sqlite
   ```
   In production the app refuses to start with weak or placeholder secrets. The database lives
   outside the app folder so uploading new code never touches your data.
6. **Keep it running** with a RunCloud **Supervisor** job (or PM2 if you prefer):
   user `APPUSER`, directory = the app folder, command
   `node --env-file=/home/APPUSER/bream-bay/.env src/server.js`
   (use the full path from `which node` if the job can't find `node`).
7. **Proxy the domain to it**: open the web app -> *Settings -> NGINX Config -> Add a New Config ->
   Predefined Config -> Proxy configuration*, enter port `3000`, then *Run and Debug* and *Create Config*.
   Then turn on the free Let's Encrypt certificate for the web app in RunCloud's SSL settings.
8. **Backups**: add a RunCloud *Cron Job* (nightly) running
   `cd /home/APPUSER/APP && node --env-file=/home/APPUSER/bream-bay/.env scripts/backup.js`
   (writes dated snapshots into `/home/APPUSER/bream-bay/data/backups`, keeping the latest 30; safe while
   the app is live). Copy that folder off the server occasionally.
9. **Updating later**: upload the new code over the old, `npm ci --omit=dev`, restart the Supervisor job.
   Phones pick up changes on their next visit.

If login ever says "Too many failed attempts" for everyone, the proxy isn't passing the visitor's address
through (`X-Forwarded-For`), so all visitors look like one address. Restarting the app clears it; tell me
and I'll adjust the proxy config.

## First-night setup (in `/admin`)

1. **Create the league** (8 teams, 4 pitches, 3 rounds per week). Teams start as "Team 1-8"; rename them any time.
2. **Schedule** -> first match night, then *Generate*. Renaming teams afterwards is fine;
   *regenerating* the schedule wipes all results.
3. **Info pages** -> add the starter pages (Rules, Referee guide, Parents and supporters) as drafts, edit them,
   and tick *Published* when ready. The *Info* tab only appears on the public site once something is published.
4. Enter scores under **Results**; when the group stage is done, generate the Cup/Plate brackets.

## Good to know

- Match times aren't shown to parents - just the date and round order. The first kickoff and minutes between
  rounds are still stored on record, ready if a later league needs them shown.
- The admin is logged out when the app restarts (sessions are in memory). Ten wrong passwords locks
  an IP out of login for 15 minutes.
- Public pages show players as first name + last initial only.
