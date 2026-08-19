const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { gradientLine } = require('../renderer/backgrounds.js');
const { toPixels, squareForCircle, resolveCrop } = require('../renderer/layouts.js');
const { MESH_EPS } = require('../renderer/backgrounds.js');
const crypto = require('crypto');
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);

/* Bundled binaries, so a packaged build depends on nothing being installed.
   A universal app ships both slices and picks by the running architecture;
   process.arch is the arch the app is actually executing as, which is what
   matters under Rosetta too. */
function binary(name) {
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const vendored = path.join(__dirname, '..', 'vendor', 'bin', `${name}-${arch}`);
  if (fs.existsSync(vendored)) return vendored;

  // dev fallback: whatever npm installed for this machine
  try {
    const mod = require(name === 'ffmpeg' ? 'ffmpeg-static' : 'ffprobe-static');
    const p = typeof mod === 'string' ? mod : mod.path;
    const real = p.replace('app.asar', 'app.asar.unpacked');
    if (real && fs.existsSync(real)) return real;
  } catch (_) {}

  return name === 'ffmpeg' ? '/opt/homebrew/bin/ffmpeg' : '/opt/homebrew/bin/ffprobe';
}

const FFMPEG = binary('ffmpeg');
const FFPROBE = binary('ffprobe');

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      file,
    ], { maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) return reject(err);
      let data;
      try { data = JSON.parse(stdout); } catch (e) { return reject(e); }
      const v = (data.streams || []).find((s) => s.codec_type === 'video') || {};
      const a = (data.streams || []).find((s) => s.codec_type === 'audio');
      resolve({
        duration: parseFloat((data.format && data.format.duration) || v.duration || 0) || 0,
        width: v.width || 0,
        height: v.height || 0,
        fps: parseFrameRate(v.avg_frame_rate || v.r_frame_rate),
        hasAudio: Boolean(a),
      });
    });
  });
}

function parseFrameRate(r) {
  if (!r) return 30;
  const [n, d] = String(r).split('/').map(Number);
  if (!d) return n || 30;
  return Math.round((n / d) * 100) / 100 || 30;
}

function run(args, onLine) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', (c) => {
      const text = c.toString();
      err += text;
      if (err.length > 200000) err = err.slice(-100000);
      if (onLine) text.split(/[\r\n]/).forEach((l) => { if (l.trim()) onLine(l); });
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}\n${err.slice(-2000)}`));
    });
  });
}

/* Build a reusable alpha mask PNG: circle, squircle or plain rectangle. */
async function makeMask(shape, w, h, radius, out) {
  const W = Math.max(2, Math.round(w));
  const H = Math.max(2, Math.round(h));
  let expr;
  if (shape === 'circle') {
    const rx = W / 2, ry = H / 2;
    expr = `if(lte(pow((X-${rx})/${rx},2)+pow((Y-${ry})/${ry},2),1),255,0)`;
  } else {
    const r = Math.max(0, Math.min(radius || 0, Math.min(W, H) / 2));
    if (r === 0) expr = '255';
    else {
      // rounded rectangle: inside if within the inset rect, or within r of a corner centre
      expr = `if(lt(X,${r})*lt(Y,${r}), if(lte(pow(X-${r},2)+pow(Y-${r},2),${r * r}),255,0),` +
             `if(gt(X,${W - r})*lt(Y,${r}), if(lte(pow(X-${W - r},2)+pow(Y-${r},2),${r * r}),255,0),` +
             `if(lt(X,${r})*gt(Y,${H - r}), if(lte(pow(X-${r},2)+pow(Y-${H - r},2),${r * r}),255,0),` +
             `if(gt(X,${W - r})*gt(Y,${H - r}), if(lte(pow(X-${W - r},2)+pow(Y-${H - r},2),${r * r}),255,0),` +
             `255))))`;
    }
  }
  await run([
    '-y', '-f', 'lavfi',
    '-i', `color=c=black:s=${W}x${H}`,
    '-vf', `format=gray,geq=lum='${expr}'`,
    '-frames:v', '1',
    out,
  ]);
  return out;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");

const rgb = (hex) => {
  const h = String(hex || '#000000').replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
};

/* Bake a multi-stop linear gradient to a single PNG.
   ffmpeg's own `gradients` source deadlocks when its output is overlaid with a
   real video input, so we render one frame with geq (a few milliseconds) and
   feed it in as a looped image the same way the corner masks work. */
async function makeGradient(colors, angle, W, H, out) {
  const stops = colors.map(rgb);
  const n = stops.length;
  const { x0, y0, x1, y1 } = gradientLine(angle, W, H);
  const vx = x1 - x0;
  const vy = y1 - y0;
  const L2 = (vx * vx + vy * vy) || 1;

  // position along the gradient axis, 0..1
  const T = `clip(((X-${x0.toFixed(2)})*${vx.toFixed(4)}+(Y-${y0.toFixed(2)})*${vy.toFixed(4)})/${L2.toFixed(2)},0,1)`;

  // piecewise linear interpolation between the stops, per channel
  const channel = (ci) => {
    if (n === 1) return String(stops[0][ci]);
    let expr = String(stops[n - 1][ci]);
    for (let i = n - 2; i >= 0; i--) {
      const p0 = i / (n - 1);
      const p1 = (i + 1) / (n - 1);
      const a = stops[i][ci];
      const b = stops[i + 1][ci];
      const lerp = `(${a}+(${b - a})*((${T})-${p0.toFixed(6)})/${(p1 - p0).toFixed(6)})`;
      expr = `if(lt(${T},${p1.toFixed(6)}),${lerp},${expr})`;
    }
    return expr;
  };

  await run([
    '-y', '-f', 'lavfi',
    '-i', `color=c=black:s=${W}x${H}`,
    '-vf', `format=rgba,geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}':a='255'`,
    '-frames:v', '1',
    out,
  ]);
  return out;
}

/* Bake a mesh gradient to a PNG with the same inverse-distance weighting the
   preview uses, so Studio and the finished file agree. One geq pass, cached. */
async function makeMesh(points, W, H, out) {
  const pts = points.map((p) => ({ x: p.x, y: p.y, rgb: rgb(p.c) }));
  const wexpr = (p) => `(1/(pow(X/${W}-${p.x},2)+pow(Y/${H}-${p.y},2)+${MESH_EPS}))`;
  const denom = pts.map(wexpr).join('+');
  const channel = (ci) => {
    const num = pts.map((p) => `${wexpr(p)}*${p.rgb[ci]}`).join('+');
    return `(${num})/(${denom})`;
  };
  await run([
    '-y', '-f', 'lavfi',
    '-i', `color=c=black:s=${W}x${H}`,
    '-vf', `format=rgba,geq=r='${channel(0)}':g='${channel(1)}':b='${channel(2)}':a='255'`,
    '-frames:v', '1',
    out,
  ]);
  return out;
}

/* ------------------------------------------------------------------ *
 * Voice chain
 *
 * The microphone is captured raw, so all cleanup happens here where there are
 * real tools rather than a call-optimised black box. Order matters: remove what
 * you do not want before touching dynamics, and normalise last.
 *
 *   off      nothing, just level matching
 *   clean    rumble and hiss out, gentle levelling
 *   studio   the above plus a gate that removes breaths between phrases,
 *            compression, de-essing and a presence lift
 * ------------------------------------------------------------------ */
function voiceChain(level = 'clean') {
  if (!level || level === 'off') return [];

  const f = [
    // room rumble, desk bumps, aircon
    'highpass=f=85',
    // anything above this is hiss, not voice
    'lowpass=f=14000',
    // broadband denoise; gentle enough not to add artefacts
    'afftdn=nf=-24:tn=1',
  ];

  if (level === 'studio') {
    /* The gate is what removes breathing and mouth noise between phrases.
       A slow release keeps word tails intact instead of chopping them. */
    f.push('agate=threshold=0.018:ratio=3:attack=6:release=280:knee=3');
    // even out delivery so quiet phrases stay audible
    f.push('acompressor=threshold=-20dB:ratio=3.2:attack=12:release=240:makeup=2');
    // tame sibilance the compressor just pushed forward
    f.push('deesser=i=0.35:m=0.5:f=0.18');
    // clarity without the boxiness of a low-mid boost
    f.push('equalizer=f=250:t=q:w=1.2:g=-2');
    f.push('equalizer=f=3600:t=q:w=1.4:g=3');
  } else {
    f.push('acompressor=threshold=-22dB:ratio=2.2:attack=20:release=300:makeup=1.5');
  }

  // consistent perceived loudness, then a ceiling so nothing clips
  f.push('speechnorm=e=6.25:r=0.0005:l=1');
  f.push('alimiter=limit=0.94:level=false');
  return f;
}

/* Reduce a recorded bubble path to a handful of keyframes. The overlay
   expression is parsed per frame, so an unbounded chain would crawl. */
const MOTION_MAX = 48;
function simplifyMotion(motion, trimStart = 0, duration = null) {
  if (!Array.isArray(motion) || motion.length < 2) return [];
  const end = duration ? trimStart + duration : Infinity;
  const pts = motion
    .map((m) => ({ t: (Number(m.t) || 0) / 1000 - trimStart, x: Number(m.x), y: Number(m.y) }))
    .filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y) && m.t >= -1 && m.t <= (end - trimStart) + 1)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 2) return [];

  // drop points that barely moved
  const kept = [pts[0]];
  for (const p of pts.slice(1)) {
    const last = kept[kept.length - 1];
    if (Math.abs(p.x - last.x) > 0.004 || Math.abs(p.y - last.y) > 0.004) kept.push(p);
  }
  if (kept.length < 2) return [];

  if (kept.length <= MOTION_MAX) return kept;
  const step = kept.length / MOTION_MAX;
  const out = [];
  for (let i = 0; i < MOTION_MAX; i++) out.push(kept[Math.floor(i * step)]);
  out.push(kept[kept.length - 1]);
  return out;
}

/* Piecewise linear interpolation over t, as a nested if() chain. */
function motionExpr(points, axis, canvasSize, boxSize) {
  const px = (v) => Math.round(Math.max(0, Math.min(1, v)) * canvasSize - boxSize / 2);
  let expr = String(px(points[points.length - 1][axis]));
  for (let i = points.length - 2; i >= 0; i--) {
    const a = points[i];
    const b = points[i + 1];
    const t0 = Math.max(0, a.t);
    const t1 = Math.max(t0 + 0.001, b.t);
    const v0 = px(a[axis]);
    const v1 = px(b[axis]);
    const lerp = `(${v0}+(${v1 - v0})*(t-${t0.toFixed(3)})/${(t1 - t0).toFixed(3)})`;
    expr = `if(lt(t,${t1.toFixed(3)}),${lerp},${expr})`;
  }
  return expr;
}

/* Smooth eased zoom across the zoom segments, as a zoompan expression chain.
   zoompan exposes the frame timestamp as in_time, not t, and exposes the
   already-computed z for this frame as `zoom` inside the x/y expressions.
   Times are relative to the trimmed clip because -ss rebases PTS to zero. */
function zoomExpressions(zooms, trimStart = 0) {
  if (!zooms || !zooms.length) return null;
  const RAMP = 0.45;   // seconds of ease in and out
  const T = 'in_time';

  let z = '1';
  let fx = '0.5';
  let fy = '0.5';
  let used = 0;

  for (const s of zooms) {
    const a = (Number(s.start) || 0) - trimStart;
    const b = (Number(s.end) || 0) - trimStart;
    if (b <= a || b <= 0) continue;
    const A = Math.max(0, a);
    const scale = Math.max(1, Number(s.scale) || 1.5);
    const inEnd = Math.min(A + RAMP, (A + b) / 2);
    const outStart = Math.max(b - RAMP, (A + b) / 2);

    const ramp =
      `if(lt(${T},${A}),0,` +
      `if(lt(${T},${inEnd}),(${T}-${A})/${(inEnd - A) || 1},` +
      `if(lt(${T},${outStart}),1,` +
      `if(lt(${T},${b}),1-(${T}-${outStart})/${(b - outStart) || 1},0))))`;

    z = `(${z})+(${scale - 1})*(${ramp})`;
    const px = Math.max(0, Math.min(1, Number(s.x) ?? 0.5));
    const py = Math.max(0, Math.min(1, Number(s.y) ?? 0.5));
    fx = `(${fx})+(${px - 0.5})*(${ramp})`;
    fy = `(${fy})+(${py - 0.5})*(${ramp})`;
    used++;
  }

  if (!used) return null;

  // top-left of the crop window, clamped inside the frame
  return {
    z: `max(1,${z})`,
    x: `max(0,min(iw-iw/zoom,(${fx})*iw-(iw/zoom)/2))`,
    y: `max(0,min(ih-ih/zoom,(${fy})*ih-(ih/zoom)/2))`,
  };
}
/* ------------------------------------------------------------------ *
 * renderComposite
 *
 * The screen and the camera are each just a rect on the canvas with an
 * optional crop of their own source. Layout presets only decide those rects,
 * which is what lets you drag and resize either layer afterwards without
 * leaving the preset.
 *
 * spec = {
 *   screenPath, cameraPath, out,
 *   trim: { start, end },
 *   canvas: { w, h }, fps,
 *   background: { type, colors[], angle, padding, radius },
 *   screen: { visible, rect:{x,y,w,h}, crop:{nx,ny,nw,nh} },   rect normalised
 *   camera: { visible, rect, crop, shape, mirror, motion[] },
 *   zooms:  [{ start, end, x, y, scale }],
 *   blurs:  [{ start, end, x, y, w, h }],
 * }
 * ------------------------------------------------------------------ */
/* Cutting a piece out of the middle means the result is several ranges of the
   source joined together. Render each range on its own with the full composite,
   then concatenate. Slower than one pass, but it reuses the whole pipeline
   rather than duplicating it, and it is exact. */
async function renderWithSegments(spec, onProgress) {
  const segs = (spec.segments || [])
    .filter((s) => s && s.end > s.start)
    .sort((a, b) => a.start - b.start);

  if (segs.length <= 1) {
    const only = segs[0];
    return renderComposite(only ? { ...spec, trim: { start: only.start, end: only.end } } : spec, onProgress);
  }

  const dir = path.dirname(spec.out);
  const parts = [];
  const total = segs.reduce((n, s) => n + (s.end - s.start), 0);
  let done = 0;

  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const part = path.join(dir, `part-${String(i).padStart(3, '0')}.mp4`);
    await renderComposite(
      { ...spec, out: part, trim: { start: s.start, end: s.end } },
      ({ pct }) => {
        const within = ((s.end - s.start) * (pct / 100));
        if (onProgress) onProgress({ pct: Math.min(99, Math.round(((done + within) / total) * 100)) });
      },
    );
    done += (s.end - s.start);
    parts.push(part);
  }

  const listFile = path.join(dir, 'segments.txt');
  fs.writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));

  // every part came out of the same encoder settings, so a stream copy is safe
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', spec.out]);

  for (const p of parts) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.unlinkSync(listFile); } catch (_) {}

  if (onProgress) onProgress({ pct: 100 });
  return { out: spec.out, size: fs.statSync(spec.out).size };
}

async function renderComposite(spec, onProgress) {
  const {
    screenPath,
    cameraPath,
    micPath,
    audio = {},
    out,
    trim = {},
    canvas = { w: 1920, h: 1080 },
    fps = 30,
    background = {},
    screen: screenSpec = {},
    camera: cameraSpec = {},
    zooms = [],
    blurs = [],
  } = spec;

  const CW = Math.round(canvas.w / 2) * 2;
  const CH = Math.round(canvas.h / 2) * 2;
  const workDir = path.dirname(out);
  const start = Number(trim.start) || 0;
  const end = Number(trim.end) || 0;
  const duration = end > start ? end - start : null;

  const screenOn = Boolean(screenSpec.visible !== false && screenPath && fs.existsSync(screenPath) && screenSpec.rect);
  const camOn = Boolean(cameraSpec.visible && cameraPath && fs.existsSync(cameraPath) && cameraSpec.rect);
  if (!screenOn && !camOn) throw new Error('Nothing to render');

  /* filter_complex has no optional stream specifier, so we must know up front
     which inputs actually carry an audio track before wiring the mix. */
  const screenInfo = (screenPath && fs.existsSync(screenPath)) ? await probe(screenPath) : null;
  const camInfo = (cameraPath && fs.existsSync(cameraPath)) ? await probe(cameraPath) : null;
  const micInfo = (micPath && fs.existsSync(micPath)) ? await probe(micPath) : null;

  /* Every generated or looped input must be bounded to the output length,
     otherwise the render has no reason to ever stop. */
  const outDuration = duration
    || (screenInfo && screenInfo.duration)
    || (camInfo && camInfo.duration)
    || (micInfo && micInfo.duration)
    || 0;
  const boundT = (outDuration > 0 ? outDuration : 3600).toFixed(3);

  const pad = Math.max(0, Math.round(Number(background.padding) || 0));
  const args = ['-y'];
  const inputs = [];

  // ---- inputs (trim on the input side so decoding stays cheap) ----
  // audio must survive even when a layer is hidden, so decode both files if
  // they exist rather than only the visible ones
  const wantScreenFile = Boolean(screenPath && fs.existsSync(screenPath));
  const wantCamFile = Boolean(cameraPath && fs.existsSync(cameraPath));
  const wantMicFile = Boolean(micPath && fs.existsSync(micPath));

  if (wantScreenFile) {
    if (start > 0) args.push('-ss', String(start));
    if (duration) args.push('-t', String(duration));
    args.push('-i', screenPath);
    inputs.push('screen');
  }
  if (wantCamFile) {
    if (start > 0) args.push('-ss', String(start));
    if (duration) args.push('-t', String(duration));
    args.push('-i', cameraPath);
    inputs.push('camera');
  }
  if (wantMicFile) {
    if (start > 0) args.push('-ss', String(start));
    if (duration) args.push('-t', String(duration));
    args.push('-i', micPath);
    inputs.push('mic');
  }

  const idx = (name) => inputs.indexOf(name);
  const filters = [];

  // ---- background plate, always present so every layer has a base ----
  const stops = (Array.isArray(background.colors) && background.colors.length)
    ? background.colors.slice(0, 8)
    : [background.color || '#08090b'];

  if (background.type === 'mesh' && Array.isArray(background.points) && background.points.length) {
    const key = background.points.map((p) => `${p.x},${p.y},${String(p.c).replace('#', '')}`).join('_');
    const meshFile = path.join(workDir, `bg-mesh-${hash(key)}-${CW}x${CH}.png`);
    if (!fs.existsSync(meshFile)) await makeMesh(background.points, CW, CH, meshFile);
    args.push('-loop', '1', '-t', boundT, '-i', meshFile);
    inputs.push('bgimage');
    filters.push(`[${idx('bgimage')}:v]format=rgba,scale=${CW}:${CH},fps=${fps}[bg]`);
  } else if (background.type === 'gradient' && stops.length >= 2) {
    const key = `${stops.join('_').replace(/#/g, '')}-${background.angle || 135}-${CW}x${CH}`;
    const gradFile = path.join(workDir, `bg-${key}.png`);
    if (!fs.existsSync(gradFile)) await makeGradient(stops, background.angle, CW, CH, gradFile);
    args.push('-loop', '1', '-t', boundT, '-i', gradFile);
    inputs.push('bgimage');
    filters.push(`[${idx('bgimage')}:v]format=rgba,scale=${CW}:${CH},fps=${fps}[bg]`);
  } else {
    filters.push(`color=c=${stops[0] || '#08090b'}:s=${CW}x${CH}:r=${fps}:d=${boundT},format=rgba[bg]`);
  }
  let base = 'bg';

  // ---- screen layer ----
  if (screenOn) {
    const box = toPixels(screenSpec.rect, { w: CW, h: CH }, pad);
    const steps = [`fps=${fps}`, 'format=rgba'];

    let srcW = screenInfo.width;
    let srcH = screenInfo.height;
    const sc = resolveCrop(screenSpec.crop, srcW, srcH);
    if (sc) {
      steps.push(`crop=${sc.w}:${sc.h}:${sc.x}:${sc.y}`);
      srcW = sc.w;
      srcH = sc.h;
    }

    /* Pad to the target aspect at native resolution rather than scaling down
       first, so a zoom crops real pixels instead of upscaling a downscale. */
    const aspect = box.w / box.h;
    let padW = srcW;
    let padH = srcH;
    if (srcW / srcH > aspect) padH = Math.round(srcW / aspect / 2) * 2;
    else padW = Math.round(srcH * aspect / 2) * 2;
    if (padW !== srcW || padH !== srcH) {
      steps.push(`pad=${padW}:${padH}:(ow-iw)/2:(oh-ih)/2:color=black@0`);
    }

    const zx = zoomExpressions(zooms, start);
    if (zx) steps.push(`zoompan=z='${zx.z}':x='${zx.x}':y='${zx.y}':d=1:fps=${fps}:s=${box.w}x${box.h}`);
    else steps.push(`scale=${box.w}:${box.h}:flags=lanczos`);
    steps.push('setsar=1');

    filters.push(`[${idx('screen')}:v]${steps.join(',')}[scr]`);
    let label = 'scr';

    const radius = Math.max(0, Math.round(Number(background.radius) || 0));
    if (radius > 0) {
      const maskFile = path.join(workDir, `mask-screen-${box.w}x${box.h}-${radius}.png`);
      if (!fs.existsSync(maskFile)) await makeMask('rounded', box.w, box.h, radius, maskFile);
      args.push('-loop', '1', '-t', boundT, '-i', maskFile);
      inputs.push('screenmask');
      filters.push(`[${idx('screenmask')}:v]format=gray,scale=${box.w}:${box.h}[smask]`);
      filters.push(`[${label}][smask]alphamerge[scrr]`);
      label = 'scrr';
    }

    filters.push(`[${base}][${label}]overlay=${box.x}:${box.y}:format=auto:shortest=1[stage]`);
    base = 'stage';
  }

  /* ---- hidden regions, under the camera so a bubble is never obscured ----
     Strength has to reach far enough to make text genuinely unreadable; the
     previous fixed radius only softened it. Pixelate and solid are offered
     because a blur can sometimes be reversed. */
  let blurIdx = 0;
  for (const b of (blurs || [])) {
    const bw = Math.max(8, Math.round((Number(b.w) || 0) * CW / 2) * 2);
    const bh = Math.max(8, Math.round((Number(b.h) || 0) * CH / 2) * 2);
    const bx = Math.round((Number(b.x) || 0) * CW);
    const by = Math.round((Number(b.y) || 0) * CH);
    const on = (b.start != null && b.end != null && b.end > b.start)
      ? `:enable='between(t,${Math.max(0, b.start - start).toFixed(3)},${Math.max(0, b.end - start).toFixed(3)})'`
      : '';
    const tag = `blur${blurIdx++}`;
    const strength = Math.max(0, Math.min(100, Number(b.strength) ?? 70)) / 100;
    const style = b.style || 'blur';

    let effect;
    if (style === 'solid') {
      effect = `drawbox=x=0:y=0:w=iw:h=ih:color=0x0b0d12:t=fill`;
    } else if (style === 'pixelate') {
      const blocks = Math.max(2, Math.round(24 - strength * 21));
      const tw = Math.max(2, Math.round(bw / blocks / 2) * 2);
      const th = Math.max(2, Math.round(bh / blocks / 2) * 2);
      effect = `scale=${tw}:${th}:flags=area,scale=${bw}:${bh}:flags=neighbor`;
    } else {
      // boxblur is separable and cheap; applying it repeatedly approximates a
      // wide gaussian far better than one pass with a big radius
      const radius = Math.max(3, Math.round(Math.min(bw, bh) * (0.04 + strength * 0.30) / 2));
      const cap = Math.max(1, Math.floor(Math.min(bw, bh) / 2) - 1);
      const r = Math.min(radius, cap);
      effect = `boxblur=luma_radius=${r}:luma_power=3:chroma_radius=${r}:chroma_power=3`;
    }

    filters.push(
      `[${base}]split[${tag}a][${tag}b]`,
      `[${tag}b]crop=${bw}:${bh}:${bx}:${by},${effect},setsar=1[${tag}c]`,
      `[${tag}a][${tag}c]overlay=${bx}:${by}${on}[${tag}out]`,
    );
    base = `${tag}out`;
  }

  // ---- camera layer ----
  if (camOn) {
    let box = toPixels(cameraSpec.rect, { w: CW, h: CH }, pad);
    const shape = cameraSpec.shape || 'rect';
    if (shape === 'circle') box = squareForCircle(box);

    const steps = [`fps=${fps}`];
    const cc = resolveCrop(cameraSpec.crop, camInfo.width, camInfo.height);
    if (cc) steps.push(`crop=${cc.w}:${cc.h}:${cc.x}:${cc.y}`);
    if (cameraSpec.mirror !== false) steps.push('hflip');
    // fill the box without distortion
    steps.push(
      `scale=${box.w}:${box.h}:force_original_aspect_ratio=increase`,
      `crop=${box.w}:${box.h}`,
      'setsar=1',
      'format=rgba',
    );
    filters.push(`[${idx('camera')}:v]${steps.join(',')}[cam]`);
    let label = 'cam';

    if (shape !== 'rect') {
      const radius = shape === 'circle' ? 0 : Math.round(Math.min(box.w, box.h) * 0.10);
      const maskFile = path.join(workDir, `mask-cam-${shape}-${box.w}x${box.h}.png`);
      if (!fs.existsSync(maskFile)) {
        await makeMask(shape === 'circle' ? 'circle' : 'rounded', box.w, box.h, radius, maskFile);
      }
      args.push('-loop', '1', '-t', boundT, '-i', maskFile);
      inputs.push('cammask');
      filters.push(`[${idx('cammask')}:v]format=gray,scale=${box.w}:${box.h}[cmask]`);
      filters.push(`[${label}][cmask]alphamerge[camr]`);
      label = 'camr';
    }

    /* Replay the path the bubble was dragged along during the recording.
       overlay can animate x/y per frame but not width/height, so the size
       stays fixed at whatever the layout specifies. */
    let ox = String(box.x);
    let oy = String(box.y);
    const motion = simplifyMotion(cameraSpec.motion, start, duration);
    if (motion.length > 1) {
      ox = motionExpr(motion, 'x', CW, box.w);
      oy = motionExpr(motion, 'y', CH, box.h);
    }
    filters.push(`[${base}][${label}]overlay='${ox}':'${oy}':format=auto:shortest=1[vout]`);
    base = 'vout';
  }

  filters.push(`[${base}]format=yuv420p[v]`);

  /* ---- audio ----
     The voice is its own file, so the cleanup chain only ever touches the
     voice. System audio stays untouched apart from level, which is what stops
     a gate from chewing holes in music the user was demonstrating. */
  const audioParts = [];

  if (wantScreenFile && screenInfo && screenInfo.hasAudio) {
    const g = Number.isFinite(audio.systemGain) ? audio.systemGain : 0.7;
    filters.push(`[${idx('screen')}:a]volume=${g.toFixed(2)},aresample=async=1:first_pts=0[sysa]`);
    audioParts.push('[sysa]');
  }
  if (wantCamFile && camInfo && camInfo.hasAudio) {
    filters.push(`[${idx('camera')}:a]aresample=async=1:first_pts=0[cama]`);
    audioParts.push('[cama]');
  }
  if (wantMicFile && micInfo && micInfo.hasAudio) {
    const chain = voiceChain(audio.voice);
    const g = Number.isFinite(audio.micGain) ? audio.micGain : 1;
    const steps = [`volume=${g.toFixed(2)}`, ...chain, 'aresample=async=1:first_pts=0'];
    filters.push(`[${idx('mic')}:a]${steps.join(',')}[mica]`);
    audioParts.push('[mica]');
  }

  let audioOut = null;
  if (audioParts.length === 1) {
    filters.push(`${audioParts[0]}anull[a]`);
    audioOut = '[a]';
  } else if (audioParts.length > 1) {
    filters.push(`${audioParts.join('')}amix=inputs=${audioParts.length}:duration=longest:normalize=0,alimiter=limit=0.96:level=false[a]`);
    audioOut = '[a]';
  }

  args.push('-filter_complex', filters.join(';'));
  args.push('-map', '[v]');
  if (audioOut) args.push('-map', audioOut);

  args.push(
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-r', String(fps),
  );
  if (audioOut) args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');

  /* Pin the output length. Padded backgrounds and zoompan can each nudge the
     duration, and shortest= is not reliable enough on its own. */
  if (outDuration > 0) args.push('-t', outDuration.toFixed(3));

  args.push('-progress', 'pipe:2', '-nostats', out);

  // ---- run with progress ----
  const totalUs = (outDuration || 0) * 1e6;
  await run(args, (line) => {
    if (!onProgress) return;
    const m = /out_time_us=(\d+)/.exec(line) || /out_time_ms=(\d+)/.exec(line);
    if (m && totalUs > 0) {
      const done = Number(m[1]);
      onProgress({ pct: Math.max(0, Math.min(99, Math.round((done / totalUs) * 100))) });
    }
  });

  if (onProgress) onProgress({ pct: 100 });
  return { out, size: fs.statSync(out).size };
}

/* Decode an audio track down to peak pairs for the timeline waveform.
   Reading raw samples through ffmpeg is far cheaper than decoding the whole
   file in the renderer, and it happens once per recording. */
async function waveform(file, buckets = 2000) {
  if (!file || !fs.existsSync(file)) return null;
  const info = await probe(file).catch(() => null);
  if (!info || !info.hasAudio || !info.duration) return null;

  const RATE = 8000;    // plenty for a visual envelope
  const raw = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, [
      '-v', 'error', '-i', file,
      '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-',
    ]);
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(chunks)));
  });

  const samples = Math.floor(raw.length / 2);
  if (!samples) return null;
  const per = Math.max(1, Math.floor(samples / buckets));
  const peaks = [];
  for (let i = 0; i < samples; i += per) {
    let min = 0;
    let max = 0;
    const end = Math.min(samples, i + per);
    for (let j = i; j < end; j++) {
      const v = raw.readInt16LE(j * 2) / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push(Math.max(Math.abs(min), Math.abs(max)));
  }
  return { duration: info.duration, peaks };
}

/* MediaRecorder writes a live WebM stream with no duration and no cues, so
   seeking in the editor misbehaves. A stream copy rewrites the container with
   proper timing in a fraction of a second and touches none of the pixels. */
async function remux(src) {
  if (!src || !fs.existsSync(src)) return null;
  const out = src.replace(/\.webm$/, '') + '.fixed.webm';
  try {
    await run(['-y', '-fflags', '+genpts', '-i', src, '-c', 'copy', out]);
    const info = await probe(out);
    if (info.duration > 0) {
      fs.unlinkSync(src);
      return { path: out, info };
    }
    return { path: src, info: await probe(src) };
  } catch (e) {
    console.error('[smoke] remux failed, using the raw file:', e.message);
    try { return { path: src, info: await probe(src) }; }
    catch (_) { return { path: src, info: null }; }
  }
}

module.exports = { renderComposite, renderWithSegments, probe, makeMask, remux, voiceChain, waveform, FFMPEG, FFPROBE };
