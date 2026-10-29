// Offline model: Google's Gemma 4 running on this PC with llama.cpp, bundled
// in the app through @fugood/llama.node (Vulkan, so it uses the GPU,
// integrated Radeon included, and falls back to the CPU). The first time it's
// used, the model downloads from Hugging Face into the app's data folder;
// after that it works with no internet. It runs in a separate process that
// only exists while the model is in use.
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Largest model that runs comfortably for a given amount of RAM, alongside
// the browser and other apps the user has open.
const TIERS = {
  small: { repo: 'ggml-org/gemma-4-E2B-it-GGUF', name: 'Gemma 4 E2B', approxGB: 3.5, minRamGB: 0 },
  medium: { repo: 'ggml-org/gemma-4-E4B-it-GGUF', name: 'Gemma 4 E4B', approxGB: 5.5, minRamGB: 12 },
  large: { repo: 'ggml-org/gemma-4-26B-A4B-it-GGUF', name: 'Gemma 4 26B-A4B', approxGB: 17, minRamGB: 28 },
};
const QUANT = 'Q4_K_M';
const IDLE_STOP_MS = 5 * 60 * 1000; // unload the offline model (frees ~6 GB of RAM and the GPU) after 5 idle minutes

const modelsDir = () => path.join(app.getPath('userData'), 'offline', 'models');

function ramGB() {
  return os.totalmem() / 1024 ** 3;
}

function autoTier() {
  const ram = ramGB();
  if (ram >= TIERS.large.minRamGB) return 'large';
  if (ram >= TIERS.medium.minRamGB) return 'medium';
  return 'small';
}

function resolveTier(setting) {
  return TIERS[setting] ? setting : autoTier();
}

// ---------- status reported to the UI ----------

let status = { state: 'idle', progress: 0, message: '' };
let listener = () => {};

function setStatus(next) {
  status = { ...status, ...next };
  listener(status);
}

function onStatus(fn) { listener = fn; }

// ---------- downloads ----------

// Resumable: an interrupted multi-GB download continues where it stopped.
async function download(url, dest, label) {
  const tmp = `${dest}.part`;
  const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
  const headers = { 'User-Agent': 'Assistant-desktop' };
  if (have) headers.Range = `bytes=${have}-`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`Download of ${label} failed (HTTP ${res.status}).`);
  const resumed = res.status === 206;
  const total = (Number(res.headers.get('content-length')) || 0) + (resumed ? have : 0);
  let done = resumed ? have : 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (total && now - lastReport > 250) {
        lastReport = now;
        setStatus({ state: 'downloading', progress: done / total, message: `Downloading ${label}: ${(done / 1e9).toFixed(2)} of ${(total / 1e9).toFixed(2)} GB` });
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp, { flags: resumed ? 'a' : 'w' }));
  fs.renameSync(tmp, dest);
}

async function hfFiles(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main`, { headers: { 'User-Agent': 'Assistant-desktop' } });
  if (!res.ok) throw new Error(`Could not list the files of ${repo} (HTTP ${res.status}).`);
  return (await res.json()).filter((f) => f.type === 'file').map((f) => f.path);
}

async function ensureModel(tierKey) {
  const tier = TIERS[tierKey];
  const dir = path.join(modelsDir(), tier.repo.replace('/', '__'));
  fs.mkdirSync(dir, { recursive: true });
  const have = fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'));
  let model = have.find((f) => !f.startsWith('mmproj'));
  let mmproj = have.find((f) => f.startsWith('mmproj'));
  if (model && mmproj) return { model: path.join(dir, model), mmproj: path.join(dir, mmproj) };

  setStatus({ state: 'downloading', progress: 0, message: `Finding ${tier.name}…` });
  const files = await hfFiles(tier.repo);
  const ggufs = files.filter((f) => f.endsWith('.gguf'));
  const weights = ggufs.filter((f) => !/mmproj/i.test(f));
  const projs = ggufs.filter((f) => /mmproj/i.test(f));
  model = model || weights.find((f) => f.includes(QUANT)) || weights.find((f) => /Q4/i.test(f)) || weights[0];
  mmproj = mmproj || projs.find((f) => /f16/i.test(f)) || projs[0];
  if (!model || !mmproj) throw new Error(`${tier.repo} does not have the files needed for image input.`);

  const url = (f) => `https://huggingface.co/${tier.repo}/resolve/main/${encodeURIComponent(f)}`;
  const modelPath = path.join(dir, path.basename(model));
  const projPath = path.join(dir, `mmproj-${path.basename(mmproj).replace(/^mmproj-?/i, '')}`);
  if (!fs.existsSync(projPath)) await download(url(mmproj), projPath, `${tier.name} (vision part)`);
  if (!fs.existsSync(modelPath)) await download(url(model), modelPath, tier.name);
  return { model: modelPath, mmproj: projPath };
}

// ---------- model process lifecycle ----------

let worker = null; // { proc, tierKey, gpu }
let starting = null;
let idleTimer = null;
let requestSeq = 0;
const pending = new Map(); // id -> { onText, resolve, reject }

// A failed load can crash llama.cpp outright instead of throwing, so a GPU
// load that takes the process down is retried once on the CPU.
let gpuCrashed = false;

function startWorker(files, cpuOnly) {
  return new Promise((resolve, reject) => {
    const proc = utilityProcess.fork(path.join(__dirname, 'local-worker.js'), [], { serviceName: 'Assistant offline model' });
    let loaded = false;
    proc.on('message', (msg) => {
      if (msg.type === 'progress') {
        if (loaded) return; // a late report from llama.cpp's loader thread
        setStatus({ state: 'loading', progress: msg.progress, message: 'Loading the offline model…' });
      } else if (msg.type === 'loaded') {
        loaded = true;
        resolve({ proc, gpu: msg.gpu });
      } else if (msg.type === 'token') {
        pending.get(msg.id)?.onText(msg.text);
      } else if (msg.type === 'done') {
        pending.get(msg.id)?.resolve(msg);
        pending.delete(msg.id);
      } else if (msg.type === 'error') {
        if (!loaded) reject(new Error(msg.message));
        else if (pending.has(msg.id)) { pending.get(msg.id).reject(new Error(msg.message)); pending.delete(msg.id); }
      } else if (msg.type === 'log') {
        console.warn('[offline model]', msg.message);
      }
    });
    proc.on('exit', (code) => {
      if (!loaded) reject(new Error(`The offline model process stopped while loading (code ${code}).`));
      for (const p of pending.values()) p.reject(new Error('The offline model stopped unexpectedly.'));
      pending.clear();
      if (worker && worker.proc === proc) {
        worker = null;
        setStatus({ state: 'idle', progress: 0, message: '' });
      }
    });
    proc.postMessage({
      type: 'load',
      model: files.model,
      mmproj: files.mmproj,
      nCtx: 8192,
      threads: Math.max(2, Math.floor(os.cpus().length / 2)),
      cpuOnly,
    });
  });
}

async function start(tierSetting) {
  const tierKey = resolveTier(tierSetting);
  if (worker && worker.tierKey === tierKey) return worker;
  if (starting) return starting;
  starting = (async () => {
    stop();
    try {
      const files = await ensureModel(tierKey);
      setStatus({ state: 'loading', progress: 0, message: `Loading ${TIERS[tierKey].name}…` });
      let result;
      try {
        result = await startWorker(files, gpuCrashed);
      } catch (err) {
        if (gpuCrashed || !/stopped while loading/.test(err.message)) throw err;
        gpuCrashed = true;
        setStatus({ state: 'loading', progress: 0, message: 'Graphics chip failed, loading on the CPU instead…' });
        result = await startWorker(files, true);
      }
      const { proc, gpu } = result;
      worker = { proc, tierKey, gpu };
      markReady(worker);
      return worker;
    } catch (err) {
      setStatus({ state: 'error', message: err.message });
      throw err;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

function markReady(w) {
  setStatus({ state: 'ready', progress: 1, message: `${TIERS[w.tierKey].name} is ready (offline, ${w.gpu ? 'on the GPU' : 'on the CPU'}).` });
}

function stop() {
  clearTimeout(idleTimer);
  if (worker) {
    worker.proc.kill();
    worker = null;
  }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stop(); setStatus({ state: 'idle', progress: 0, message: '' }); }, IDLE_STOP_MS);
}

// ---------- chat ----------

// Image encoding is the slow part on a laptop GPU, so the offline model only
// sees images from the newest question; older ones become a short note.
function toChatMessages(systemPrompt, messages) {
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  const out = [{ role: 'system', content: systemPrompt }];
  messages.forEach((m, i) => {
    const parts = m.content.map((b) => {
      if (b.type !== 'image') return { type: 'text', text: b.text };
      if (i !== lastUser) return { type: 'text', text: '[earlier image omitted]' };
      return { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } };
    });
    out.push({ role: m.role, content: m.role === 'assistant' ? parts.map((p) => p.text).join('\n') : parts });
  });
  return out;
}

async function streamLocal({ tierSetting, systemPrompt, messages, signal, onText }) {
  const w = await start(tierSetting);
  clearTimeout(idleTimer);
  if (status.state !== 'ready') markReady(w);
  const id = ++requestSeq;
  try {
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { onText, resolve, reject });
      const onAbort = () => {
        w.proc.postMessage({ type: 'stop' });
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      w.proc.postMessage({ type: 'complete', id, messages: toChatMessages(systemPrompt, messages), nPredict: 2048 });
    });
    return { refused: false, truncated: result.truncated, servedBy: TIERS[w.tierKey].name, text: result.text };
  } finally {
    pending.delete(id);
    touch();
  }
}

function describe(tierSetting) {
  const key = resolveTier(tierSetting);
  return { tier: key, auto: !TIERS[tierSetting], ramGB: Math.round(ramGB()), ...TIERS[key], status };
}

module.exports = { TIERS, autoTier, describe, start, stop, streamLocal, onStatus };
