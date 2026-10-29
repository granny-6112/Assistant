// Voice input: records the microphone as 16 kHz mono WAV (a format Gemini
// accepts) and stops by itself after a stretch of silence. The audio is only
// kept in memory until it has been transcribed.
(() => {
  const RATE = 16000;
  const SILENCE_MS = 5000;     // stop after this long without speech
  const NO_SPEECH_MS = 8000;   // give up if nothing is said at all
  const MAX_MS = 60000;
  const SPEECH_RMS = 0.02;     // level that counts as speaking

  let rec = null;

  function encodeWav(chunks, inRate) {
    // Downsample by averaging, then write 16-bit PCM.
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const ratio = inRate / RATE;
    const outLen = Math.floor(total / ratio);
    const pcm = new Int16Array(outLen);
    const all = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(total, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += all[j];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.byteLength);
    const dv = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
    str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, RATE, true); dv.setUint32(28, RATE * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, pcm.byteLength, true);
    new Int16Array(buf, 44).set(pcm);
    return buf;
  }

  function describeMicError(err) {
    if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') {
      return 'Windows is blocking the microphone for Assistant. Turn on "Let desktop apps access your microphone" in Windows Settings → Privacy & security → Microphone.';
    }
    if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No microphone was found. Plug one in or check it in Windows sound settings.';
    if (err?.name === 'NotReadableError') return 'Another app is using the microphone, or Windows blocked it. Close that app, or check Windows Settings → Privacy & security → Microphone.';
    return `The microphone couldn't start: ${err?.message || err}`;
  }

  // Resolves with { wav, spoke } when recording ends: silence, finish() or the
  // time limit. cancel() resolves with null.
  async function start({ onTick } = {}) {
    if (rec) return null;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    const began = performance.now();
    let lastVoice = 0;
    let spoke = false;

    return new Promise((resolve) => {
      const end = (keep) => {
        if (!rec) return;
        clearInterval(rec.timer);
        node.disconnect();
        src.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        const rate = ctx.sampleRate;
        ctx.close();
        rec = null;
        resolve(keep && chunks.length ? { wav: encodeWav(chunks, rate), spoke } : null);
      };
      node.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        chunks.push(new Float32Array(data));
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        if (Math.sqrt(sum / data.length) > SPEECH_RMS) { spoke = true; lastVoice = performance.now(); }
      };
      src.connect(node);
      node.connect(ctx.destination);
      rec = {
        finish: () => end(true),
        cancel: () => end(false),
        timer: setInterval(() => {
          const now = performance.now();
          onTick?.(Math.floor((now - began) / 1000));
          if (now - began > MAX_MS) end(true);
          else if (spoke && now - lastVoice > SILENCE_MS) end(true);
          else if (!spoke && now - began > NO_SPEECH_MS) end(true);
        }, 200),
      };
    });
  }

  // Asks for the microphone once (first-run setup) without recording anything.
  async function requestAccess() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  }

  window.Voice = {
    start,
    finish: () => rec?.finish(),
    cancel: () => rec?.cancel(),
    active: () => Boolean(rec),
    requestAccess,
    describeMicError,
  };
})();
