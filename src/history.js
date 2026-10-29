// Saves each conversation as a small JSON file (text only, never screenshots)
// under userData/history, so the "Assistant for Claude" extension can let the
// Claude desktop app read what was discussed here. Nothing leaves the PC.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KEEP = 200; // newest conversations kept on disk

const dir = () => path.join(app.getPath('userData'), 'history');

function newId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 19).replace(/[-:T]/g, '');
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

function file(id) {
  return path.join(dir(), `${id}.json`);
}

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return null;
  }
}

function prune() {
  try {
    const files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) fs.rmSync(path.join(dir(), f), { force: true });
  } catch {
    // nothing to prune
  }
}

// Appends one question and its answer. Writes to a temp file and renames, so
// the extension never reads a half-written file.
function append(id, { question, answer, model, attachments = [], mode = 'ask' }) {
  const now = new Date().toISOString();
  const convo = read(id) || { id, title: question.slice(0, 80), startedAt: now, turns: [] };
  convo.updatedAt = now;
  convo.turns.push(
    { role: 'user', text: question, at: now, mode, attachments },
    { role: 'assistant', text: answer, at: now, model },
  );
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(id)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(convo, null, 1));
  fs.renameSync(tmp, file(id));
  if (convo.turns.length === 2) prune();
}

function clearAll() {
  fs.rmSync(dir(), { recursive: true, force: true });
}

module.exports = { newId, append, clearAll, dir };
