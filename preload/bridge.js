const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const wrapped = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('cue', {
  /* app */
  info: () => ipcRenderer.invoke('app:info'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  checkPermissions: () => ipcRenderer.invoke('perm:check'),
  requestPermission: (kind) => ipcRenderer.invoke('perm:request', kind),
  relaunch: () => ipcRenderer.send('app:relaunch'),

  /* sources */
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (opts) => ipcRenderer.invoke('capture:choose', opts),
  pickRegion: () => ipcRenderer.invoke('region:pick'),
  regionResult: (rect) => ipcRenderer.send('region:result', rect),
  regionCancel: () => ipcRenderer.send('region:cancel'),

  /* camera bubble */
  camShow: (opts) => ipcRenderer.invoke('cam:show', opts),
  camHide: () => ipcRenderer.invoke('cam:hide'),
  camUpdate: (patch) => ipcRenderer.invoke('cam:update', patch),
  camBounds: () => ipcRenderer.invoke('cam:bounds'),
  camResizeStart: () => ipcRenderer.send('cam:resize-start'),
  camResizeEnd: () => ipcRenderer.send('cam:resize-end'),
  onCamConfig: on('cam-config'),

  /* recording */
  recStart: (opts) => ipcRenderer.invoke('rec:start', opts),
  recChunk: (which, buffer) => ipcRenderer.invoke('rec:chunk', { which, buffer }),
  recStop: (opts) => ipcRenderer.invoke('rec:stop', opts || {}),
  recState: (state) => ipcRenderer.send('rec:state', state),
  recAction: (action) => ipcRenderer.send('rec:action', action),
  camPosition: (entry) => ipcRenderer.send('rec:cam-position', entry),
  onRecConfig: on('rec-config'),
  onRecState: on('rec-state'),
  onRecAction: on('rec-action'),
  onControlShown: on('control-shown'),
  onCountdownStart: on('countdown-start'),

  /* studio */
  onStudioLoad: on('studio-load'),
  probe: (file) => ipcRenderer.invoke('studio:probe', file),
  waveform: (file) => ipcRenderer.invoke('studio:waveform', file),
  render: (spec) => ipcRenderer.invoke('studio:render', spec),
  onRenderProgress: on('render-progress'),
  reveal: (file) => ipcRenderer.invoke('studio:reveal', file),
  saveAs: (opts) => ipcRenderer.invoke('studio:saveAs', opts),

  /* bunny */
  publish: (opts) => ipcRenderer.invoke('bunny:publish', opts),
  onPublishProgress: on('publish-progress'),

  /* first run setup */
  saveBunny: (creds) => ipcRenderer.invoke('bunny:save', creds),
  setupDone: () => ipcRenderer.send('setup:done'),
  setupCancel: () => ipcRenderer.send('setup:cancel'),

  /* misc */
  openTeleprompter: () => ipcRenderer.invoke('cue:teleprompter'),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  closeWindow: () => ipcRenderer.send('win:close'),
  closeStudio: () => ipcRenderer.send('studio:close'),
  minimiseStudio: () => ipcRenderer.send('studio:minimise'),
  hideControl: () => ipcRenderer.send('win:hide-control'),
  showControl: () => ipcRenderer.send('control:show'),
});
