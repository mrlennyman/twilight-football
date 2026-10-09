# Bream Bay Twilight Football

Fixtures, results, standings and knockout brackets for Bream Bay Twilight Football leagues.
Installable as a phone app (PWA). Node + Express + EJS + SQLite (built-in `node:sqlite`, nothing to compile).

## Run it locally

```bash
npm install
cp .env.example .env   # then edit ADMIN_PASSWORD
npm run dev
```

Needs **Node.js 22.13 or newer** (24 LTS recommended). Public site: `http://localhost:3000`, admin: `/admin`.
Tests: `npm test`.

## How it is run now (GitHub deploys)

The live site updates itself from GitHub: pushing to the `main` branch triggers a RunCloud webhook that pulls the
code, and the app notices the new files and restarts itself (about 40 seconds). `.env`, the `data` folder (the
database, `sessions.sqlite`, `backups/`) and `node-runtime` (the Linux Node binary) live only on the server and are
never in GitHub. The step-by-step zip guide below is how the server was first set up.

- Don't deploy on match night: a deploy restarts the app (the admin stays logged in - sessions are saved - but a
  save made in those 40 seconds can be lost; the app then says so instead of failing silently).
- After deploying, open **Admin -> Server check** (`/admin/diagnostics`) to see the client address the app sees
  and the age of the newest backup.

## Putting it online on RunCloud - no terminal needed

**You upload one file:** `bream-bay-twilight-football-deploy.zip` (about 45 MB). It already contains the app,
its packages, **and Node itself** (so nothing is installed on the server) - but none of your private data.

In these steps the web app is `kids-twilight` and its folder is `/home/runcloud/webapps/kids-twilight`.
Use your own names/paths if they differ (File Manager shows the path at the top).

### Step 1 - Point the web address at your server (DNS)
Where you manage the domain, add an **A record** for your subdomain pointing at the server's IP address.

### Step 2 - Create the web app in RunCloud
*Web Applications -> Create Web Application -> **Empty Web App*** (not "Script Installer" or "One-Click").
Choose a name, your domain and a system user. Ignore PHP and database. *Deploy*.

### Step 3 - Connect the web address to the app (OpenLiteSpeed server)
Open the web app -> **LiteSpeed Config**:
1. In the block `extprocessor kids-twilight { ... }`, put a `#` in front of the lines beginning `type` and `address`.
2. Directly under them add:
   ```
   type                    proxy
   address                 127.0.0.1:3000
   ```
3. Outside any other `{ }` block add (use your extprocessor name after `handler`):
   ```
   context / {
     type                    proxy
     handler                 kids-twilight
     addDefaultCharset       off
   }
   ```
4. Click **Update Config**.

(On an Nginx server instead: *Settings -> NGINX Config -> Add a New Config -> Predefined -> Proxy*, port 3000.)

### Step 4 - Upload and unzip the app
Web app -> **File Manager** -> upload the zip into the web app's main folder -> tick it -> *Unzip*.
Afterwards `src`, `scripts`, `node_modules`, `node-runtime` and `package.json` must sit **directly inside the
web app's main folder** (not inside another folder). If your Unzip box asks for a destination, use that folder.

### Step 5 - Create your settings file
In File Manager, inside the same main folder, click **New File**, name it exactly `.env`, and put in it:
```
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
ADMIN_PASSWORD=ChooseYourOwnPasswordHere
```
Pick your own admin password: **10+ characters, letters and numbers only**. Save. (The app creates its own
secret keys automatically.)

### Step 6 - Start the app with RunCloud Supervisor
RunCloud -> **Supervisor** -> create a job:
- **Name:** `kids-twilight-app`
- **Vendor Binary:** none / blank / custom (not a PHP version)
- **Command:** (one line)
  `/lib64/ld-linux-x86-64.so.2 /home/runcloud/webapps/kids-twilight/node-runtime/node /home/runcloud/webapps/kids-twilight/src/server.js`
- **Directory:** `/home/runcloud/webapps/kids-twilight`
- **User:** `runcloud` (the web app's system user)
- **Auto start** and **Auto restart:** on

Save. The job should show as running. It restarts itself after crashes and server reboots.

### Step 7 - Turn on HTTPS
Web app -> *SSL/TLS* -> *Let's Encrypt* -> *Deploy* (needs step 1's DNS working). HTTPS is what lets phones
install it as an app.

### Step 8 - Check it
- Open your address - you should see the site (until a league is created it just says so).
- Open `/admin` and log in with your password.
- On a phone: browser menu -> *Add to Home Screen*.

## First-night setup (in `/admin`)

1. **Create the league** (8 teams, 4 pitches, 3 rounds per week). Teams start as "Team 1-8"; rename them any time.
2. **Schedule** -> first match night -> *Generate*. Renaming teams afterwards is fine. *Regenerating* wipes all
   results, so once any result exists you must type the league name to confirm, and the app saves a safety copy
   of the database first (`data/backups/bream-bay-pre-regenerate-...`). A league needs at least half as many
   pitches as teams (8 teams -> 4 pitches).
3. **Info pages** -> add the starter pages (Rules, Referee guide, Parents and supporters) as drafts, edit them,
   and tick *Published* when ready. The *Info* tab only appears on the public site once something is published.
4. Enter scores under **Results**: type a round's scores and press **Save round** (one tap per round). **Clear**
   puts a match back to unplayed. When the group stage is done and no teams are tied, generate the Cup/Plate
   brackets; group results are then locked (use *Reset the brackets* if a group score was wrong).
5. **Change log** (per league on the dashboard) lists the latest score changes; **Server check** shows the
   client address and backup age.

## After launch

- **Updating the app**: push to GitHub `main` (see "How it is run now"). Your data lives in the `data` folder,
  which updates never touch.
- **Backups** (recommended): RunCloud -> *Cron Job* -> nightly, user `runcloud`, command (one line)
  `/lib64/ld-linux-x86-64.so.2 /home/runcloud/webapps/twilight-football/node-runtime/node /home/runcloud/webapps/twilight-football/scripts/backup.js`
  (use your own app folder name). It keeps the latest 30 dated copies in `data/backups`; the automatic safety
  copies taken before a regenerate, league delete or bracket draw are kept separately (newest 20). The backups sit
  on the same disk as the database, so download the `data/backups` folder every week or so.
- **Settings in `.env`**: `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=3000`, `ADMIN_PASSWORD`, and optionally
  `TRUST_PROXY` (how many proxies are in front of the app: 1 behind OpenLiteSpeed, 2 behind Cloudflare too - check
  *Server check*), `DATABASE_PATH`, `BACKUP_DIR`, `AUTO_RESTART=0` (turn off restart-on-deploy).

## If something goes wrong

- **502 Bad Gateway** - the app isn't running. Open the Supervisor job in RunCloud and look at its status/log.
  Common causes: the settings file isn't named exactly `.env`, or the password is shorter than 10 characters
  (the log then says so).
- **You see a RunCloud default page, not the app** - step 3 isn't applied, or the domain isn't pointing at the
  server yet.
- **Login says "Too many failed attempts"** - ten wrong passwords locks an address out for 15 minutes.
  Restarting the app clears it.
- **Login locks everyone out, or "Server check" shows a strange address** - open *Admin -> Server check*
  (`/admin/diagnostics`). The first row should be your own public IP. If it is a shared address (for example
  Cloudflare's), add `TRUST_PROXY=2` to `.env` (Cloudflare + OpenLiteSpeed = 2 proxies; the default is 1) and
  restart the app.
- **Forgot the admin password** - edit `.env` in File Manager, then restart the Supervisor job. Data is kept.

## Advanced: with a terminal instead

If you have root SSH access you can instead install Node 22.13+ yourself and run
`node scripts/setup-production.js 'PASSWORD' --user APPUSER`, which writes the settings and installs a
systemd service.

## Good to know

- Match times aren't shown to parents - just the date and round order. The first kickoff and minutes between
  rounds are still stored on record, ready if a later league needs them shown.
- The admin is logged out whenever the app restarts (sessions are in memory).
- Public pages show players as first name + last initial only.
