// Runs the offline model in its own process (Electron utilityProcess), so a
// crash in native code can't take the app down, and unloading is just ending
// this process: all of its RAM and GPU memory goes back to Windows at once.
const { loadModel } = require('@fugood/llama.node');

let ctx = null;
let gpu = false;

const send = (msg) => process.parentPort.postMessage(msg);

async function load({ model, mmproj, nCtx, threads, cpuOnly }) {
  // llama.cpp reports progress from its own thread, so the last few reports
  // can arrive after loadModel has resolved. Drop those, or the app would
  // show "Loading" again after the model is ready.
  let loading = true;
  const progress = (p) => { if (loading) send({ type: 'progress', progress: p / 100 }); };
  const opts = { model, n_ctx: nCtx, n_threads: threads, n_gpu_layers: 99, use_mlock: false };
  try {
    if (cpuOnly) throw new Error('GPU disabled after an earlier crash');
    // Vulkan runs on the laptop's graphics chip (integrated Radeon included).
    ctx = await loadModel({ ...opts, lib_variant: 'vulkan' }, progress);
    gpu = true;
  } catch (err) {
    send({ type: 'log', message: `Vulkan unavailable, using the CPU: ${err.message}` });
    ctx = await loadModel({ ...opts, n_gpu_layers: 0 }, progress);
    gpu = false;
  }
  if (!ctx.initMultimodal({ path: mmproj, use_gpu: gpu })) {
    throw new Error('The vision part of the offline model failed to load.');
  }
  loading = false;
}

async function complete({ id, messages, nPredict }) {
  const result = await ctx.completion(
    { messages, n_predict: nPredict, jinja: true, enable_thinking: false, reasoning_format: 'none', temperature: 0.4 },
    (t) => { if (t.token) send({ type: 'token', id, text: t.token }); },
  );
  send({ type: 'done', id, truncated: Boolean(result.stopped_limit), text: result.text });
}

process.parentPort.on('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      await load(data);
      send({ type: 'loaded', gpu });
    } else if (data.type === 'complete') {
      await complete(data);
    } else if (data.type === 'stop') {
      if (ctx) ctx.stopCompletion();
    }
  } catch (err) {
    send({ type: 'error', id: data.id, message: err?.message || String(err) });
  }
});
