// Offline speech-to-text: OpenAI's Whisper (small, multilingual) running on
// this PC with whisper.cpp. It's used when the Offline model is selected or
// there's no Gemini key, and as a fallback when Gemini can't be reached. The
// model (about 190 MB) downloads once, only when you agree to it, and runs in
// its own process that ends after a few idle minutes.
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { download } = require('./local');

const MODEL = { file: 'ggml-small-q5_1.bin', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin', approxMB: 190 };
const IDLE_STOP_MS = 3 * 60 * 1000;

const modelPath = () => path.join(app.getPath('userData'), 'offline', 'speech', MODEL.file);
const isDownloaded = () => fs.existsSync(modelPath());

let downloading = null;
async function ensureModel(onProgress) {
  if (isDownloaded()) return modelPath();
  downloading ||= (async () => {
    fs.mkdirSync(path.dirname(modelPath()), { recursive: true });
    try {
      await download(MODEL.url, modelPath(), 'offline speech recognition', onProgress);
    } finally {
      downloading = null;
    }
  })();
  await downloading;
  return modelPath();
}

let worker = null; // { proc, ready: Promise }
let idleTimer = null;
let seq = 0;
const pending = new Map();

function startWorker() {
  const proc = utilityProcess.fork(path.join(__dirname, 'speech-worker.js'), [], { serviceName: 'Assistant offline speech' });
  const ready = new Promise((resolve, reject) => {
    proc.on('message', (msg) => {
      if (msg.type === 'loaded') resolve();
      else if (msg.type === 'result') { pending.get(msg.id)?.resolve(msg.text); pending.delete(msg.id); }
      else if (msg.type === 'error') {
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id).reject(new Error(msg.message)); pending.delete(msg.id); }
        else reject(new Error(msg.message));
      }
    });
    proc.on('exit', () => {
      reject(new Error('Offline speech recognition stopped while loading.'));
      for (const p of pending.values()) p.reject(new Error('Offline speech recognition stopped unexpectedly.'));
      pending.clear();
      if (worker?.proc === proc) worker = null;
    });
  });
  proc.postMessage({ type: 'load', model: modelPath(), threads: Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2))) });
  return { proc, ready };
}

function stop() {
  clearTimeout(idleTimer);
  if (worker) { worker.proc.kill(); worker = null; }
}

// wav: a 16 kHz mono 16-bit WAV (what the renderer records).
async function transcribe(wav) {
  if (!isDownloaded()) throw new Error('Offline speech recognition is not downloaded yet.');
  clearTimeout(idleTimer);
  worker ||= startWorker();
  const w = worker;
  try {
    await w.ready;
    const buf = Buffer.from(wav);
    const pcm = buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.byteLength);
    const id = ++seq;
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.proc.postMessage({ type: 'transcribe', id, pcm });
    });
  } finally {
    idleTimer = setTimeout(stop, IDLE_STOP_MS);
  }
}

module.exports = { MODEL, isDownloaded, ensureModel, transcribe, stop };
