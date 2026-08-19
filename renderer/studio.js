/* Smoke Studio - preview compositor and editor.
   The canvas preview mirrors exactly what main/render.js will produce with
   ffmpeg, so what you arrange here is what gets published. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

/* BACKGROUNDS, gradientLine and toCss come from backgrounds.js */

const S = {
  session: null,
  screen: null,          // <video>
  mic: null,             // <audio>, the voice track
  camera: null,          // <video>
  duration: 0,
  playing: false,
  t: 0,
  /* The recording as a list of kept ranges in source time. One segment means
     a plain trim; more than one means something was cut out of the middle. */
  segments: [],
  selectedSeg: -1,
  zoom: 1,          // 1 fits the whole recording
  viewStart: 0,
  wave: null,
  canvas: { w: 1920, h: 1080 },
  /* Both layers are just a rect on the canvas plus an optional crop of their
     own source. A layout preset only sets the rects, so you can keep dragging
     and resizing afterwards without leaving the preset. */
  layoutId: 'bubble',
  camSize: 'M',
  screen_: { visible: true, rect: { x: 0, y: 0, w: 1, h: 1 }, crop: null },
  camera_: {
    visible: true, rect: { x: 0.74, y: 0.68, w: 0.22, h: 0.22 },
    crop: null, shape: 'circle', mirror: true, useMotion: false,
  },
  sel: null,          // 'screen' | 'camera' | null
  cropping: null,     // 'screen' | 'camera' | null
  pendingCrop: null,  // canvas-pixel rect being dragged in crop mode
  /* Where each layer's source actually landed on the canvas this frame. Crop
     boxes are drawn in canvas space, so they can only be mapped back to source
     pixels with the real geometry: the screen is letterboxed inside its rect,
     the camera is cover-cropped and may be mirrored. */
  geom: { screen: null, camera: null },
  background: { type: 'none', colors: ['#08090b'], angle: 135, padding: 0, radius: 0 },
  audio: { voice: 'clean', micGain: 1, systemGain: 0.7 },
  zooms: [],
  blurs: [],
  selectedZoom: -1,
  selectedBlur: -1,
  mode: 'aim-off',       // aim-off | aim-zoom | draw-blur
  rafId: null,
};

const cv = $('#canvas');
const ctx = cv.getContext('2d');

// offscreen buffer for hiding regions without sampling their surroundings
const scratch = document.createElement('canvas');
const sctx = scratch.getContext('2d', { willReadFrequently: true });

/* Mesh gradients are computed at low resolution and scaled up. The blend has
   no hard edges, so nothing is lost and it stays cheap to redraw every frame. */
const meshCache = new Map();
function meshCanvas(points) {
  const key = points.map((p) => `${p.x},${p.y},${p.c}`).join('|');
  if (meshCache.has(key)) return meshCache.get(key);
  const w = 96, h = 54;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  const img = cx.createImageData(w, h);
  img.data.set(meshPixels(points, w, h));
  cx.putImageData(img, 0, 0);
  if (meshCache.size > 40) meshCache.clear();
  meshCache.set(key, c);
  return c;
}

/* Shared by the preview and the export so both hide equally well. A blur that
   only softens is useless: at full strength the radius has to be a large
   fraction of the region itself. */
function blurRadiusPx(w, h, strength) {
  const s = Math.max(0, Math.min(100, strength ?? 70)) / 100;
  const base = Math.min(w, h);
  return Math.max(4, Math.round(base * (0.04 + s * 0.30)));
}

/* ---------------- helpers ---------------- */
function fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function makeVideo(src) {
  const v = document.createElement('video');
  v.src = 'file://' + src;
  v.preload = 'auto';
  v.muted = true;
  v.playsInline = true;
  return v;
}

/* ---------------- window controls ---------------- */
let busy = false;          // a render or upload is in flight

function closeStudio(force) {
  if (busy && !force) {
    const go = window.confirm('This recording is still being published. Close anyway and lose the link?');
    if (!go) return;
  }
  pause();
  cue.closeStudio();
}
$('#closeBtn').onclick = closeStudio;
$('#minBtn').onclick = () => cue.minimiseStudio();

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'w') { e.preventDefault(); closeStudio(); }
});

const help = {
  open() { $('#help').classList.add('on'); },
  close() { $('#help').classList.remove('on'); },
  toggle() { $('#help').classList.toggle('on'); },
};
$('#helpBtn').onclick = () => help.toggle();
$('#helpClose').onclick = () => help.close();

/* ---------------- load ---------------- */
cue.onStudioLoad(async (payload) => {
  /* A second take reuses this window, so every edit from the previous one has
     to be cleared or the old zooms and blurs bleed into the new recording. */
  S.zooms = [];
  S.blurs = [];
  S.selectedZoom = -1;
  S.selectedBlur = -1;
  S.mode = 'aim-off';
  S.background = { type: 'none', colors: ['#08090b'], angle: 135, padding: 0, radius: 0 };
  S.screen_ = { visible: true, rect: { x: 0, y: 0, w: 1, h: 1 }, crop: null };
  S.camera_ = { visible: true, rect: { x: 0.74, y: 0.68, w: 0.22, h: 0.22 }, crop: null, shape: 'circle', mirror: true, useMotion: false };
  S.sel = null; S.cropping = null; S.pendingCrop = null; S.camSize = 'M';
  S.audio = { voice: 'clean', micGain: 1, systemGain: 0.7 };
  S.segments = [];
  S.selectedSeg = -1;
  S.zoom = 1;
  S.viewStart = 0;
  S.wave = null;
  $('#micGain').value = 100; $('#micGainVal').textContent = '100%';
  $('#sysGain').value = 70; $('#sysGainVal').textContent = '70%';
  S.playing = false;
  for (const v of [S.screen, S.camera, S.mic]) { if (v) { try { v.pause(); } catch (_) {} } }
  if (S.mic) { try { S.mic.pause(); } catch (_) {} }
  S.screen = null;
  S.camera = null;
  S.mic = null;
  $('#padding').value = 0; $('#paddingVal').textContent = '0%';
  setRadius(0);
  $$('#bgGrid .bg').forEach((x) => x.classList.remove('on'));
  renderZoomList();
  renderBlurList();
  pub.close();

  S.session = payload;

  if (payload.screenPath) S.screen = makeVideo(payload.screenPath);
  if (payload.cameraPath) S.camera = makeVideo(payload.cameraPath);
  // the voice lives in its own file now, so the preview needs it too
  if (payload.micPath) { S.mic = new Audio('file://' + payload.micPath); S.mic.preload = 'auto'; }

  const waits = [];
  for (const v of [S.screen, S.camera]) {
    if (!v) continue;
    waits.push(new Promise((r) => {
      v.addEventListener('loadedmetadata', r, { once: true });
      v.addEventListener('error', r, { once: true });
    }));
  }
  await Promise.all(waits);

  // ffprobe is authoritative; the media element can report Infinity on webm
  const probed = Math.max(
    (payload.screenInfo && payload.screenInfo.duration) || 0,
    (payload.cameraInfo && payload.cameraInfo.duration) || 0,
  );
  S.duration = probed > 0 ? probed : (payload.durationMs || 0) / 1000;
  S.segments = [{ start: 0, end: S.duration }];
  S.selectedSeg = -1;
  S.zoom = 1;
  S.viewStart = 0;
  $('#zoomVal').textContent = '100%';

  // open on the layout that matches what was actually captured
  const startPreset =
    (!S.screen && S.camera) ? 'camera' :
    (S.camera ? 'bubble' : 'screen');
  applyPreset(LAYOUTS.find((p) => p.id === startPreset) || LAYOUTS[0]);

  // start the bubble where it sat while recording, if we tracked it
  const hasTrack = Array.isArray(payload.camTrack) && payload.camTrack.length > 1;
  if (hasTrack && S.camera_.visible && startPreset === 'bubble') {
    const f = payload.camTrack[0];
    const w = clamp(f.w, 0.08, 0.5);
    S.camera_.rect = {
      x: clamp(f.x - w / 2, 0, 1 - w),
      y: clamp(f.y - w / 2, 0, 1 - w),
      w,
      h: w * (S.canvas.w / S.canvas.h),
    };
  }

  $('#ttotal').textContent = fmt(S.duration);
  $('#durtext').textContent = fmt(S.duration);
  $('#durchip').className = 'chip accent';

  syncLayoutUI();
  syncAudioUI();
  applyPreviewLevels();
  drawTimeline();
  loadWaveform(payload);
  seek(0);
  loop();
});

/* ---------------- preview compositor ---------------- */
function activeZoom(t) {
  const RAMP = 0.45;
  let z = 1, fx = 0.5, fy = 0.5;
  // cropping is done against the un-zoomed frame, so what you draw is what you get
  if (S.cropping) return { z, fx, fy };
  for (const s of S.zooms) {
    if (t < s.start || t > s.end) continue;
    const inEnd = Math.min(s.start + RAMP, (s.start + s.end) / 2);
    const outStart = Math.max(s.end - RAMP, (s.start + s.end) / 2);
    let r = 1;
    if (t < inEnd) r = (t - s.start) / Math.max(0.001, inEnd - s.start);
    else if (t > outStart) r = 1 - (t - outStart) / Math.max(0.001, s.end - outStart);
    r = clamp(r, 0, 1);
    z += (s.scale - 1) * r;
    fx += (s.x - 0.5) * r;
    fy += (s.y - 0.5) * r;
  }
  return { z, fx, fy };
}

/* Pixel rects, resolved exactly the way render.js will resolve them. */
function padPx() {
  return Math.round((S.background.padding / 100) * S.canvas.w);
}
function screenBox() {
  return toPixels(S.screen_.rect, S.canvas, padPx());
}
function camBox() {
  const box = toPixels(S.camera_.rect, S.canvas, padPx());
  return S.camera_.shape === 'circle' ? squareForCircle(box) : box;
}
function layerBox(which) {
  return which === 'camera' ? camBox() : screenBox();
}

function motionAt(t) {
  const track = S.session && S.session.camTrack;
  if (!track || track.length < 2) return null;
  const ms = t * 1000;
  let a = track[0];
  let b = track[track.length - 1];
  for (let i = 0; i < track.length - 1; i++) {
    if (track[i].t <= ms && track[i + 1].t >= ms) { a = track[i]; b = track[i + 1]; break; }
  }
  const span = Math.max(1, b.t - a.t);
  const k = clamp((ms - a.t) / span, 0, 1);
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

function draw() {
  const W = S.canvas.w, H = S.canvas.h;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }

  const bg = S.background;

  // background plate, resolved exactly the way render.js will
  ctx.clearRect(0, 0, W, H);
  const stops = bg.colors && bg.colors.length ? bg.colors : ['#08090b'];
  if (bg.type === 'mesh' && bg.points) {
    // computed small and scaled up; the blend is smooth so nothing is lost
    ctx.drawImage(meshCanvas(bg.points), 0, 0, W, H);
  } else if (bg.type === 'gradient' && stops.length >= 2) {
    const { x0, y0, x1, y1 } = gradientLine(bg.angle, W, H);
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c));
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = bg.type === 'none' ? '#08090b' : stops[0];
  }
  ctx.fillRect(0, 0, W, H);

  // screen layer, contained inside its rect
  if (S.screen && S.screen_.visible) {
    const vw = S.screen.videoWidth || 1920;
    const vh = S.screen.videoHeight || 1080;

    // the recording's own region crop is the base; a Studio crop nests inside it
    let baseX = 0, baseY = 0, baseW = vw, baseH = vh;
    const rec = S.session && S.session.crop;
    if (rec && rec.nw) { baseX = rec.nx * vw; baseY = rec.ny * vh; baseW = rec.nw * vw; baseH = rec.nh * vh; }
    let sx = baseX, sy = baseY, sw = baseW, sh = baseH;
    const c = S.screen_.crop;
    if (c) { sx = baseX + c.nx * baseW; sy = baseY + c.ny * baseH; sw = baseW * c.nw; sh = baseH * c.nh; }

    const { z, fx, fy } = activeZoom(S.t);
    const zw = sw / z, zh = sh / z;
    const zx = clamp(sx + fx * sw - zw / 2, sx, sx + sw - zw);
    const zy = clamp(sy + fy * sh - zh / 2, sy, sy + sh - zh);

    const box = screenBox();
    const srcAspect = zw / zh;
    let dw = box.w, dh = box.h;
    if (srcAspect > box.w / box.h) dh = box.w / srcAspect;
    else dw = box.h * srcAspect;
    const dx = box.x + (box.w - dw) / 2;
    const dy = box.y + (box.h - dh) / 2;

    S.geom.screen = { dx, dy, dw, dh, sx: zx, sy: zy, sw: zw, sh: zh, mirror: false, baseX, baseY, baseW, baseH };

    ctx.save();
    const rp = radiusPx();
    if (rp > 0) { roundRect(ctx, box.x, box.y, box.w, box.h, rp); ctx.clip(); }
    if (S.screen.readyState >= 2) {
      try { ctx.drawImage(S.screen, zx, zy, zw, zh, dx, dy, dw, dh); } catch (_) {}
    }
    ctx.restore();
  } else {
    S.geom.screen = null;
  }

  /* Hidden regions. Drawn through an offscreen buffer so the effect samples
     only the region itself; filtering the canvas onto itself pulled in
     surrounding pixels and left a soft, still-readable edge. */
  for (const b of S.blurs) {
    if (S.t < b.start || S.t > b.end) continue;
    const bx = Math.round(b.x * W), by = Math.round(b.y * H);
    const bw = Math.max(2, Math.round(b.w * W)), bh = Math.max(2, Math.round(b.h * H));
    const strength = b.strength ?? 70;
    const style = b.style || 'blur';

    if (style === 'solid') {
      ctx.save();
      ctx.fillStyle = '#0b0d12';
      ctx.fillRect(bx, by, bw, bh);
      ctx.restore();
    } else if (style === 'pixelate') {
      // bigger blocks as strength rises
      const blocks = Math.max(2, Math.round(24 - (strength / 100) * 21));
      const tw = Math.max(1, blocks), th = Math.max(1, Math.round(blocks * (bh / bw)) || 1);
      scratch.width = tw; scratch.height = th;
      sctx.imageSmoothingEnabled = true;
      sctx.drawImage(cv, bx, by, bw, bh, 0, 0, tw, th);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(scratch, 0, 0, tw, th, bx, by, bw, bh);
      ctx.restore();
    } else {
      const radius = blurRadiusPx(bw, bh, strength);
      scratch.width = bw; scratch.height = bh;
      sctx.filter = 'none';
      sctx.clearRect(0, 0, bw, bh);
      sctx.drawImage(cv, bx, by, bw, bh, 0, 0, bw, bh);
      ctx.save();
      ctx.filter = `blur(${radius}px)`;
      // clip so the blur cannot smear outside the region
      ctx.beginPath();
      ctx.rect(bx, by, bw, bh);
      ctx.clip();
      ctx.drawImage(scratch, bx, by);
      ctx.restore();
      ctx.filter = 'none';
    }

    if (S.blurs.indexOf(b) === S.selectedBlur) {
      ctx.save();
      ctx.strokeStyle = '#f3b34a';
      ctx.lineWidth = 3;
      ctx.strokeRect(bx, by, bw, bh);
      ctx.restore();
    }
  }

  // camera layer, covering its rect
  if (S.camera && S.camera_.visible && S.camera.readyState >= 2) {
    const box = camBox();
    if (S.camera_.useMotion) {
      const m = motionAt(S.t);
      if (m) { box.x = m.x * W - box.w / 2; box.y = m.y * H - box.h / 2; }
    }

    ctx.save();
    clipShape(box, S.camera_.shape);

    // the visible part of the source after the framing crop
    const cw = S.camera.videoWidth || 1280;
    const ch = S.camera.videoHeight || 720;
    const cc = S.camera_.crop;
    const sx = cc ? cc.nx * cw : 0;
    const sy = cc ? cc.ny * ch : 0;
    const sw = cc ? cc.nw * cw : cw;
    const sh = cc ? cc.nh * ch : ch;

    // cover-fit into the box
    const scale = Math.max(box.w / sw, box.h / sh);
    const dw = sw * scale, dh = sh * scale;
    const dx = box.x + (box.w - dw) / 2;
    const dy = box.y + (box.h - dh) / 2;

    S.geom.camera = { dx, dy, dw, dh, sx, sy, sw, sh, mirror: S.camera_.mirror, baseX: 0, baseY: 0, baseW: cw, baseH: ch };

    if (S.camera_.mirror) {
      ctx.translate(box.x + box.w / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(box.x + box.w / 2), 0);
    }
    try { ctx.drawImage(S.camera, sx, sy, sw, sh, dx, dy, dw, dh); } catch (_) {}
    ctx.restore();
  } else {
    S.geom.camera = null;
  }

  // selection handles, drawn last so they sit above both layers
  if (S.sel && !S.cropping) drawHandles(layerBox(S.sel), S.sel === 'camera' ? S.camera_.shape : 'rect');

  /* Crop mode: dim everything outside the kept box by painting four rects
     around it. Clearing the middle and redrawing would copy back pixels that
     have already been dimmed. */
  if (S.cropping) {
    const b = layerBox(S.cropping);
    const r = S.pendingCrop;
    ctx.save();
    ctx.fillStyle = 'rgba(5,6,9,.62)';
    if (r && r.w > 2 && r.h > 2) {
      ctx.fillRect(b.x, b.y, b.w, r.y - b.y);                          // above
      ctx.fillRect(b.x, r.y + r.h, b.w, (b.y + b.h) - (r.y + r.h));    // below
      ctx.fillRect(b.x, r.y, r.x - b.x, r.h);                          // left
      ctx.fillRect(r.x + r.w, r.y, (b.x + b.w) - (r.x + r.w), r.h);    // right

      ctx.strokeStyle = '#6d7bff';
      ctx.lineWidth = 3;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      // rule of thirds inside the keep area, the way any framing tool shows it
      ctx.strokeStyle = 'rgba(255,255,255,.28)';
      ctx.lineWidth = 1.5;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(r.x + (r.w * i) / 3, r.y);
        ctx.lineTo(r.x + (r.w * i) / 3, r.y + r.h);
        ctx.moveTo(r.x, r.y + (r.h * i) / 3);
        ctx.lineTo(r.x + r.w, r.y + (r.h * i) / 3);
        ctx.stroke();
      }
    } else {
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.strokeStyle = '#6d7bff';
      ctx.lineWidth = 3;
      ctx.setLineDash([12, 9]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
    }
    ctx.restore();
  }

  // zoom aim marker
  if (S.mode === 'aim-zoom' && S.selectedZoom >= 0) {
    const z = S.zooms[S.selectedZoom];
    ctx.save();
    ctx.strokeStyle = '#6d7bff';
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    const rw = W / z.scale, rh = H / z.scale;
    ctx.strokeRect(z.x * W - rw / 2, z.y * H - rh / 2, rw, rh);
    ctx.restore();
  }
}

function clipShape(box, shape) {
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, box.w / 2, box.h / 2, 0, 0, Math.PI * 2);
    ctx.clip();
  } else if (shape === 'rounded') {
    roundRect(ctx, box.x, box.y, box.w, box.h, Math.min(box.w, box.h) * 0.10);
    ctx.clip();
  }
}

/* Eight handles plus an outline, the way any editor signals "you can move and
   resize this". Sized in canvas pixels so they stay constant on screen. */
const HANDLE = 22;
function handlePoints(b) {
  return [
    { id: 'nw', x: b.x,             y: b.y },
    { id: 'n',  x: b.x + b.w / 2,   y: b.y },
    { id: 'ne', x: b.x + b.w,       y: b.y },
    { id: 'e',  x: b.x + b.w,       y: b.y + b.h / 2 },
    { id: 'se', x: b.x + b.w,       y: b.y + b.h },
    { id: 's',  x: b.x + b.w / 2,   y: b.y + b.h },
    { id: 'sw', x: b.x,             y: b.y + b.h },
    { id: 'w',  x: b.x,             y: b.y + b.h / 2 },
  ];
}

function drawHandles(b, shape) {
  ctx.save();
  ctx.strokeStyle = '#6d7bff';
  ctx.lineWidth = 3;
  if (shape === 'circle') {
    ctx.beginPath();
    ctx.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, b.h / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
  for (const p of handlePoints(b)) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, HANDLE / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#6d7bff';
    ctx.stroke();
  }
  ctx.restore();
}

function hitHandle(b, px, py) {
  for (const p of handlePoints(b)) {
    if (Math.hypot(px - p.x, py - p.y) <= HANDLE) return p.id;
  }
  return null;
}

function insideBox(b, px, py) {
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
}

/* Resize a normalised rect by one handle, in canvas pixel space. */
function resizeRect(rect, handle, dxN, dyN, keepSquare) {
  const r = { ...rect };
  if (handle.includes('w')) { r.x += dxN; r.w -= dxN; }
  if (handle.includes('e')) { r.w += dxN; }
  if (handle.includes('n')) { r.y += dyN; r.h -= dyN; }
  if (handle.includes('s')) { r.h += dyN; }
  if (keepSquare) {
    // a circle stays round: follow the larger change on both axes
    const aspect = S.canvas.w / S.canvas.h;
    const side = Math.max(r.w, r.h * (1 / aspect));
    if (handle.includes('w')) r.x = rect.x + rect.w - side;
    if (handle.includes('n')) r.y = rect.y + rect.h - side * aspect;
    r.w = side;
    r.h = side * aspect;
  }
  r.w = Math.max(0.05, r.w);
  r.h = Math.max(0.05, r.h);
  r.x = clamp(r.x, -0.5, 1.5 - r.w);
  r.y = clamp(r.y, -0.5, 1.5 - r.h);
  return r;
}

function roundRect(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

/* ---------------- playback ---------------- */
function loop() {
  if (S.playing) {
    const v = S.screen || S.camera;
    if (v) {
      S.t = v.currentTime;
      const cur = segmentAt(S.t);
      if (cur === -1) {
        // landed in a removed region: jump to the next kept moment
        const to = nextPlayable(S.t);
        if (to == null) { pause(); seek(S.segments[0].start); }
        else seek(to);
      } else if (S.t >= S.segments[cur].end - 0.02) {
        const to = nextPlayable(S.segments[cur].end + 0.01);
        if (to == null) { pause(); seek(S.segments[0].start); }
        else seek(to);
      }
    }
    movePlayhead();
  }
  draw();
  S.rafId = requestAnimationFrame(loop);
}

function play() {
  if (segmentAt(S.t) === -1) {
    const to = nextPlayable(S.t);
    seek(to == null ? S.segments[0].start : to);
  }
  S.playing = true;
  for (const v of [S.screen, S.camera, S.mic]) if (v) v.play().catch(() => {});
  if (S.screen) S.screen.muted = false;
  else if (S.camera) S.camera.muted = false;
  $('#play').innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></svg>';
}

function pause() {
  S.playing = false;
  for (const v of [S.screen, S.camera, S.mic]) if (v) v.pause();
  $('#play').innerHTML = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
}

function seek(t) {
  S.t = clamp(t, 0, S.duration);
  for (const v of [S.screen, S.camera, S.mic]) {
    if (v) { try { v.currentTime = S.t; } catch (_) {} }
  }
  movePlayhead();
}

$('#play').onclick = () => (S.playing ? pause() : play());
$('#toStart').onclick = () => seek(S.segments[0].start);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); S.playing ? pause() : play(); }
  if (e.key === 'ArrowLeft') seek(S.t - (e.shiftKey ? 1 : 1 / 30));
  if (e.key === 'ArrowRight') seek(S.t + (e.shiftKey ? 1 : 1 / 30));
  // Escape backs out of whatever is currently active, one step at a time
  if (e.key === 'Escape') {
    if ($('#help').classList.contains('on')) return help.close();
    if (S.cropping) return setCropMode(null);
    if (S.mode !== 'aim-off') return setMode('aim-off');
    if (S.sel) { S.sel = null; syncSelectionUI(); return; }
  }
  if (e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); splitAtPlayhead(); }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    if (S.selectedZoom >= 0) { S.zooms.splice(S.selectedZoom, 1); S.selectedZoom = -1; renderZoomList(); drawTimeline(); }
    else if (S.selectedBlur >= 0) { S.blurs.splice(S.selectedBlur, 1); S.selectedBlur = -1; renderBlurList(); syncBlurEdit(); drawTimeline(); }
    else if (S.selectedSeg >= 0) deleteSelectedSegment();
  }
});

/* ---------------- timeline ----------------
   The recording is a list of segments in source time. Trimming moves the outer
   edges, splitting divides one segment in two, and deleting removes one from
   the middle. Playback skips whatever is no longer between segments, so the
   preview matches the export without rendering anything.

   The view has its own zoom and scroll so you can find a cut point precisely
   on a long take. Zoom is a factor: 1 fits the whole recording. */

const timeline = $('#timeline');
const wavesCv = $('#waves');
const wctx = wavesCv.getContext('2d');

function tlRect() { return timeline.getBoundingClientRect(); }

// visible window in source seconds
function viewSpan() { return S.duration / S.zoom; }
function viewEnd() { return Math.min(S.duration, S.viewStart + viewSpan()); }

function tToPct(t) {
  const span = viewSpan() || 1;
  return ((t - S.viewStart) / span) * 100;
}
function xToT(clientX) {
  const r = tlRect();
  const f = (clientX - r.left) / r.width;
  return clamp(S.viewStart + f * viewSpan(), 0, S.duration);
}

function clampView() {
  const span = viewSpan();
  S.viewStart = clamp(S.viewStart, 0, Math.max(0, S.duration - span));
}

function setZoom(z, anchorT) {
  const prev = S.zoom;
  S.zoom = clamp(z, 1, 60);
  if (S.zoom === prev) return;
  // keep the anchor point under the cursor where it was
  const a = anchorT != null ? anchorT : S.t;
  S.viewStart = a - (a - S.viewStart) * (prev / S.zoom);
  clampView();
  $('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  drawTimeline();
}

/* ---------- segments ---------- */
function totalKept() {
  return S.segments.reduce((n, s) => n + (s.end - s.start), 0);
}
function segmentAt(t) {
  return S.segments.findIndex((s) => t >= s.start && t <= s.end);
}
/* The next playable moment at or after t, skipping anything cut out. */
function nextPlayable(t) {
  for (const s of S.segments) {
    if (t < s.start) return s.start;
    if (t <= s.end) return t;
  }
  return null;
}

function splitAtPlayhead() {
  const i = segmentAt(S.t);
  if (i === -1) return;
  const s = S.segments[i];
  const MIN = 0.15;
  if (S.t - s.start < MIN || s.end - S.t < MIN) {
    toast('Move the playhead further from the edge to split');
    return;
  }
  S.segments.splice(i, 1, { start: s.start, end: S.t }, { start: S.t, end: s.end });
  S.selectedSeg = i + 1;
  drawTimeline();
  toast('Split. Select a piece and press Delete to remove it.');
}

function deleteSelectedSegment() {
  if (S.selectedSeg < 0 || S.segments.length < 2) {
    if (S.segments.length < 2) toast('Split the recording first, then delete a piece');
    return;
  }
  S.segments.splice(S.selectedSeg, 1);
  S.selectedSeg = -1;
  drawTimeline();
  const to = nextPlayable(S.t);
  if (to == null) seek(S.segments[0].start);
  else seek(to);
  toast('Removed');
}

/* ---------- waveform ---------- */
async function loadWaveform(payload) {
  S.wave = null;
  const src = payload.micPath || payload.screenPath;
  if (!src) return drawTimeline();
  try {
    const w = await cue.waveform(src);
    if (w && w.peaks && w.peaks.length) S.wave = w;
  } catch (_) {}
  drawTimeline();
}

function drawWaveform() {
  const r = tlRect();
  const W = Math.max(1, Math.round(r.width));
  const H = Math.max(1, Math.round(r.height));
  const dpr = window.devicePixelRatio || 1;
  if (wavesCv.width !== W * dpr || wavesCv.height !== H * dpr) {
    wavesCv.width = W * dpr;
    wavesCv.height = H * dpr;
  }
  wctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  wctx.clearRect(0, 0, W, H);
  if (!S.wave || !S.duration) return;

  const peaks = S.wave.peaks;
  const mid = H / 2;
  const span = viewSpan();
  wctx.fillStyle = 'rgba(154, 163, 178, .55)';

  for (let x = 0; x < W; x++) {
    const t = S.viewStart + (x / W) * span;
    const i = Math.floor((t / S.duration) * peaks.length);
    if (i < 0 || i >= peaks.length) continue;
    // take the loudest peak covered by this column so nothing disappears when zoomed out
    const iEnd = Math.min(peaks.length, Math.max(i + 1, Math.floor((((t + span / W) / S.duration)) * peaks.length)));
    let p = 0;
    for (let k = i; k < iEnd; k++) if (peaks[k] > p) p = peaks[k];
    const h = Math.max(1, p * (H * 0.78));
    wctx.fillRect(x, mid - h / 2, 1, h);
  }
}

/* ---------- ruler ---------- */
function niceStep(span) {
  const target = span / 8;
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const s of steps) if (s >= target) return s;
  return 600;
}

function drawRuler() {
  const ruler = $('#ruler');
  const span = viewSpan();
  const step = niceStep(span);
  const first = Math.ceil(S.viewStart / step) * step;
  let html = '';
  for (let t = first; t <= viewEnd() + 0.0001; t += step) {
    const pct = tToPct(t);
    if (pct < -2 || pct > 102) continue;
    html += `<span class="tick" style="left:${pct}%"><i></i>${fmtTick(t, step)}</span>`;
  }
  ruler.innerHTML = html;
}

function fmtTick(t, step) {
  if (step < 1) return t.toFixed(1) + 's';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------- draw ---------- */
function movePlayhead() {
  const pct = tToPct(S.t);
  const ph = $('#playhead');
  ph.style.left = pct + '%';
  ph.style.display = (pct < 0 || pct > 100) ? 'none' : 'block';
  $('#tnow').textContent = fmt(S.t);
}

function drawTimeline() {
  clampView();
  drawWaveform();
  drawRuler();

  // cut regions are everything not covered by a segment
  const cuts = [];
  let cursor = 0;
  for (const s of S.segments) {
    if (s.start > cursor) cuts.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < S.duration) cuts.push({ start: cursor, end: S.duration });

  timeline.querySelectorAll('.cut,.segblock,.tlseg').forEach((el) => el.remove());

  for (const c of cuts) {
    const el = document.createElement('div');
    el.className = 'cut';
    el.style.left = tToPct(c.start) + '%';
    el.style.width = Math.max(0, tToPct(c.end) - tToPct(c.start)) + '%';
    timeline.appendChild(el);
  }

  S.segments.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'segblock' + (i === S.selectedSeg ? ' sel' : '');
    el.style.left = tToPct(s.start) + '%';
    el.style.width = Math.max(0.4, tToPct(s.end) - tToPct(s.start)) + '%';
    el.dataset.i = String(i);
    if (S.segments.length > 1) {
      el.innerHTML = `<span class="segname">${i + 1}</span>`;
    }
    el.addEventListener('mousedown', (ev) => {
      if (ev.target.closest('.tlseg')) return;
      ev.stopPropagation();
      S.selectedSeg = Number(el.dataset.i);
      S.selectedZoom = -1;
      S.selectedBlur = -1;
      drawTimeline();
      syncCutButtons();
      // clicking a piece still scrubs to where you clicked
      seek(xToT(ev.clientX));
      const scrub = (e2) => seek(xToT(e2.clientX));
      const up = () => {
        window.removeEventListener('mousemove', scrub);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', scrub);
      window.addEventListener('mouseup', up);
    });
    timeline.appendChild(el);
  });

  // trim handles sit on the outer edges of the kept range
  const firstS = S.segments[0];
  const lastS = S.segments[S.segments.length - 1];
  $('#trimL').style.left = `calc(${tToPct(firstS.start)}% - 0px)`;
  $('#trimR').style.left = `calc(${tToPct(lastS.end)}% - 10px)`;

  S.zooms.forEach((z, i) => timeline.appendChild(effectEl(z, i, 'zoom')));
  S.blurs.forEach((b, i) => timeline.appendChild(effectEl(b, i, 'blur')));

  $('#durtext').textContent = fmt(totalKept());
  $('#ttotal').textContent = fmt(totalKept());
  movePlayhead();
  syncCutButtons();
}

function syncCutButtons() {
  $('#splitBtn').disabled = segmentAt(S.t) === -1;
  $('#deleteSegBtn').disabled = S.selectedSeg < 0 || S.segments.length < 2;
}

/* zoom and blur markers, unchanged behaviour but positioned in view space */
function effectEl(seg, i, kind) {
  const el = document.createElement('div');
  el.className = `tlseg ${kind}` + ((kind === 'zoom' ? S.selectedZoom : S.selectedBlur) === i ? ' sel' : '');
  el.style.left = tToPct(seg.start) + '%';
  el.style.width = Math.max(1.2, tToPct(seg.end) - tToPct(seg.start)) + '%';
  el.textContent = kind === 'zoom' ? `${seg.scale.toFixed(1)}x` : (seg.style === 'pixelate' ? 'Pixel' : seg.style === 'solid' ? 'Solid' : 'Blur');
  el.innerHTML += '<div class="grab l"></div><div class="grab r"></div>';

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    if (kind === 'zoom') { S.selectedZoom = i; S.selectedBlur = -1; renderZoomList(); syncZoomEdit(); }
    else { S.selectedBlur = i; S.selectedZoom = -1; renderBlurList(); syncBlurEdit(); }
    S.selectedSeg = -1;
    drawTimeline();

    const grab = e.target.classList.contains('grab') ? (e.target.classList.contains('l') ? 'l' : 'r') : 'move';
    const t0 = xToT(e.clientX);
    const orig = { start: seg.start, end: seg.end };

    const move = (ev) => {
      const dt = xToT(ev.clientX) - t0;
      if (grab === 'move') {
        const len = orig.end - orig.start;
        seg.start = clamp(orig.start + dt, 0, S.duration - len);
        seg.end = seg.start + len;
      } else if (grab === 'l') {
        seg.start = clamp(orig.start + dt, 0, seg.end - 0.2);
      } else {
        seg.end = clamp(orig.end + dt, seg.start + 0.2, S.duration);
      }
      drawTimeline();
      if (kind === 'zoom') syncZoomEdit();
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  return el;
}

/* scrub on empty timeline space */
timeline.addEventListener('mousedown', (e) => {
  if (e.target.closest('.trim-handle') || e.target.closest('.tlseg') || e.target.closest('.segblock')) return;
  S.selectedSeg = -1;
  drawTimeline();
  const scrub = (ev) => seek(xToT(ev.clientX));
  scrub(e);
  const up = () => {
    window.removeEventListener('mousemove', scrub);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', scrub);
  window.addEventListener('mouseup', up);
});

/* wheel: zoom with a modifier, scroll the view otherwise */
timeline.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.metaKey || e.ctrlKey || e.altKey) {
    setZoom(S.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), xToT(e.clientX));
  } else if (S.zoom > 1) {
    S.viewStart += (e.deltaX || e.deltaY) * (viewSpan() / 600);
    clampView();
    drawTimeline();
  }
}, { passive: false });

/* trim the outer edges */
for (const [el, key] of [[$('#trimL'), 'start'], [$('#trimR'), 'end']]) {
  el.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    const move = (ev) => {
      const t = xToT(ev.clientX);
      if (key === 'start') {
        const s = S.segments[0];
        s.start = clamp(t, 0, s.end - 0.3);
      } else {
        const s = S.segments[S.segments.length - 1];
        s.end = clamp(t, s.start + 0.3, S.duration);
      }
      drawTimeline();
      const to = nextPlayable(S.t);
      seek(to == null ? S.segments[0].start : to);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

$('#zoomIn').onclick = () => setZoom(S.zoom * 1.5, S.t);
$('#zoomOut').onclick = () => setZoom(S.zoom / 1.5, S.t);
$('#zoomFit').onclick = () => { S.zoom = 1; S.viewStart = 0; $('#zoomVal').textContent = '100%'; drawTimeline(); };
$('#splitBtn').onclick = splitAtPlayhead;
$('#deleteSegBtn').onclick = deleteSelectedSegment;

window.addEventListener('resize', () => drawTimeline());


/* ---------------- canvas interaction ---------------- */
function canvasPoint(e) {
  const r = cv.getBoundingClientRect();
  return {
    x: clamp((e.clientX - r.left) / r.width, 0, 1),
    y: clamp((e.clientY - r.top) / r.height, 0, 1),
  };
}

function setMode(mode) {
  S.mode = mode;
  cv.classList.toggle('aiming', mode !== 'aim-off');
  const hint = $('#stageHint');
  if (mode === 'aim-zoom') { hint.textContent = 'Click where the zoom should centre'; hint.classList.add('on'); }
  else if (mode === 'draw-blur') { hint.textContent = 'Drag a box over what to hide'; hint.classList.add('on'); }
  else hint.classList.remove('on');
}

cv.addEventListener('mousedown', (e) => {
  const p = canvasPoint(e);

  if (S.mode === 'aim-zoom' && S.selectedZoom >= 0) {
    S.zooms[S.selectedZoom].x = p.x;
    S.zooms[S.selectedZoom].y = p.y;
    setMode('aim-off');
    return;
  }

  if (S.mode === 'draw-blur') {
    const b = { start: S.segments[0].start, end: S.segments[S.segments.length - 1].end, x: p.x, y: p.y, w: 0, h: 0, style: 'blur', strength: 70 };
    S.blurs.push(b);
    S.selectedBlur = S.blurs.length - 1;
    const move = (ev) => {
      const q = canvasPoint(ev);
      b.x = Math.min(p.x, q.x); b.y = Math.min(p.y, q.y);
      b.w = Math.abs(q.x - p.x); b.h = Math.abs(q.y - p.y);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (b.w < 0.01 || b.h < 0.01) S.blurs.pop();
      setMode('aim-off');
      renderBlurList();
      drawTimeline();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return;
  }

  const px = p.x * S.canvas.w;
  const py = p.y * S.canvas.h;

  /* Cropping draws a box in the SOURCE, so it is handled on its own. */
  if (S.cropping) {
    const which = S.cropping;
    const box = layerBox(which);
    // clamp the drag to the layer so you cannot crop empty canvas
    const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const x0 = cl(px, box.x, box.x + box.w);
    const y0 = cl(py, box.y, box.y + box.h);
    const move = (ev) => {
      const q = canvasPoint(ev);
      const cx = cl(q.x * S.canvas.w, box.x, box.x + box.w);
      const cy = cl(q.y * S.canvas.h, box.y, box.y + box.h);
      S.pendingCrop = {
        x: Math.min(x0, cx), y: Math.min(y0, cy),
        w: Math.abs(cx - x0), h: Math.abs(cy - y0),
      };
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const c = S.pendingCrop;
      if (c && c.w > box.w * 0.05 && c.h > box.h * 0.05) applyCrop(which, c);
      S.pendingCrop = null;
      setCropMode(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return;
  }

  // resizing the current selection
  if (S.sel) {
    const box = layerBox(S.sel);
    const h = hitHandle(box, px, py);
    if (h) {
      const target = S.sel === 'camera' ? S.camera_ : S.screen_;
      const orig = { ...target.rect };
      const startX = px, startY = py;
      const square = S.sel === 'camera' && S.camera_.shape === 'circle';
      if (S.sel === 'camera') { S.camera_.useMotion = false; syncMotionBtn(); }
      const move = (ev) => {
        const q = canvasPoint(ev);
        const dxN = (q.x * S.canvas.w - startX) / S.canvas.w;
        const dyN = (q.y * S.canvas.h - startY) / S.canvas.h;
        target.rect = resizeRect(orig, h, dxN, dyN, square);
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }
  }

  // otherwise pick a layer and move it. Camera first, it sits on top.
  const camHit = S.camera_.visible && S.camera && insideBox(camBox(), px, py);
  const scrHit = S.screen_.visible && S.screen && insideBox(screenBox(), px, py);
  const which = camHit ? 'camera' : (scrHit ? 'screen' : null);

  S.sel = which;
  syncSelectionUI();
  if (!which) return;

  const target = which === 'camera' ? S.camera_ : S.screen_;
  const box = layerBox(which);
  const offX = (px - box.x) / S.canvas.w;
  const offY = (py - box.y) / S.canvas.h;
  cv.classList.add('dragging');
  if (which === 'camera') { S.camera_.useMotion = false; syncMotionBtn(); }

  const move = (ev) => {
    const q = canvasPoint(ev);
    target.rect = {
      ...target.rect,
      x: clamp(q.x - offX, -0.4, 1.4 - target.rect.w),
      y: clamp(q.y - offY, -0.4, 1.4 - target.rect.h),
    };
  };
  const up = () => {
    cv.classList.remove('dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
});

/* Map a box drawn in canvas pixels back to a crop of the layer's source.
   Goes through the geometry recorded during draw(), which is the only thing
   that knows about letterboxing, cover-cropping and mirroring. The result is
   absolute against the source, so it replaces rather than compounds. */
function applyCrop(which, rect) {
  const g = S.geom[which];
  const target = which === 'camera' ? S.camera_ : S.screen_;
  if (!g || !g.dw || !g.dh) return;

  const toSrcX = (cx) => {
    let f = (cx - g.dx) / g.dw;
    if (g.mirror) f = 1 - f;
    return g.sx + f * g.sw;
  };
  const toSrcY = (cy) => g.sy + ((cy - g.dy) / g.dh) * g.sh;

  let x0 = toSrcX(rect.x);
  let x1 = toSrcX(rect.x + rect.w);
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  const y0 = toSrcY(rect.y);
  const y1 = toSrcY(rect.y + rect.h);

  // express against the base region, which for the screen is the recorded crop
  const nx = clamp((x0 - g.baseX) / g.baseW, 0, 0.97);
  const ny = clamp((y0 - g.baseY) / g.baseH, 0, 0.97);
  const nw = clamp((x1 - x0) / g.baseW, 0.03, 1 - nx);
  const nh = clamp((y1 - y0) / g.baseH, 0.03, 1 - ny);

  target.crop = { nx, ny, nw, nh };
  syncCropUI();
}

function setCropMode(which) {
  S.cropping = which;
  S.pendingCrop = null;
  cv.classList.toggle('aiming', Boolean(which) || S.mode !== 'aim-off');
  const hint = $('#stageHint');
  if (which) {
    hint.textContent = which === 'camera'
      ? 'Drag a box over the camera to reframe it'
      : 'Drag a box over the screen to crop it';
    hint.classList.add('on');
  } else if (S.mode === 'aim-off') {
    hint.classList.remove('on');
  }
  syncCropUI();
}

/* ---------------- inspector ---------------- */
$$('#tabs button').forEach((b) => b.onclick = () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === b.dataset.tab));
});

/* Each preset is drawn as a small diagram of where the two layers sit. */
function layoutThumb(p) {
  const box = (r, cls, extra) => r
    ? `<span class="${cls} ${extra || ''}" style="left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%"></span>`
    : '';
  return box(p.screen, 'ls') + box(p.camera, 'lc', p.shape === 'circle' ? 'circle' : (p.shape === 'rounded' ? 'rounded' : ''));
}

$('#layoutGrid').innerHTML = LAYOUTS.map((p) => `
  <button class="lay" data-id="${p.id}" title="${p.name}">
    ${layoutThumb(p)}
    <span class="nmx">${p.name}</span>
  </button>`).join('');

$$('#layoutGrid .lay').forEach((el) => el.onclick = () => {
  const preset = LAYOUTS.find((p) => p.id === el.dataset.id);
  if (!preset) return;
  applyPreset(preset);
});

function applyPreset(preset) {
  const L = applyLayout(preset, S.camSize);
  S.layoutId = preset.id;
  S.screen_.visible = Boolean(L.screen);
  if (L.screen) S.screen_.rect = L.screen;
  S.camera_.visible = Boolean(L.camera) && Boolean(S.camera);
  if (L.camera) S.camera_.rect = L.camera;
  S.camera_.shape = L.shape;
  S.camera_.useMotion = false;
  S.sel = null;
  syncLayoutUI();
}

$$('#camSizeSeg button').forEach((b) => b.onclick = () => {
  S.camSize = b.dataset.size;
  const preset = LAYOUTS.find((p) => p.id === S.layoutId);
  if (preset) applyPreset(preset);
  else syncLayoutUI();
});

$$('#shapeSeg button').forEach((b) => b.onclick = () => {
  S.camera_.shape = b.dataset.shape;
  syncLayoutUI();
});

function syncLayoutUI() {
  /* No camera track means the camera half of this pane is meaningless. */
  const hasCam = Boolean(S.camera && S.session && S.session.cameraPath);
  /* Every layout stays clickable even with no camera, because the screen half
     of each one is still a real, useful change. Disabling them made the whole
     picker look broken. Only camera-only has nothing to show. */
  $$('#layoutGrid .lay').forEach((el) => {
    const p = LAYOUTS.find((x) => x.id === el.dataset.id);
    const cameraOnly = Boolean(p && !p.screen);
    el.disabled = cameraOnly && !hasCam;
    el.style.opacity = el.disabled ? '.35' : '';
    el.classList.toggle('on', el.dataset.id === S.layoutId);
    el.title = (!hasCam && p && p.camera) ? `${p.name} (no camera in this take)` : p.name;
  });
  $('#noCamNote').classList.toggle('hide', hasCam);
  $('#noCamNote').innerHTML = 'This take has no camera track, so the camera half of each layout stays empty. '
    + 'The screen placement still applies. Turn the camera on in the recorder before your next one.';
  $('#shapeField').classList.toggle('hide', !hasCam || !S.camera_.visible);
  $('#sizeField').classList.toggle('hide', !hasCam || !S.camera_.visible);
  $('#cropCamera').parentElement.classList.toggle('hide', !hasCam || !S.camera_.visible);
  $('#mirrorBtn').parentElement.classList.toggle('hide', !hasCam || !S.camera_.visible);

  $$('#shapeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.shape === S.camera_.shape));
  $$('#camSizeSeg button').forEach((x) => x.classList.toggle('on', x.dataset.size === S.camSize));

  const hasTrack = S.session && S.session.camTrack && S.session.camTrack.length > 1;
  $('#motionField').classList.toggle('hide', !hasCam || !S.camera_.visible || !hasTrack);
  syncMotionBtn();
  syncCropUI();
  syncSelectionUI();
}

function syncSelectionUI() {
  const hint = $('#stageHint');
  if (S.cropping) return;
  if (S.sel) {
    hint.textContent = S.sel === 'camera'
      ? 'Camera selected. Drag to move, pull a handle to resize.'
      : 'Screen selected. Drag to move, pull a handle to resize.';
    hint.classList.add('on');
  } else if (S.mode === 'aim-off') {
    hint.classList.remove('on');
  }
}

function syncCropUI() {
  $('#resetScreenCrop').classList.toggle('hide', !S.screen_.crop);
  $('#resetCameraCrop').classList.toggle('hide', !S.camera_.crop);
  $('#cropScreen').classList.toggle('on', S.cropping === 'screen');
  $('#cropCamera').classList.toggle('on', S.cropping === 'camera');
}

$('#cropScreen').onclick = () => setCropMode(S.cropping === 'screen' ? null : 'screen');
$('#cropCamera').onclick = () => setCropMode(S.cropping === 'camera' ? null : 'camera');
$('#resetScreenCrop').onclick = () => { S.screen_.crop = null; syncCropUI(); };
$('#resetCameraCrop').onclick = () => { S.camera_.crop = null; syncCropUI(); };

$('#mirrorBtn').onclick = () => {
  S.camera_.mirror = !S.camera_.mirror;
  $('#mirrorBtn').classList.toggle('on', S.camera_.mirror);
};

$('#motionBtn').onclick = () => {
  S.camera_.useMotion = !S.camera_.useMotion;
  syncMotionBtn();
};

function syncMotionBtn() {
  $('#motionBtn').classList.toggle('on', S.camera_.useMotion);
  $('#motionHint').textContent = S.camera_.useMotion
    ? 'Following your recorded path. Drag the bubble to switch back to a fixed spot.'
    : 'Uses the path the bubble took while you recorded.';
}

/* ---------------- zooms ---------------- */
$('#addZoom').onclick = () => {
  const last = S.segments[S.segments.length - 1].end;
  const start = clamp(S.t, S.segments[0].start, Math.max(S.segments[0].start, last - 0.5));
  const z = { start, end: Math.min(start + 2.5, last), x: 0.5, y: 0.5, scale: 1.6 };
  S.zooms.push(z);
  S.zooms.sort((a, b) => a.start - b.start);
  S.selectedZoom = S.zooms.indexOf(z);
  renderZoomList();
  syncZoomEdit();
  drawTimeline();
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'zoom'));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === 'zoom'));
  setMode('aim-zoom');
};

function renderZoomList() {
  const wrap = $('#zoomList');
  $('#zoomEmpty').classList.toggle('hide', S.zooms.length > 0);
  wrap.innerHTML = S.zooms.map((z, i) => `
    <div class="item ${i === S.selectedZoom ? 'on' : ''}" data-i="${i}">
      <span class="t">${fmt(z.start)}</span>
      <span class="s">${(z.end - z.start).toFixed(1)}s at ${z.scale.toFixed(1)}x</span>
      <button class="icon-btn del" data-del="${i}" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join('');

  wrap.querySelectorAll('.item').forEach((el) => el.onclick = (e) => {
    if (e.target.closest('[data-del]')) return;
    S.selectedZoom = Number(el.dataset.i);
    renderZoomList(); syncZoomEdit(); drawTimeline();
    seek(S.zooms[S.selectedZoom].start);
  });
  wrap.querySelectorAll('[data-del]').forEach((el) => el.onclick = (e) => {
    e.stopPropagation();
    S.zooms.splice(Number(el.dataset.del), 1);
    S.selectedZoom = -1;
    renderZoomList(); syncZoomEdit(); drawTimeline();
  });
}

function syncZoomEdit() {
  const on = S.selectedZoom >= 0 && S.zooms[S.selectedZoom];
  $('#zoomEdit').classList.toggle('hide', !on);
  if (!on) return;
  const z = S.zooms[S.selectedZoom];
  $('#zoomScale').value = Math.round(z.scale * 100);
  $('#zoomScaleVal').textContent = z.scale.toFixed(1) + 'x';
  $('#zoomStart').max = Math.round(S.duration * 10);
  $('#zoomStart').value = Math.round(z.start * 10);
  $('#zoomStartVal').textContent = z.start.toFixed(1) + 's';
  $('#zoomLen').value = Math.round((z.end - z.start) * 10);
  $('#zoomLenVal').textContent = (z.end - z.start).toFixed(1) + 's';
}

$('#zoomScale').oninput = (e) => {
  if (S.selectedZoom < 0) return;
  S.zooms[S.selectedZoom].scale = Number(e.target.value) / 100;
  $('#zoomScaleVal').textContent = S.zooms[S.selectedZoom].scale.toFixed(1) + 'x';
  renderZoomList(); drawTimeline();
};
$('#zoomStart').oninput = (e) => {
  if (S.selectedZoom < 0) return;
  const z = S.zooms[S.selectedZoom];
  const len = z.end - z.start;
  z.start = clamp(Number(e.target.value) / 10, 0, S.duration - len);
  z.end = z.start + len;
  $('#zoomStartVal').textContent = z.start.toFixed(1) + 's';
  renderZoomList(); drawTimeline();
};
$('#zoomLen').oninput = (e) => {
  if (S.selectedZoom < 0) return;
  const z = S.zooms[S.selectedZoom];
  z.end = clamp(z.start + Number(e.target.value) / 10, z.start + 0.3, S.duration);
  $('#zoomLenVal').textContent = (z.end - z.start).toFixed(1) + 's';
  renderZoomList(); drawTimeline();
};
$('#zoomAim').onclick = () => setMode('aim-zoom');

/* ---------------- blurs ---------------- */
$('#addBlur').onclick = () => {
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === 'blur'));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.dataset.pane === 'blur'));
  setMode('draw-blur');
};

function syncBlurEdit() {
  const on = S.selectedBlur >= 0 && S.blurs[S.selectedBlur];
  $('#blurEdit').classList.toggle('hide', !on);
  if (!on) return;
  const b = S.blurs[S.selectedBlur];
  $$('#blurStyle button').forEach((x) => x.classList.toggle('on', x.dataset.style === (b.style || 'blur')));
  $('#blurStrength').value = b.strength ?? 70;
  $('#blurStrengthVal').textContent = (b.strength ?? 70) + '%';
  $('#blurStrength').disabled = (b.style === 'solid');
  $('#blurStrength').style.opacity = (b.style === 'solid') ? '.4' : '';
}

$$('#blurStyle button').forEach((b) => b.onclick = () => {
  if (S.selectedBlur < 0) return;
  S.blurs[S.selectedBlur].style = b.dataset.style;
  syncBlurEdit();
  renderBlurList();
});

$('#blurStrength').oninput = (e) => {
  if (S.selectedBlur < 0) return;
  S.blurs[S.selectedBlur].strength = Number(e.target.value);
  $('#blurStrengthVal').textContent = e.target.value + '%';
};

function renderBlurList() {
  const wrap = $('#blurList');
  $('#blurEmpty').classList.toggle('hide', S.blurs.length > 0);
  wrap.innerHTML = S.blurs.map((b, i) => `
    <div class="item ${i === S.selectedBlur ? 'on' : ''}" data-i="${i}">
      <span class="t">${fmt(b.start)}</span>
      <span class="s">${b.style === 'pixelate' ? 'Pixelate' : b.style === 'solid' ? 'Solid' : 'Blur'} ${b.style === 'solid' ? '' : (b.strength ?? 70) + '%'}</span>
      <button class="icon-btn del" data-del="${i}" title="Remove">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`).join('');

  wrap.querySelectorAll('.item').forEach((el) => el.onclick = (e) => {
    if (e.target.closest('[data-del]')) return;
    S.selectedBlur = Number(el.dataset.i);
    renderBlurList(); syncBlurEdit(); drawTimeline();
  });
  wrap.querySelectorAll('[data-del]').forEach((el) => el.onclick = (e) => {
    e.stopPropagation();
    S.blurs.splice(Number(el.dataset.del), 1);
    S.selectedBlur = -1;
    renderBlurList(); syncBlurEdit(); drawTimeline();
  });
}

/* ---------------- audio ---------------- */
const VOICE_HINTS = {
  off: 'The microphone exactly as recorded. Nothing added, nothing removed.',
  clean: 'Removes rumble and hiss, evens out your level. Keeps the room sounding natural.',
  studio: 'Adds a gate that cuts breathing and room noise between phrases, plus compression and a presence lift. Best for talking to camera.',
};

$$('#voiceSeg button').forEach((b) => b.onclick = () => {
  S.audio.voice = b.dataset.voice;
  syncAudioUI();
});

$('#micGain').oninput = (e) => {
  S.audio.micGain = Number(e.target.value) / 100;
  $('#micGainVal').textContent = e.target.value + '%';
  applyPreviewLevels();
};
$('#sysGain').oninput = (e) => {
  S.audio.systemGain = Number(e.target.value) / 100;
  $('#sysGainVal').textContent = e.target.value + '%';
  applyPreviewLevels();
};

/* The preview plays the raw take; the cleanup chain only runs at export. Levels
   are mirrored though, so the balance you set is the balance you hear. */
function applyPreviewLevels() {
  if (S.mic) S.mic.volume = clamp(S.audio.micGain, 0, 1);
  if (S.screen) S.screen.volume = clamp(S.audio.systemGain, 0, 1);
}

function syncAudioUI() {
  const hasMic = Boolean(S.session && S.session.micPath);
  const hasSys = Boolean(S.session && S.session.screenInfo && S.session.screenInfo.hasAudio);
  $$('#voiceSeg button').forEach((x) => x.classList.toggle('on', x.dataset.voice === S.audio.voice));
  $('#voiceHint').textContent = VOICE_HINTS[S.audio.voice] || '';
  $('#micField').classList.toggle('hide', !hasMic);
  $('#voiceSeg').parentElement.classList.toggle('hide', !hasMic);
  $('#sysField').classList.toggle('hide', !hasSys);
  $('#noAudioNote').classList.toggle('hide', hasMic || hasSys);
}

/* ---------------- look ---------------- */
/* the picker is built from the shared preset list so the swatch, the canvas
   preview and the ffmpeg render all describe the same gradient */
const LIGHT = new Set(['paper', 'linen']);

$('#bgGrid').innerHTML = BACKGROUNDS.map((b) => `
  <button class="bg ${LIGHT.has(b.id) ? 'light' : ''}" data-id="${b.id}" style="background:${toCss(b)}" title="${b.name}">
    <span class="nm">${b.name}</span>
  </button>`).join('');

$$('#bgGrid .bg').forEach((el) => el.onclick = () => {
  const preset = BACKGROUNDS.find((b) => b.id === el.dataset.id);
  if (!preset) return;
  $$('#bgGrid .bg').forEach((x) => x.classList.toggle('on', x === el));
  S.background.type = preset.type;
  S.background.colors = (preset.colors || ['#08090b']).slice();
  S.background.angle = preset.angle || 135;
  S.background.points = preset.points || null;
  // a background with no padding is invisible, so give it some the first time
  if (S.background.padding === 0) {
    S.background.padding = 5;
    $('#padding').value = 5;
    $('#paddingVal').textContent = '5%';
  }
  if (S.background.radius === 0) setRadius(25);
});

$('#bgNone').onclick = () => {
  S.background.type = 'none';
  S.background.points = null;
  $$('#bgGrid .bg').forEach((x) => x.classList.remove('on'));
};

$('#padding').oninput = (e) => {
  S.background.padding = Number(e.target.value);
  $('#paddingVal').textContent = e.target.value + '%';
};
/* Radius is stored in tenths of a percent of the canvas width, so a given
   setting looks identical at 720p and 1440p. The old slider topped out at
   48px on a 1920 canvas, which is a 2.5% corner: basically invisible. */
function setRadius(v) {
  S.background.radius = Math.max(0, Math.min(80, Number(v) || 0));
  $('#radius').value = S.background.radius;
  $('#radiusVal').textContent = (S.background.radius / 10).toFixed(1) + '%';
  $$('#shapeSegBg button').forEach((x) => x.classList.toggle('on', Number(x.dataset.r) === S.background.radius));
}
$('#radius').oninput = (e) => setRadius(e.target.value);
$$('#shapeSegBg button').forEach((b) => b.onclick = () => setRadius(b.dataset.r));

// canvas pixels for the current radius setting
function radiusPx() {
  return Math.round((S.background.radius / 1000) * S.canvas.w);
}
$('#canvasSize').onchange = (e) => {
  const [w, h] = e.target.value.split('x').map(Number);
  S.canvas = { w, h };
};

/* ---------------- export ---------------- */
function buildSpec(outName) {
  const padPct = S.background.type === 'none' ? 0 : S.background.padding;
  return {
    screenPath: S.session.screenPath,
    cameraPath: S.session.cameraPath,
    micPath: S.session.micPath || null,
    audio: { ...S.audio },
    out: S.session.dir + '/' + outName,
    segments: S.segments.map((x) => ({ start: x.start, end: x.end })),
    canvas: S.canvas,
    fps: 30,
    background: {
      type: S.background.type,
      colors: S.background.colors,
      angle: S.background.angle,
      points: S.background.points || null,
      padding: Math.round((padPct / 100) * S.canvas.w),
      radius: radiusPx(),
    },
    screen: {
      visible: S.screen_.visible && Boolean(S.session.screenPath),
      rect: S.screen_.rect,
      // fold the recording's own region crop together with any crop set here
      crop: combineCrop(S.session.crop, S.screen_.crop),
    },
    camera: {
      visible: S.camera_.visible && Boolean(S.session.cameraPath),
      rect: S.camera_.rect,
      crop: S.camera_.crop,
      shape: S.camera_.shape,
      mirror: S.camera_.mirror,
      motion: S.camera_.useMotion ? (S.session.camTrack || []) : null,
    },
    zooms: S.zooms,
    blurs: S.blurs,
  };
}

/* The region you picked while recording and a crop applied in Studio are both
   normalised against the source, so the second nests inside the first. */
function combineCrop(recorded, edited) {
  const a = (recorded && recorded.nw) ? recorded : null;
  if (!a && !edited) return null;
  if (!a) return edited;
  if (!edited) return a;
  return {
    nx: a.nx + edited.nx * a.nw,
    ny: a.ny + edited.ny * a.nh,
    nw: a.nw * edited.nw,
    nh: a.nh * edited.nh,
  };
}

/* The elapsed counter is not decoration: a publish that quietly stops making
   progress is otherwise indistinguishable from one that is just slow. */
const pub = {
  startedAt: 0,
  timer: null,
  lastPct: -1,
  stalledSince: 0,
  stallWatch: true,
  open({ stallWatch = true } = {}) {
    $('#publish').classList.add('on');
    this.startedAt = Date.now();
    this.lastPct = -1;
    this.stalledSince = Date.now();
    // only an upload can stall on someone else's server; a local save cannot
    this.stallWatch = stallWatch;
    $('#pubStalled').classList.add('hide');
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
  },
  close() {
    $('#publish').classList.remove('on');
    $('#pubStalled').classList.add('hide');
    clearInterval(this.timer);
    this.timer = null;
  },
  tick() {
    const secs = Math.floor((Date.now() - this.startedAt) / 1000);
    $('#pubElapsed').textContent = fmt(secs);
    if (!this.stallWatch) return;
    const stalled = Math.floor((Date.now() - this.stalledSince) / 1000);
    $('#pubStalled').classList.toggle('hide', stalled < 45);
    if (stalled >= 45) {
      $('#pubStalled').textContent = `No progress for ${fmt(stalled)}. Still waiting on Bunny.`;
    }
  },
  set(stage, pct) {
    $('#pubStage').textContent = stage;
    const p = clamp(pct, 0, 100);
    if (Math.round(p) !== Math.round(this.lastPct)) {
      this.lastPct = p;
      this.stalledSince = Date.now();
    }
    $('#pubFill').style.width = p + '%';
  },
};

$('#pubClose').onclick = () => pub.close();

cue.onRenderProgress(({ pct }) => pub.set('Rendering your video', pct * 0.55));
cue.onPublishProgress(({ stage, pct }) => {
  const map = {
    creating: ['Creating the video on Bunny', 58],
    uploading: ['Uploading to Bunny', 60 + (pct || 0) * 0.3],
    encoding: ['Bunny is encoding', 90 + (pct || 0) * 0.1],
    done: ['Published', 100],
  };
  const [label, p] = map[stage] || [stage, 60];
  pub.set(label, p);
});

$('#publishBtn').onclick = async () => {
  pause();
  pub.open();
  busy = true;
  $('#pubTitle').textContent = 'Publishing to Bunny';
  $('#pubLinks').classList.add('hide');
  $('#pubLinks').innerHTML = '';
  $('#pubClose').textContent = 'Close';
  $('#pubClose').className = 'btn ghost';
  $('#pubClose').onclick = () => pub.close();
  pub.set('Rendering your video', 2);

  try {
    const spec = buildSpec('smoke-export.mp4');
    await cue.render(spec);
    const title = `Smoke recording ${new Date().toLocaleString()}`;
    const { links } = await cue.publish({ file: spec.out, title });

    $('#pubTitle').textContent = 'Published';
    pub.set('Ready to share', 100);

    /* The direct MP4 link needs the CDN hostname, which is unknown until the
       library has its first video. Drop the row rather than print "null". */
    const rows = [
      ['Share', links.share],
      ['Embed', links.embed],
      ['MP4', links.mp4],
    ].filter(([, url]) => Boolean(url));
    $('#pubLinks').classList.remove('hide');
    $('#pubLinks').innerHTML = rows.map(([lbl, url]) => `
      <div class="link-row">
        <span class="lbl">${lbl}</span>
        <span class="url">${url}</span>
        <button class="icon-btn" data-copy="${url}" title="Copy">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
        </button>
      </div>`).join('') +
      `<button class="btn primary" id="openShare" style="margin-top:4px">Open the share page</button>`;

    $$('#pubLinks [data-copy]').forEach((el) => el.onclick = async () => {
      await cue.copy(el.dataset.copy);
      el.classList.add('on');
      setTimeout(() => el.classList.remove('on'), 900);
    });
    $('#openShare').onclick = () => cue.openExternal(links.share);

    // the take is published, so offer the actual exit rather than just
    // dismissing the overlay back to an editor you are finished with
    $('#pubClose').textContent = 'Done, close Studio';
    $('#pubClose').className = 'btn';
    $('#pubClose').onclick = closeStudio;

    await cue.copy(links.share);
    busy = false;
  } catch (e) {
    busy = false;
    $('#pubTitle').textContent = 'Publishing failed';
    $('#pubStage').textContent = String(e && e.message ? e.message : e).slice(0, 300);
    $('#pubFill').style.width = '0%';
  }
};

/* Saving a file is a local operation and has nothing to do with Bunny. It
   renders, writes the file, and hands you straight back to the editor. The
   overlay used to stay open afterwards running the publish stall timer, which
   then announced it was "still waiting on Bunny" for a save that had already
   finished. */
$('#saveLocal').onclick = async () => {
  pause();
  pub.open({ stallWatch: false });
  busy = true;
  $('#pubTitle').textContent = 'Saving a file';
  $('#pubLinks').classList.add('hide');
  $('#pubClose').textContent = 'Cancel';
  $('#pubClose').className = 'btn ghost';
  $('#pubClose').onclick = () => pub.close();
  pub.set('Rendering your video', 2);
  try {
    const spec = buildSpec('smoke-export.mp4');
    await cue.render(spec);
    pub.set('Choose where to save', 100);
    const saved = await cue.saveAs({ src: spec.out, suggested: defaultFileName() });
    busy = false;
    pub.close();
    if (saved) toast(`Saved to ${saved.split('/').pop()}`);
  } catch (e) {
    busy = false;
    $('#pubTitle').textContent = 'Could not save';
    $('#pubStage').textContent = String(e && e.message ? e.message : e).slice(0, 300);
    $('#pubClose').textContent = 'Close';
  }
};

/* Brief confirmation that does not require dismissing anything. */
let toastTimer = null;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
}

/* A recognisable name beats "export": Smoke 2026-08-10 14-32.mp4 */
function defaultFileName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Smoke ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}-${p(d.getMinutes())}.mp4`;
}

renderZoomList();
renderBlurList();
