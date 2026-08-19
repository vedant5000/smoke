/* First run credential screen.
   Nothing is saved until Bunny has confirmed the pair works, so the app can
   never end up holding credentials that only fail later, in the middle of a
   publish, after someone has already recorded something. */
const $ = (s) => document.querySelector(s);

const els = {
  lib: $('#lib'),
  key: $('#key'),
  cdn: $('#cdn'),
  save: $('#save'),
  status: $('#status'),
  reveal: $('#reveal'),
};

let existing = false;

const ICONS = {
  busy: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.2-8.6"/></svg>',
  ok:   '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
  err:  '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
};

function status(kind, text) {
  if (!kind) { els.status.className = 'status'; els.status.innerHTML = ''; return; }
  els.status.className = `status show ${kind}`;
  els.status.innerHTML = `${ICONS[kind]}<span></span>`;
  els.status.querySelector('span').textContent = text;
}

function busy(on) {
  els.save.disabled = on;
  els.lib.disabled = on;
  els.key.disabled = on;
  els.save.textContent = on ? 'Checking...' : (existing ? 'Save' : 'Connect');
}

/* People paste the whole dashboard URL as often as the bare number. */
function cleanLibraryId(v) {
  const s = String(v || '').trim();
  const m = /(\d{4,})/.exec(s);
  return m ? m[1] : s;
}

/* A key never contains whitespace or zero-width characters, but a key copied
   out of a wrapped chat message very often does, in the middle where trimming
   cannot reach. Clean it in the field itself so the dots visibly drop to the
   real length and you can see the paste was the problem. */
function cleanKey(v) {
  return String(v || '').replace(/[\s\u200B-\u200D\uFEFF\u00A0]/g, '');
}

async function connect() {
  const libraryId = cleanLibraryId(els.lib.value);
  const apiKey = cleanKey(els.key.value);
  const cdnHostname = els.cdn.value.trim();

  els.lib.value = libraryId;
  els.key.value = apiKey;
  els.lib.classList.remove('bad');
  els.key.classList.remove('bad');

  busy(true);
  status('busy', 'Asking Bunny to confirm these...');

  const res = await window.cue.saveBunny({ libraryId, apiKey, cdnHostname });

  if (!res.ok) {
    busy(false);
    status('err', res.error);
    /* Point at the box that is actually wrong. validate() works out which one
       it is, so trust its verdict rather than re-reading the message here. */
    if (res.kind === 'account-key') els.key.classList.add('bad');
    else if (res.kind === 'wrong-library') { els.lib.classList.add('bad'); els.key.classList.add('bad'); }
    else if (/library ID should be numbers|Enter your library/i.test(res.error)) els.lib.classList.add('bad');
    else if (/Enter your Stream API key/i.test(res.error)) els.key.classList.add('bad');
    else { els.lib.classList.add('bad'); els.key.classList.add('bad'); }
    return;
  }

  const n = res.videoCount;
  const count = n === 0 ? 'It is empty and ready' : `It has ${n} video${n === 1 ? '' : 's'} in it`;
  status('ok', `Connected to library ${res.libraryId}. ${count}.`);
  els.save.textContent = 'Done';

  setTimeout(() => window.cue.setupDone(), 900);
}

els.save.onclick = connect;

els.reveal.onclick = () => {
  const shown = els.key.type === 'text';
  els.key.type = shown ? 'password' : 'text';
  els.reveal.textContent = shown ? 'Show' : 'Hide';
};

for (const el of [els.lib, els.key, els.cdn]) {
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
  el.addEventListener('input', () => { el.classList.remove('bad'); });
}

/* Clean a pasted key immediately rather than waiting for Connect, so what you
   see in the box is what actually gets sent. */
els.key.addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  e.preventDefault();
  els.key.value = cleanKey(text);
  els.key.classList.remove('bad');
});

$('#dash').onclick = () => window.cue.openExternal('https://dash.bunny.net/stream');
$('#close').onclick = () => window.cue.setupCancel();

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.cue.setupCancel();
});

/* Reopened from the tray to change credentials: prefill and say so, rather than
   presenting a first run screen to someone who is already set up. */
(async () => {
  const info = await window.cue.info();
  if (info.bunnyConfigured) {
    existing = true;
    els.lib.value = info.libraryId || '';
    els.key.value = info.apiKey || '';
    els.cdn.value = info.cdnHostname || '';
    els.save.textContent = 'Save';
    document.querySelector('#lede-title').textContent = 'Bunny Credentials';
    document.querySelector('#lede-copy').textContent =
      'Recordings publish to this library. Change these to point Smoke somewhere else.';
  }
  els.lib.focus();
})();
