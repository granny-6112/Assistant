(() => {
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const panel = $('panel');
  const input = $('question');
  const messagesEl = $('messages');
  const banner = $('banner');
  const settingsForm = $('settings');
  const recordBtn = $('record');
  const recTime = $('rec-time');

  const QUICK_QUESTION = "What's on my screen? Point out anything important or anything that looks wrong.";

  const state = {
    settings: {},
    busy: false,
    pinned: false,
    listening: false,
    settingsOpen: false,
    agentMode: false,
    agentRunning: false,
    agentConfirmId: null,
    includeScreen: true,
    attachRecording: false,
    lastRecording: null,
    recordingTimer: 0,
    pickerOpen: false,
    models: [],
    local: null,
  };

  // ---------- helpers ----------

  const formatTime = (sec) => {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  // Maths is pulled out before Markdown runs (so _ and * inside it survive),
  // rendered with KaTeX, and put back after sanitising. Code is left alone.
  const MATH_OPEN = '\uE000';
  const MATH_CLOSE = '\uE001';
  function extractMath(text) {
    const math = [];
    const keep = (tex, display) => `${MATH_OPEN}${math.push({ tex, display }) - 1}${MATH_CLOSE}`;
    const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/);
    for (let i = 0; i < parts.length; i += 2) {
      parts[i] = parts[i]
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep(t, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => keep(t, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => keep(t, false))
        // $x$ only when it hugs its content, so "$5 and $10" stays money.
        .replace(/(^|[^\\$\w])\$(?=\S)([^$\n]*?\S)\$(?![\w$])/g, (_, pre, t) => pre + keep(t, false));
    }
    return { src: parts.join(''), math };
  }

  // KaTeX is 270 KB, so it loads the first time an answer contains maths.
  let katexLoading = null;
  function loadKatex() {
    katexLoading ||= new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '../../node_modules/katex/dist/katex.min.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = '../../node_modules/katex/dist/katex.min.js';
      js.onload = resolve;
      js.onerror = reject;
      document.head.appendChild(js);
    });
    return katexLoading;
  }

  function renderMath({ tex, display }) {
    if (!window.katex) return `<span class="math-pending">${display ? '$$' : '$'}${DOMPurify.sanitize(tex)}${display ? '$$' : '$'}</span>`;
    try {
      return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'htmlAndMathml' });
    } catch {
      return display ? `$$${tex}$$` : `$${tex}$`;
    }
  }

  const rendered = new WeakMap(); // element → the text it last showed
  function renderMarkdown(el, text) {
    const { src, math } = extractMath(text);
    let html = DOMPurify.sanitize(marked.parse(src, { breaks: true, gfm: true }));
    if (math.length && !window.katex) {
      loadKatex().then(() => { if (el.isConnected && rendered.get(el) === text) renderMarkdown(el, text); }).catch(() => {});
    }
    rendered.set(el, text);
    if (math.length) {
      html = html.replace(new RegExp(`${MATH_OPEN}(\\d+)${MATH_CLOSE}`, 'g'), (_, i) => renderMath(math[Number(i)]));
    }
    el.innerHTML = html;
    // Code blocks get a header with the language and a Copy button; wide tables scroll.
    for (const pre of el.querySelectorAll('pre')) {
      const code = pre.querySelector('code');
      const lang = (code?.className.match(/language-([\w+#-]+)/) || [])[1] || 'code';
      const head = document.createElement('div');
      head.className = 'code-head';
      head.innerHTML = '<span></span><button type="button" class="code-copy">Copy</button>';
      head.firstChild.textContent = lang;
      pre.prepend(head);
    }
    for (const table of el.querySelectorAll('table')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
  }

  let wasTyping = false;
  function reportUi() {
    wasTyping = input.value.trim().length > 0;
    window.bar.uiState({
      busy: state.busy,
      typing: wasTyping,
      settingsOpen: state.settingsOpen,
      pinned: state.pinned,
      recording: window.Recorder.active(),
      listening: state.listening,
    });
  }

  function syncPanel() {
    if (state.agentRunning && !state.agentConfirmId) { panel.hidden = true; return; }
    $('agent-confirm').hidden = !state.agentConfirmId;
    $('setup').hidden = !state.setupOpen || state.settingsOpen;
    const hasContent = state.setupOpen || Boolean(state.agentConfirmId) || messagesEl.children.length > 0 || !banner.hidden || state.settingsOpen || Boolean(state.lastRecording);
    if (hasContent && panel.hidden) {
      panel.hidden = false;
      panel.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('entering')));
    } else if (!hasContent) {
      panel.hidden = true;
    }
    settingsForm.hidden = !state.settingsOpen;
    messagesEl.hidden = state.settingsOpen;
    $('recording-chip').hidden = state.settingsOpen || !state.lastRecording;
  }

  // actions: [{ label, primary, onClick }] shown as buttons under the text.
  function showBanner(text, kind = 'error', actions = []) {
    banner.textContent = text;
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'banner-actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `pill-btn${a.primary ? ' primary' : ' ghost'}`;
        b.textContent = a.label;
        b.addEventListener('click', a.onClick);
        row.append(b);
      }
      banner.append(row);
    }
    banner.className = `banner ${kind === 'info' ? 'info' : ''}`;
    banner.hidden = !text;
    syncPanel();
  }

  function applyTint() {
    const pref = state.settings.glassTint;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.tint = pref === 'auto' ? (dark ? 'dark' : 'light') : pref;
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTint);

  function applyAccent(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
    const root = document.documentElement.style;
    root.setProperty('--accent', hex);
    // Dark text on light accents (amber, graphite…), white on the rest.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    root.setProperty('--accent-text', 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#15151b' : '#fff');
    for (const sw of document.querySelectorAll('.swatch[data-color]')) sw.classList.toggle('on', sw.dataset.color.toLowerCase() === hex.toLowerCase());
    const custom = $('accent-custom');
    if (custom) {
      custom.value = hex;
      custom.parentElement.classList.toggle('on', !document.querySelector('.swatch[data-color].on'));
      custom.parentElement.style.setProperty('--c', hex);
    }
  }

  // ---------- font ----------

  // Segoe is Windows' own font; the next five ship with the app; Satoshi's
  // licence doesn't allow bundling, so it loads from Fontshare the first time.
  const FONTS = [
    { id: 'segoe', name: 'Segoe UI Variable', stack: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
    { id: 'inter', name: 'Inter', stack: '"Inter Variable", "Segoe UI", sans-serif' },
    { id: 'geist', name: 'Geist', stack: '"Geist Variable", "Segoe UI", sans-serif' },
    { id: 'manrope', name: 'Manrope', stack: '"Manrope Variable", "Segoe UI", sans-serif' },
    { id: 'dm-sans', name: 'DM Sans', stack: '"DM Sans Variable", "Segoe UI", sans-serif' },
    { id: 'plex', name: 'IBM Plex Sans', stack: '"IBM Plex Sans Variable", "Segoe UI", sans-serif' },
    { id: 'satoshi', name: 'Satoshi', stack: '"Satoshi", "Segoe UI", sans-serif', remote: 'https://api.fontshare.com/v2/css?f[]=satoshi@300,400,500,600,700&display=swap' },
  ];

  function ensureRemoteFont(font) {
    if (!font.remote || document.querySelector(`link[data-font="${font.id}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = font.remote;
    link.dataset.font = font.id;
    document.head.appendChild(link);
  }

  function applyFont(id) {
    const i = Math.max(0, FONTS.findIndex((f) => f.id === id));
    const font = FONTS[i];
    ensureRemoteFont(font);
    document.documentElement.style.setProperty('--font', font.stack);
    $('font-slider').value = String(i);
    $('font-name').textContent = font.name;
    $('font-name').style.fontFamily = font.stack;
    for (const [j, t] of [...$('font-ticks').children].entries()) t.classList.toggle('on', j === i);
  }

  // Each tick is "Aa" in its own typeface; clicking one picks it too.
  for (const [i, f] of FONTS.entries()) {
    const t = document.createElement('button');
    t.type = 'button';
    t.textContent = 'Aa';
    t.title = f.name;
    t.style.fontFamily = f.stack;
    t.addEventListener('click', () => { $('font-slider').value = String(i); $('font-slider').dispatchEvent(new Event('change')); });
    $('font-ticks').appendChild(t);
  }
  $('font-slider').addEventListener('input', (e) => applyFont(FONTS[Number(e.target.value)].id));
  $('font-slider').addEventListener('change', async (e) => {
    const font = FONTS[Number(e.target.value)];
    applyFont(font.id);
    state.settings = await window.bar.saveSettings({ fontFamily: font.id });
  });

  // Scales the glass tint: 0 → about 1.8× as opaque as the default, 100 → nearly clear.
  function applyTransparency(t) {
    const v = Number.isFinite(Number(t)) ? Number(t) : 50;
    document.documentElement.style.setProperty('--glass-k', String(1 + ((50 - v) / 50) * 0.8));
    const label = $('transparency-value');
    if (label) label.textContent = `${v}%`;
  }
  $('glass-transparency').addEventListener('input', (e) => applyTransparency(e.target.value));

  async function setAccent(hex) {
    applyAccent(hex);
    state.settings = await window.bar.saveSettings({ accentColor: hex });
  }
  for (const sw of document.querySelectorAll('.swatch[data-color]')) sw.addEventListener('click', () => setAccent(sw.dataset.color));
  $('accent-custom').addEventListener('input', (e) => applyAccent(e.target.value));
  $('accent-custom').addEventListener('change', (e) => setAccent(e.target.value));

  // Tell the main process how tall the window needs to be, at most once per
  // frame and only when it changed: resizing a transparent window is costly.
  let sentHeight = 0;
  let heightQueued = 0;
  new ResizeObserver(() => {
    if (heightQueued) return;
    heightQueued = requestAnimationFrame(() => {
      heightQueued = 0;
      // While an answer is being revealed the content grows a little every
      // frame; grow the window in 48px steps so it isn't resized 60 times a second.
      let h = Math.ceil(root.getBoundingClientRect().height);
      if (h > sentHeight && revealing > 0) h = Math.ceil(h / 48) * 48;
      if (h !== sentHeight) { sentHeight = h; window.bar.contentHeight(h); }
    });
  }).observe(root);

  // ---------- messages ----------

  function nearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg user';
    el.textContent = text;
    const attach = document.createElement('span');
    attach.className = 'attach';
    el.appendChild(attach);
    messagesEl.appendChild(el);
    syncPanel();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  function addAssistantMessage() {
    const el = document.createElement('div');
    el.className = 'msg assistant pending';
    const thinking = document.createElement('div');
    thinking.className = 'thinking';
    thinking.setAttribute('aria-label', 'Thinking');
    thinking.append(...[0, 1, 2].map(() => document.createElement('span')));
    const clip = document.createElement('div');
    clip.className = 'reveal';
    const body = document.createElement('div');
    body.className = 'md';
    clip.appendChild(body);
    el.append(thinking, clip);
    messagesEl.appendChild(el);
    syncPanel();
    messagesEl.scrollTop = messagesEl.scrollHeight;
    const msg = { el, body, clip, text: '' };
    msg.reveal = createReveal(msg);
    return msg;
  }

  // Answers are rendered as they stream, but shown through a clip whose bottom
  // edge glides down at reading pace, so lines appear one after another instead
  // of in jumps. It speeds up when it falls behind, so it never lags far.
  let revealing = 0;
  function createReveal(msg) {
    let shown = 0;
    let raf = 0;
    let last = 0;
    let finished = false;
    let started = false;
    const LINE_SPEED = 260; // px per second, about 12 lines

    function settle() {
      msg.clip.style.height = '';
      msg.clip.classList.remove('revealing');
      if (started) { started = false; revealing--; }
    }

    function frame(t) {
      const target = msg.body.offsetHeight;
      const dt = last ? Math.min(64, t - last) : 16;
      last = t;
      const gap = target - shown;
      if (gap <= 0.5) {
        shown = target;
        raf = 0;
        last = 0;
        if (finished) settle(); else msg.clip.style.height = `${shown}px`;
        return;
      }
      const stick = nearBottom();
      shown = Math.min(target, shown + ((LINE_SPEED + gap * 2.5) * dt) / 1000);
      msg.clip.style.height = `${shown}px`;
      if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
      raf = requestAnimationFrame(frame);
    }

    return {
      kick() {
        if (!started) { started = true; revealing++; msg.clip.classList.add('revealing'); msg.clip.style.height = '0px'; }
        if (!raf) raf = requestAnimationFrame(frame);
      },
      finish() {
        finished = true;
        if (!started) return;
        if (!raf) raf = requestAnimationFrame(frame);
      },
      skip() {
        finished = true;
        cancelAnimationFrame(raf);
        raf = 0;
        settle();
      },
    };
  }

  function stopThinking(msg) {
    msg.el.classList.remove('pending');
  }

  function addNote(msg, text) {
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = text;
    msg.el.appendChild(note);
  }

  function addActions(msg) {
    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(msg.text);
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
    };
    bar.appendChild(copy);
    msg.el.appendChild(bar);
  }

  messagesEl.addEventListener('click', async (e) => {
    const copy = e.target.closest('.code-copy');
    if (!copy) return;
    await navigator.clipboard.writeText(copy.closest('pre').querySelector('code')?.textContent || '');
    copy.textContent = 'Copied';
    setTimeout(() => { copy.textContent = 'Copy'; }, 1200);
  });

  messagesEl.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    window.bar.openExternal(a.href);
  });

  // ---------- asking ----------

  let active = null; // { msg, userEl, renderQueued }

  window.bar.onStatus((text) => {
    if (text) showBanner(text, 'info'); else if (banner.classList.contains('info')) showBanner('');
  });

  window.bar.onStart(({ attachments }) => {
    if (active && attachments.length) active.userEl.querySelector('.attach').textContent = `with ${attachments.join(' + ')}`;
  });

  window.bar.onDelta((t) => {
    if (!active) return;
    active.msg.text += t;
    if (active.renderQueued) return;
    active.renderQueued = true;
    requestAnimationFrame(() => {
      if (!active) return;
      active.renderQueued = false;
      stopThinking(active.msg);
      renderMarkdown(active.msg.body, active.msg.text);
      active.msg.reveal.kick();
    });
  });

  window.bar.onFallback(() => { if (active) active.fellBack = true; });

  async function ask(question, { forceScreen = false } = {}) {
    if (state.busy) return;
    const text = question.trim();
    if (!text) return;
    if (state.settingsOpen) closeSettings();
    input.value = '';
    showBanner('');

    state.busy = true;
    root.classList.add('busy');
    reportUi();

    const userEl = addUserMessage(text);
    const msg = addAssistantMessage();
    active = { msg, userEl, renderQueued: false, fellBack: false };
    const includeScreen = forceScreen || state.includeScreen;
    const attachRecording = state.attachRecording;
    state.attachRecording = false;
    $('attach-recording').classList.remove('on');

    const result = await window.bar.ask({ text, includeScreen, attachRecording });
    const fellBack = active.fellBack;
    active = null;

    stopThinking(msg);
    if (!result.ok || result.refused) msg.reveal.skip();
    if (result.ok) {
      if (result.refused) {
        msg.text = '';
        msg.body.textContent = 'The model declined to answer this one. Try rephrasing, or slide to another model.';
        msg.el.classList.add('error');
      } else {
        renderMarkdown(msg.body, msg.text || '(no answer)');
        msg.reveal.finish();
        if (result.truncated) addNote(msg, 'The answer hit the length limit and was cut off.');
        if (fellBack) addNote(msg, `Finished by ${result.servedBy} after the first model declined.`);
        if (result.busyFallback) addNote(msg, `Answered by ${result.busyFallback} because the model you picked was busy.`);
        const u = result.usage;
        if (u?.near) addNote(msg, `Heads up: ${u.used} of about ${u.limit} free ${u.name} requests used today. The allowance resets at ${u.resetsAt}.`);
        if (u) { state.usage = { ...state.usage, [result.servedBy]: u }; renderPicker(); }
        addActions(msg);
      }
    } else if (result.cancelled) {
      renderMarkdown(msg.body, msg.text);
      addNote(msg, 'Stopped.');
    } else {
      msg.el.classList.add('error');
      msg.body.textContent = result.error;
      if (result.needsKey) openSettings('keys');
    }

    state.busy = false;
    root.classList.remove('busy');
    reportUi();
    if (!revealing) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ---------- agent mode ----------

  function setAgentMode(on) {
    state.agentMode = on;
    $('agent-mode').classList.toggle('on', on);
    root.classList.toggle('agent-mode', on);
    input.placeholder = on ? 'Tell Assistant what to do on your PC…' : 'Ask about your screen…';
  }
  $('agent-mode').addEventListener('click', () => { setAgentMode(!state.agentMode); input.focus(); });

  window.bar.onAgentState(({ running, step, text }) => {
    state.agentRunning = running;
    root.classList.toggle('agent-running', running);
    $('agent-status').hidden = !running;
    if (running) $('agent-status-text').textContent = step ? `Step ${step} · ${text}` : text;
    if (!running) state.agentConfirmId = null;
    syncPanel();
  });

  window.bar.onAgentConfirm(({ id, action }) => {
    state.agentConfirmId = id;
    $('agent-confirm-action').textContent = action;
    syncPanel();
  });
  function answerConfirm(ok) {
    if (!state.agentConfirmId) return;
    window.bar.agentConfirmReply(state.agentConfirmId, ok);
    state.agentConfirmId = null;
    syncPanel();
  }
  $('agent-allow').addEventListener('click', () => answerConfirm(true));
  $('agent-deny').addEventListener('click', () => answerConfirm(false));

  async function runAgent(task) {
    if (state.busy) return;
    const text = task.trim();
    if (!text) return;
    if (state.settingsOpen) closeSettings();
    input.value = '';
    showBanner('');
    state.busy = true;
    root.classList.add('busy');
    reportUi();

    const userEl = addUserMessage(text);
    userEl.querySelector('.attach').textContent = 'agent mode';
    const msg = addAssistantMessage();
    const result = await window.bar.agentRun(text);
    stopThinking(msg);
    msg.reveal.skip();
    if (result.ok) {
      msg.text = result.text;
      renderMarkdown(msg.body, result.text);
      addNote(msg, `Agent mode · ${result.steps} step${result.steps === 1 ? '' : 's'} with ${result.model}`);
      addActions(msg);
    } else if (result.cancelled) {
      msg.body.textContent = 'Stopped. Anything already done stays done.';
    } else {
      msg.el.classList.add('error');
      msg.body.textContent = result.error;
      if (result.needsKey) openSettings('keys');
    }
    state.busy = false;
    root.classList.remove('busy');
    reportUi();
    syncPanel();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function submit() {
    if (state.agentMode) runAgent(input.value); else ask(input.value);
  }

  $('send').addEventListener('click', () => {
    if (state.agentRunning) window.bar.agentStop();
    else if (state.busy) window.bar.cancel();
    else submit();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (window.Voice?.active()) window.Voice.finish(); else submit();
    }
  });
  input.addEventListener('input', () => {
    const typing = input.value.trim().length > 0;
    if (typing !== wasTyping) { wasTyping = typing; reportUi(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && window.Voice?.active() && e.target !== input) { e.preventDefault(); window.Voice.finish(); return; }
    if (e.key !== 'Escape') return;
    if (window.Voice?.active()) { window.Voice.cancel(); showBanner(''); return; }
    if (state.agentConfirmId) answerConfirm(false);
    else if (state.pickerOpen) setPickerOpen(false);
    else if (state.agentRunning) window.bar.agentStop();
    else if (state.busy) window.bar.cancel();
    else if (state.settingsOpen) closeSettings();
    else window.bar.hide();
  });

  // ---------- bar buttons ----------

  const screenBtn = $('toggle-screen');
  function setIncludeScreen(on) {
    state.includeScreen = on;
    screenBtn.classList.toggle('on', on);
    screenBtn.title = on ? 'A screenshot is sent with each question (click to turn off)' : 'Screenshots are off (click to send one with each question)';
  }
  screenBtn.addEventListener('click', () => {
    setIncludeScreen(!state.includeScreen);
    window.bar.saveSettings({ includeScreen: state.includeScreen });
  });

  $('clear-history').addEventListener('click', async (e) => {
    await window.bar.clearHistory();
    e.target.textContent = 'Cleared';
    setTimeout(() => { e.target.textContent = 'Clear saved conversations'; }, 1500);
  });

  $('new-chat').addEventListener('click', async () => {
    if (state.busy) await window.bar.cancel();
    await window.bar.newChat();
    messagesEl.replaceChildren();
    showBanner('');
    syncPanel();
    input.focus();
  });

  $('pin').addEventListener('click', () => {
    state.pinned = !state.pinned;
    $('pin').classList.toggle('on', state.pinned);
    reportUi();
  });

  // ---------- recording ----------

  async function toggleRecording() {
    if (window.Recorder.active()) {
      clearInterval(state.recordingTimer);
      recordBtn.classList.remove('active');
      recTime.textContent = '';
      const result = await window.Recorder.stop();
      reportUi();
      if (result && result.ok) onRecordingSaved(result);
      return;
    }
    try {
      const r = await window.Recorder.start({
        withAudio: state.settings.recordAudio,
        onUnexpectedStop: (result) => {
          clearInterval(state.recordingTimer);
          recordBtn.classList.remove('active');
          recTime.textContent = '';
          reportUi();
          if (result && result.ok) onRecordingSaved(result);
        },
      });
      recordBtn.classList.add('active');
      recTime.textContent = '0:00';
      state.recordingTimer = setInterval(() => { recTime.textContent = formatTime(window.Recorder.elapsedSec()); }, 500);
      if (state.settings.recordAudio && !r.audio) showBanner('Recording without system audio: Windows did not allow audio capture.', 'info');
      reportUi();
    } catch (err) {
      showBanner(`Could not start recording: ${err.message}`);
    }
  }

  function onRecordingSaved({ path, durationSec }) {
    state.lastRecording = { path, durationSec };
    $('recording-label').textContent = `Ask about last recording (${formatTime(durationSec)})`;
    syncPanel();
  }

  recordBtn.addEventListener('click', toggleRecording);
  window.bar.onToggleRecording(toggleRecording);

  $('attach-recording').addEventListener('click', () => {
    state.attachRecording = !state.attachRecording;
    $('attach-recording').classList.toggle('on', state.attachRecording);
    input.focus();
  });
  $('reveal-recording').addEventListener('click', () => {
    if (state.lastRecording) window.bar.showInFolder(state.lastRecording.path);
  });

  // ---------- settings ----------

  async function loadSettings() {
    const s = await window.bar.getSettings();
    state.settings = s;
    for (const el of settingsForm.querySelectorAll('[data-setting]')) {
      const v = s[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = Boolean(v); else el.value = String(v);
    }
    setIncludeScreen(s.includeScreen);
    $('agent-mode').hidden = !s.agentEnabled;
    if (!s.agentEnabled && state.agentMode) setAgentMode(false);
    applyTint();
    applyAccent(s.accentColor);
    applyTransparency(s.glassTransparency);
    applyFont(s.fontFamily);
    renderKeysSummary(s.keys);
    renderUpdate(s.update, s.version);
    for (const provider of ['google', 'anthropic']) {
      const k = s.keys[provider];
      setKeyStatus(provider, k.has ? (k.fromEnv ? 'Using the key from your environment variables.' : 'Key saved (encrypted with your Windows account).') : 'No key yet.', k.has ? 'ok' : '');
    }
    renderPicker();
  }

  // Microphone list in Settings → General. Names only show once the mic has
  // been allowed; before that Windows reports them as unnamed.
  async function fillMics() {
    const select = $('mic-device');
    let mics = [];
    try { mics = await window.Voice.listMics(); } catch {}
    const want = state.settings.micDeviceId || '';
    select.replaceChildren(new Option('Windows default', ''), ...mics.map((m) => new Option(m.label, m.id)));
    if (want && !mics.some((m) => m.id === want)) select.append(new Option('Saved microphone (not plugged in)', want));
    select.value = want;
  }
  navigator.mediaDevices?.addEventListener('devicechange', () => { if (state.settingsOpen) fillMics(); });

  let testingMic = false;
  $('mic-test').addEventListener('click', async () => {
    if (testingMic) return;
    testingMic = true;
    const btn = $('mic-test');
    const bar = $('mic-test-level');
    btn.textContent = 'Talk now…';
    try {
      await window.Voice.test($('mic-device').value, (v) => { bar.style.transform = `scaleX(${v.toFixed(2)})`; });
      state.settings = await window.bar.saveSettings({ micAsked: true });
      fillMics(); // names appear once access is allowed
    } catch (err) {
      showBanner(window.Voice.describeMicError(err));
    } finally {
      btn.textContent = 'Test';
      testingMic = false;
      maybeAutoClose();
    }
  });

  function renderKeysSummary(k) {
    const mark = (x) => (x?.has ? '✓' : '–');
    $('keys-summary').textContent = `Google ${mark(k.google)} · Anthropic ${mark(k.anthropic)}`;
  }

  function setKeyStatus(provider, text, kind) {
    const el = $(`key-status-${provider}`);
    el.textContent = text;
    el.className = kind || '';
  }

  settingsForm.addEventListener('click', (e) => {
    const a = e.target.closest('a.ext');
    if (!a) return;
    e.preventDefault();
    window.bar.openExternal(a.href);
  });

  settingsForm.addEventListener('change', async (e) => {
    const el = e.target.closest('[data-setting]');
    if (!el) return;
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if ('number' in el.dataset) value = Number(value);
    state.settings = await window.bar.saveSettings({ [el.dataset.setting]: value });
    applyTint();
    if (el.dataset.setting === 'liveGlass' && value === 'off') window.Glass.stop();
    if (el.dataset.setting === 'agentEnabled') {
      $('agent-mode').hidden = !value;
      if (!value) setAgentMode(false);
    }
  });

  for (const btn of settingsForm.querySelectorAll('.save-key')) {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const field = $(`key-${provider}`);
      const key = field.value.trim();
      btn.disabled = true;
      setKeyStatus(provider, key ? 'Checking key…' : '', '');
      const r = await window.bar.setApiKey(provider, key);
      btn.disabled = false;
      field.value = '';
      if (!r.ok) setKeyStatus(provider, r.error, 'bad');
      else if (!r.hasKey) setKeyStatus(provider, 'Key removed.', '');
      else if (r.check && r.check.valid === false) setKeyStatus(provider, r.check.message, 'bad');
      else if (r.check && r.check.valid === null) setKeyStatus(provider, r.check.message, '');
      else setKeyStatus(provider, 'Key saved and working (encrypted with your Windows account).', 'ok');
      if (r.ok && r.hasKey && /key/i.test(banner.textContent)) showBanner('');
      state.settings = await window.bar.getSettings();
      renderKeysSummary(state.settings.keys);
      renderPicker();
    });
  }

  // ---------- updates ----------

  const updateAction = $('update-action');

  function renderUpdate(st, version) {
    if (version) state.version = version;
    if (st) state.update = st;
    st = state.update || {};
    const available = st.state === 'downloading' || st.state === 'ready';
    $('update-version').textContent = state.version ? `You're on version ${state.version}` : '';
    $('update-status').textContent = {
      checking: 'Checking for updates…',
      none: 'This is the latest version.',
      downloading: `Version ${st.version} is available. Downloading… ${Math.round((st.progress || 0) * 100)}%`,
      ready: `Version ${st.version} is ready. Restart to install it.`,
      error: st.message || 'Update check failed.',
    }[st.state] || '';
    $('updates-summary').textContent = available ? `${st.version} available` : (state.version ? `Version ${state.version}` : '');
    updateAction.hidden = st.state === 'checking' || st.state === 'downloading';
    updateAction.textContent = st.state === 'ready' ? 'Restart now' : 'Check now';
    updateAction.classList.toggle('primary', st.state === 'ready');
    const notes = available && st.notes ? DOMPurify.sanitize(st.notes) : '';
    $('update-notes').innerHTML = notes ? `<p class="update-notes-title">What's new in ${st.version}</p>${notes}` : '';
    $('update-notes').hidden = !notes;
    $('update-callout').hidden = !available;
    $('update-callout-text').textContent = st.state === 'ready' ? `Update ${st.version} is ready` : `Update ${st.version} available`;
  }

  $('update-callout').addEventListener('click', () => {
    const d = settingsForm.querySelector('details[data-section="updates"]');
    d.open = true;
    d.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  updateAction.addEventListener('click', () => {
    if (updateAction.textContent === 'Restart now') window.bar.installUpdate();
    else window.bar.checkUpdates();
  });
  window.bar.onUpdateStatus((st) => renderUpdate(st));

  // ---------- model slider ----------

  const slider = $('model-slider');

  function currentModelIndex() {
    const i = state.models.findIndex((m) => m.id === state.settings.modelId);
    return i >= 0 ? i : 0;
  }

  function hasKeyFor(model) {
    if (model.provider === 'local') return true;
    return Boolean(state.settings.keys && state.settings.keys[model.provider] && state.settings.keys[model.provider].has);
  }

  function renderPicker() {
    if (!state.models.length) return;
    const i = currentModelIndex();
    const model = state.models[i];
    slider.max = String(state.models.length - 1);
    slider.value = String(i);
    slider.style.setProperty('--fill', `${(i / (state.models.length - 1)) * 100}%`);
    $('model-chip-label').textContent = model.label;
    $('model-chip').dataset.provider = model.provider;
    $('mp-ticks').replaceChildren(...state.models.map((m, j) => {
      const t = document.createElement('button');
      t.type = 'button';
      t.textContent = m.label;
      t.className = j === i ? 'on' : '';
      t.addEventListener('click', () => selectModel(j));
      return t;
    }));

    let name = model.name;
    let badge = model.provider === 'google' && model.id !== 'gemini-4-argon' ? 'Free' : model.provider === 'local' ? 'Offline' : 'Paid';
    let note = model.note;
    if (model.provider === 'local' && state.local) {
      name = `${state.local.name} on this PC`;
      note = `${model.note} ${state.local.auto ? `Picked for your ${state.local.ramGB} GB of RAM.` : ''}`;
    }
    if (!hasKeyFor(model)) note += ` No ${model.provider === 'google' ? 'Google AI Studio' : 'Anthropic'} key saved yet: add one in Settings.`;
    $('mp-name').textContent = name;
    $('mp-badge').textContent = badge;
    $('mp-badge').dataset.kind = badge.toLowerCase();
    const u = state.usage?.[model.id];
    if (model.provider === 'google' && u?.used) {
      note += ` Used today: ${u.used} request${u.used === 1 ? '' : 's'}${u.limit ? ` of about ${u.limit} (the free limit you hit before)` : ''}. Resets at ${u.resetsAt}.`;
    }
    $('mp-note').textContent = note.trim();
    $('mp-local').hidden = model.provider !== 'local';
    renderLocalStatus();
  }

  function renderLocalStatus() {
    const l = state.local;
    if (!l) return;
    const st = l.status || {};
    const busy = st.state === 'downloading' || st.state === 'loading';
    $('mp-progress').style.width = `${Math.round((st.progress || 0) * 100)}%`;
    $('mp-progress').parentElement.hidden = !busy;
    $('mp-local-status').textContent = st.message || (l.downloaded
      ? `${l.name} is downloaded. Works with no internet.`
      : `Downloads about ${l.approxGB} GB the first time, then works offline.`);
    const btn = $('mp-local-prepare');
    btn.hidden = busy || st.state === 'ready';
    btn.textContent = st.state === 'error' ? 'Try again' : (l.downloaded ? 'Load now' : 'Download & load now');
  }

  async function selectModel(i) {
    const model = state.models[i];
    if (!model || model.id === state.settings.modelId) return;
    state.settings = { ...state.settings, ...(await window.bar.saveSettings({ modelId: model.id })) };
    renderPicker();
  }

  slider.addEventListener('input', () => selectModel(Number(slider.value)));
  // Close once a model is picked: 'change' fires when the slider is let go, not
  // while it's being dragged. The offline model stays open for its Download button.
  slider.addEventListener('change', () => {
    if (state.models[Number(slider.value)]?.provider !== 'local') setPickerOpen(false);
  });

  // The model picker pops out of the model box in the bar, centred under it.
  const pop = $('model-pop');
  function placePicker() {
    const chip = $('model-chip').getBoundingClientRect();
    const rootBox = root.getBoundingClientRect();
    const pad = 20;
    const left = chip.left + chip.width / 2 - pop.offsetWidth / 2 - rootBox.left;
    pop.style.marginLeft = `${Math.max(0, Math.min(left - pad, rootBox.width - pad * 2 - pop.offsetWidth))}px`;
    pop.style.setProperty('--caret-x', `${chip.left + chip.width / 2 - rootBox.left - pad - parseFloat(pop.style.marginLeft)}px`);
  }
  function setPickerOpen(open) {
    if (state.pickerOpen === open) return;
    state.pickerOpen = open;
    $('model-chip').classList.toggle('on', open);
    $('model-chip').setAttribute('aria-expanded', String(open));
    pop.hidden = !open;
    if (open) {
      placePicker();
      pop.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => pop.classList.remove('entering')));
    }
  }
  $('model-chip').addEventListener('click', () => {
    if (state.settingsOpen) closeSettings();
    setPickerOpen(!state.pickerOpen);
  });
  document.addEventListener('pointerdown', (e) => {
    if (state.pickerOpen && !e.target.closest('#model-pop, #model-chip')) setPickerOpen(false);
  });

  $('mp-local-prepare').addEventListener('click', async () => {
    const r = await window.bar.localPrepare();
    if (!r.ok) showBanner(`Offline model: ${r.error}`);
  });

  window.bar.onLocalStatus((status) => {
    if (state.local) {
      state.local.status = status;
      if (status.state === 'ready') state.local.downloaded = true;
    }
    renderLocalStatus();
    if (status.state === 'downloading' || status.state === 'loading') showBanner(status.message, 'info');
    else if (banner.classList.contains('info') && /Download|Loading|Finding|Unpacking/.test(banner.textContent)) showBanner('');
  });

  async function loadModels() {
    const r = await window.bar.getModels();
    state.models = r.models;
    state.usage = r.usage || {};
    state.local = r.local;
    const autoOpt = $('local-tier').querySelector('option[value="auto"]');
    autoOpt.textContent = `Auto (${r.local.name} for your ${r.local.ramGB} GB RAM)`;
    renderPicker();
  }

  settingsForm.addEventListener('change', (e) => {
    if (e.target.dataset.setting === 'localTier') setTimeout(loadModels, 50);
  });

  function openSettings(section) {
    ensureRemoteFont(FONTS.find((f) => f.remote)); // so its preview renders
    if (section) {
      for (const d of settingsForm.querySelectorAll('details.section')) d.open = d.dataset.section === section;
    }
    state.settingsOpen = true;
    loadSettings().then(fillMics);
    syncPanel();
    reportUi();
  }
  function closeSettings() {
    state.settingsOpen = false;
    syncPanel();
    reportUi();
    input.focus();
  }

  $('open-settings').addEventListener('click', () => {
    clearTimeout(hoverOpenTimer);
    if (state.settingsOpen) closeSettings(); else { openSettings(); settingsHover.armed = true; }
  });

  // Settings also open by hovering the gear and close by themselves once the
  // pointer has left both the gear and the settings panel. A short delay
  // stops a pass over the gear from opening them, and a grace period lets the
  // pointer cross the gap between the gear and the panel. They stay open
  // while you type in a field, have a dropdown open or test the mic.
  const HOVER_OPEN_MS = 150;
  const HOVER_CLOSE_MS = 350;
  let hoverOpenTimer = 0;
  let hoverCloseTimer = 0;
  const settingsHover = { gear: false, panel: false, armed: false };
  const busyInSettings = () => {
    const a = document.activeElement;
    return testingMic || Boolean(a && settingsForm.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && a.type !== 'checkbox' && a.type !== 'range');
  };
  function maybeAutoClose() {
    clearTimeout(hoverCloseTimer);
    if (!state.settingsOpen || !settingsHover.armed || settingsHover.gear || settingsHover.panel) return;
    hoverCloseTimer = setTimeout(() => {
      if (settingsHover.gear || settingsHover.panel || !state.settingsOpen) return;
      if (busyInSettings()) return; // re-checked when the field loses focus
      settingsHover.armed = false;
      closeSettings();
    }, HOVER_CLOSE_MS);
  }
  const gear = $('open-settings');
  gear.addEventListener('pointerenter', () => {
    settingsHover.gear = true;
    clearTimeout(hoverCloseTimer);
    if (state.settingsOpen) return;
    hoverOpenTimer = setTimeout(() => {
      if (!settingsHover.gear || state.settingsOpen) return;
      setPickerOpen(false);
      openSettings();
      settingsHover.armed = true;
    }, HOVER_OPEN_MS);
  });
  gear.addEventListener('pointerleave', () => {
    settingsHover.gear = false;
    clearTimeout(hoverOpenTimer);
    maybeAutoClose();
  });
  panel.addEventListener('pointerenter', () => {
    settingsHover.panel = true;
    if (state.settingsOpen) settingsHover.armed = true; // settings opened another way close too once visited
    clearTimeout(hoverCloseTimer);
  });
  panel.addEventListener('pointerleave', () => { settingsHover.panel = false; maybeAutoClose(); });
  settingsForm.addEventListener('focusout', () => setTimeout(maybeAutoClose, 0));
  $('close-settings').addEventListener('click', closeSettings);
  $('recordings-folder').addEventListener('click', () => window.bar.openRecordingsFolder());
  $('quit').addEventListener('click', () => window.bar.quit());

  // ---------- first-run setup ----------

  window.bar.onFirstRun(() => {
    state.setupOpen = true;
    syncPanel();
    $('setup-key').focus();
  });
  $('setup-open').addEventListener('click', () => window.bar.openExternal('https://aistudio.google.com/apikey'));
  async function finishSetup(patch = {}) {
    state.setupOpen = false;
    state.settings = { ...state.settings, ...(await window.bar.saveSettings({ setupDone: true, ...patch })) };
    renderPicker();
    syncPanel();
    input.focus();
  }
  $('setup-save').addEventListener('click', async () => {
    const key = $('setup-key').value.trim();
    if (!key) { $('setup-key').focus(); return; }
    $('setup-save').disabled = true;
    $('setup-status').className = '';
    $('setup-status').textContent = 'Checking your key…';
    const r = await window.bar.setApiKey('google', key);
    $('setup-save').disabled = false;
    if (!r.ok || r.check?.valid === false) {
      $('setup-status').className = 'bad';
      $('setup-status').textContent = r.error || r.check.message;
      return;
    }
    $('setup-key').value = '';
    $('setup-status').className = 'ok';
    $('setup-status').textContent = r.check?.valid === null ? "Saved. Couldn't check it right now, but it should work." : 'Key works.';
    $('setup-done').hidden = false;
    $('setup-skip').hidden = true;
    state.settings = await window.bar.getSettings();
    if (findModelIndex('local') === currentModelIndex()) await window.bar.saveSettings({ modelId: 'gemini-3.8-flash' });
  });
  $('setup-key').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('setup-save').click(); } });
  $('setup-finish').addEventListener('click', () => finishSetup());
  $('setup-skip').addEventListener('click', () => finishSetup({ modelId: 'local' }));
  $('setup-mic').addEventListener('click', async () => {
    const status = $('setup-mic-status');
    try {
      await window.Voice.requestAccess();
      state.settings = await window.bar.saveSettings({ micAsked: true });
      status.className = 'ok';
      status.textContent = 'Microphone allowed.';
      $('setup-mic').hidden = true;
      $('setup-mic-settings').hidden = true;
    } catch (err) {
      status.className = 'bad';
      status.textContent = window.Voice.describeMicError(err);
      $('setup-mic-settings').hidden = false;
    }
  });
  $('setup-mic-settings').addEventListener('click', () => window.bar.openMicSettings());

  // ---------- voice input ----------

  const micBtn = $('mic');
  const defaultPlaceholder = input.placeholder;
  async function startVoice() {
    if (state.busy || window.Voice.active()) return;
    if (!state.settings.keys?.google?.has) {
      showBanner('Voice input uses your free Google Gemini key to turn speech into text. Add one in Settings → API keys.');
      return;
    }
    // Keep the bar open while listening and transcribing, so the question
    // can't land in a hidden bar.
    // Ask once, in Assistant itself, before the microphone is first used.
    if (!state.settings.micAsked) {
      if (state.micPrompting) return;
      state.micPrompting = true;
      const allowed = await new Promise((resolve) => showBanner('Assistant would like to use your microphone so you can ask out loud. Audio is only sent to Gemini to turn it into text and is never saved.', 'info', [
        { label: 'Allow microphone', primary: true, onClick: () => resolve(true) },
        { label: 'Not now', onClick: () => resolve(false) },
      ]));
      state.micPrompting = false;
      showBanner('');
      if (!allowed) return;
      state.settings = await window.bar.saveSettings({ micAsked: true });
    }
    if (await window.bar.micStatus() === 'denied') {
      showBanner('Windows is blocking the microphone for Assistant. Turn on "Microphone access" and "Let desktop apps access your microphone", then try again.', 'error', [
        { label: 'Open Windows microphone settings', primary: true, onClick: () => window.bar.openMicSettings() },
      ]);
      return;
    }
    const setListening = (on) => { state.listening = on; reportUi(); };
    setListening(true);
    showBanner('Listening… click the mic or press Enter when you\'re done, or just pause for 5 seconds.', 'info');
    micBtn.classList.add('listening');
    // Live preview: about every 1.2 s, everything said so far is transcribed
    // again and shown in the box, so you can see you've been heard. One
    // request at a time; a final pass on the whole recording follows.
    input.value = '';
    input.classList.add('live-transcript');
    input.placeholder = 'Listening…';
    let liveBusy = false;
    let liveBytes = 0;
    let liveOff = false;
    const liveTimer = setInterval(async () => {
      if (liveBusy || liveOff || !window.Voice.active()) return;
      const wav = window.Voice.snapshot();
      if (!wav || wav.byteLength - liveBytes < 16000 * 2 * 0.6) return; // wait for 0.6 s more audio
      liveBusy = true;
      liveBytes = wav.byteLength;
      let r = null;
      try { r = await window.bar.transcribe(wav, { partial: true }); } catch {}
      liveBusy = false;
      if (!r?.ok) liveOff = /limit|quota|429/i.test(r?.error || ''); // don't burn the daily quota on previews
      else if (r.text && window.Voice.active()) input.value = r.text;
    }, 1200);
    function stopLive() {
      clearInterval(liveTimer);
      liveOff = true;
      input.classList.remove('live-transcript');
      input.placeholder = defaultPlaceholder;
    }
    let result;
    try {
      result = await window.Voice.start({
        deviceId: state.settings.micDeviceId,
        onLevel: (v) => micBtn.style.setProperty('--mic-level', v.toFixed(2)),
      });
    } catch (err) {
      stopLive();
      micBtn.classList.remove('listening');
      setListening(false);
      const blocked = err?.name === 'NotAllowedError' || err?.name === 'SecurityError' || err?.name === 'NotReadableError';
      showBanner(window.Voice.describeMicError(err), 'error', blocked ? [{ label: 'Open Windows microphone settings', onClick: () => window.bar.openMicSettings() }] : []);
      return;
    }
    stopLive();
    micBtn.classList.remove('listening');
    micBtn.style.setProperty('--mic-level', '0');
    if (!result) { setListening(false); input.value = ''; showBanner(''); return; }
    if (!result.spoke) {
      setListening(false);
      showBanner("Didn't hear anything. The ring around the mic should move when you talk; if it doesn't, pick the right microphone in Windows sound settings.", 'info');
      return;
    }
    micBtn.classList.add('transcribing');
    showBanner('Turning your speech into text…', 'info');
    let r;
    try {
      r = await window.bar.transcribe(result.wav);
    } catch (err) {
      r = { ok: false, error: `Couldn't turn your speech into text: ${err.message || err}` };
    }
    micBtn.classList.remove('transcribing');
    setListening(false);
    if (!r.ok) { showBanner(r.error); return; }
    if (!r.text) { showBanner("Couldn't make out any words. Try again a little closer to the mic.", 'info'); return; }
    showBanner('');
    input.value = r.text;
    submit();
  }
  // Clicking the mic again sends what was said; Esc throws it away.
  micBtn.addEventListener('click', () => {
    if (window.Voice.active()) window.Voice.finish(); else startVoice();
  });

  function findModelIndex(id) { return state.models.findIndex((m) => m.id === id); }

  window.bar.onOpenSettings(() => {
    openSettings();
  });

  // ---------- reveal / conceal ----------

  let concealTimer = 0;
  window.bar.onReveal(({ display, glassSourceId }) => {
    clearTimeout(concealTimer);
    requestAnimationFrame(() => root.classList.remove('concealed'));
    if (glassSourceId) window.Glass.start(glassSourceId, display);
    else window.Glass.stop();
  });

  window.bar.onConceal(() => {
    root.classList.add('concealed');
    window.Glass.freeze();
    concealTimer = setTimeout(() => window.Glass.stop(), 260);
  });

  window.bar.onFocusInput(() => input.focus());
  window.bar.onQuickAsk(() => ask(input.value.trim() || QUICK_QUESTION, { forceScreen: true }));

  loadSettings().then(loadModels).then(syncPanel);
})();
