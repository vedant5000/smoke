const { BrowserWindow, screen } = require('electron');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'bridge.js');

/* Content protection hides a window from every screen capture, which is what
   keeps our own chrome out of your recordings.
   It is deliberately NOT tied to --dev: disabling it silently puts the
   recording bar into real recordings. Only the explicit --noprotect flag,
   used for taking screenshots of the UI, turns it off. */
const DEV = process.argv.includes('--dev');
const NO_PROTECT = process.argv.includes('--noprotect');
const protect = (win, on = true) => win.setContentProtection(on && !NO_PROTECT);

/* In dev, surface renderer console output in the terminal. Half of this app
   lives in renderer windows that have no visible devtools while recording. */
function pipeConsole(win, name) {
  if (!DEV) return win;
  win.webContents.on('console-message', (e) => {
    const level = ['log', 'warn', 'error'][e.level] || 'log';
    console.log(`[${name}:${level}] ${e.message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.log(`[${name}] gone:`, d.reason));
  return win;
}

const wins = {
  setup: null,
  control: null,
  recbar: null,
  camera: null,
  studio: null,
  countdown: null,
  regions: [],      // one overlay per display
};

function base(extra = {}) {
  return {
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
    ...extra,
  };
}

function displayForCursor() {
  const pt = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
}

/* ---------------- first run setup ---------------- */
/* Focusable and NOT content protected: you have to be able to see this one in a
   screen share when someone is walking you through it. Nothing sensitive is
   visible anyway, the key field is masked until you press Show. */
const SETUP_W = 440;
const SETUP_H = 610;

function createSetup() {
  if (wins.setup && !wins.setup.isDestroyed()) return wins.setup;
  const d = displayForCursor();
  const w = new BrowserWindow(base({
    width: SETUP_W,
    height: SETUP_H,
    x: Math.round(d.workArea.x + (d.workArea.width - SETUP_W) / 2),
    y: Math.round(d.workArea.y + (d.workArea.height - SETUP_H) / 2),
    movable: true,
    focusable: true,
  }));
  w.loadFile(path.join(RENDERER, 'setup.html'));
  pipeConsole(w, 'setup');
  w.setAlwaysOnTop(true, 'floating');
  w.on('closed', () => { wins.setup = null; });
  wins.setup = w;
  return w;
}

function showSetup() {
  const w = createSetup();
  w.show();
  w.focus();
  return w;
}

function destroySetup() {
  if (wins.setup && !wins.setup.isDestroyed()) wins.setup.destroy();
  wins.setup = null;
}

/* ---------------- control panel ---------------- */
const CONTROL_W = 392;
const CONTROL_H = 624;

function createControl() {
  if (wins.control && !wins.control.isDestroyed()) return wins.control;
  const d = displayForCursor();
  const w = new BrowserWindow(base({
    width: CONTROL_W,
    height: CONTROL_H,
    x: Math.round(d.workArea.x + (d.workArea.width - CONTROL_W) / 2),
    y: Math.round(d.workArea.y + d.workArea.height - CONTROL_H - 80),
    movable: true,
    focusable: true,
  }));
  w.loadFile(path.join(RENDERER, 'control.html'));
  pipeConsole(w, "control");
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  protect(w);          // never appears in a recording
  w.on('closed', () => { wins.control = null; });
  wins.control = w;
  return w;
}

function showControl() {
  const w = createControl();
  const d = displayForCursor();
  const b = w.getBounds();
  w.setBounds({
    x: Math.round(d.workArea.x + (d.workArea.width - b.width) / 2),
    y: Math.round(d.workArea.y + d.workArea.height - b.height - 80),
    width: b.width,
    height: b.height,
  });
  w.show();
  w.focus();
  /* The panel only touches the camera, the microphone and the screen list once
     it is actually on screen, so this message is what starts all of that. If it
     is sent while the page is still loading nobody is listening yet and the
     panel comes up empty, so wait for the load when there is one. */
  const tell = () => { if (!w.isDestroyed()) w.webContents.send('control-shown'); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', tell);
  else tell();
}

function hideControl() {
  const w = wins.control;
  if (!w || w.isDestroyed() || !w.isVisible()) return;
  w.webContents.send('control-hidden');
  w.hide();
}

/* ---------------- recording bar ---------------- */
const RECBAR_W = 372;
const RECBAR_H = 60;

function createRecbar() {
  if (wins.recbar && !wins.recbar.isDestroyed()) return wins.recbar;
  const d = displayForCursor();
  const w = new BrowserWindow(base({
    width: RECBAR_W,
    height: RECBAR_H,
    x: Math.round(d.workArea.x + (d.workArea.width - RECBAR_W) / 2),
    y: Math.round(d.workArea.y + d.workArea.height - RECBAR_H - 28),
    movable: true,
    focusable: true,
  }));
  w.loadFile(path.join(RENDERER, 'recbar.html'));
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  protect(w);          // stays out of the recording
  w.on('closed', () => { wins.recbar = null; });
  wins.recbar = w;
  return w;
}

/* ---------------- camera bubble ---------------- */
/* Transparent breathing room around the bubble so its shadow can fade out
   instead of being clipped into a rectangle by the window edge. */
const CAM_MARGIN = 14;
const camWindowSize = (size) => Math.round(size) + CAM_MARGIN * 2;

function createCamera(size = 220) {
  if (wins.camera && !wins.camera.isDestroyed()) return wins.camera;
  const d = displayForCursor();
  const w = new BrowserWindow(base({
    width: camWindowSize(size),
    height: camWindowSize(size),
    x: Math.round(d.workArea.x + 40),
    y: Math.round(d.workArea.y + d.workArea.height - size - 40),
    movable: true,
    focusable: true,          // needed for the drag region to work
    roundedCorners: false,
    acceptFirstMouse: true,
  }));
  w.loadFile(path.join(RENDERER, 'camera.html'));
  pipeConsole(w, "camera");
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  w.on('closed', () => { wins.camera = null; });
  wins.camera = w;
  return w;
}

/* studio mode hides the bubble from the capture so the editor can place it freely.
   burn mode leaves it visible so it bakes into the screen recording, Loom style. */
function setCameraProtection(mode) {
  if (wins.camera && !wins.camera.isDestroyed()) {
    protect(wins.camera, mode === "studio");
  }
}

function setCameraSize(size) {
  if (!wins.camera || wins.camera.isDestroyed()) return;
  const b = wins.camera.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const win = camWindowSize(size);
  wins.camera.setBounds({
    x: Math.round(cx - win / 2),
    y: Math.round(cy - win / 2),
    width: win,
    height: win,
  });
}

/* Resize by following the cursor here rather than in the renderer. A mousemove
   handler that IPCs main on every event lags badly; a 16ms timer reading the
   real cursor position is smooth and keeps the bubble centred while it grows. */
let camResizeTimer = null;
const CAM_MIN = 120;
const CAM_MAX = 620;

function startCameraResize() {
  if (!wins.camera || wins.camera.isDestroyed()) return;
  stopCameraResize();
  const b = wins.camera.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  let ticks = 0;

  camResizeTimer = setInterval(() => {
    if (!wins.camera || wins.camera.isDestroyed()) return stopCameraResize();
    const p = screen.getCursorScreenPoint();
    // distance from the centre defines the radius, so the drag feels direct
    const dist = Math.hypot(p.x - cx, p.y - cy);
    const size = Math.max(CAM_MIN, Math.min(CAM_MAX, Math.round(dist * 2) - CAM_MARGIN * 2));
    const win = camWindowSize(size);
    wins.camera.setBounds({
      x: Math.round(cx - win / 2),
      y: Math.round(cy - win / 2),
      width: win,
      height: win,
    });
    wins.camera.webContents.send('cam-config', { size });
    if (++ticks > 1200) stopCameraResize();      // ~20s safety stop
  }, 16);
}

function stopCameraResize() {
  clearInterval(camResizeTimer);
  camResizeTimer = null;
}

function destroyCamera() {
  stopCameraResize();
  if (wins.camera && !wins.camera.isDestroyed()) wins.camera.destroy();
  wins.camera = null;
}

/* ---------------- region overlays ---------------- */
function createRegionOverlays() {
  destroyRegionOverlays();
  for (const d of screen.getAllDisplays()) {
    const w = new BrowserWindow(base({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      enableLargerThanScreen: true,
      movable: false,
      focusable: true,
      hasShadow: false,
    }));
    w.loadFile(path.join(RENDERER, 'region.html'), {
      query: {
        displayId: String(d.id),
        dx: String(d.bounds.x),
        dy: String(d.bounds.y),
        dw: String(d.bounds.width),
        dh: String(d.bounds.height),
        scale: String(d.scaleFactor),
      },
    });
    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    protect(w);
    w.once('ready-to-show', () => { w.show(); w.focus(); });
    wins.regions.push(w);
  }
  return wins.regions;
}

function destroyRegionOverlays() {
  for (const w of wins.regions) {
    if (w && !w.isDestroyed()) w.destroy();
  }
  wins.regions = [];
}

/* ---------------- countdown ---------------- */
const CD = 300;
function showCountdown(seconds) {
  const d = displayForCursor();
  if (!wins.countdown || wins.countdown.isDestroyed()) {
    wins.countdown = new BrowserWindow(base({
      width: CD,
      height: CD,
      movable: false,
      focusable: false,
    }));
    wins.countdown.loadFile(path.join(RENDERER, 'countdown.html'));
    wins.countdown.setAlwaysOnTop(true, 'screen-saver');
    wins.countdown.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    protect(wins.countdown);
    wins.countdown.setIgnoreMouseEvents(true, { forward: true });
    wins.countdown.on('closed', () => { wins.countdown = null; });
  }
  wins.countdown.setBounds({
    x: Math.round(d.bounds.x + (d.bounds.width - CD) / 2),
    y: Math.round(d.bounds.y + (d.bounds.height - CD) / 2),
    width: CD,
    height: CD,
  });
  wins.countdown.showInactive();
  wins.countdown.webContents.send('countdown-start', seconds);
}

function hideCountdown() {
  if (wins.countdown && !wins.countdown.isDestroyed()) wins.countdown.hide();
}

/* ---------------- studio editor ---------------- */
function createStudio() {
  if (wins.studio && !wins.studio.isDestroyed()) {
    wins.studio.show();
    wins.studio.focus();
    return wins.studio;
  }
  const d = displayForCursor();
  const W = Math.min(1280, d.workArea.width - 80);
  const H = Math.min(820, d.workArea.height - 80);
  const w = new BrowserWindow(base({
    width: W,
    height: H,
    minWidth: 900,
    minHeight: 620,
    x: Math.round(d.workArea.x + (d.workArea.width - W) / 2),
    y: Math.round(d.workArea.y + (d.workArea.height - H) / 2),
    resizable: true,
    movable: true,
    focusable: true,
    maximizable: true,
    skipTaskbar: false,
    transparent: false,
    backgroundColor: '#08090b',
    hasShadow: true,
  }));
  w.loadFile(path.join(RENDERER, 'studio.html'));
  pipeConsole(w, "studio");
  w.on('closed', () => { wins.studio = null; });
  wins.studio = w;
  return w;
}

/* ---------------- helpers ---------------- */
function send(name, channel, ...args) {
  const w = wins[name];
  if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
}

function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

module.exports = {
  wins,
  CAM_MARGIN,
  displayForCursor,
  createSetup, showSetup, destroySetup,
  createControl, showControl, hideControl,
  createRecbar,
  createCamera, setCameraProtection, setCameraSize,
  startCameraResize, stopCameraResize, destroyCamera,
  createRegionOverlays, destroyRegionOverlays,
  showCountdown, hideCountdown,
  createStudio,
  send, broadcast,
};
