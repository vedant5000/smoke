/* Dev-only end to end check: record the screen for a few seconds, stop,
   then render and publish the result. Run with `npm run selftest`.
   Exists so the whole chain can be exercised without clicking through the UI. */

const W = require('./windows');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ seconds = 6, publish = true } = {}) {
  const log = (...a) => console.log('[selftest]', ...a);

  log('waiting for the control window');
  const control = W.createControl();
  if (control.webContents.isLoading()) {
    await new Promise((r) => control.webContents.once('did-finish-load', r));
  }
  await wait(2500);   // let device and source enumeration settle

  log('starting a screen-only recording');
  const started = await control.webContents.executeJavaScript(`(async () => {
    const list = await cue.listSources();
    const screenSrc = list.find(s => s.kind === 'screen');
    if (!screenSrc) return { ok: false, why: 'no screen source' };
    state.mode = 'screen';
    state.camOn = false;
    state.micOn = true;
    state.sysAudio = true;
    state.countdown = 0;
    state.sourceId = screenSrc.id;
    state.sourceMeta = screenSrc;
    state.sourceKind = 'screen';
    state.region = null;
    try { await engine.start(state); return { ok: true, source: screenSrc.name }; }
    catch (e) { return { ok: false, why: String(e && e.message || e) }; }
  })()`);

  if (!started.ok) {
    log('FAILED to start:', started.why);
    return { ok: false, stage: 'start', why: started.why };
  }
  log('recording from:', started.source);

  await wait(seconds * 1000);

  log('stopping');
  await control.webContents.executeJavaScript('engine.stop(false)');
  await wait(4000);   // remux + studio load

  const studio = W.wins.studio;
  if (!studio || studio.isDestroyed()) {
    log('FAILED: studio never opened');
    return { ok: false, stage: 'studio' };
  }

  const loaded = await studio.webContents.executeJavaScript(`({
    duration: S.duration,
    screen: Boolean(S.screen),
    hasFile: Boolean(S.session && S.session.screenPath),
  })`);
  log('studio loaded:', JSON.stringify(loaded));

  if (!loaded.hasFile || !(loaded.duration > 0)) {
    log('FAILED: studio has no usable recording');
    return { ok: false, stage: 'load', loaded };
  }

  if (!publish) {
    await wait(1200);
    // land on the Look tab so the background picker is on screen for review
    const look = await studio.webContents.executeJavaScript(`(() => {
      const tab = document.querySelector('#tabs [data-tab="look"]');
      if (tab) tab.click();
      const grid = document.querySelectorAll('#bgGrid .bg');
      return {
        tabActive: document.querySelector('.pane[data-pane="look"]').classList.contains('on'),
        backgrounds: grid.length,
        names: Array.from(grid).slice(0, 4).map(e => e.title),
      };
    })()`);
    log('look pane:', JSON.stringify(look));
    return { ok: true, stage: 'load', loaded, look };
  }

  log('rendering and publishing (zoom, gradient background, screen crop and a layout)');
  const result = await studio.webContents.executeJavaScript(`(async () => {
    S.zooms.push({ start: 1, end: 3.5, x: 0.4, y: 0.4, scale: 1.7 });
    S.background = { type: 'gradient', colors: ['#1a1140', '#7b4397', '#dc2430'], angle: 135, padding: 4, radius: 24 };
    // exercise the segment path too: keep the head and tail, cut the middle out
    S.segments = [
      { start: 0, end: Math.max(0.5, S.duration * 0.35) },
      { start: S.duration * 0.6, end: Math.min(S.duration, ${seconds - 0.5}) },
    ].filter(s => s.end > s.start);
    S.audio = { voice: 'studio', micGain: 1, systemGain: 0.7 };
    const spec = buildSpec('selftest.mp4');
    try {
      await cue.render(spec);
      const r = await cue.publish({ file: spec.out, title: 'Smoke selftest' });
      return { ok: true, links: r.links, guid: r.guid };
    } catch (e) {
      return { ok: false, why: String(e && e.message || e) };
    }
  })()`);

  if (!result.ok) {
    log('FAILED to publish:', result.why);
    return { ok: false, stage: 'publish', why: result.why };
  }

  log('PUBLISHED');
  log('  share:', result.links.share);
  log('  mp4:  ', result.links.mp4);
  return { ok: true, ...result };
}

module.exports = { run };
