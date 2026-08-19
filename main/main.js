const { app, ipcMain, desktopCapturer, screen, Tray, Menu, nativeImage, clipboard, shell, systemPreferences, globalShortcut, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const http = require('http');

/* System audio loopback on macOS needs these Chromium features.
   Electron 39+ supports audio:'loopback' in setDisplayMediaRequestHandler. */
app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

const config = require('./config');
const bunny = require('./bunny');
const W = require('./windows');
const { renderComposite, renderWithSegments, probe, remux, waveform } = require('./render');

let tray = null;

/* A render or upload keeps reporting progress after you close Studio, and
   messaging a destroyed webContents throws an uncaught exception that Electron
   surfaces as a scary dialog. Every progress path goes through this. */
function safeSend(sender, channel, payload) {
  try {
    if (sender && !sender.isDestroyed()) sender.send(channel, payload);
  } catch (_) { /* the window went away mid-send, which is fine */ }
}

/* Last line of defence: log instead of showing Electron's error dialog. */
process.on('uncaughtException', (err) => {
  console.error('[smoke] uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[smoke] unhandled rejection:', err && err.stack ? err.stack : err);
});

/* ---------------- recording session ---------------- */
let session = null;
let pendingSource = null;     // source served to the next getDisplayMedia call
let regionResolve = null;

function newSession(opts) {
  const id = `rec-${Date.now()}`;
  const dir = path.join(config.recordingsDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  session = {
    id,
    dir,
    screenPath: path.join(dir, 'screen.webm'),
    cameraPath: path.join(dir, 'camera.webm'),
    micPath: path.join(dir, 'mic.webm'),
    screenStream: null,
    cameraStream: null,
    micStream: null,
    startedAt: Date.now(),
    pausedMs: 0,
    mode: opts.mode || 'studio',
    sourceKind: opts.sourceKind || 'screen',
    crop: opts.crop || null,
    displayScale: opts.displayScale || 1,
    camTrack: [],
    hasCamera: Boolean(opts.hasCamera),
    displayBounds: displayBoundsFor(opts.displayId),
    meta: opts,
  };
  return session;
}

function displayBoundsFor(displayId) {
  const all = screen.getAllDisplays();
  const match = displayId ? all.find((d) => String(d.id) === String(displayId)) : null;
  return (match || screen.getPrimaryDisplay()).bounds;
}

/* The bubble path is logged in global screen coordinates. Convert it to
   fractions of the captured area so Studio and the renderer can use it
   regardless of resolution, and clip it to the selected region. */
function normaliseCamTrack(s) {
  if (!s.camTrack.length) return [];
  const d = s.displayBounds;
  if (!d || !d.width || !d.height) return [];

  const region = s.crop && s.crop.nw
    ? { x: s.crop.nx, y: s.crop.ny, w: s.crop.nw, h: s.crop.nh }
    : { x: 0, y: 0, w: 1, h: 1 };

  // the window is larger than the visible bubble by the shadow margin
  const M = W.CAM_MARGIN * 2;

  return s.camTrack.map((e) => {
    // centre of the bubble, as a fraction of the display
    const fx = ((e.x + e.width / 2) - d.x) / d.width;
    const fy = ((e.y + e.height / 2) - d.y) / d.height;
    return {
      t: e.t,
      x: (fx - region.x) / region.w,
      y: (fy - region.y) / region.h,
      w: (Math.max(1, e.width - M) / d.width) / region.w,
      h: (Math.max(1, e.height - M) / d.height) / region.h,
    };
  });
}

function closeStreams() {
  if (!session) return;
  for (const k of ['screenStream', 'cameraStream', 'micStream']) {
    const s = session[k];
    if (s) { try { s.end(); } catch (_) {} session[k] = null; }
  }
}

/* ---------------- display media ---------------- */
function installDisplayMediaHandler() {
  const { session: electronSession } = require('electron');
  electronSession.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!pendingSource) return callback({});
    const wantsAudio = pendingSource.systemAudio !== false;
    callback({
      video: pendingSource.source,
      audio: wantsAudio ? 'loopback' : undefined,
    });
  }, { useSystemPicker: false });
}

/* ---------------- ipc ---------------- */
function wireIpc() {
  ipcMain.handle('app:info', () => ({
    bunnyConfigured: config.bunnyConfigured(),
    libraryId: config.bunny.libraryId,
    apiKey: config.bunny.apiKey,
    cdnHostname: config.bunny.cdnHostname,
    settings: config.readSettings(),
    version: app.getVersion(),
  }));

  ipcMain.handle('settings:save', (_e, patch) => config.writeSettings(patch));

  ipcMain.handle('perm:check', async () => ({
    screen: systemPreferences.getMediaAccessStatus('screen'),
    camera: systemPreferences.getMediaAccessStatus('camera'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  }));

  ipcMain.handle('perm:request', async (_e, kind) => {
    if (kind === 'screen') {
      shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      return 'opened-settings';
    }
    try { return await systemPreferences.askForMediaAccess(kind); }
    catch (_) { return false; }
  });

  /* source list with thumbnails for the picker */
  ipcMain.handle('sources:list', async () => {
    const access = systemPreferences.getMediaAccessStatus('screen');
    const displays = screen.getAllDisplays();
    /* A fixed thumbnailSize letterboxes or crops, which is exactly what makes
       it unclear what you are about to record. Ask for a generous box and let
       Electron preserve the source aspect inside it. */
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 640, height: 640 },
      fetchWindowIcons: true,
    });
    console.log(`[smoke] sources: ${sources.length} found, screen access = ${access}`);

    return sources
      .filter((s) => s.name !== 'Smoke' && !/^Smoke/.test(s.name))
      .map((s) => {
        const d = s.display_id ? displays.find((x) => String(x.id) === String(s.display_id)) : null;
        // the thumbnail's own size is the only reliable aspect for windows
        const t = s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.getSize() : null;
        return {
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen') ? 'screen' : 'window',
          displayId: s.display_id || null,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
          appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
          width: d ? d.bounds.width : null,
          height: d ? d.bounds.height : null,
          thumbW: t ? t.width : null,
          thumbH: t ? t.height : null,
          scaleFactor: d ? d.scaleFactor : 1,
        };
      });
  });

  /* the renderer nominates a source, then calls getDisplayMedia */
  ipcMain.handle('capture:choose', async (_e, { sourceId, systemAudio }) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((s) => s.id === sourceId);
    if (!source) throw new Error('That source is no longer available');
    pendingSource = { source, systemAudio };
    return true;
  });

  /* ---- region select ---- */
  ipcMain.handle('region:pick', () => new Promise((resolve) => {
    regionResolve = resolve;
    W.createRegionOverlays();
  }));

  ipcMain.on('region:result', (_e, rect) => {
    W.destroyRegionOverlays();
    if (regionResolve) { regionResolve(rect); regionResolve = null; }
  });

  ipcMain.on('region:cancel', () => {
    W.destroyRegionOverlays();
    if (regionResolve) { regionResolve(null); regionResolve = null; }
  });

  /* ---- camera bubble ---- */
  ipcMain.handle('cam:show', (_e, { size, shape, deviceId, mode }) => {
    const w = W.createCamera(size);
    W.setCameraProtection(mode);
    const push = () => w.webContents.send('cam-config', { shape, deviceId, size });
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', push);
    else push();
    w.showInactive();
    return true;
  });

  /* Destroy rather than hide. A hidden bubble keeps holding the camera, and a
     stale one has a habit of reappearing in a corner with nothing driving it. */
  ipcMain.handle('cam:hide', () => { W.destroyCamera(); return true; });

  ipcMain.on('cam:resize-start', () => W.startCameraResize());
  ipcMain.on('cam:resize-end', () => {
    W.stopCameraResize();
    const b = W.wins.camera && !W.wins.camera.isDestroyed() ? W.wins.camera.getBounds() : null;
    if (b) config.writeSettings({ cameraSize: b.width - W.CAM_MARGIN * 2 });
  });

  ipcMain.handle('cam:update', (_e, patch) => {
    if (patch.size) W.setCameraSize(patch.size);
    if (patch.mode) W.setCameraProtection(patch.mode);
    W.send('camera', 'cam-config', patch);
    return true;
  });

  ipcMain.handle('cam:bounds', () => {
    if (!W.wins.camera || W.wins.camera.isDestroyed()) return null;
    return W.wins.camera.getBounds();
  });

  /* ---- recording lifecycle ---- */
  ipcMain.handle('rec:start', async (_e, opts) => {
    const s = newSession(opts);
    if (opts.countdown > 0) {
      W.showCountdown(opts.countdown);
      await new Promise((r) => setTimeout(r, opts.countdown * 1000 + 150));
      W.hideCountdown();
    }
    W.hideControl();
    const bar = W.createRecbar();
    const push = () => bar.webContents.send('rec-config', {
      mode: s.mode,
      hasCamera: s.hasCamera,
      hasMic: Boolean(opts.hasMic),
    });
    if (bar.webContents.isLoading()) bar.webContents.once('did-finish-load', push);
    else push();
    bar.showInactive();
    return { id: s.id, dir: s.dir };
  });

  /* streamed chunks land straight on disk so long recordings never sit in memory */
  ipcMain.handle('rec:chunk', (_e, { which, buffer }) => {
    if (!session) { console.warn('[smoke] chunk dropped, no session:', which, buffer.byteLength); return false; }
    const key = { camera: 'cameraStream', mic: 'micStream' }[which] || 'screenStream';
    const file = { camera: session.cameraPath, mic: session.micPath }[which] || session.screenPath;
    /* Append, never truncate. If a late chunk ever outlives the stream this
       costs nothing, whereas the default 'w' flag silently ate the recording. */
    if (!session[key]) session[key] = fs.createWriteStream(file, { flags: 'a' });
    session[key].write(Buffer.from(buffer));
    return true;
  });

  ipcMain.on('rec:cam-position', (_e, entry) => {
    if (session) session.camTrack.push(entry);
  });

  ipcMain.handle('rec:stop', async (_e, { cancelled } = {}) => {
    if (!session) return null;
    closeStreams();
    await new Promise((r) => setTimeout(r, 250));   // let the write streams flush

    if (W.wins.recbar && !W.wins.recbar.isDestroyed()) W.wins.recbar.hide();
    W.destroyCamera();

    const s = session;
    session = null;

    if (cancelled) {
      try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch (_) {}
      showControl();
      return null;
    }

    const studio = W.createStudio();

    const screenFile = await remux(fs.existsSync(s.screenPath) ? s.screenPath : null);
    const camera = await remux(fs.existsSync(s.cameraPath) ? s.cameraPath : null);
    const mic = await remux(fs.existsSync(s.micPath) ? s.micPath : null);

    const payload = {
      id: s.id,
      dir: s.dir,
      screenPath: screenFile ? screenFile.path : null,
      cameraPath: camera ? camera.path : null,
      micPath: mic ? mic.path : null,
      screenInfo: screenFile ? screenFile.info : null,
      cameraInfo: camera ? camera.info : null,
      micInfo: mic ? mic.info : null,
      camTrack: normaliseCamTrack(s),
      mode: s.mode,
      crop: s.crop,
      displayScale: s.displayScale,
      durationMs: Date.now() - s.startedAt,
    };
    fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify(payload, null, 2));

    const push = () => studio.webContents.send('studio-load', payload);
    if (studio.webContents.isLoading()) studio.webContents.once('did-finish-load', push);
    else push();
    studio.show();
    studio.focus();
    return payload;
  });

  /* the control window owns the MediaRecorder even while hidden,
     so the bar's buttons are relayed to it through main */
  ipcMain.on('rec:state', (_e, state) => {
    W.send('recbar', 'rec-state', state);
  });

  ipcMain.on('rec:action', (_e, action) => {
    W.send('control', 'rec-action', action);
  });

  /* ---- studio: probe + render ---- */
  ipcMain.handle('studio:probe', async (_e, file) => probe(file));

  ipcMain.handle('studio:waveform', async (_e, file) => {
    try { return await waveform(file); } catch (_) { return null; }
  });

  ipcMain.handle('studio:render', async (e, spec) => {
    return renderWithSegments(spec, (p) => safeSend(e.sender, 'render-progress', p));
  });

  ipcMain.handle('studio:reveal', (_e, file) => { shell.showItemInFolder(file); return true; });

  /* Destroy rather than hide, so the next take opens a clean editor instead of
     inheriting the previous one's trim, zooms and blurs. */
  ipcMain.on('studio:close', () => {
    if (W.wins.studio && !W.wins.studio.isDestroyed()) W.wins.studio.destroy();
    W.wins.studio = null;
  });

  ipcMain.on('studio:minimise', () => {
    if (W.wins.studio && !W.wins.studio.isDestroyed()) W.wins.studio.minimize();
  });

  ipcMain.handle('studio:saveAs', async (_e, { src, suggested }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: suggested || 'recording.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(src, filePath);
    return filePath;
  });

  /* ---- bunny credentials ---- */
  /* Validate before saving. Credentials that are wrong should fail here, in a
     screen built to explain them, not later inside a publish that someone has
     already recorded for. */
  ipcMain.handle('bunny:save', async (_e, { libraryId, apiKey, cdnHostname }) => {
    const check = await bunny.validate({ libraryId, apiKey });
    if (!check.ok) return check;

    let host = String(cdnHostname || '').trim();
    if (!host) host = await bunny.discoverCdnHostname({ libraryId, apiKey });

    const saved = config.saveBunny({ libraryId, apiKey, cdnHostname: host });
    rebuildTrayMenu();
    W.broadcast('bunny-configured', { libraryId: saved.libraryId });
    console.log('[smoke] credentials saved to', saved.savedTo);
    return { ok: true, videoCount: check.videoCount, libraryId: saved.libraryId, cdnHostname: saved.cdnHostname };
  });

  ipcMain.on('setup:done', () => {
    W.destroySetup();
    showControl();
  });

  /* Closing setup with nothing configured leaves an app that cannot publish,
     so quit rather than sit in the menubar looking functional. */
  ipcMain.on('setup:cancel', () => {
    W.destroySetup();
    if (!config.bunnyConfigured()) return app.quit();
    showControl();
  });

  /* ---- bunny ---- */
  ipcMain.handle('bunny:publish', async (e, { file, title }) => {
    if (!config.bunnyConfigured()) {
      W.showSetup();
      throw new Error('Bunny is not connected yet. Enter your library ID and API key in the window that just opened, then publish again.');
    }
    const send = (stage, data) => safeSend(e.sender, 'publish-progress', { stage, ...data });

    send('creating', { pct: 0 });
    const guid = await bunny.createVideo(title);

    send('uploading', { pct: 0, guid });
    await bunny.uploadVideo(guid, file, ({ pct, sent, total }) => send('uploading', { pct, sent, total, guid }));

    /* The share URL is built from the library id and the guid, and both are
       known the moment the upload lands. Hand it over NOW rather than at the
       end of encoding. Bunny routinely spends many minutes on a clip that took
       one second to upload, and making someone watch a progress bar for a link
       that already exists is what makes publishing feel broken. */
    const links = bunny.urls(guid);
    send('uploaded', { pct: 100, guid, links });

    send('encoding', { pct: 0, guid, links });
    let encoded = false;
    try {
      const video = await bunny.waitUntilPlayable(guid, {
        /* Encoding is Bunny's queue, not ours, and a busy queue can sit on a
           short clip for a quarter of an hour. Waiting longer costs nothing now
           that the link is already in the user's hands. */
        timeoutMs: 30 * 60 * 1000,
        onTick: ({ encodeProgress }) => send('encoding', { pct: encodeProgress || 0, guid, links }),
      });
      encoded = true;

      /* An empty library has no video to read the pull zone hostname off, so the
         first publish is the earliest moment it can be learned. Do it here and
         the direct MP4 link is available from the second recording onwards. */
      if (!config.bunny.cdnHostname && video && video.thumbnailUrl) {
        const host = bunny.hostnameFromThumbnail(video.thumbnailUrl);
        if (host && config.rememberCdnHostname(host)) console.log('[smoke] learned CDN hostname:', host);
      }
      send('done', { pct: 100, guid, links: bunny.urls(guid) });
    } catch (err) {
      /* Slow encoding is not a failed publish. The file is on Bunny and the
         link is real, so report the wait instead of throwing away a good link
         and telling someone their recording failed. */
      console.warn('[smoke] still encoding after the wait:', err.message);
      send('slow', { pct: 100, guid, links, message: err.message });
    }

    return { guid, links, encoded };
  });

  /* Cue (the notch app) already runs a localhost listener and its teleprompter
     window is content protected, so it is invisible to any capture. We just ask
     it to open. Smoke works fine without Cue installed. */
  ipcMain.handle('cue:teleprompter', async () => {
    return new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: 8787, path: '/prompter', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 },
        timeout: 1200,
      }, (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end('{}');
    });
  });

  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text)); return true; });
  ipcMain.handle('shell:open', (_e, url) => { shell.openExternal(String(url)); return true; });

  ipcMain.on('win:close', (e) => {
    const w = require('electron').BrowserWindow.fromWebContents(e.sender);
    if (w && !w.isDestroyed()) w.hide();
  });

  ipcMain.on('win:hide-control', () => W.hideControl());

  ipcMain.on('control:show', () => showControl());

  /* Screen Recording only takes effect after a restart, so offer one. */
  ipcMain.on('app:relaunch', () => {
    W.destroyCamera();
    app.relaunch();
    app.exit(0);
  });
}

/* Created once, from whichever comes first: a configured launch, or finishing
   the setup screen. The hide/close handlers have to travel with it, so this
   cannot just be W.createControl() in two places. */
function ensureControl() {
  const control = W.createControl();
  if (control.__smokeWired) return control;
  control.__smokeWired = true;
  /* The bubble is a preview of the take you are setting up. If the panel goes
     away and nothing is recording, it has no reason to sit on your screen
     holding the camera. */
  control.on('hide', () => { if (!session) W.destroyCamera(); });
  control.on('closed', () => { if (!session) W.destroyCamera(); });
  return control;
}

/* Always go through this rather than W.showControl(). The panel is destroyed
   and rebuilt over an app's lifetime, and a rebuilt one with no hide handler
   leaves the camera bubble stranded on screen holding the webcam. */
function showControl() {
  ensureControl();
  W.showControl();
}

/* Closing Studio without publishing should not strand the take. The files are
   still on disk, so offer a way back into the most recent one. */
function reopenLastSession() {
  let dirs = [];
  try {
    const root = config.recordingsDir();
    dirs = fs.readdirSync(root)
      .map((name) => path.join(root, name))
      .filter((p) => fs.existsSync(path.join(p, 'session.json')))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch (_) {}

  if (!dirs.length) {
    dialog.showMessageBox({
      type: 'info',
      message: 'No recordings yet',
      detail: 'Take one first and it will open in Studio automatically.',
      buttons: ['OK'],
    });
    return;
  }

  let payload;
  try { payload = JSON.parse(fs.readFileSync(path.join(dirs[0], 'session.json'), 'utf8')); }
  catch (_) { return; }

  const studio = W.createStudio();
  const push = () => studio.webContents.send('studio-load', payload);
  if (studio.webContents.isLoading()) studio.webContents.once('did-finish-load', push);
  else push();
  studio.show();
  studio.focus();
}

/* ---------------- tray ---------------- */
/* The menu is rebuilt rather than built once, because connecting Bunny changes
   what it should say and a stale "not connected" line is confusing. */
let trayMenu = null;

function rebuildTrayMenu() {
  const connected = config.bunnyConfigured();
  trayMenu = Menu.buildFromTemplate([
    { label: 'New recording', accelerator: 'Cmd+Shift+9', click: () => showControl() },
    { label: 'Reopen last recording', click: () => reopenLastSession() },
    { label: 'Hide camera bubble', click: () => W.destroyCamera() },
    { type: 'separator' },
    { label: 'Open recordings folder', click: () => shell.openPath(config.recordingsDir()) },
    {
      label: connected ? `Bunny library ${config.bunny.libraryId}` : 'Bunny not connected',
      enabled: false,
    },
    { label: connected ? 'Change Bunny credentials...' : 'Connect Bunny...', click: () => W.showSetup() },
    {
      label: 'Open Bunny dashboard',
      enabled: connected,
      click: () => shell.openExternal('https://dash.bunny.net/stream/' + config.bunny.libraryId),
    },
    { type: 'separator' },
    { label: 'Quit Smoke', click: () => { app.quit(); } },
  ]);
  return trayMenu;
}

function makeTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'smokeTemplate.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Smoke - click to record');
  rebuildTrayMenu();

  tray.on('click', () => {
    /* Nothing else in this app works without credentials, so an unconfigured
       click goes to setup instead of a panel whose publish button would fail. */
    if (!config.bunnyConfigured()) return W.showSetup();
    if (W.wins.control && !W.wins.control.isDestroyed() && W.wins.control.isVisible()) W.hideControl();
    else showControl();
  });
  tray.on('right-click', () => tray.popUpContextMenu(trayMenu));
}

/* ---------------- boot ---------------- */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (config.bunnyConfigured()) showControl(); else W.showSetup();
  });

  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
    installDisplayMediaHandler();
    wireIpc();
    makeTray();

    /* First run, or credentials that were never entered: ask for them before
       anything else, and do NOT build the control panel yet. Creating it runs
       its renderer, which raises the camera bubble, so an unconfigured launch
       would grab the webcam and float a preview over the setup screen. */
    if (!config.bunnyConfigured() && !process.argv.includes('--selftest')) {
      W.showSetup();
      console.log('[smoke] no Bunny credentials yet, showing setup');
    } else {
      ensureControl();
    }

    globalShortcut.register('CommandOrControl+Shift+9', () => {
      if (config.bunnyConfigured()) showControl(); else W.showSetup();
    });
    console.log('[smoke] ready. env loaded from:', config.loadedFrom || 'nothing found');

    if (process.argv.includes('--selftest')) {
      const keepOpen = process.argv.includes('--keepopen');
      require('./selftest').run({ seconds: 6, publish: !keepOpen })
        .then((r) => {
          console.log('[selftest] result:', JSON.stringify(r, null, 2));
          if (!keepOpen) setTimeout(() => app.quit(), 1500);
        })
        .catch((e) => {
          console.error('[selftest] threw:', e);
          setTimeout(() => app.quit(), 1500);
        });
    }
  });

  app.on('window-all-closed', (e) => { e.preventDefault(); });

  // never leave a floating bubble behind holding the camera
  app.on('before-quit', () => { W.destroyCamera(); W.destroyRegionOverlays(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); W.destroyCamera(); });
}
