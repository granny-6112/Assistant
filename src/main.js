const {
  app, BrowserWindow, ipcMain, screen, desktopCapturer, globalShortcut,
  Tray, Menu, nativeImage, shell, dialog, powerMonitor,
} = require('electron');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const { MODELS, PROVIDERS, findModel, Conversation, describeError, isAbort, verifyKey } = require('./providers');
const local = require('./local');
const updater = require('./updater');
const agent = require('./agent');
const input = require('./input');

const WIN_WIDTH = 780;        // bar is 740 wide plus room for its shadow
const COLLAPSED_HEIGHT = 96;
// The top edge is checked with a timer whose rate adapts to where the cursor
// is, so an idle background app wakes the CPU only a few times a second.
const POLL_NEAR_MS = 40;   // cursor close to the top edge, or the bar is open
const POLL_FAR_MS = 160;   // cursor elsewhere
const POLL_IDLE_MS = 1000; // nobody has touched the PC for a minute
const NEAR_EDGE_PX = 60;

let win = null;
let tray = null;
let shown = false;
let hiding = null;
let currentDisplay = null;
let edgeSince = 0;
let outsideSince = 0;
let contentHeight = COLLAPSED_HEIGHT;
let ui = { busy: false, typing: false, settingsOpen: false, pinned: false, recording: false };
let agentRun = null; // { controller, confirmations: Map } while agent mode is driving the PC

const conversation = new Conversation();
const recording = { file: null, stream: null, path: null, startedAt: 0, frames: [] };
let lastRecording = null; // { path, durationSec, frames: [{t, data}] }

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showBar({ focus: true }));
  app.whenReady().then(init);
}

function init() {
  app.setAppUserModelId('app.assistant.desktop');
  const s = settings.load();
  app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });

  createWindow();
  createTray();
  registerShortcuts();
  scheduleTick(POLL_FAR_MS);
  updater.onStatus((st) => { send('update-status', st); refreshTray(); });
  updater.start();
  // Stop watching the cursor entirely while the PC is locked or asleep.
  powerMonitor.on('lock-screen', pausePolling);
  powerMonitor.on('suspend', pausePolling);
  powerMonitor.on('unlock-screen', resumePolling);
  powerMonitor.on('resume', resumePolling);

  // First run: open the bar on the settings page so the user can paste a key.
  win.webContents.once('did-finish-load', () => {
    if (!settings.getApiKey('google') && !settings.getApiKey('anthropic')) {
      showBar({ focus: true });
      send('open-settings', { firstRun: true });
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_WIDTH,
    height: COLLAPSED_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true, // turned off only while recording, so a hidden bar costs nothing
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // Keeps the bar out of every screen capture, including our own screenshots,
  // the live glass backdrop and recordings (Windows 10 2004 or later).
  win.setContentProtection(true);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('blur', () => { ui.typing = false; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- reveal / hide ----------

function barBounds(display, height) {
  const { x, y, width } = display.bounds;
  return {
    x: Math.round(x + width / 2 - WIN_WIDTH / 2),
    y,
    width: WIN_WIDTH,
    height: Math.ceil(height),
  };
}

async function showBar({ focus = false, display = null } = {}) {
  const target = display || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (hiding) { clearTimeout(hiding); hiding = null; }
  const moved = !currentDisplay || currentDisplay.id !== target.id;
  currentDisplay = target;
  win.setBounds(barBounds(target, contentHeight));

  if (!shown || moved) {
    shown = true;
    outsideSince = 0;
    if (focus) win.show(); else win.showInactive();
    win.setAlwaysOnTop(true, 'screen-saver');
    send('reveal', {
      display: { id: target.id, bounds: target.bounds, scaleFactor: target.scaleFactor },
      glassSourceId: liveGlassAllowed() ? await screenSourceId(target) : null,
    });
  }
  if (focus) {
    win.focus();
    send('focus-input');
  }
}

function hideBar() {
  if (!shown) return;
  shown = false;
  edgeSince = 0;
  send('conceal');
  hiding = setTimeout(() => {
    hiding = null;
    if (!shown) win.hide();
  }, 220);
}

function toggleBar() {
  if (agentRun) return stopAgent();
  if (shown) hideBar(); else showBar({ focus: true });
}

function keepOpen() {
  return Boolean(agentRun) || ui.pinned || ui.busy || ui.settingsOpen || (ui.typing && win.isFocused());
}

let tickTimer = null;
let pollingPaused = false;

function scheduleTick(ms) {
  clearTimeout(tickTimer);
  if (!pollingPaused) tickTimer = setTimeout(() => scheduleTick(tick()), ms);
}

function pausePolling() {
  pollingPaused = true;
  clearTimeout(tickTimer);
  if (shown) hideBar();
}

function resumePolling() {
  pollingPaused = false;
  scheduleTick(POLL_FAR_MS);
}

// Returns how long to wait before the next check.
function tick() {
  if (!win) return POLL_FAR_MS;
  const p = screen.getCursorScreenPoint();
  const now = Date.now();
  const s = settings.load();

  if (!shown) {
    const d = screen.getDisplayNearestPoint(p);
    const nearTop = p.y <= d.bounds.y + NEAR_EDGE_PX;
    const atTop = p.y <= d.bounds.y + 1;
    const centerX = d.bounds.x + d.bounds.width / 2;
    const inZone = s.revealZone === 'full' || Math.abs(p.x - centerX) <= WIN_WIDTH / 2;
    if (atTop && inZone) {
      if (!edgeSince) edgeSince = now;
      if (now - edgeSince >= s.revealDelayMs) {
        edgeSince = 0;
        showBar({ display: d });
      }
    } else {
      edgeSince = 0;
    }
    if (nearTop) return POLL_NEAR_MS;
    return powerMonitor.getSystemIdleTime() > 60 ? POLL_IDLE_MS : POLL_FAR_MS;
  }

  if (keepOpen()) { outsideSince = 0; return POLL_NEAR_MS * 2; }
  const b = win.getBounds();
  const m = 28;
  const inside = p.x >= b.x - m && p.x <= b.x + b.width + m && p.y >= b.y - m && p.y <= b.y + contentHeight + m;
  if (inside) { outsideSince = 0; return POLL_NEAR_MS * 2; }
  if (!outsideSince) outsideSince = now;
  if (now - outsideSince >= s.hideDelayMs) hideBar();
  return POLL_NEAR_MS;
}

// Live glass streams the screen while the bar is open; skip it when the
// setting says so or when the laptop is on battery in "plugged in" mode.
function liveGlassAllowed() {
  const mode = settings.load().liveGlass;
  if (mode === 'off' || mode === false) return false;
  if (mode === 'plugged') return !powerMonitor.isOnBatteryPower();
  return true;
}

// ---------- screen capture ----------

async function screenSource(display, thumbnailSize) {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  return sources.find((src) => src.display_id === String(display.id)) || sources[0];
}

async function screenSourceId(display) {
  try {
    const src = await screenSource(display, { width: 0, height: 0 });
    return src ? src.id : null;
  } catch {
    return null;
  }
}

async function captureScreenshot(display, maxEdgeOverride) {
  const maxEdge = maxEdgeOverride || (settings.load().screenshotQuality === 'high' ? 2576 : 1920);
  const pw = display.size.width * display.scaleFactor;
  const ph = display.size.height * display.scaleFactor;
  // Stay inside Claude's image limits: 2576px long edge and about 3.75 megapixels.
  const k = Math.min(1, maxEdge / Math.max(pw, ph), Math.sqrt(3_600_000 / (pw * ph)));
  const src = await screenSource(display, { width: Math.round(pw * k), height: Math.round(ph * k) });
  if (!src || src.thumbnail.isEmpty()) {
    throw new Error('Could not capture the screen. Windows may be blocking screen capture for this app.');
  }
  return src.thumbnail.toJPEG(82).toString('base64');
}

function jpegBlock(base64) {
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } };
}

function sampleFrames(frames, max) {
  if (frames.length <= max) return frames;
  const out = [];
  for (let i = 0; i < max; i++) out.push(frames[Math.round((i * (frames.length - 1)) / (max - 1))]);
  return out;
}

function formatTime(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- IPC: asking ----------

ipcMain.handle('ask', async (_e, { text, includeScreen, attachRecording }) => {
  const s = settings.load();
  const model = findModel(s.modelId);
  const isLocal = model.provider === 'local';
  const apiKey = isLocal ? null : settings.getApiKey(model.provider);
  if (!isLocal && !apiKey) {
    return { ok: false, error: `${model.name} needs a ${PROVIDERS[model.provider].name} key. Add one in Settings, or slide to another model.`, needsKey: true };
  }
  const content = [];
  const attachments = [];

  try {
    if (attachRecording && lastRecording && lastRecording.frames.length) {
      send('ai-status', 'Reading your recording…');
      // The offline model is far slower per image, so it gets fewer frames.
      const frames = sampleFrames(lastRecording.frames, isLocal ? 6 : 16);
      content.push({
        type: 'text',
        text: `The next ${frames.length} images are frames sampled evenly from a ${formatTime(lastRecording.durationSec)} screen recording, in order.`,
      });
      for (const f of frames) {
        content.push({ type: 'text', text: `Frame at ${formatTime(f.t)}:` });
        content.push(jpegBlock(f.data));
      }
      attachments.push(`recording · ${frames.length} frames`);
    }
    if (includeScreen) {
      send('ai-status', 'Looking at your screen…');
      const display = currentDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      content.push(jpegBlock(await captureScreenshot(display, isLocal ? 1280 : null)));
      attachments.push('screenshot');
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }

  content.push({ type: 'text', text });
  send('ai-status', null);
  send('ai-start', { attachments, model: model.name });

  try {
    const result = await conversation.ask({
      model,
      apiKey,
      effort: s.effort,
      localTier: s.localTier,
      content,
      onText: (t) => send('ai-delta', t),
      onFallback: () => send('ai-fallback'),
      onBusy: (text) => send('ai-status', text),
    });
    return { ok: true, refused: result.refused, truncated: result.truncated, servedBy: result.servedBy, busyFallback: result.busyFallback };
  } catch (err) {
    if (isAbort(err)) return { ok: false, cancelled: true };
    return { ok: false, error: describeError(err, model) };
  } finally {
    send('ai-status', null);
  }
});

ipcMain.handle('cancel', () => conversation.cancel());

// ---------- agent mode ----------

// Screenshot of the primary display for agent mode, plus what's needed to map
// the model's coordinates back to the screen. A zoom crops a region of the
// full-resolution screen and returns it at a readable size.
async function captureAgentShot({ region } = {}) {
  const display = screen.getPrimaryDisplay();
  const pw = display.size.width * display.scaleFactor;
  const ph = display.size.height * display.scaleFactor;
  if (region) {
    const { x0, y0, x1, y1, from } = region;
    const src = await screenSource(display, { width: Math.round(pw), height: Math.round(ph) });
    const kx = pw / from.width;
    const ky = ph / from.height;
    const rect = {
      x: Math.max(0, Math.round(Math.min(x0, x1) * kx)),
      y: Math.max(0, Math.round(Math.min(y0, y1) * ky)),
      width: Math.max(8, Math.round(Math.abs(x1 - x0) * kx)),
      height: Math.max(8, Math.round(Math.abs(y1 - y0) * ky)),
    };
    let img = src.thumbnail.crop(rect);
    const k = Math.min(1, 1280 / Math.max(rect.width, rect.height));
    if (k < 1) img = img.resize({ width: Math.round(rect.width * k), height: Math.round(rect.height * k), quality: 'best' });
    const data = img.toJPEG(85).toString('base64');
    return { data, block: jpegBlock(data) };
  }
  // 1280px wide keeps text legible and coordinates accurate for both models.
  const k = Math.min(1, 1280 / Math.max(pw, ph));
  const src = await screenSource(display, { width: Math.round(pw * k), height: Math.round(ph * k) });
  if (!src || src.thumbnail.isEmpty()) throw new Error('Could not capture the screen.');
  const size = src.thumbnail.getSize();
  const data = src.thumbnail.toJPEG(82).toString('base64');
  return { data, width: size.width, height: size.height, block: jpegBlock(data), display: { bounds: display.bounds, scaleFactor: display.scaleFactor } };
}

function setAgentWindowMode(running) {
  if (!win || win.isDestroyed()) return;
  // While the agent works, the bar shows its status but lets every click
  // through and never takes focus, so it can't get in the way of the task.
  win.setIgnoreMouseEvents(running);
  win.setFocusable(!running);
  if (running) win.blur();
}

function stopAgent() {
  if (agentRun) agentRun.controller.abort();
}

function agentConfirm(action) {
  return new Promise((resolve) => {
    if (!agentRun) return resolve(false);
    const id = `c${Date.now()}`;
    agentRun.confirmations.set(id, resolve);
    // The user has to be able to click Allow, so the bar is interactive until they answer.
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    send('agent-confirm', { id, action });
    agentRun.controller.signal.addEventListener('abort', () => resolve(false), { once: true });
  }).finally(() => { if (agentRun) setAgentWindowMode(true); });
}

ipcMain.on('agent-confirm-reply', (_e, { id, ok }) => {
  const resolve = agentRun?.confirmations.get(id);
  if (!resolve) return;
  agentRun.confirmations.delete(id);
  resolve(Boolean(ok));
});

ipcMain.handle('agent-stop', () => stopAgent());

ipcMain.handle('agent-run', async (_e, { task }) => {
  const s = settings.load();
  if (!s.agentEnabled) return { ok: false, error: 'Turn on "Let Assistant control the mouse and keyboard" in Settings first.' };
  if (agentRun) return { ok: false, error: 'Agent mode is already running.' };
  const model = findModel(s.modelId);
  if (model.provider === 'local') {
    return { ok: false, error: 'Agent mode needs a Gemini or Claude model; the offline model is too small to control the PC reliably. Slide to a cloud model.' };
  }
  const apiKey = settings.getApiKey(model.provider);
  if (!apiKey) return { ok: false, error: `${model.name} needs a ${PROVIDERS[model.provider].name} key. Add one in Settings.`, needsKey: true };

  const controller = new AbortController();
  agentRun = { controller, confirmations: new Map() };
  const stopKey = globalShortcut.register('Alt+Shift+X', stopAgent);
  await showBar({ display: screen.getPrimaryDisplay() });
  setAgentWindowMode(true);
  send('agent-state', { running: true, step: 0, text: 'Starting…' });
  refreshTray();
  try {
    const result = await agent.run({
      provider: model.provider,
      model: model.id,
      task,
      apiKey,
      effort: s.effort,
      capture: captureAgentShot,
      signal: controller.signal,
      onStep: ({ step, text }) => send('agent-state', { running: true, step, text }),
      confirm: agentConfirm,
    });
    return { ok: true, text: result.text, steps: result.steps, model: model.name };
  } catch (err) {
    if (isAbort(err) || controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: false, error: describeError(err, model) };
  } finally {
    input.releaseAll();
    if (stopKey) globalShortcut.unregister('Alt+Shift+X');
    agentRun = null;
    setAgentWindowMode(false);
    send('agent-state', { running: false });
    refreshTray();
  }
});
ipcMain.handle('new-chat', () => conversation.reset());

// ---------- IPC: models & offline model ----------

local.onStatus((status) => send('local-status', status));

ipcMain.handle('get-models', () => ({
  models: MODELS,
  local: local.describe(settings.load().localTier),
  tiers: local.TIERS,
}));

ipcMain.handle('local-prepare', async () => {
  try {
    await local.start(settings.load().localTier);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- IPC: settings & UI state ----------

ipcMain.handle('get-settings', () => ({
  ...settings.load(),
  keys: {
    google: { has: Boolean(settings.getApiKey('google')), fromEnv: Boolean(settings.envKey('google')) },
    anthropic: { has: Boolean(settings.getApiKey('anthropic')), fromEnv: Boolean(settings.envKey('anthropic')) },
    github: { has: Boolean(settings.getApiKey('github')), fromEnv: Boolean(settings.envKey('github')) },
  },
  version: app.getVersion(),
  update: updater.getStatus(),
}));

ipcMain.handle('check-updates', () => updater.check());
ipcMain.on('install-update', () => updater.installNow());

ipcMain.handle('save-settings', (_e, patch) => {
  const next = settings.save(patch);
  if ('launchAtLogin' in patch) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
  if ('localTier' in patch) local.stop();
  return next;
});

ipcMain.handle('set-api-key', async (_e, { provider, key }) => {
  try {
    // Accept any format (Google issues several, e.g. "AIza…" and "AQ.…"); strip
    // stray quotes or spaces from copy-paste, then check it with a real call.
    const cleaned = String(key || '').trim().replace(/^["']|["']$/g, '').trim();
    settings.setApiKey(provider, cleaned);
    const hasKey = Boolean(settings.getApiKey(provider));
    const value = cleaned || settings.getApiKey(provider);
    const check = !hasKey ? null : provider === 'github' ? await updater.verifyToken(value) : await verifyKey(provider, value);
    if (provider === 'github' && check?.valid !== false) updater.check();
    return { ok: true, hasKey, check };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('ui-state', (_e, state) => {
  const wasRecording = ui.recording;
  ui = { ...ui, ...state };
  if (ui.recording !== wasRecording) {
    // Recording keeps working while the bar is hidden only without throttling.
    win.webContents.setBackgroundThrottling(!ui.recording);
    refreshTray();
  }
});

ipcMain.on('content-height', (_e, h) => {
  contentHeight = Math.max(60, Math.min(Math.ceil(h), 720));
  if (shown && currentDisplay) win.setBounds(barBounds(currentDisplay, contentHeight));
});

ipcMain.on('hide', () => hideBar());
ipcMain.on('open-external', (_e, url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); });
ipcMain.on('show-in-folder', (_e, p) => { if (p && fs.existsSync(p)) shell.showItemInFolder(p); });
ipcMain.on('open-recordings-folder', () => shell.openPath(recordingsDir()));
ipcMain.on('quit', () => app.quit());

// ---------- IPC: recording ----------

function recordingsDir() {
  const dir = path.join(app.getPath('videos'), 'Assistant');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

ipcMain.handle('rec-begin', async (_e, { extension }) => {
  const display = currentDisplay || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const sourceId = await screenSourceId(display);
  if (!sourceId) return { ok: false, error: 'Could not find the screen to record.' };
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  recording.path = path.join(recordingsDir(), `Assistant ${stamp}.${extension}`);
  recording.stream = fs.createWriteStream(recording.path);
  recording.startedAt = Date.now();
  recording.frames = [];
  return { ok: true, sourceId, display: { bounds: display.bounds, scaleFactor: display.scaleFactor } };
});

ipcMain.on('rec-chunk', (_e, chunk) => {
  if (recording.stream) recording.stream.write(Buffer.from(chunk));
});

ipcMain.on('rec-frame', (_e, { t, data }) => {
  if (!recording.stream) return;
  recording.frames.push({ t, data });
  // Keep memory bounded on long recordings: thin out to every other frame.
  if (recording.frames.length > 120) recording.frames = recording.frames.filter((_, i) => i % 2 === 0);
});

ipcMain.handle('rec-end', async () => {
  if (!recording.stream) return { ok: false };
  const stream = recording.stream;
  recording.stream = null;
  await new Promise((resolve) => stream.end(resolve));
  lastRecording = {
    path: recording.path,
    durationSec: (Date.now() - recording.startedAt) / 1000,
    frames: recording.frames,
  };
  return { ok: true, path: lastRecording.path, durationSec: lastRecording.durationSec };
});

// ---------- tray & shortcuts ----------

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Assistant');
  tray.on('click', () => showBar({ focus: true }));
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(agentRun ? [{ label: 'Stop the agent\tAlt+Shift+X', click: stopAgent }, { type: 'separator' }] : []),
    { label: 'Show bar\tAlt+Shift+C', click: () => showBar({ focus: true }) },
    { label: ui.recording ? 'Stop recording\tAlt+Shift+R' : 'Start recording\tAlt+Shift+R', click: () => send('toggle-recording') },
    { label: 'Open recordings folder', click: () => shell.openPath(recordingsDir()) },
    { label: 'Settings…', click: () => { showBar({ focus: true }); send('open-settings', {}); } },
    ...(updater.getStatus().state === 'ready'
      ? [{ label: `Restart to update to ${updater.getStatus().version}`, click: () => updater.installNow() }]
      : [{ label: 'Check for updates', click: () => updater.check() }]),
    { type: 'separator' },
    { label: 'Quit Assistant', click: () => app.quit() },
  ]));
  tray.setToolTip(ui.recording ? 'Assistant (recording)' : 'Assistant');
}

function registerShortcuts() {
  const failed = [];
  const reg = (accel, fn) => { if (!globalShortcut.register(accel, fn)) failed.push(accel); };
  reg('Alt+Shift+C', toggleBar);
  reg('Alt+Shift+R', () => send('toggle-recording'));
  reg('Alt+Shift+S', () => { showBar({ focus: true }); send('quick-ask'); });
  if (settings.load().copilotKey) registerCopilotKey();
  if (failed.length) {
    dialog.showMessageBox({
      type: 'warning',
      message: `Assistant could not register ${failed.join(', ')} because another app already uses ${failed.length > 1 ? 'them' : 'it'}.`,
    });
  }
}

// The Copilot key on newer Windows laptops sends Win+Shift+F23. Windows' shell
// may already own that combination, so a low-level keyboard hook backs up the
// regular shortcut. Both can fire for one press; the debounce keeps it to one toggle.
let lastCopilotPress = 0;
let keyboardHook = null;

function onCopilotKey() {
  const now = Date.now();
  if (now - lastCopilotPress < 400) return;
  lastCopilotPress = now;
  toggleBar();
}

function registerCopilotKey() {
  try { globalShortcut.register('Super+Shift+F23', onCopilotKey); } catch { /* reserved by the shell */ }
  try {
    const { uIOhook, UiohookKey } = require('uiohook-napi');
    uIOhook.on('keydown', (e) => { if (e.keycode === UiohookKey.F23) onCopilotKey(); });
    uIOhook.start();
    keyboardHook = uIOhook;
  } catch (err) {
    console.warn('Keyboard hook unavailable; the Copilot key relies on the global shortcut only.', err);
  }
}

app.on('will-quit', () => {
  local.stop();
  globalShortcut.unregisterAll();
  if (keyboardHook) keyboardHook.stop();
});
app.on('window-all-closed', (e) => e.preventDefault());
