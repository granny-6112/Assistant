// Updates from the public GitHub repo's releases. Checks are a single small
// HTTPS request a few times a day, and a new version installs itself when the
// app quits.
const { app } = require('electron');

const REPO = { owner: 'granny-6112', repo: 'Assistant' };
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let timer = null;
let status = { state: 'idle' }; // idle | checking | none | downloading | ready | error
const listeners = new Set();

function setStatus(next) {
  status = next;
  for (const fn of listeners) fn(status);
}

function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function updater() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => setStatus({ state: 'downloading', version: info.version, progress: 0 }));
  autoUpdater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: describe(err) }));
  return autoUpdater;
}

function describe(err) {
  const msg = err?.message || String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|net::/i.test(msg)) return "Couldn't reach GitHub. Will try again later.";
  return msg.split('\n')[0];
}

async function check() {
  if (!app.isPackaged) return setStatus({ state: 'none', version: app.getVersion() });
  const u = updater();
  u.setFeedURL({ provider: 'github', ...REPO });
  try {
    await u.checkForUpdates();
  } catch (err) {
    setStatus({ state: 'error', message: describe(err) });
  }
}

function start() {
  clearTimeout(timer);
  timer = setTimeout(function loop() {
    check();
    timer = setTimeout(loop, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);
}

function installNow() {
  if (status.state === 'ready') updater().quitAndInstall(true, true);
}

module.exports = { start, check, installNow, onStatus, getStatus: () => status, REPO };
