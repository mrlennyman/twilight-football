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

## Putting it online on RunCloud - step by step

**You upload one file:** `bream-bay-twilight-football-deploy.zip`. It already contains everything the app
needs (no installing packages on the server) and none of your private data.

**Before you start, have these ready:**
- A web address for the app, e.g. `twilight.yourclub.nz` (a subdomain is easiest), and access to wherever
  that domain's DNS is managed.
- Your RunCloud login.
- An admin password you choose: **10+ characters, letters and numbers only** (a dot, dash or underscore is
  fine too), e.g. `KickOff-Wed-2026`.

### Step 1 - Point the web address at your server
Where you manage the domain, add an **A record**: name `twilight` (or whatever you chose), value = your
server's IP address (shown on the server's page in RunCloud). It can take a few minutes to an hour to work.

### Step 2 - Create the web app in RunCloud
*Web Applications -> Create Web Application* -> choose **Empty Web App** (not "Script Installer" or
"One-Click" - those are for ready-made apps like WordPress):
- Name: `bream-bay` (anything)
- Domain name: your address from step 1
- System user: pick or create one, and **write its name down** - called `APPUSER` below
- PHP version and database: ignore (the app uses neither)
- Environment: Production -> *Deploy*

### Step 3 - Connect website traffic to the app
This is where the server type matters. (Do it before uploading.)

**OpenLiteSpeed server** (RunCloud's docs: <https://runcloud.io/docs/install-and-run-nodejs>) - open the web
app -> **LiteSpeed Config**, then:
1. Find the block that starts `extprocessor something {` and **note down that name** (e.g. `bream-bay`).
2. Inside that block, put a `#` at the start of the line beginning `type` and the line beginning `address`.
3. Directly under those two lines, add:
   ```
   type                    proxy
   address                 127.0.0.1:3000
   ```
4. Somewhere else in the file (not inside another `{ }` block), add - replacing `NAME` with the name from step 1:
   ```
   context / {
     type                    proxy
     handler                 NAME
     addDefaultCharset       off
   }
   ```
5. Click **Update Config** (this restarts OpenLiteSpeed).

**Nginx server** instead: web app -> *Settings -> NGINX Config -> Add a New Config -> Predefined Config ->
Proxy configuration*, port **3000**, *Run and Debug*, then *Create Config*.

### Step 4 - Upload the app
Open the web app -> **File Manager**. Upload `bream-bay-twilight-football-deploy.zip` into the web app's main
folder (File Manager shows the path at the top - usually `/home/APPUSER/webapps/bream-bay`).
Tick the zip file -> *Unzip* -> destination = that same folder.
You should now see folders named `src`, `scripts` and `node_modules`, and a file called `package.json`.

### Step 5 - Open a terminal on the server (one time only)
RunCloud has no built-in terminal, so use one of these:
- **Vultr** (if that's your host): Vultr dashboard -> your server -> *View Console*. Log in as `root`
  (the password is on the server's Overview page).
- **SSH from your PC**: open PowerShell and type `ssh root@YOUR-SERVER-IP`. RunCloud servers usually need an
  SSH key added first (RunCloud's SSH key settings).

If you get stuck on this step, that's normal - tell me what you see on screen.

### Step 6 - Install Node (skip if `node -v` already shows v22.13 or higher)
Paste these three lines, one after the other:
```
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
node -v
```
The last one should print something like `v24.x.x`.

### Step 7 - Run the one-command setup
Replace `APPUSER` (twice) and the password, and use your app's folder if it differs:
```
cd /home/APPUSER/webapps/bream-bay
node scripts/setup-production.js 'YOUR-PASSWORD' --user APPUSER
```
It creates your private settings (password plus a random session secret, stored in
`/home/APPUSER/bream-bay-data/`), installs a service that keeps the app running (it restarts after crashes
and server reboots), starts it, and prints **SUCCESS**. If it says port 3000 is already used by another app on
your server, add `--port 3010` and use `3010` in step 3 too.

### Step 8 - Turn on HTTPS
Web app -> *SSL/TLS* -> *Let's Encrypt* -> *Deploy*. (This needs step 1's DNS to be working. HTTPS is what
lets phones install it as an app.)

### Step 9 - Check it
- Open your address - you should see the site.
- Open `/admin` and log in with your password.
- On a phone: open the site -> browser menu -> *Add to Home Screen*.

## First-night setup (in `/admin`)

1. **Create the league** (8 teams, 4 pitches, 3 rounds per week). Teams start as "Team 1-8"; rename them any time.
2. **Schedule** -> first match night -> *Generate*. Renaming teams afterwards is fine;
   *regenerating* the schedule wipes all results.
3. **Info pages** -> add the starter pages (Rules, Referee guide, Parents and supporters) as drafts, edit them,
   and tick *Published* when ready. The *Info* tab only appears on the public site once something is published.
4. Enter scores under **Results**; when the group stage is done, generate the Cup/Plate brackets.

## After launch

- **Updating the app**: upload the new zip over the old one (File Manager -> Unzip, overwrite), then in a
  terminal run `systemctl restart bb-twilight`. Your data is stored outside the app folder, so it is untouched.
- **Backups** (recommended): RunCloud -> *Cron Job* -> create a nightly job, running as `APPUSER`, with the command
  `cd /home/APPUSER/webapps/bream-bay && node --env-file=/home/APPUSER/bream-bay-data/.env scripts/backup.js`
  It keeps the latest 30 dated copies in `/home/APPUSER/bream-bay-data/backups`. Download that folder
  occasionally.

## If something goes wrong

- **"502 Bad Gateway"** - the app isn't running. In the terminal: `systemctl status bb-twilight`, and
  `journalctl -u bb-twilight -n 40 --no-pager` shows why.
- **You see a RunCloud default page, not the app** - step 3 (the proxy) isn't set up, or the domain isn't
  pointing at the server yet.
- **Login says "Too many failed attempts"** - ten wrong passwords locks an address out for 15 minutes.
  If it happens to everybody, tell me (the proxy may not be passing visitors' addresses through). Restarting
  the app also clears it.
- **Forgot the admin password** - as root: `rm /home/APPUSER/bream-bay-data/.env`, run step 7 again with a new
  password, and your data is kept.

## Good to know

- Match times aren't shown to parents - just the date and round order. The first kickoff and minutes between
  rounds are still stored on record, ready if a later league needs them shown.
- The admin is logged out whenever the app restarts (sessions are in memory).
- Public pages show players as first name + last initial only.
