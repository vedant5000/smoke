/* Smoke - layout model.
   Both the canvas preview and the ffmpeg render resolve layouts through this
   file, so what you arrange in Studio is exactly what gets encoded.

   Everything is normalised 0..1 against the canvas. A layout preset simply
   computes a rect for the screen and a rect for the camera; once a preset is
   applied you are free to drag or resize either one without leaving it. */

const LAYOUTS = [
  {
    id: 'screen',
    name: 'Screen only',
    group: 'Screen',
    screen: { x: 0, y: 0, w: 1, h: 1 },
    camera: null,
  },
  {
    id: 'bubble',
    name: 'Camera bubble',
    group: 'Camera Bubble',
    screen: { x: 0, y: 0, w: 1, h: 1 },
    camera: { x: 0.74, y: 0.68, w: 0.22, h: 0.22 },
    shape: 'circle',
  },
  {
    id: 'bubble-left',
    name: 'Bubble, left',
    group: 'Camera Bubble',
    screen: { x: 0, y: 0, w: 1, h: 1 },
    camera: { x: 0.04, y: 0.68, w: 0.22, h: 0.22 },
    shape: 'circle',
  },
  {
    id: 'side',
    name: 'Side by side',
    group: 'Side by Side',
    screen: { x: 0, y: 0.125, w: 0.5, h: 0.75 },
    camera: { x: 0.5, y: 0, w: 0.5, h: 1 },
    shape: 'rect',
  },
  {
    id: 'side-left',
    name: 'Side, camera left',
    group: 'Side by Side',
    screen: { x: 0.5, y: 0.125, w: 0.5, h: 0.75 },
    camera: { x: 0, y: 0, w: 0.5, h: 1 },
    shape: 'rect',
  },
  {
    id: 'overlap',
    name: 'Overlap',
    group: 'Side by Side',
    screen: { x: 0, y: 0.06, w: 0.78, h: 0.88 },
    camera: { x: 0.66, y: 0.2, w: 0.3, h: 0.6 },
    shape: 'rounded',
  },
  {
    id: 'tv',
    name: 'TV presenter',
    group: 'TV Presenter',
    screen: { x: 0.02, y: 0.14, w: 0.64, h: 0.72 },
    camera: { x: 0.66, y: 0, w: 0.34, h: 1 },
    shape: 'rect',
  },
  {
    id: 'tv-inset',
    name: 'TV, inset',
    group: 'TV Presenter',
    screen: { x: 0.04, y: 0.18, w: 0.58, h: 0.64 },
    camera: { x: 0.62, y: 0.08, w: 0.34, h: 0.84 },
    shape: 'rounded',
  },
  {
    id: 'camera',
    name: 'Camera only',
    group: 'Camera',
    screen: null,
    camera: { x: 0, y: 0, w: 1, h: 1 },
    shape: 'rect',
  },
];

const CAM_SIZES = { S: 0.78, M: 1, L: 1.3 };

/* Apply a preset, scaling the camera rect around its own centre for S/M/L. */
function applyLayout(preset, sizeKey = 'M') {
  const k = CAM_SIZES[sizeKey] || 1;
  const out = {
    id: preset.id,
    shape: preset.shape || 'rect',
    screen: preset.screen ? { ...preset.screen } : null,
    camera: preset.camera ? { ...preset.camera } : null,
  };
  // only free-floating cameras rescale; a side or TV panel is meant to fill
  if (out.camera && (preset.id === 'bubble' || preset.id === 'bubble-left' || preset.id === 'overlap') && k !== 1) {
    const cx = out.camera.x + out.camera.w / 2;
    const cy = out.camera.y + out.camera.h / 2;
    out.camera.w *= k;
    out.camera.h *= k;
    out.camera.x = cx - out.camera.w / 2;
    out.camera.y = cy - out.camera.h / 2;
  }
  return out;
}

/* Resolve normalised rects to canvas pixels, inset by the background padding.
   Even dimensions throughout, because encoders reject odd ones. */
function toPixels(rect, canvas, pad = 0) {
  if (!rect) return null;
  const innerX = pad;
  const innerY = pad;
  const innerW = canvas.w - pad * 2;
  const innerH = canvas.h - pad * 2;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return {
    x: Math.round(innerX + rect.x * innerW),
    y: Math.round(innerY + rect.y * innerH),
    w: even(rect.w * innerW),
    h: even(rect.h * innerH),
  };
}

/* A circle has to stay round, so clamp the box to a square on the short side. */
function squareForCircle(px) {
  if (!px) return px;
  const d = Math.min(px.w, px.h);
  return {
    x: Math.round(px.x + (px.w - d) / 2),
    y: Math.round(px.y + (px.h - d) / 2),
    w: d,
    h: d,
  };
}

/* Resolve a normalised crop against a source's real pixel dimensions. */
function resolveCrop(crop, srcW, srcH) {
  if (!crop) return null;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  const x = Math.max(0, Math.round((crop.nx || 0) * srcW));
  const y = Math.max(0, Math.round((crop.ny || 0) * srcH));
  const w = even(Math.min(srcW - x, (crop.nw != null ? crop.nw : 1) * srcW));
  const h = even(Math.min(srcH - y, (crop.nh != null ? crop.nh : 1) * srcH));
  if (w < 2 || h < 2) return null;
  // a full-frame crop is not worth a filter
  if (x === 0 && y === 0 && w >= srcW - 1 && h >= srcH - 1) return null;
  return { x, y, w, h };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LAYOUTS, CAM_SIZES, applyLayout, toPixels, squareForCircle, resolveCrop };
}
