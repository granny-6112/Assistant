// Updates from the private GitHub repo's releases. The repo is private, so
// every request carries the read-only token the user pasted into Settings;
// without a token this does nothing. Checks are a single small HTTPS request
// a few times a day, and a new version installs itself when the app quits.
const { app } = require('electron');
const settings = require('./settings');

const REPO = { owner: 'granny-6112', repo: 'Assistant' };
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let autoUpdater = null;
let timer = null;
let status = { state: 'idle' }; // idle | no-token | checking | none | downloading | ready | error
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
  if (/\b(401|403|404)\b/.test(msg)) return 'GitHub refused the token. It needs read access to the Assistant repo (Contents: Read-only).';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|net::/i.test(msg)) return "Couldn't reach GitHub. Will try again later.";
  return msg.split('\n')[0];
}

async function check() {
  const token = settings.getApiKey('github');
  if (!token) return setStatus({ state: 'no-token' });
  if (!app.isPackaged) return setStatus({ state: 'none', version: app.getVersion() });
  const u = updater();
  u.setFeedURL({ provider: 'github', ...REPO, private: true, token });
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

// Confirms a token can see the repo, so a wrong token shows up when it's
// pasted rather than as a silent failure hours later.
async function verifyToken(token) {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'Assistant' },
    });
    if (res.ok) return { valid: true };
    if (res.status === 401) return { valid: false, message: 'GitHub says this token is invalid or expired.' };
    if (res.status === 403 || res.status === 404) return { valid: false, message: "This token can't see granny-6112/Assistant. Give it Contents: Read-only on that repo." };
    return { valid: null, message: `Saved, but GitHub answered ${res.status}. Will retry later.` };
  } catch {
    return { valid: null, message: "Saved, but couldn't check it right now (no connection?)." };
  }
}

module.exports = { start, check, installNow, onStatus, verifyToken, getStatus: () => status, REPO };
