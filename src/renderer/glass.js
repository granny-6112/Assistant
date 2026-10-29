// Liquid glass: streams the screen behind the window (the window itself is
// excluded from capture), draws the part under each glass element blurred and
// saturated into its canvas, then bends it at the edges with an SVG
// displacement map so the rim magnifies what's behind it like curved glass.
(() => {
  const video = document.getElementById('backdrop-video');
  const root = document.documentElement;
  const BLUR_PX = 7;          // in canvas pixels; canvases render at half resolution
  const CANVAS_SCALE = 0.5;
  // The backdrop is heavily blurred, so a small, slow capture looks identical
  // to a full one at a fraction of the CPU and GPU cost.
  const CAPTURE_MAX_PX = 960;
  const CAPTURE_FPS = 20;

  const glasses = [...document.querySelectorAll('.glass')].map((el) => ({
    el,
    canvas: el.querySelector('.glass-refraction'),
    ctx: el.querySelector('.glass-refraction').getContext('2d'),
    filter: document.getElementById(el.dataset.lens),
    sizeKey: '',
  }));

  let stream = null;
  let sourceId = null;
  let display = null;
  let frameCb = 0;
  let redrawQueued = 0;

  // ---- displacement maps ----

  function radiusOf(el, w, h) {
    const r = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return Math.min(r, w / 2, h / 2);
  }

  // Encodes, per pixel, how far to pull the image inward near the rounded edge.
  // R/G = 128 means no shift; feDisplacementMap turns the offset into pixels.
  function buildMap(w, h, radius, edge) {
    const cw = Math.max(2, Math.round(w * CANVAS_SCALE));
    const ch = Math.max(2, Math.round(h * CANVAS_SCALE));
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(cw, ch);
    const d = img.data;
    for (let j = 0; j < ch; j++) {
      const y = (j + 0.5) / CANVAS_SCALE;
      for (let i = 0; i < cw; i++) {
        const x = (i + 0.5) / CANVAS_SCALE;
        const cx = Math.min(Math.max(x, radius), w - radius);
        const cy = Math.min(Math.max(y, radius), h - radius);
        let dx = x - cx;
        let dy = y - cy;
        const len = Math.hypot(dx, dy);
        let dist;
        let nx = 0;
        let ny = 0;
        if (len > 0) {
          dist = radius - len;
          nx = dx / len;
          ny = dy / len;
        } else {
          const m = Math.min(x, w - x, y, h - y);
          dist = m;
          if (m === x) nx = -1; else if (m === w - x) nx = 1; else if (m === y) ny = -1; else ny = 1;
        }
        const t = Math.min(Math.max(1 - dist / edge, 0), 1);
        const mag = t * t * (3 - 2 * t); // smoothstep: soft lens falloff
        const k = (j * cw + i) * 4;
        d[k] = 128 - nx * mag * 127;
        d[k + 1] = 128 - ny * mag * 127;
        d[k + 2] = 128;
        d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }

  function syncSize(g) {
    const w = g.el.offsetWidth;
    const h = g.el.offsetHeight;
    if (!w || !h) return false;
    const key = `${w}x${h}`;
    if (key === g.sizeKey) return true;
    g.sizeKey = key;
    g.canvas.width = Math.max(1, Math.round(w * CANVAS_SCALE));
    g.canvas.height = Math.max(1, Math.round(h * CANVAS_SCALE));
    const fe = g.filter.querySelector('feImage');
    fe.setAttribute('href', buildMap(w, h, radiusOf(g.el, w, h), Math.min(26, h / 2)));
    fe.setAttribute('x', '0');
    fe.setAttribute('y', '0');
    fe.setAttribute('width', String(w));
    fe.setAttribute('height', String(h));
    g.canvas.style.filter = `url(#${g.filter.id})`;
    return true;
  }

  const ro = new ResizeObserver(() => { glasses.forEach(syncSize); requestRedraw(); });
  glasses.forEach((g) => ro.observe(g.el));

  // ---- drawing ----

  // Draws only when the capture delivers a new frame. Windows sends frames only
  // when something on screen changes, so an idle desktop costs nothing.
  function onVideoFrame() {
    frameCb = video.requestVideoFrameCallback(onVideoFrame);
    draw();
  }

  // Redraw from the last frame when the glass changes size on a still screen.
  function requestRedraw() {
    if (redrawQueued || !stream) return;
    redrawQueued = requestAnimationFrame(() => { redrawQueued = 0; draw(); });
  }

  function draw() {
    if (!display || video.readyState < 2 || !video.videoWidth) return;

    const sx = video.videoWidth / display.bounds.width;
    const sy = video.videoHeight / display.bounds.height;
    const light = root.dataset.tint === 'light';

    for (const g of glasses) {
      if (g.el.hidden || !syncSize(g)) continue;
      // Use layout position (not the animated transform) so the glass shows what
      // is really behind its resting place, like a pane sliding into view.
      const left = window.screenX - display.bounds.x + offsetLeft(g.el);
      const top = window.screenY - display.bounds.y + offsetTop(g.el);
      const w = g.el.offsetWidth;
      const h = g.el.offsetHeight;
      const pad = 24; // sample beyond the edges so the blur doesn't fade out at the rim
      const ctx = g.ctx;
      ctx.filter = `blur(${BLUR_PX}px) saturate(1.8) brightness(${light ? 1.08 : 0.92})`;
      ctx.drawImage(
        video,
        (left - pad) * sx, (top - pad) * sy, (w + pad * 2) * sx, (h + pad * 2) * sy,
        -pad * CANVAS_SCALE, -pad * CANVAS_SCALE, (w + pad * 2) * CANVAS_SCALE, (h + pad * 2) * CANVAS_SCALE,
      );
    }
  }

  function offsetLeft(el) { let x = 0; for (let n = el; n; n = n.offsetParent) x += n.offsetLeft; return x; }
  function offsetTop(el) { let y = 0; for (let n = el; n; n = n.offsetParent) y += n.offsetTop; return y; }

  function setLive(on) {
    glasses.forEach((g) => g.el.classList.toggle('live', on));
  }

  async function start(id, disp) {
    display = disp;
    if (!id) { stop(); return; }
    if (!stream || sourceId !== id) {
      stopStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: id,
              maxWidth: CAPTURE_MAX_PX,
              maxHeight: CAPTURE_MAX_PX,
              maxFrameRate: CAPTURE_FPS,
            },
          },
        });
        sourceId = id;
        video.srcObject = stream;
      } catch (err) {
        console.warn('Live glass unavailable, using flat glass:', err);
        stop();
        return;
      }
    }
    video.play().catch(() => {});
    // Switch from flat to live glass only once real frames arrive.
    if (video.readyState >= 2) setLive(true);
    else video.addEventListener('loadeddata', () => { if (stream) setLive(true); }, { once: true });
    if (!frameCb) frameCb = video.requestVideoFrameCallback(onVideoFrame);
  }

  function stopStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    sourceId = null;
    video.srcObject = null;
  }

  function stop() {
    if (frameCb) video.cancelVideoFrameCallback(frameCb);
    frameCb = 0;
    cancelAnimationFrame(redrawQueued);
    redrawQueued = 0;
    stopStream();
    setLive(false);
  }

  // Specular glow that follows the pointer 1:1. The element's position is read
  // once on entry (not per move), and the spot only gets a transform.
  for (const g of glasses) {
    const glow = g.el.querySelector('.glass-glow');
    if (!glow) continue;
    let origin = null;
    g.el.addEventListener('pointerenter', () => { origin = g.el.getBoundingClientRect(); });
    g.el.addEventListener('pointermove', (e) => {
      origin ||= g.el.getBoundingClientRect();
      glow.style.transform = `translate3d(${e.clientX - origin.left}px, ${e.clientY - origin.top}px, 0)`;
    });
  }

  window.Glass = { start, stop };
})();
