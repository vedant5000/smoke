/* Smoke - capture engine.
   Lives in the control window, which stays alive (hidden) for the whole recording
   so MediaRecorder keeps running while the floating bar drives it. */

const engine = (() => {
  const S = {
    recording: false,
    paused: false,
    startedAt: 0,
    pausedTotal: 0,
    pausedAt: 0,
    screenRecorder: null,
    cameraRecorder: null,
    micRecorder: null,
    streams: [],
    audioCtx: null,
    micTrack: null,
    tickTimer: null,
    camPosTimer: null,
    session: null,
    mode: 'studio',
  };

  /* Chromium gives us a few container options. VP9 in WebM is the safest
     combination of quality and guaranteed playback in the Studio preview. */
  function pickMime() {
    const options = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const m of options) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  function pickAudioMime() {
    for (const m of ['audio/webm;codecs=opus', 'audio/webm']) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function getScreenStream(state) {
    await cue.chooseSource({ sourceId: state.sourceId, systemAudio: state.sysAudio });
    /* main's display-media handler serves the source we just nominated.
       The cursor constraint is honoured even though getSettings() always
       reports "always" back, verified against captured pixels. */
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        cursor: state.hideCursor ? 'never' : 'always',
      },
      audio: state.sysAudio,
    });
    // keep encoding sane on very large displays
    const track = stream.getVideoTracks()[0];
    try {
      const settings = track.getSettings();
      if (settings.height && settings.height > 1440) {
        await track.applyConstraints({ height: { max: 1440 } });
      }
    } catch (_) {}
    return stream;
  }

  /* Chrome's echo cancellation, noise suppression and auto gain are tuned for
     phone calls. They band-limit the signal toward telephony bandwidth and dull
     consonants, which is exactly the "muffled" sound. For a recording we want
     the raw microphone and we clean it up properly at export instead.

     Echo cancellation stays available as an opt-in, because on speakers it is
     the only thing stopping the mic re-recording your system audio. */
  async function getMicStream(state) {
    if (!state.micOn) return null;
    const wantsEcho = state.echoCancel === true;
    const base = {
      deviceId: state.micId && state.micId !== 'default' ? { exact: state.micId } : undefined,
      echoCancellation: wantsEcho,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
      sampleRate: 48000,
    };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: base });
    } catch (e) {
      // some devices reject the exact constraints; fall back to plain capture
      console.warn('[smoke] microphone constraints rejected, retrying plain:', e.message);
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: base.deviceId ? { deviceId: base.deviceId } : true,
        });
      } catch (e2) {
        console.warn('[smoke] microphone unavailable:', e2.message);
        return null;
      }
    }
  }

  async function getCameraStream(state) {
    if (!state.camOn || !state.cameraId) return null;
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: state.cameraId },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      });
    } catch (e) {
      console.warn('[cue] camera unavailable:', e.message);
      return null;
    }
  }

  /* Reading a Blob is async, so naive handlers can reach main out of order and,
     worse, land after the stream has been closed. Each recorder gets a promise
     chain: writes stay in order and stop() can wait for the tail. Getting this
     wrong silently truncates a recording to its final chunk. */
  const chains = {};

  function enqueueChunk(which, blob) {
    const prev = chains[which] || Promise.resolve();
    chains[which] = prev.then(async () => {
      const buf = await blob.arrayBuffer();
      await cue.recChunk(which, buf);
    }).catch((err) => { console.error('[smoke] chunk write failed:', err); });
    return chains[which];
  }

  function flushChunks() {
    return Promise.allSettled(Object.values(chains));
  }

  function startRecorder(stream, which, mime) {
    const opts = { mimeType: mime };
    if (which === 'screen') opts.videoBitsPerSecond = 8_000_000;
    else opts.videoBitsPerSecond = 2_500_000;
    // never left to the default; voice deserves the headroom
    opts.audioBitsPerSecond = 192_000;

    const rec = new MediaRecorder(stream, opts);
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      enqueueChunk(which, e.data);
    };
    rec.onerror = (e) => console.error(`[cue] ${which} recorder error:`, e.error);
    rec.start(2000);                        // flush to disk every 2s
    return rec;
  }

  function pushState() {
    const elapsed = S.recording
      ? Date.now() - S.startedAt - S.pausedTotal - (S.paused ? Date.now() - S.pausedAt : 0)
      : 0;
    cue.recState({
      recording: S.recording,
      paused: S.paused,
      elapsed: Math.max(0, elapsed),
    });
  }

  async function start(state) {
    if (S.recording) return;
    const mime = pickMime();
    if (!mime) throw new Error('This build has no supported recording format');

    S.mode = state.camMode;
    const wantsScreen = state.mode !== 'camera';
    const wantsCamera = state.camOn && Boolean(state.cameraId);

    // acquire everything before the countdown so failures surface immediately
    let screenStream = null;
    if (wantsScreen) {
      if (!state.sourceId) {
        throw new Error(
          'No screen or window is selected.\n\n' +
          'If the Source list is empty, macOS has not granted Smoke ' +
          'Screen Recording permission yet. Open System Settings > Privacy & ' +
          'Security > Screen Recording, turn Smoke on, then reopen it.',
        );
      }
      screenStream = await getScreenStream(state);
      S.streams.push(screenStream);
    }

    const micStream = await getMicStream(state);
    if (micStream) S.streams.push(micStream);

    const cameraStream = await getCameraStream(state);
    if (cameraStream) S.streams.push(cameraStream);

    if (!screenStream && !cameraStream) throw new Error('Nothing to record - no screen and no camera');

    /* Store the crop as fractions of the display, not pixels. The captured
       track may be downscaled from the panel size, so Studio resolves it
       against the real video dimensions at render time. */
    const crop = state.region ? {
      nx: state.region.nx,
      ny: state.region.ny,
      nw: state.region.nw,
      nh: state.region.nh,
      label: `${Math.round(state.region.w)} x ${Math.round(state.region.h)}`,
    } : null;

    S.session = await cue.recStart({
      mode: state.camMode,
      sourceKind: state.region ? 'region' : state.sourceKind,
      displayId: state.region
        ? state.region.displayId
        : (state.sourceMeta ? state.sourceMeta.displayId : null),
      crop,
      displayScale: state.region ? state.region.scale : (state.sourceMeta ? state.sourceMeta.scaleFactor : 1),
      hasCamera: Boolean(cameraStream),
      hasMic: Boolean(micStream && micStream.getAudioTracks().length),
      countdown: state.countdown,
    });

    /* The voice and the system audio are recorded to separate files. Mixed
       together at capture there is no way to clean up the voice later without
       also gating and compressing whatever music or video was playing. */
    if (screenStream) {
      const tracks = [screenStream.getVideoTracks()[0]];
      const sysTrack = state.sysAudio ? screenStream.getAudioTracks()[0] : null;
      if (sysTrack) tracks.push(sysTrack);
      S.screenRecorder = startRecorder(new MediaStream(tracks), 'screen', mime);
    }

    // the camera is always recorded on its own so Studio can re-place it
    if (cameraStream) {
      S.cameraRecorder = startRecorder(new MediaStream([cameraStream.getVideoTracks()[0]]), 'camera', mime);
    }

    // the microphone on its own track, routed through a gain node so the
    // recording bar's mute still works
    const micTrack = micStream && micStream.getAudioTracks()[0];
    if (micTrack) {
      const ctx = new AudioContext();
      S.audioCtx = ctx;
      const dest = ctx.createMediaStreamDestination();
      const node = ctx.createMediaStreamSource(new MediaStream([micTrack]));
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      S.micGain = gain;
      node.connect(gain).connect(dest);
      S.micRecorder = startRecorder(dest.stream, 'mic', pickAudioMime());
    }

    // stop if the user ends the share from the OS bar
    if (screenStream) {
      screenStream.getVideoTracks()[0].addEventListener('ended', () => stop(false));
    }

    S.recording = true;
    S.paused = false;
    S.startedAt = Date.now();
    S.pausedTotal = 0;
    S.tickTimer = setInterval(pushState, 250);
    pushState();

    // record where the bubble sits over time so Studio can replay the motion
    if (cameraStream && state.camMode === 'studio') {
      S.camPosTimer = setInterval(async () => {
        if (S.paused) return;
        const b = await cue.camBounds();
        if (b) cue.camPosition({ t: Date.now() - S.startedAt - S.pausedTotal, ...b });
      }, 400);
    }
  }

  function pause() {
    if (!S.recording || S.paused) return;
    S.paused = true;
    S.pausedAt = Date.now();
    for (const r of [S.screenRecorder, S.cameraRecorder, S.micRecorder]) {
      if (r && r.state === "recording") r.pause();
    }
    pushState();
  }

  function resume() {
    if (!S.recording || !S.paused) return;
    S.pausedTotal += Date.now() - S.pausedAt;
    S.paused = false;
    for (const r of [S.screenRecorder, S.cameraRecorder, S.micRecorder]) {
      if (r && r.state === "paused") r.resume();
    }
    pushState();
  }

  function cleanup() {
    clearInterval(S.tickTimer); S.tickTimer = null;
    clearInterval(S.camPosTimer); S.camPosTimer = null;
    for (const s of S.streams) {
      try { s.getTracks().forEach((t) => t.stop()); } catch (_) {}
    }
    S.streams = [];
    if (S.audioCtx) { try { S.audioCtx.close(); } catch (_) {} S.audioCtx = null; }
    S.micGain = null;
    S.screenRecorder = null;
    S.cameraRecorder = null;
    S.micRecorder = null;
    S.recording = false;
    S.paused = false;
  }

  async function stop(cancelled) {
    if (!S.recording) return;
    const waits = [];
    for (const rec of [S.screenRecorder, S.cameraRecorder, S.micRecorder]) {
      if (!rec || rec.state === 'inactive') continue;
      waits.push(new Promise((r) => { rec.onstop = r; }));
      rec.stop();
    }
    await Promise.all(waits);
    // the final dataavailable fires around onstop, so drain the queue before
    // main is allowed to close the files
    await flushChunks();
    cleanup();
    pushState();
    await cue.recStop({ cancelled: Boolean(cancelled) });
  }

  function handleAction(action) {
    if (action === 'pause') return pause();
    if (action === 'resume') return resume();
    if (action === 'stop') return stop(false);
    if (action === 'cancel') return stop(true);
    if (action === 'toggle-mic') {
      if (S.micGain) S.micGain.gain.value = S.micGain.gain.value > 0 ? 0 : 1;
      return;
    }
  }

  return {
    start,
    stop,
    pause,
    resume,
    handleAction,
    get recording() { return S.recording; },
  };
})();
