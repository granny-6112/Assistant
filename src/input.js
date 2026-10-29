// Mouse and keyboard for agent mode, through libnut (SendInput on Windows).
// Coordinates arrive in screenshot pixels and are mapped to the physical pixels
// of the display the screenshot came from. libnut addresses the primary
// display only, so agent mode always works on the primary display.
const { screen } = require('electron');

let lib = null;
function nut() {
  if (lib) return lib;
  try {
    lib = require(process.platform === 'win32' ? '@nut-tree-fork/libnut-win32' : '@nut-tree-fork/libnut-linux');
  } catch (err) {
    throw new Error(`Couldn't load the mouse and keyboard module: ${err.message}`);
  }
  lib.setMouseDelay(0);
  lib.setKeyboardDelay(8);
  return lib;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function toScreen(sx, sy, shot) {
  const b = shot.display.bounds;
  const dip = { x: b.x + (sx * b.width) / shot.width, y: b.y + (sy * b.height) / shot.height };
  const p = process.platform === 'win32' ? screen.dipToScreenPoint(dip) : dip;
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

function fromScreen(p, shot) {
  const b = shot.display.bounds;
  const dip = process.platform === 'win32' ? screen.screenToDipPoint(p) : p;
  return { x: Math.round(((dip.x - b.x) * shot.width) / b.width), y: Math.round(((dip.y - b.y) * shot.height) / b.height) };
}

// Model key names (xdotool style from Claude, plain words from Gemini) to libnut's.
const KEY_ALIASES = {
  ctrl: 'control', control: 'control', ctl: 'control',
  alt: 'alt', option: 'alt',
  shift: 'shift',
  win: 'command', windows: 'command', super: 'command', meta: 'command', cmd: 'command', command: 'command', super_l: 'command',
  return: 'enter', enter: 'enter', kp_enter: 'enter',
  esc: 'escape', escape: 'escape',
  backspace: 'backspace', back_space: 'backspace',
  del: 'delete', delete: 'delete',
  ins: 'insert', insert: 'insert',
  tab: 'tab', space: 'space', spacebar: 'space',
  up: 'up', down: 'down', left: 'left', right: 'right',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
  home: 'home', end: 'end',
  pageup: 'pageup', page_up: 'pageup', prior: 'pageup', pgup: 'pageup',
  pagedown: 'pagedown', page_down: 'pagedown', next: 'pagedown', pgdn: 'pagedown',
  printscreen: 'printscreen', print: 'printscreen',
  menu: 'menu', capslock: 'caps_lock', caps_lock: 'caps_lock',
  minus: '-', equal: '=', plus: '+', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', apostrophe: "'", grave: '`',
};
const MODIFIERS = new Set(['control', 'alt', 'shift', 'command']);

function keyName(k) {
  const raw = String(k).trim();
  const lower = raw.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) return lower;
  if (raw.length === 1) return raw.toLowerCase();
  return lower;
}

function parseCombo(combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean).map(keyName);
  if (!parts.length) throw new Error(`No key given in "${combo}"`);
  const key = parts.pop();
  return { key, modifiers: parts.filter((p) => MODIFIERS.has(p)) };
}

function modifierList(text) {
  if (!text) return [];
  return String(text).split('+').map(keyName).filter((m) => MODIFIERS.has(m));
}

const held = new Set();
function hold(mods) { for (const m of mods) { nut().keyToggle(m, 'down'); held.add(m); } }
function release(mods) { for (const m of [...mods].reverse()) { nut().keyToggle(m, 'up'); held.delete(m); } }

function releaseAll() {
  if (!lib) return;
  try {
    release([...held]);
    lib.mouseToggle('up', 'left');
  } catch {
    // best effort after a stop
  }
}

function move(p) { nut().moveMouse(p.x, p.y); }

function cursor() { return nut().getMousePos(); }

async function click({ point, button = 'left', count = 1, modifiers }) {
  const mods = modifierList(modifiers);
  if (point) { move(point); await pause(40); }
  hold(mods);
  try {
    if (count === 2) nut().mouseClick(button, true);
    else for (let i = 0; i < count; i++) { nut().mouseClick(button, false); if (i < count - 1) await pause(40); }
  } finally {
    release(mods);
  }
}

function mouseToggle(state) { nut().mouseToggle(state, 'left'); }

async function drag(from, to, modifiers) {
  const mods = modifierList(modifiers);
  move(from);
  await pause(60);
  hold(mods);
  nut().mouseToggle('down', 'left');
  try {
    // Move in steps so apps see a real drag rather than a jump.
    for (let i = 1; i <= 12; i++) {
      move({ x: Math.round(from.x + ((to.x - from.x) * i) / 12), y: Math.round(from.y + ((to.y - from.y) * i) / 12) });
      await pause(15);
    }
  } finally {
    nut().mouseToggle('up', 'left');
    release(mods);
  }
}

// Windows takes raw wheel units (120 per notch); X11 takes notches.
const NOTCH = process.platform === 'win32' ? 120 : 1;

async function scroll({ point, direction, amount = 3, modifiers }) {
  const mods = modifierList(modifiers);
  if (point) { move(point); await pause(40); }
  const n = Math.max(1, Math.min(30, Math.round(amount))) * NOTCH;
  const dx = direction === 'right' ? n : direction === 'left' ? -n : 0;
  const dy = direction === 'up' ? n : direction === 'down' ? -n : 0;
  hold(mods);
  try {
    nut().scrollMouse(dx, dy);
  } finally {
    release(mods);
  }
}

async function key(combo, repeat = 1) {
  const { key: k, modifiers } = parseCombo(combo);
  for (let i = 0; i < Math.max(1, Math.min(100, repeat)); i++) {
    if (modifiers.length) nut().keyTap(k, modifiers); else nut().keyTap(k);
    if (repeat > 1) await pause(30);
  }
}

async function holdKey(combo, seconds, signal) {
  const { key: k, modifiers } = parseCombo(combo);
  hold(modifiers);
  nut().keyToggle(k, 'down');
  try {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, seconds * 1000);
      signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  } finally {
    nut().keyToggle(k, 'up');
    release(modifiers);
  }
}

// Types in short chunks so a stop takes effect quickly. Newlines become Enter.
async function type(text, signal) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j += 24) {
      if (signal?.aborted) return;
      nut().typeString(lines[i].slice(j, j + 24));
    }
    if (i < lines.length - 1) nut().keyTap('enter');
  }
}

module.exports = { toScreen, fromScreen, move, cursor, click, mouseToggle, drag, scroll, key, holdKey, type, releaseAll };
