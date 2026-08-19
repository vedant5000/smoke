/* A stand-in for preload/bridge.js so the REAL renderer pages can be rendered
   in a headless browser with no Electron behind them.
   shoot.sh copies renderer/ to a temp dir and injects this at the top of each
   page, so the shipping app never carries it.

   Every value here is invented. Nothing touches a real screen or a real Bunny
   library. */
(() => {
  const q = new URLSearchParams(location.search);

  /* Fake source thumbnails: a tiny SVG data URI per card, so the picker grid
     looks populated without embedding a picture of anyone's actual desktop. */
  /* base64, not percent-encoding: control.html builds an unquoted CSS
     url(...), and a raw "(" from an rgba() colour would end the url early. */
  const thumb = (label, from, to) => 'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0%" stop-color="${from}"/><stop offset="100%" stop-color="${to}"/>
       </linearGradient></defs>
       <rect width="640" height="400" fill="url(#g)"/>
       <rect x="0" y="0" width="640" height="30" fill="#000" fill-opacity=".28"/>
       <circle cx="18" cy="15" r="5" fill="#ff5f57"/><circle cx="36" cy="15" r="5" fill="#febc2e"/>
       <circle cx="54" cy="15" r="5" fill="#28c840"/>
       <rect x="34" y="70" width="240" height="16" rx="6" fill="#fff" fill-opacity=".50"/>
       <rect x="34" y="104" width="410" height="10" rx="5" fill="#fff" fill-opacity=".24"/>
       <rect x="34" y="126" width="330" height="10" rx="5" fill="#fff" fill-opacity=".18"/>
       <rect x="34" y="176" width="180" height="118" rx="10" fill="#fff" fill-opacity=".13"/>
       <rect x="230" y="176" width="180" height="118" rx="10" fill="#fff" fill-opacity=".10"/>
       <rect x="426" y="176" width="180" height="118" rx="10" fill="#fff" fill-opacity=".08"/>
       <text x="34" y="345" font-family="-apple-system,sans-serif" font-size="19"
             fill="#fff" fill-opacity=".62">${label}</text>
     </svg>`);

  const icon = (c) => 'data:image/svg+xml;base64,' + btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">
       <rect width="32" height="32" rx="7" fill="${c}"/></svg>`);

  const SOURCES = [
    { id: 'screen:0', name: 'Built-in Retina Display', kind: 'screen', displayId: '1',
      thumbnail: thumb('Northwind - Revenue', '#243358', '#3d2f63'),
      appIcon: null, width: 1920, height: 1080, thumbW: 640, thumbH: 400, scaleFactor: 2 },
    { id: 'screen:1', name: 'Studio Display', kind: 'screen', displayId: '2',
      thumbnail: thumb('Reference - Docs', '#123840', '#1d5648'),
      appIcon: null, width: 2560, height: 1440, thumbW: 640, thumbH: 360, scaleFactor: 2 },
    { id: 'window:12', name: 'Northwind - Revenue', kind: 'window', displayId: null,
      thumbnail: thumb('Dashboard', '#2b2350', '#4a2a5e'),
      appIcon: icon('#6d7bff'), width: null, height: null, thumbW: 640, thumbH: 400, scaleFactor: 1 },
    { id: 'window:31', name: 'Figma — Onboarding v4', kind: 'window', displayId: null,
      thumbnail: thumb('Onboarding v4', '#402a2a', '#63382a'),
      appIcon: icon('#f3b34a'), width: null, height: null, thumbW: 640, thumbH: 400, scaleFactor: 1 },
  ];

  const listeners = {};
  const on = (ch) => (fn) => { (listeners[ch] ||= []).push(fn); return () => {}; };
  window.__demoEmit = (ch, ...a) => (listeners[ch] || []).forEach((f) => f(...a));

  const noop = async () => true;

  window.cue = {
    info: async () => ({
      bunnyConfigured: !q.has('unconfigured'),
      libraryId: '123456',
      apiKey: q.has('unconfigured') ? '' : 'demo-key-not-real',
      cdnHostname: q.has('unconfigured') ? '' : 'vz-example.b-cdn.net',
      version: '1.0.0',
      settings: {
        micId: 'default', cameraId: 'cam', systemAudio: true, micEnabled: true,
        cameraEnabled: true, cameraShape: 'circle', cameraSize: 220, countdown: 3,
        mode: 'studio', autoUpload: true, autoCopyLink: true, saveLocalCopy: true,
        hideCursor: false,
      },
    }),
    saveSettings: async (p) => p,
    checkPermissions: async () => ({ screen: 'granted', camera: 'granted', microphone: 'granted' }),
    requestPermission: noop,
    relaunch: noop,

    listSources: async () => SOURCES,
    chooseSource: noop,
    pickRegion: async () => null,
    regionResult: noop, regionCancel: noop,

    camShow: noop, camHide: noop, camUpdate: noop,
    camBounds: async () => ({ x: 40, y: 700, width: 248, height: 248 }),
    camResizeStart: noop, camResizeEnd: noop,
    onCamConfig: on('cam-config'),

    recStart: async () => ({ id: 'demo', dir: '/tmp/demo' }),
    recChunk: noop, recStop: async () => null, recState: noop, recAction: noop,
    camPosition: noop,
    onRecConfig: on('rec-config'), onRecState: on('rec-state'),
    onRecAction: on('rec-action'), onControlShown: on('control-shown'),
    onCountdownStart: on('countdown-start'),

    onStudioLoad: on('studio-load'),
    probe: async () => ({ duration: 42.5, width: 1920, height: 1080 }),
    waveform: async () => {
      /* Studio reads w.peaks, not a bare array.
         A believable speech envelope: bursts of talking with gaps between. */
      const N = 1400, peaks = [];
      for (let i = 0; i < N; i++) {
        const t = i / N;
        const gap = (Math.sin(t * 47) + Math.sin(t * 13.7) + Math.sin(t * 5.1)) / 3;
        const env = gap > -0.28 ? 1 : 0.05;
        const detail = 0.5 + 0.5 * Math.abs(Math.sin(i * 2.3) * Math.cos(i * 0.83));
        peaks.push(Math.min(1, env * detail * (0.6 + 0.4 * Math.sin(t * 7.4))));
      }
      return { peaks };
    },
    render: async () => ({ out: '/tmp/demo/smoke-export.mp4' }),
    onRenderProgress: on('render-progress'),
    reveal: noop,
    saveAs: async () => null,

    publish: async () => {
      /* Studio renders the links from the progress stream now, not from this
         return value, so the mock has to emit the same stages the real handler
         does or the overlay comes up empty. */
      const links = {
        share: 'https://iframe.mediadelivery.net/play/123456/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        embed: 'https://iframe.mediadelivery.net/embed/123456/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        mp4:   'https://vz-example.b-cdn.net/a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/play_720p.mp4',
      };
      const guid = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
      window.__demoEmit('publish-progress', { stage: 'uploaded', pct: 100, guid, links });
      if (!q.has('encoding')) {
        window.__demoEmit('publish-progress', { stage: 'done', pct: 100, guid, links });
      }
      return { guid, links, encoded: !q.has('encoding') };
    },
    onPublishProgress: on('publish-progress'),
    saveBunny: async () => ({ ok: true, videoCount: 0, libraryId: '123456', cdnHostname: 'vz-example.b-cdn.net' }),
    setupDone: noop, setupCancel: noop,

    openTeleprompter: async () => ({ ok: true }),
    copy: noop, openExternal: noop,
    closeWindow: noop, closeStudio: noop, minimiseStudio: noop,
    hideControl: noop, showControl: noop,
  };

  /* ---- studio needs a take to open ----
     The media sits next to the injected renderer copy, so derive absolute
     paths from this script's own location rather than hardcoding a temp dir. */
  const mediaPath = (name) => decodeURIComponent(new URL('../media/' + name, location.href).pathname);

  /* Studio's preview draws whatever makeVideo() returns straight onto a canvas.
     A real <video> is the wrong tool for a screenshot: Chrome's virtual clock
     races ahead of media decoding and seeking, so the shot lands on an empty
     frame. An <img> with the handful of video properties Studio touches decodes
     once, synchronously afterwards, and always draws. */
  function stillAsVideo(w, h, duration) {
    const img = new Image();
    /* dimensions live in these vars so the source can change later without
       redefining a property, which throws once it is already installed */
    const dim = { w, h };
    Object.defineProperties(img, {
      videoWidth:  { configurable: true, get: () => dim.w },
      videoHeight: { configurable: true, get: () => dim.h },
      readyState:  { configurable: true, get: () => (img.complete ? 4 : 0) },
      duration:    { configurable: true, get: () => duration },
      paused:      { configurable: true, get: () => true },
    });
    img.__dim = dim;
    img.currentTime = 0;
    img.muted = true;
    img.play = () => Promise.resolve();
    img.pause = () => {};
    return img;
  }

  if (q.has('demo') && /studio\.html/.test(location.pathname)) {
    const realCreate = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      if (String(tag).toLowerCase() !== 'video') return realCreate(tag, ...rest);
      const el = stillAsVideo(1920, 1080, 42.5);
      /* makeVideo sets .src to "file://" + path straight after creating it, so
         map that onto the matching still. */
      Object.defineProperty(el, 'src', {
        configurable: true,
        get() { return el.getAttribute('src') || ''; },
        set(v) {
          const isCam = /camera/.test(v);
          if (isCam) { el.__dim.w = 720; el.__dim.h = 720; }
          el.setAttribute('src', 'file://' + mediaPath(isCam ? 'avatar.png' : 'frame.png'));
          el.decode().catch(() => {}).then(() => el.dispatchEvent(new Event('loadedmetadata')));
        },
      });
      return el;
    };
  }

  if (q.has('demo') && /studio\.html/.test(location.pathname)) {
    const payload = {
      id: 'demo', dir: '/tmp/demo',
      screenPath: mediaPath('screen.mp4'),
      cameraPath: mediaPath('camera.mp4'),
      micPath: null,
      screenInfo: { duration: 42.5, width: 1920, height: 1080 },
      cameraInfo: { duration: 42.5, width: 720, height: 720 },
      micInfo: null,
      camTrack: [],
      mode: 'studio',
      crop: null,
      displayScale: 2,
      durationMs: 42500,
    };
    /* the page registers its listener at the end of studio.js, so wait for the
       document to finish rather than racing it */
    const fire = () => {
      window.__demoEmit('studio-load', payload);
      /* The publish overlay is opened by the real click handler, not by a
         progress event, so drive the button. render() and publish() are both
         mocked above, so this reaches the finished state without touching
         ffmpeg or Bunny. */
      if (q.has('publish')) {
        setTimeout(() => {
          const b = document.getElementById('publishBtn');
          if (b) b.click();
        }, 200);
      }
    };
    if (document.readyState === 'complete') setTimeout(fire, 60);
    else window.addEventListener('load', () => setTimeout(fire, 60));
  }

  /* recbar shows its controls only once main sends the take config */
  if (q.has('demo') && /recbar\.html/.test(location.pathname)) {
    const fire = () => {
      window.__demoEmit('rec-config', { mode: 'studio', hasCamera: true, hasMic: true });
      window.__demoEmit('rec-state', { recording: true, paused: false, elapsed: Number(q.get('elapsed') || 47000) });
    };
    if (document.readyState === 'complete') setTimeout(fire, 60);
    else window.addEventListener('load', () => setTimeout(fire, 60));
  }

  /* countdown, parked on one number so the gif can step through 3, 2, 1.
     Its own setInterval has to be neutered first: under Chrome's virtual clock
     the whole count runs to zero long before the screenshot, leaving an empty
     ring. */
  if (q.has('demo') && /countdown\.html/.test(location.pathname)) {
    window.setInterval = () => 0;
    const fire = () => window.__demoEmit('countdown-start', Number(q.get('count') || 3));
    if (document.readyState === 'complete') setTimeout(fire, 40);
    else window.addEventListener('load', () => setTimeout(fire, 40));
  }

  /* the camera bubble waits for its config too */
  if (q.has('demo') && /camera\.html/.test(location.pathname)) {
    /* A canvas captureStream never composites under headless, so the bubble
       photographs empty. The <video> is transparent until frames arrive, so
       painting the stand-in as its background shows through, and the existing
       clip-path rounds it exactly the way a real frame would be rounded. */
    const st = document.createElement('style');
    st.textContent = `#frame video {
      background-image: url("${new URL('../media/avatar.png', location.href).href}");
      background-size: cover; background-position: center;
    }`;
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(st));
    if (document.readyState !== 'loading') document.head.appendChild(st);

    const fire = () => window.__demoEmit('cam-config', { shape: 'circle', deviceId: 'cam', size: 220 });
    if (document.readyState === 'complete') setTimeout(fire, 60);
    else window.addEventListener('load', () => setTimeout(fire, 60));
  }

  /* control.html asks for real devices; headless Chrome has none. */
  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.enumerateDevices = async () => ([
    { kind: 'videoinput', deviceId: 'cam', label: 'FaceTime HD Camera' },
    { kind: 'audioinput', deviceId: 'default', label: 'MacBook Pro Microphone' },
    { kind: 'audioinput', deviceId: 'ext',     label: 'Shure MV7' },
  ]);
  /* The bubble puts a real MediaStream into a <video>, so hand it a canvas
     stream painted with the illustrated stand-in. */
  navigator.mediaDevices.getUserMedia = async () => {
    const c = document.createElement('canvas');
    c.width = 720; c.height = 720;
    const ctx = c.getContext('2d');
    let img = null;
    try {
      img = new Image();
      img.src = new URL('../media/avatar.png', location.href).href;
      await img.decode();
    } catch (_) { img = null; }
    const paint = () => {
      if (img) ctx.drawImage(img, 0, 0, 720, 720);
      else { ctx.fillStyle = '#2a2620'; ctx.fillRect(0, 0, 720, 720); }
      requestAnimationFrame(paint);
    };
    paint();
    /* a live frame rate, not captureStream(0): a zero-fps track only emits a
       frame when you ask for one, and the bubble would sit empty */
    return c.captureStream(30);
  };
})();
