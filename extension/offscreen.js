/* Smoke - offscreen capture document.
   Owns the MediaRecorder and the upload, because a service worker can do
   neither. Talks to the popup through the background worker. */

let recorder = null;
let chunks = [];
let streams = [];
let audioCtx = null;

const relay = (payload) => {
  chrome.runtime.sendMessage({ target: 'popup-relay', ...payload }).catch(() => {});
};

function pickMime() {
  for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

async function start({ streamId, micEnabled }) {
  const tabStream = await navigator.mediaDevices.getUserMedia({
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
  });
  streams.push(tabStream);

  /* Capturing a tab silences it for the user. Pipe the audio back to the
     speakers so you can still hear what you are demonstrating. */
  audioCtx = new AudioContext();
  const tabAudio = audioCtx.createMediaStreamSource(tabStream);
  tabAudio.connect(audioCtx.destination);

  const dest = audioCtx.createMediaStreamDestination();
  tabAudio.connect(dest);

  if (micEnabled) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streams.push(micStream);
      audioCtx.createMediaStreamSource(micStream).connect(dest);
    } catch (e) {
      console.warn('[cue] microphone unavailable:', e.message);
    }
  }

  const tracks = [tabStream.getVideoTracks()[0], ...dest.stream.getAudioTracks()];
  chunks = [];
  recorder = new MediaRecorder(new MediaStream(tracks), {
    mimeType: pickMime(),
    videoBitsPerSecond: 8_000_000,
  });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(2000);

  // stop cleanly if the user ends sharing from Chrome's own bar
  tabStream.getVideoTracks()[0].addEventListener('ended', () => stop());
  return { ok: true };
}

function cleanup() {
  for (const s of streams) { try { s.getTracks().forEach((t) => t.stop()); } catch (_) {} }
  streams = [];
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
}

async function stop() {
  if (!recorder) return { ok: false, why: 'Not recording' };

  await new Promise((resolve) => {
    recorder.onstop = resolve;
    if (recorder.state !== 'inactive') recorder.stop();
    else resolve();
  });
  cleanup();

  const blob = new Blob(chunks, { type: 'video/webm' });
  recorder = null;
  chunks = [];

  if (!blob.size) return { ok: false, why: 'Nothing was captured' };

  try {
    const links = await publish(blob);
    relay({ type: 'done', links });
    return { ok: true, links };
  } catch (e) {
    const why = String((e && e.message) || e);
    relay({ type: 'error', why });
    return { ok: false, why };
  }
}

async function publish(blob) {
  const { libraryId, apiKey, cdnHostname } = await chrome.storage.local.get(['libraryId', 'apiKey', 'cdnHostname']);

  relay({ type: 'progress', stage: 'creating', pct: 0 });
  const createRes = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos`, {
    method: 'POST',
    headers: { AccessKey: apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `Tab recording ${new Date().toLocaleString()}` }),
  });
  if (!createRes.ok) throw new Error(`Bunny rejected the create call (${createRes.status})`);
  const { guid } = await createRes.json();

  relay({ type: 'progress', stage: 'uploading', pct: 0 });
  const upload = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${guid}`, {
    method: 'PUT',
    headers: { AccessKey: apiKey, 'Content-Type': 'application/octet-stream' },
    body: blob,
  });
  if (!upload.ok) throw new Error(`Upload failed (${upload.status})`);

  relay({ type: 'progress', stage: 'encoding', pct: 50 });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = await fetch(`https://video.bunnycdn.com/library/${libraryId}/videos/${guid}`, {
      headers: { AccessKey: apiKey },
    });
    if (!st.ok) continue;
    const v = await st.json();
    relay({ type: 'progress', stage: 'encoding', pct: 50 + (v.encodeProgress || 0) / 2 });
    if (v.status === 3 || v.status === 4) break;
    if (v.status === 5) throw new Error('Bunny failed to encode this recording');
  }

  return {
    share: `https://iframe.mediadelivery.net/play/${libraryId}/${guid}`,
    embed: `https://iframe.mediadelivery.net/embed/${libraryId}/${guid}`,
    mp4: cdnHostname ? `https://${cdnHostname}/${guid}/play_720p.mp4` : '',
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  (async () => {
    try {
      if (msg.type === 'start') return sendResponse(await start(msg));
      if (msg.type === 'stop') return sendResponse(await stop());
      sendResponse({ ok: false, why: 'Unknown message' });
    } catch (e) {
      cleanup();
      sendResponse({ ok: false, why: String((e && e.message) || e) });
    }
  })();
  return true;
});
