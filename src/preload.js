// The renderer's only bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('bar', {
  ask: (req) => ipcRenderer.invoke('ask', req),
  cancel: () => ipcRenderer.invoke('cancel'),
  newChat: () => ipcRenderer.invoke('new-chat'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (patch) => ipcRenderer.invoke('save-settings', patch),
  setApiKey: (provider, key) => ipcRenderer.invoke('set-api-key', { provider, key }),
  getModels: () => ipcRenderer.invoke('get-models'),
  localPrepare: () => ipcRenderer.invoke('local-prepare'),
  agentRun: (task) => ipcRenderer.invoke('agent-run', { task }),
  agentStop: () => ipcRenderer.invoke('agent-stop'),
  agentConfirmReply: (id, ok) => ipcRenderer.send('agent-confirm-reply', { id, ok }),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.send('install-update'),
  uiState: (state) => ipcRenderer.send('ui-state', state),
  contentHeight: (h) => ipcRenderer.send('content-height', h),
  hide: () => ipcRenderer.send('hide'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  showInFolder: (p) => ipcRenderer.send('show-in-folder', p),
  openRecordingsFolder: () => ipcRenderer.send('open-recordings-folder'),
  quit: () => ipcRenderer.send('quit'),
  recBegin: (opts) => ipcRenderer.invoke('rec-begin', opts),
  recChunk: (buf) => ipcRenderer.send('rec-chunk', buf),
  recFrame: (frame) => ipcRenderer.send('rec-frame', frame),
  recEnd: () => ipcRenderer.invoke('rec-end'),
  onReveal: on('reveal'),
  onConceal: on('conceal'),
  onFocusInput: on('focus-input'),
  onOpenSettings: on('open-settings'),
  onToggleRecording: on('toggle-recording'),
  onQuickAsk: on('quick-ask'),
  onStatus: on('ai-status'),
  onStart: on('ai-start'),
  onDelta: on('ai-delta'),
  onFallback: on('ai-fallback'),
  onLocalStatus: on('local-status'),
  onUpdateStatus: on('update-status'),
  onAgentState: on('agent-state'),
  onAgentConfirm: on('agent-confirm'),
});
