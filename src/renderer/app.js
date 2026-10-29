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

  function renderMarkdown(el, text) {
    el.innerHTML = DOMPurify.sanitize(marked.parse(text, { breaks: true, gfm: true }));
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
    });
  }

  function syncPanel() {
    if (state.agentRunning && !state.agentConfirmId) { panel.hidden = true; return; }
    $('agent-confirm').hidden = !state.agentConfirmId;
    const hasContent = Boolean(state.agentConfirmId) || messagesEl.children.length > 0 || !banner.hidden || state.settingsOpen || state.pickerOpen || Boolean(state.lastRecording);
    if (hasContent && panel.hidden) {
      panel.hidden = false;
      panel.classList.add('entering');
      requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.remove('entering')));
    } else if (!hasContent) {
      panel.hidden = true;
    }
    settingsForm.hidden = !state.settingsOpen;
    $('model-picker').hidden = state.settingsOpen || !state.pickerOpen;
    messagesEl.hidden = state.settingsOpen;
    $('recording-chip').hidden = state.settingsOpen || !state.lastRecording;
  }

  function showBanner(text, kind = 'error') {
    banner.textContent = text;
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
        addActions(msg);
      }
    } else if (result.cancelled) {
      renderMarkdown(msg.body, msg.text);
      addNote(msg, 'Stopped.');
    } else {
      msg.el.classList.add('error');
      msg.body.textContent = result.error;
      if (result.needsKey) openSettings();
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
      if (result.needsKey) openSettings();
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
      submit();
    }
  });
  input.addEventListener('input', () => {
    const typing = input.value.trim().length > 0;
    if (typing !== wasTyping) { wasTyping = typing; reportUi(); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.agentConfirmId) answerConfirm(false);
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
    renderUpdate(s.update, s.version);
    for (const provider of ['google', 'anthropic', 'github']) {
      const k = s.keys[provider];
      setKeyStatus(provider, k.has ? (k.fromEnv ? 'Using the key from your environment variables.' : 'Key saved (encrypted with your Windows account).') : 'No key yet.', k.has ? 'ok' : '');
    }
    renderPicker();
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
      else setKeyStatus(provider, provider === 'github' ? 'Token saved and working. Checking for updates…' : 'Key saved and working (encrypted with your Windows account).', 'ok');
      if (r.ok && r.hasKey && /key/i.test(banner.textContent)) showBanner('');
      state.settings = await window.bar.getSettings();
      renderPicker();
    });
  }

  // ---------- updates ----------

  const updateAction = $('update-action');

  function renderUpdate(st, version) {
    if (version) state.version = version;
    const v = state.version ? `You're on ${state.version}. ` : '';
    const text = {
      'no-token': `${v}Add a token to get updates automatically.`,
      checking: `${v}Checking for updates…`,
      none: `${v}This is the latest version.`,
      downloading: `Downloading ${st.version}… ${Math.round((st.progress || 0) * 100)}%`,
      ready: `Version ${st.version} is ready. It installs when Assistant restarts.`,
      error: `${v}${st.message || 'Update check failed.'}`,
    }[st?.state] || v;
    $('update-status').textContent = text;
    updateAction.hidden = !st || st.state === 'no-token' || st.state === 'checking' || st.state === 'downloading';
    updateAction.textContent = st?.state === 'ready' ? 'Restart now' : 'Check now';
    if (st?.state === 'ready' && !banner.textContent) showBanner(`Assistant ${st.version} is ready. It installs next time Assistant restarts.`, 'info');
  }

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
    $('mp-local-status').textContent = st.message || `Downloads about ${l.approxGB} GB the first time, then works offline.`;
    const btn = $('mp-local-prepare');
    btn.hidden = busy || st.state === 'ready';
    btn.textContent = st.state === 'error' ? 'Try again' : 'Download & load now';
  }

  async function selectModel(i) {
    const model = state.models[i];
    if (!model || model.id === state.settings.modelId) return;
    state.settings = { ...state.settings, ...(await window.bar.saveSettings({ modelId: model.id })) };
    renderPicker();
  }

  slider.addEventListener('input', () => selectModel(Number(slider.value)));

  $('model-chip').addEventListener('click', () => {
    if (state.settingsOpen) closeSettings();
    state.pickerOpen = !state.pickerOpen;
    $('model-chip').classList.toggle('on', state.pickerOpen);
    syncPanel();
  });

  $('mp-local-prepare').addEventListener('click', async () => {
    const r = await window.bar.localPrepare();
    if (!r.ok) showBanner(`Offline model: ${r.error}`);
  });

  window.bar.onLocalStatus((status) => {
    if (state.local) state.local.status = status;
    renderLocalStatus();
    if (status.state === 'downloading' || status.state === 'loading') showBanner(status.message, 'info');
    else if (banner.classList.contains('info') && /Download|Loading|Finding|Unpacking/.test(banner.textContent)) showBanner('');
  });

  async function loadModels() {
    const r = await window.bar.getModels();
    state.models = r.models;
    state.local = r.local;
    const autoOpt = $('local-tier').querySelector('option[value="auto"]');
    autoOpt.textContent = `Auto (${r.local.name} for your ${r.local.ramGB} GB RAM)`;
    renderPicker();
  }

  settingsForm.addEventListener('change', (e) => {
    if (e.target.dataset.setting === 'localTier') setTimeout(loadModels, 50);
  });

  function openSettings() {
    state.settingsOpen = true;
    loadSettings();
    syncPanel();
    reportUi();
  }
  function closeSettings() {
    state.settingsOpen = false;
    syncPanel();
    reportUi();
    input.focus();
  }

  $('open-settings').addEventListener('click', () => (state.settingsOpen ? closeSettings() : openSettings()));
  $('close-settings').addEventListener('click', closeSettings);
  $('recordings-folder').addEventListener('click', () => window.bar.openRecordingsFolder());
  $('quit').addEventListener('click', () => window.bar.quit());

  window.bar.onOpenSettings(({ firstRun } = {}) => {
    openSettings();
    if (firstRun) showBanner('Welcome! Paste a free Google AI Studio key below to start, or close Settings and slide the model to Offline to use the on-device model with no key.', 'info');
    setTimeout(() => $('key-google').focus(), 50);
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
    concealTimer = setTimeout(() => window.Glass.stop(), 260);
  });

  window.bar.onFocusInput(() => input.focus());
  window.bar.onQuickAsk(() => ask(input.value.trim() || QUICK_QUESTION, { forceScreen: true }));

  loadSettings().then(loadModels).then(syncPanel);
})();
