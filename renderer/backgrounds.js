/* Smoke - background presets.
   angle is in degrees: 0 points right, 90 points down, 135 is the diagonal
   from top left to bottom right. Both the canvas preview and the ffmpeg
   render resolve it with the same maths, so what you pick is what you get. */

const BACKGROUNDS = [
  // --- solids ---
  { id: 'cue',        name: 'Cue Black',    type: 'solid',    colors: ['#08090b'] },
  { id: 'slate',      name: 'Slate',        type: 'solid',    colors: ['#1c1f26'] },
  { id: 'paper',      name: 'Paper',        type: 'solid',    colors: ['#f4f6fb'] },

  // --- gradients ---
  { id: 'periwinkle', name: 'Periwinkle',   type: 'gradient', angle: 135, colors: ['#2b2f6b', '#6d7bff'] },
  { id: 'nightfall',  name: 'Nightfall',    type: 'gradient', angle: 135, colors: ['#08090b', '#2b2f6b', '#6d7bff'] },
  { id: 'violet',     name: 'Violet Haze',  type: 'gradient', angle: 135, colors: ['#1f0f3d', '#8e2de2'] },
  { id: 'plum',       name: 'Plum',         type: 'gradient', angle: 135, colors: ['#2d0b3a', '#d946ef'] },
  { id: 'dusk',       name: 'Dusk',         type: 'gradient', angle: 160, colors: ['#1a1140', '#7b4397', '#dc2430'] },
  { id: 'ocean',      name: 'Ocean',        type: 'gradient', angle: 135, colors: ['#05203c', '#2193b0'] },
  { id: 'deepsea',    name: 'Deep Sea',     type: 'gradient', angle: 120, colors: ['#020617', '#0e7490', '#22d3ee'] },
  { id: 'aurora',     name: 'Aurora',       type: 'gradient', angle: 135, colors: ['#0b3d3b', '#35d69b'] },
  { id: 'mint',       name: 'Mint',         type: 'gradient', angle: 135, colors: ['#06281f', '#4ade80'] },
  { id: 'ember',      name: 'Ember',        type: 'gradient', angle: 135, colors: ['#2b1220', '#ff5a5f'] },
  { id: 'sunset',     name: 'Sunset',       type: 'gradient', angle: 150, colors: ['#3d1a2b', '#ff7e5f', '#feb47b'] },
  { id: 'mango',      name: 'Mango',        type: 'gradient', angle: 135, colors: ['#3a1c00', '#f3b34a'] },
  { id: 'rose',       name: 'Rose',         type: 'gradient', angle: 135, colors: ['#3b0d24', '#fb7185'] },
  { id: 'steel',      name: 'Steel',        type: 'gradient', angle: 135, colors: ['#0f172a', '#64748b'] },
  { id: 'graphite',   name: 'Graphite',     type: 'gradient', angle: 135, colors: ['#111318', '#2f3540'] },
  { id: 'linen',      name: 'Linen',        type: 'gradient', angle: 135, colors: ['#f4f6fb', '#cbd3e1'] },
];

/* Start and end points of the gradient line across a WxH box. */
function gradientLine(angle, W, H) {
  const rad = (Number(angle) || 135) * Math.PI / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  const L = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  return {
    x0: W / 2 - dx * L,
    y0: H / 2 - dy * L,
    x1: W / 2 + dx * L,
    y1: H / 2 + dy * L,
  };
}

/* Mesh gradients: several colour points blended by inverse-distance weighting.
   Softer and richer than a straight linear ramp. The same maths runs in the
   preview and in the bake, so a mesh looks identical in Studio and in the file. */
const MESHES = [
  { id: 'm-sunrise', name: 'Sunrise', points: [
    { x: 0.1, y: 0.0, c: '#12163a' }, { x: 0.9, y: 0.1, c: '#3b1d54' },
    { x: 0.2, y: 1.0, c: '#f2673f' }, { x: 1.0, y: 0.9, c: '#ffb26b' } ] },
  { id: 'm-cotton', name: 'Cotton', points: [
    { x: 0.0, y: 0.1, c: '#7db7ff' }, { x: 1.0, y: 0.0, c: '#f5d0e8' },
    { x: 0.15, y: 1.0, c: '#ffd9c0' }, { x: 0.95, y: 0.95, c: '#b48cf0' } ] },
  { id: 'm-aurora', name: 'Aurora mesh', points: [
    { x: 0.05, y: 0.15, c: '#06253a' }, { x: 0.95, y: 0.0, c: '#0e7490' },
    { x: 0.3, y: 1.0, c: '#35d69b' }, { x: 1.0, y: 0.85, c: '#6d7bff' } ] },
  { id: 'm-ember', name: 'Ember mesh', points: [
    { x: 0.5, y: 0.0, c: '#08090b' }, { x: 0.0, y: 0.8, c: '#3b0d18' },
    { x: 0.55, y: 1.05, c: '#ff6a3d' }, { x: 1.0, y: 0.7, c: '#7a1428' } ] },
  { id: 'm-lagoon', name: 'Lagoon', points: [
    { x: 0.0, y: 0.0, c: '#0b1e3f' }, { x: 1.0, y: 0.15, c: '#1f6f8b' },
    { x: 0.2, y: 1.0, c: '#22d3ee' }, { x: 0.9, y: 1.0, c: '#0b3a53' } ] },
  { id: 'm-blossom', name: 'Blossom', points: [
    { x: 0.0, y: 0.2, c: '#3b0d24' }, { x: 1.0, y: 0.0, c: '#d946ef' },
    { x: 0.25, y: 1.0, c: '#fb7185' }, { x: 1.0, y: 1.0, c: '#ffd6a5' } ] },
  { id: 'm-graphite', name: 'Graphite mesh', points: [
    { x: 0.0, y: 0.0, c: '#0d1016' }, { x: 1.0, y: 0.1, c: '#2b3140' },
    { x: 0.3, y: 1.0, c: '#414a5e' }, { x: 1.0, y: 1.0, c: '#161a22' } ] },
  { id: 'm-citrus', name: 'Citrus', points: [
    { x: 0.0, y: 0.1, c: '#1d3b18' }, { x: 1.0, y: 0.0, c: '#84cc16' },
    { x: 0.2, y: 1.0, c: '#fde047' }, { x: 1.0, y: 0.95, c: '#16a34a' } ] },
  { id: 'm-orchid', name: 'Orchid', points: [
    { x: 0.1, y: 0.0, c: '#1a1140' }, { x: 1.0, y: 0.2, c: '#7b4397' },
    { x: 0.0, y: 1.0, c: '#4c1d95' }, { x: 0.9, y: 1.0, c: '#dc2430' } ] },
  { id: 'm-porcelain', name: 'Porcelain', points: [
    { x: 0.0, y: 0.0, c: '#ffffff' }, { x: 1.0, y: 0.15, c: '#e7ecf5' },
    { x: 0.2, y: 1.0, c: '#dfe6f2' }, { x: 1.0, y: 1.0, c: '#c8d3e6' } ] },
  { id: 'm-dusk2', name: 'Deep dusk', points: [
    { x: 0.0, y: 0.0, c: '#05060a' }, { x: 1.0, y: 0.0, c: '#131a3a' },
    { x: 0.35, y: 1.0, c: '#6d7bff' }, { x: 1.0, y: 1.0, c: '#2b1b4d' } ] },
  { id: 'm-clay', name: 'Clay', points: [
    { x: 0.0, y: 0.05, c: '#2b1a12' }, { x: 1.0, y: 0.0, c: '#7c4a2d' },
    { x: 0.2, y: 1.0, c: '#e0a075' }, { x: 1.0, y: 1.0, c: '#3d2418' } ] },
];

function hexToRgb(hex) {
  const h = String(hex || '#000').replace('#', '');
  const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(f.slice(0, 2), 16) || 0, parseInt(f.slice(2, 4), 16) || 0, parseInt(f.slice(4, 6), 16) || 0];
}

const MESH_EPS = 0.035;
function meshColorAt(points, u, v) {
  let wr = 0, wg = 0, wb = 0, sum = 0;
  for (const p of points) {
    const dx = u - p.x;
    const dy = v - p.y;
    const w = 1 / (dx * dx + dy * dy + MESH_EPS);
    const rgb = p.rgb || (p.rgb = hexToRgb(p.c));
    wr += w * rgb[0]; wg += w * rgb[1]; wb += w * rgb[2]; sum += w;
  }
  return [wr / sum, wg / sum, wb / sum];
}

/* Pixel buffer for the preview and for the picker swatches. */
function meshPixels(points, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  let i = 0;
  for (let y = 0; y < h; y++) {
    const v = h === 1 ? 0 : y / (h - 1);
    for (let x = 0; x < w; x++) {
      const u = w === 1 ? 0 : x / (w - 1);
      const c = meshColorAt(points, u, v);
      out[i++] = c[0]; out[i++] = c[1]; out[i++] = c[2]; out[i++] = 255;
    }
  }
  return out;
}

/* Every mesh also appears in the flat BACKGROUNDS list so one picker shows all. */
for (const m of MESHES) {
  BACKGROUNDS.push({ id: m.id, name: m.name, group: 'Mesh', type: 'mesh', points: m.points, colors: m.points.map((p) => p.c) });
}

/* CSS for the picker swatches. Meshes get layered radial gradients, which is
   a close enough stand-in at thumbnail size. */
function toCss(bg) {
  if (!bg) return 'transparent';
  if (bg.type === 'mesh' && bg.points) {
    const layers = bg.points.map((p) =>
      `radial-gradient(circle at ${(p.x * 100).toFixed(0)}% ${(p.y * 100).toFixed(0)}%, ${p.c} 0%, transparent 62%)`);
    return `${layers.join(', ')}, ${bg.points[0].c}`;
  }
  if (bg.type === 'solid' || !bg.colors || bg.colors.length < 2) return (bg.colors && bg.colors[0]) || '#08090b';
  return `linear-gradient(${(Number(bg.angle) || 135) + 90}deg, ${bg.colors.join(', ')})`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BACKGROUNDS, MESHES, gradientLine, toCss, meshColorAt, meshPixels, hexToRgb, MESH_EPS };
}
