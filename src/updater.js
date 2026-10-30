// Updates from the public GitHub repo's releases. A check is one small HTTPS
// request, made every 90 minutes and after the PC wakes from sleep; a new
// version downloads quietly, the bar suggests it, and it installs itself when
// the app quits (or straight away with Restart now).
const { app, powerMonitor } = require('electron');

const REPO = { owner: 'granny-6112', repo: 'Assistant' };
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 90 * 60 * 1000;
const AFTER_WAKE_MS = 15 * 1000; // give Wi-Fi a moment to reconnect

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
  // Notes for every release newer than this one, not just the latest, so
  // "What's new" covers exactly what this install doesn't have yet.
  autoUpdater.fullChangelog = true;
  autoUpdater.logger = null;
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none', version: app.getVersion() }));
  autoUpdater.on('update-available', (info) => setStatus({ state: 'downloading', version: info.version, notes: notesOf(info), progress: 0 }));
  autoUpdater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', progress: p.percent / 100 }));
  autoUpdater.on('update-downloaded', (info) => setStatus({ state: 'ready', version: info.version, notes: notesOf(info) || status.notes }));
  autoUpdater.on('error', (err) => setStatus({ state: 'error', message: describe(err) }));
  return autoUpdater;
}

// What's new since the installed version, as HTML (the renderer sanitises
// it): the bullet points of every newer release, newest first, each said once.
function notesOf(info) {
  const n = info?.releaseNotes;
  if (!n) return '';
  const notes = Array.isArray(n) ? n.map((x) => x.note || '') : [String(n)];
  const seen = new Set();
  const items = [];
  for (const html of notes) {
    const lis = html.match(/<li[\s>][\s\S]*?<\/li>/gi);
    if (!lis) { if (html.trim()) items.push(`<li>${html}</li>`); continue; }
    for (const li of lis) {
      const key = li.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      if (key && !seen.has(key)) { seen.add(key); items.push(li); }
    }
  }
  return items.length ? `<ul>${items.join('')}</ul>` : '';
}

function describe(err) {
  const msg = err?.message || String(err);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|net::/i.test(msg)) return "Couldn't reach GitHub. Will try again later.";
  return msg.split('\n')[0];
}

async function check() {
  // Already downloading or waiting for a restart: nothing to look for.
  if (status.state === 'downloading') return;
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
  powerMonitor.removeListener('resume', onResume);
  powerMonitor.on('resume', onResume);
}

function onResume() {
  clearTimeout(timer);
  timer = setTimeout(function loop() {
    check();
    timer = setTimeout(loop, CHECK_EVERY_MS);
  }, AFTER_WAKE_MS);
}

function installNow() {
  if (status.state === 'ready') updater().quitAndInstall(true, true);
}

module.exports = { start, check, installNow, onStatus, getStatus: () => status, REPO };
