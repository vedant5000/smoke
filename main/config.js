const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/* Reads .env from userData first, then the app directory (dev), then Resources
   (packaged). userData wins because that is where the in-app setup screen saves
   what you type, and credentials you entered must always beat a stale copy that
   happened to be bundled at build time.
   Credentials never live in source - .env is gitignored. */
function userEnvPath() {
  return path.join(app.getPath('userData'), '.env');
}

function envPaths() {
  return [
    userEnvPath(),
    path.join(__dirname, '..', '.env'),
    path.join(process.resourcesPath || '', '.env'),
  ];
}

function loadEnv() {
  for (const p of envPaths()) {
    if (!p || !fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
    return p;
  }
  return null;
}

const loadedFrom = loadEnv();

const bunny = {
  libraryId: process.env.BUNNY_LIBRARY_ID || '',
  apiKey: process.env.BUNNY_STREAM_API_KEY || '',
  cdnHostname: process.env.BUNNY_CDN_HOSTNAME || '',
};

/* The CDN hostname is deliberately NOT required. Share and embed links run
   through iframe.mediadelivery.net and only need the library id, so the app is
   fully usable with the two values you can copy off one Bunny page. The
   hostname only adds the direct MP4/HLS/thumbnail links, and it is discovered
   automatically from the first video the library ever returns. */
function bunnyConfigured() {
  return Boolean(bunny.libraryId && bunny.apiKey);
}

/* Persist credentials to userData/.env and update the live object in place.
   In place matters: bunny.js reads these properties at call time, so an
   existing require() picks the new values up with no restart. */
function saveBunny({ libraryId, apiKey, cdnHostname }) {
  const next = {
    libraryId: String(libraryId || '').trim(),
    apiKey: String(apiKey || '').trim(),
    cdnHostname: String(cdnHostname || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
  };

  const body = [
    '# Smoke - Bunny.net Stream credentials.',
    '# Written by the in-app setup screen. Safe to edit by hand.',
    `BUNNY_LIBRARY_ID=${next.libraryId}`,
    `BUNNY_STREAM_API_KEY=${next.apiKey}`,
    `BUNNY_CDN_HOSTNAME=${next.cdnHostname}`,
    '',
  ].join('\n');

  const file = userEnvPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o600 });   // credentials, not world readable

  Object.assign(bunny, next);
  process.env.BUNNY_LIBRARY_ID = next.libraryId;
  process.env.BUNNY_STREAM_API_KEY = next.apiKey;
  process.env.BUNNY_CDN_HOSTNAME = next.cdnHostname;
  return { ...next, savedTo: file };
}

/* Fill in the CDN hostname once we learn it, without disturbing the rest. */
function rememberCdnHostname(hostname) {
  const h = String(hostname || '').trim();
  if (!h || bunny.cdnHostname === h) return false;
  saveBunny({ ...bunny, cdnHostname: h });
  return true;
}

/* ---------- user settings ---------- */
let settingsPath = null;
const defaults = {
  micId: 'default',
  cameraId: '',
  systemAudio: true,
  micEnabled: true,
  cameraEnabled: true,
  cameraShape: 'circle',
  cameraSize: 220,
  countdown: 3,
  mode: 'studio',          // 'studio' = camera composited later, 'burn' = camera burned in live
  autoUpload: true,
  autoCopyLink: true,
  saveLocalCopy: true,
};

function settingsFile() {
  if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
  return settingsPath;
}

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsFile(), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
  } catch (_) {
    return { ...defaults };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[smoke] could not save settings:', e.message);
  }
  return next;
}

/* ---------- recording scratch dir ---------- */
function recordingsDir() {
  const dir = path.join(app.getPath('userData'), 'recordings');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  bunny,
  bunnyConfigured,
  saveBunny,
  rememberCdnHostname,
  userEnvPath,
  loadedFrom,
  readSettings,
  writeSettings,
  recordingsDir,
  defaults,
};
