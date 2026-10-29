// Screen recording with MediaRecorder. Chunks stream to disk through the main
// process, and a still frame is saved every few seconds so Claude can be asked
// about the recording afterwards (the API takes images, not video).
(() => {
  const FRAME_EVERY_MS = 3000;
  let rec = null;

  function pickMimeType() {
    const candidates = [
      'video/mp4;codecs=avc1.640033,mp4a.40.2',
      'video/mp4;codecs=avc1,opus',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    return candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  }

  async function capture(sourceId, withAudio) {
    const video = {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: 3840,
        maxHeight: 2160,
        maxFrameRate: 30,
      },
    };
    if (withAudio) {
      try {
        return {
          stream: await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'desktop' } }, video }),
          audio: true,
        };
      } catch {
        // fall through to video only
      }
    }
    return { stream: await navigator.mediaDevices.getUserMedia({ audio: false, video }), audio: false };
  }

  async function start({ withAudio, onUnexpectedStop }) {
    if (rec) return rec;
    const mimeType = pickMimeType();
    const begin = await window.bar.recBegin({ extension: mimeType.startsWith('video/mp4') ? 'mp4' : 'webm' });
    if (!begin.ok) throw new Error(begin.error);

    const { stream, audio } = await capture(begin.sourceId, withAudio);
    const recorder = new MediaRecorder(stream, { mimeType: mimeType || undefined, videoBitsPerSecond: 8_000_000 });
    let chain = Promise.resolve(); // keeps chunks in order while they are converted
    recorder.ondataavailable = (e) => {
      if (!e.data.size) return;
      chain = chain.then(async () => window.bar.recChunk(new Uint8Array(await e.data.arrayBuffer())));
    };

    const frameVideo = document.createElement('video');
    frameVideo.muted = true;
    frameVideo.srcObject = stream;
    await frameVideo.play();
    const canvas = document.createElement('canvas');
    const startedAt = Date.now();
    const grab = () => {
      if (!frameVideo.videoWidth) return;
      const k = Math.min(1, 1280 / Math.max(frameVideo.videoWidth, frameVideo.videoHeight));
      canvas.width = Math.round(frameVideo.videoWidth * k);
      canvas.height = Math.round(frameVideo.videoHeight * k);
      canvas.getContext('2d').drawImage(frameVideo, 0, 0, canvas.width, canvas.height);
      const data = canvas.toDataURL('image/jpeg', 0.72).split(',')[1];
      window.bar.recFrame({ t: (Date.now() - startedAt) / 1000, data });
    };
    const firstFrame = setTimeout(grab, 400);
    const frameTimer = setInterval(grab, FRAME_EVERY_MS);

    // Windows can end the capture on its own (display unplugged, session locked).
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (rec) stop().then(onUnexpectedStop, onUnexpectedStop);
    });

    recorder.start(1000);
    rec = { stream, recorder, frameVideo, firstFrame, frameTimer, startedAt, grab, chain: () => chain, audio };
    return rec;
  }

  async function stop() {
    if (!rec) return null;
    const r = rec;
    rec = null;
    clearTimeout(r.firstFrame);
    clearInterval(r.frameTimer);
    r.grab(); // final frame, so the end of the recording is represented
    if (r.recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        r.recorder.addEventListener('stop', resolve, { once: true });
        r.recorder.stop();
      });
    }
    await r.chain();
    r.stream.getTracks().forEach((t) => t.stop());
    r.frameVideo.srcObject = null;
    return window.bar.recEnd();
  }

  window.Recorder = {
    start,
    stop,
    active: () => Boolean(rec),
    elapsedSec: () => (rec ? (Date.now() - rec.startedAt) / 1000 : 0),
  };
})();
