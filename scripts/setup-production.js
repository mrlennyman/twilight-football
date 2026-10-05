#!/usr/bin/env node
/**
 * One-command server setup for a Linux (RunCloud) server. Run as root from anywhere:
 *
 *   node scripts/setup-production.js 'AdminPassword123' --user APPUSER [--port 3000]
 *
 * It creates the private settings file (admin password + random session secret) and the
 * data folder in the app user's home, installs a service that keeps the app running
 * (restarts after crashes and reboots), starts it, and checks it responds.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFileSync } = require('child_process');
const {
  SERVICE_NAME,
  generateSecret,
  buildEnvFile,
  buildServiceUnit,
  parseArgs,
} = require('./deploy-helpers');

function die(message) {
  console.error(`\nERROR: ${message}\n`);
  process.exit(1);
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

function waitForApp(port, attempts = 15) {
  return new Promise((resolve) => {
    const tryOnce = (left) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => (left > 0 ? setTimeout(() => tryOnce(left - 1), 1000) : resolve(false)));
      req.on('timeout', () => req.destroy());
    };
    tryOnce(attempts);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.errors.length) {
    die(
      `${args.errors.join('\n       ')}\n\nExample:\n  node scripts/setup-production.js 'MyPassword123' --user myappuser`
    );
  }
  if (process.platform !== 'linux') die('This setup script is for the Linux server, not your own computer.');
  if (process.getuid() !== 0) die('Run this as root (log in as root, or put "sudo" in front of the command).');

  const appDir = path.resolve(__dirname, '..');
  if (!fs.existsSync(path.join(appDir, 'src', 'server.js')) || !fs.existsSync(path.join(appDir, 'node_modules'))) {
    die(`The app files look incomplete in ${appDir} (missing src/server.js or node_modules). Re-upload and unzip the full zip.`);
  }

  let passwd;
  try {
    passwd = run('getent', ['passwd', args.user]).trim().split(':');
  } catch {
    die(`There is no system user called "${args.user}". Check the exact name in RunCloud (web app -> Settings).`);
  }
  const [, , uid, gid, , home] = passwd;

  const dataDir = path.join(home, 'bream-bay-data');
  const envPath = path.join(dataDir, '.env');
  const unitPath = `/etc/systemd/system/${SERVICE_NAME}.service`;

  if (fs.existsSync(envPath) && !args.force) {
    die(`${envPath} already exists, so the app was already set up. To change the password, delete that file and run this again (or add --force).`);
  }

  // Stop a previous run of this service so its port counts as free.
  if (fs.existsSync(unitPath)) {
    try { run('systemctl', ['stop', SERVICE_NAME]); } catch { /* not running */ }
  }
  if (!(await portIsFree(args.port))) {
    die(`Port ${args.port} is already used by another program on this server. Run again with a different port, e.g. --port ${args.port + 10}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    envPath,
    buildEnvFile({
      password: args.password,
      sessionSecret: generateSecret(),
      dataDir,
      port: args.port,
    }),
    { mode: 0o600 }
  );
  fs.chownSync(dataDir, Number(uid), Number(gid));
  fs.chownSync(envPath, Number(uid), Number(gid));
  console.log(`Created settings file:  ${envPath}`);

  fs.writeFileSync(
    unitPath,
    buildServiceUnit({ user: args.user, appDir, envPath, nodePath: process.execPath })
  );
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', SERVICE_NAME]);
  run('systemctl', ['restart', SERVICE_NAME]);
  console.log(`Installed and started service "${SERVICE_NAME}" (restarts itself if it crashes or the server reboots)`);

  if (!(await waitForApp(args.port))) {
    die(`The app did not start. See why with:\n  journalctl -u ${SERVICE_NAME} -n 40 --no-pager`);
  }

  console.log(`
SUCCESS - the app is running on this server (port ${args.port}).

Next in RunCloud:
  1. Send the web address to the app on port ${args.port} (see step 3 of the README: "LiteSpeed Config" on an
     OpenLiteSpeed server, or "NGINX Config -> Proxy" on an Nginx server). Address: 127.0.0.1:${args.port}
  2. Web app -> SSL/TLS -> Let's Encrypt -> Deploy
  3. Open your site and log in at /admin with the password you just chose.

Handy commands:
  Status:          systemctl status ${SERVICE_NAME}
  Recent errors:   journalctl -u ${SERVICE_NAME} -n 40 --no-pager
  Restart (after uploading an update):  systemctl restart ${SERVICE_NAME}
  Nightly backup (RunCloud Cron Job, run as ${args.user}):
    cd ${appDir} && node --env-file=${envPath} scripts/backup.js
`);
}

main().catch((err) => die(err.message));
