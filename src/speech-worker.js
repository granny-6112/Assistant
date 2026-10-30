// Runs Whisper in its own process (Electron utilityProcess), so a crash in
// native code can't take the app down and unloading frees all of its memory.
const { initWhisper } = require('@fugood/whisper.node');

let ctx = null;
let threads = 4;
const send = (msg) => process.parentPort.postMessage(msg);

// Whisper sometimes "hears" these in silence; they are not speech.
const NOISE = /^\s*(\[[^\]]*\]|\([^)]*\)|thank you\.?|thanks for watching!?)\s*$/i;

process.parentPort.on('message', async ({ data }) => {
  try {
    if (data.type === 'load') {
      threads = data.threads || threads;
      ctx = await initWhisper({ filePath: data.model, useGpu: false });
      send({ type: 'loaded' });
    } else if (data.type === 'transcribe') {
      const { promise } = ctx.transcribeData(data.pcm, { language: 'auto', maxThreads: threads, temperature: 0 });
      const r = await promise;
      const text = (r.result || '').replace(/\s+/g, ' ').trim();
      send({ type: 'result', id: data.id, text: NOISE.test(text) ? '' : text });
    }
  } catch (err) {
    send({ type: 'error', id: data.id, message: err?.message || String(err) });
  }
});
