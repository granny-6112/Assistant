// Persists user settings as JSON and API keys encrypted with Windows DPAPI
// (Electron safeStorage), both under the app's userData folder.
const { app, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  modelId: 'gemini-3.8-flash', // position of the model slider; see MODELS in providers.js
  localTier: 'auto',        // offline model size: 'auto' | 'small' | 'medium' | 'large'
  effort: 'low',            // Claude only: low = fastest answers; raise for harder questions
  revealZone: 'full',       // 'full' = anywhere on the top edge, 'center' = only above the bar
  revealDelayMs: 150,       // how long the cursor must rest on the edge before the bar appears
  hideDelayMs: 600,
  includeScreen: true,
  screenshotQuality: 'standard', // 'standard' = 1920px long edge, 'high' = 2576px
  recordAudio: true,
  liveGlass: 'always',      // live refracted backdrop: 'always' | 'plugged' (only on mains power) | 'off'
  glassTint: 'auto',        // 'auto' | 'dark' | 'light'
  fontFamily: 'segoe',      // see FONTS in renderer/app.js
  glassTransparency: 50,    // 0 = solid frosted glass, 100 = almost clear
  accentColor: '#d97757',   // drives every coloured element (buttons, slider, dots, links)
  launchAtLogin: false,
  copilotKey: true,         // the laptop Copilot key toggles the bar
  setupDone: false,         // the first-run key walkthrough was finished or skipped
  saveHistory: true,        // keep conversations (text only) for the Claude extension
  agentEnabled: false,      // agent mode may move the mouse and type (opt-in)
};

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const keyFile = (provider) => path.join(app.getPath('userData'), `${provider}-key.bin`);
// Only used if the OS offers no secure storage (never the case on Windows).
const plainKeyFile = (provider) => path.join(app.getPath('userData'), `${provider}-key.txt`);
const ENV_VARS = { google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], anthropic: ['ANTHROPIC_API_KEY'] };

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function save(patch) {
  const next = { ...load() };
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULTS) next[k] = v;
  }
  cache = next;
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  return next;
}

function envKey(provider) {
  for (const name of ENV_VARS[provider] || []) if (process.env[name]) return process.env[name];
  return '';
}

function getApiKey(provider) {
  try {
    const buf = fs.readFileSync(keyFile(provider));
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
  } catch {
    // no encrypted key stored
  }
  try {
    return fs.readFileSync(plainKeyFile(provider), 'utf8').trim() || envKey(provider);
  } catch {
    return envKey(provider);
  }
}

function setApiKey(provider, key) {
  if (!ENV_VARS[provider]) throw new Error(`Unknown provider ${provider}.`);
  const trimmed = (key || '').trim();
  fs.rmSync(keyFile(provider), { force: true });
  fs.rmSync(plainKeyFile(provider), { force: true });
  if (!trimmed) return;
  fs.mkdirSync(path.dirname(keyFile(provider)), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyFile(provider), safeStorage.encryptString(trimmed));
  } else {
    fs.writeFileSync(plainKeyFile(provider), trimmed, { mode: 0o600 });
  }
}

module.exports = { DEFAULTS, load, save, getApiKey, setApiKey, envKey };
