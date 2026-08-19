/* Smoke - tab capture service worker.
   A service worker cannot touch MediaRecorder, so the actual capture happens
   in an offscreen document. This file only brokers the stream id and state. */

const OFFSCREEN = 'offscreen.html';

let state = { recording: false, tabId: null, startedAt: 0 };

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN,
    reasons: ['USER_MEDIA'],
    justification: 'Recording the active tab and uploading it to Bunny Stream.',
  });
}

async function startRecording({ tabId, micEnabled }) {
  if (state.recording) throw new Error('Already recording');

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();

  const settings = await chrome.storage.local.get(['libraryId', 'apiKey', 'cdnHostname']);
  if (!settings.libraryId || !settings.apiKey) {
    throw new Error('Add your Bunny library id and key in the extension settings first');
  }

  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    micEnabled: Boolean(micEnabled),
  });
  if (!res || !res.ok) throw new Error((res && res.why) || 'Could not start the capture');

  state = { recording: true, tabId, startedAt: Date.now() };
  chrome.action.setBadgeText({ text: 'REC' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5a5f' });
  return { ok: true };
}

async function stopRecording() {
  if (!state.recording) return { ok: false, why: 'Not recording' };
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  state = { recording: false, tabId: null, startedAt: 0 };
  chrome.action.setBadgeText({ text: '' });
  return res || { ok: false };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'background') return false;

  (async () => {
    try {
      if (msg.type === 'start') return sendResponse(await startRecording(msg));
      if (msg.type === 'stop') return sendResponse(await stopRecording());
      if (msg.type === 'state') {
        return sendResponse({
          ok: true,
          recording: state.recording,
          elapsed: state.recording ? Date.now() - state.startedAt : 0,
        });
      }
      sendResponse({ ok: false, why: 'Unknown message' });
    } catch (e) {
      sendResponse({ ok: false, why: String((e && e.message) || e) });
    }
  })();

  return true;   // keep the channel open for the async reply
});

/* the offscreen document reports upload progress and the finished link */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup-relay') return;
  chrome.runtime.sendMessage({ target: 'popup', ...msg }).catch(() => {});
});
