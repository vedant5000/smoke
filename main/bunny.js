const https = require('https');
const fs = require('fs');
const { bunny } = require('./config');

const API_HOST = 'video.bunnycdn.com';

function request(method, path, { body, headers = {}, json = true, creds = null } = {}) {
  const use = creds || bunny;
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      host: API_HOST,
      path,
      method,
      timeout: 30_000,          // metadata calls are small; never wait forever
      headers: {
        AccessKey: use.apiKey,
        accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Bunny ${method} ${path} failed (${res.statusCode}): ${data.slice(0, 300)}`));
        }
        if (!json) return resolve(data);
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (_) { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Bunny did not respond to ${method} ${path}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

/* Create the video record, which reserves the guid we upload into. */
async function createVideo(title, collectionId) {
  const body = { title: String(title || 'Untitled recording').slice(0, 200) };
  if (collectionId) body.collectionId = collectionId;
  const res = await request('POST', `/library/${bunny.libraryId}/videos`, { body });
  if (!res || !res.guid) throw new Error('Bunny did not return a video guid');
  return res.guid;
}

/* Streamed PUT upload with byte-level progress.
   Bunny accepts the whole file on a single PUT against the reserved guid.

   The socket carries an inactivity timeout. Without one, a response that never
   arrives leaves the upload hanging forever with no error and no way out, which
   is exactly what happened once: Bunny had the file and had finished encoding
   while the app sat waiting at zero CPU. */
const UPLOAD_IDLE_MS = 90_000;

function uploadVideo(guid, filePath, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(filePath).size;
    if (!total) return reject(new Error('Recording file is empty'));
    let sent = 0;
    let settled = false;

    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    const req = https.request({
      host: API_HOST,
      path: `/library/${bunny.libraryId}/videos/${guid}`,
      method: 'PUT',
      headers: {
        AccessKey: bunny.apiKey,
        'Content-Type': 'application/octet-stream',
        'Content-Length': total,
      },
      timeout: UPLOAD_IDLE_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return done(reject, new Error(`Bunny upload failed (${res.statusCode}): ${data.slice(0, 300)}`));
        }
        if (onProgress) onProgress({ sent: total, total, pct: 100 });
        done(resolve, { guid, bytes: total });
      });
    });

    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => {
      req.destroy();
      done(reject, new Error(
        `Bunny stopped responding after ${Math.round(sent / 1e6)}MB of ${Math.round(total / 1e6)}MB. ` +
        'Check your connection and publish again.',
      ));
    });

    const stream = fs.createReadStream(filePath);
    stream.on('error', (e) => { req.destroy(); done(reject, e); });
    stream.on('data', (chunk) => {
      sent += chunk.length;
      if (onProgress) onProgress({ sent, total, pct: Math.min(99, Math.round((sent / total) * 100)) });
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        stream.destroy();
        req.destroy();
        done(reject, new Error('Upload cancelled'));
      }, { once: true });
    }

    stream.pipe(req);
  });
}

async function getVideo(guid) {
  return request('GET', `/library/${bunny.libraryId}/videos/${guid}`);
}

async function deleteVideo(guid) {
  return request('DELETE', `/library/${bunny.libraryId}/videos/${guid}`);
}

async function setTitle(guid, title) {
  return request('POST', `/library/${bunny.libraryId}/videos/${guid}`, { body: { title } });
}

/* Bunny transcodes after upload. status 3/4 = playable, 5 = failed. */
/* Poll until the video is playable. Repeated poll failures are surfaced rather
   than swallowed, so a broken connection reads as an error instead of a
   progress bar that sits still until the timeout expires. */
async function waitUntilPlayable(guid, { timeoutMs = 10 * 60 * 1000, onTick } = {}) {
  const started = Date.now();
  let consecutiveFailures = 0;
  let lastError = null;

  while (Date.now() - started < timeoutMs) {
    let v = null;
    try {
      v = await getVideo(guid);
      consecutiveFailures = 0;
    } catch (e) {
      lastError = e;
      if (++consecutiveFailures >= 5) {
        throw new Error(`Lost contact with Bunny while it was encoding: ${e.message}`);
      }
    }
    if (v) {
      const status = v.status;
      if (onTick) onTick({ status, encodeProgress: v.encodeProgress || 0 });
      if (status === 3 || status === 4) return v;      // finished / resolution ready
      if (status === 5) throw new Error('Bunny failed to encode this video');
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    'Timed out waiting for Bunny to finish encoding'
    + (lastError ? ` (last error: ${lastError.message})` : '')
    + '. The upload itself succeeded, so check the Bunny dashboard.',
  );
}

/* ---------------- credential setup ----------------
   Used by the first run screen, before these credentials are adopted as the
   app's own. GET /library/{id} is the cheapest call that proves both the
   library id and the key are right: a wrong key gives 401, a wrong library
   gives 404, and a good pair gives a small counts object. */
async function validate({ libraryId, apiKey }) {
  const id = String(libraryId || '').trim();
  const key = String(apiKey || '').trim();
  if (!id) return { ok: false, error: 'Enter your library ID.' };
  if (!/^\d+$/.test(id)) return { ok: false, error: 'The library ID should be numbers only, like 123456.' };
  if (!key) return { ok: false, error: 'Enter your Stream API key.' };

  try {
    const info = await request('GET', `/library/${id}`, { creds: { apiKey: key } });
    return { ok: true, videoCount: info.videoCount || 0 };
  } catch (e) {
    const msg = String(e.message || '');
    /* Bunny answers 401 both for a bad key AND for a key that belongs to a
       different library, so the message must not blame one field: pointing at
       the key alone sends people hunting through the wrong box. */
    if (msg.includes('(401)') || msg.includes('(403)') || msg.includes('(404)')) {
      return {
        ok: false,
        error: `Bunny would not accept library ${id} with that key. They have to be from the same library: open it in the Bunny dashboard, go to API, and copy both values from that page.`,
      };
    }
    if (/did not respond|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      return { ok: false, error: 'Could not reach Bunny. Check your internet connection.' };
    }
    return { ok: false, error: msg.replace(/^Bunny GET [^:]+: /, '') };
  }
}

/* The pull zone hostname is not exposed by any endpoint this key can reach,
   but every video carries it inside thumbnailUrl. Read it off the newest one.
   Returns '' for an empty library, which is fine: the first publish fills it in. */
function hostnameFromThumbnail(url) {
  const m = /^https?:\/\/([^/]+)\//.exec(String(url || ''));
  return m ? m[1] : '';
}

async function discoverCdnHostname({ libraryId, apiKey } = {}) {
  const creds = libraryId ? { apiKey: String(apiKey || '').trim() } : null;
  const id = libraryId ? String(libraryId).trim() : bunny.libraryId;
  try {
    const res = await request('GET', `/library/${id}/videos?page=1&itemsPerPage=1`, { creds });
    const item = (res.items || [])[0];
    return item ? hostnameFromThumbnail(item.thumbnailUrl) : '';
  } catch (_) {
    return '';
  }
}

/* Share and embed only need the library id. The direct file links need the
   pull zone hostname, which is optional, so they are omitted rather than built
   into something broken like "https://undefined/...". */
function urls(guid) {
  const lib = bunny.libraryId;
  const cdn = bunny.cdnHostname;
  return {
    share:     `https://iframe.mediadelivery.net/play/${lib}/${guid}`,
    embed:     `https://iframe.mediadelivery.net/embed/${lib}/${guid}`,
    hls:       cdn ? `https://${cdn}/${guid}/playlist.m3u8` : null,
    mp4:       cdn ? `https://${cdn}/${guid}/play_720p.mp4` : null,
    thumbnail: cdn ? `https://${cdn}/${guid}/thumbnail.jpg` : null,
    iframe:    `<iframe src="https://iframe.mediadelivery.net/embed/${lib}/${guid}?autoplay=false" loading="lazy" style="border:0;width:100%;aspect-ratio:16/9" allow="encrypted-media;picture-in-picture" allowfullscreen></iframe>`,
  };
}

module.exports = {
  validate,
  discoverCdnHostname,
  hostnameFromThumbnail,
  createVideo,
  uploadVideo,
  getVideo,
  deleteVideo,
  setTitle,
  waitUntilPlayable,
  urls,
};
