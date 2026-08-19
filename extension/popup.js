const $ = (s) => document.querySelector(s);

let tab = null;
let micEnabled = false;
let timerId = null;

const send = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg });

function fmt(ms) {
  const t = Math.floor(ms / 1000);
  const m = Math.floor(t / 60);
  return `${m}:${String(t % 60).padStart(2, '0')}`;
}

function setStatus(text, cls = '') {
  $('#statusText').textContent = text;
  $('#statusChip').className = 'chip ' + cls;
}

async function boot() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    $('#tabTitle').textContent = tab.title || tab.url;
    if (tab.favIconUrl) $('#favicon').src = tab.favIconUrl;
  }

  const cfg = await chrome.storage.local.get(['libraryId', 'apiKey', 'cdnHostname']);
  if (!cfg.libraryId || !cfg.apiKey) {
    setStatus('Setup needed');
    showSettings();
  } else {
    setStatus('Library ' + cfg.libraryId, 'good');
  }

  const st = await send({ type: 'state' });
  if (st && st.recording) enterRecordingUI(st.elapsed);
}

function showSettings() {
  $('#main').classList.add('hide');
  $('#settings').classList.remove('hide');
  chrome.storage.local.get(['libraryId', 'apiKey', 'cdnHostname']).then((c) => {
    $('#libraryId').value = c.libraryId || '';
    $('#apiKey').value = c.apiKey || '';
    $('#cdnHostname').value = c.cdnHostname || '';
  });
}

$('#openSettings').onclick = showSettings;
$('#backToMain').onclick = () => {
  $('#settings').classList.add('hide');
  $('#main').classList.remove('hide');
};

$('#saveSettings').onclick = async () => {
  await chrome.storage.local.set({
    libraryId: $('#libraryId').value.trim(),
    apiKey: $('#apiKey').value.trim(),
    cdnHostname: $('#cdnHostname').value.trim().replace(/^https?:\/\//, ''),
  });
  setStatus('Saved', 'good');
  $('#settings').classList.add('hide');
  $('#main').classList.remove('hide');
};

$('#micBtn').onclick = () => {
  micEnabled = !micEnabled;
  $('#micBtn').classList.toggle('on', micEnabled);
};

function enterRecordingUI(elapsed = 0) {
  $('#startBtn').classList.add('hide');
  $('#stopBtn').classList.remove('hide');
  $('#micBtn').disabled = true;
  $('#timer').classList.remove('hide');
  setStatus('Recording', 'rec');
  const started = Date.now() - elapsed;
  clearInterval(timerId);
  timerId = setInterval(() => { $('#timer').textContent = fmt(Date.now() - started); }, 250);
}

function exitRecordingUI() {
  clearInterval(timerId);
  $('#stopBtn').classList.add('hide');
  $('#startBtn').classList.remove('hide');
  $('#micBtn').disabled = false;
  $('#timer').classList.add('hide');
}

$('#startBtn').onclick = async () => {
  $('#startBtn').disabled = true;
  const r = await send({ type: 'start', tabId: tab.id, micEnabled });
  $('#startBtn').disabled = false;
  if (!r || !r.ok) {
    $('#stageNote').classList.remove('hide');
    $('#stageNote').innerHTML = '<b>Could not start.</b> ' + ((r && r.why) || 'Unknown error');
    return;
  }
  enterRecordingUI();
};

$('#stopBtn').onclick = async () => {
  $('#stopBtn').disabled = true;
  exitRecordingUI();
  setStatus('Publishing');
  $('#progress').classList.remove('hide');
  $('#stageNote').classList.remove('hide');
  $('#stageNote').textContent = 'Uploading to Bunny. Keep this popup open.';
  const r = await send({ type: 'stop' });
  $('#stopBtn').disabled = false;
  if (r && r.ok && r.links) showLinks(r.links);
  else if (r && r.why) {
    setStatus('Failed');
    $('#stageNote').innerHTML = '<b>Publishing failed.</b> ' + r.why;
  }
};

function showLinks(links) {
  setStatus('Published', 'good');
  $('#fill').style.width = '100%';
  $('#stageNote').classList.add('hide');
  const wrap = $('#links');
  wrap.classList.remove('hide');
  wrap.innerHTML = '';
  for (const [label, url] of [['Share', links.share], ['Embed', links.embed]]) {
    if (!url) continue;
    const row = document.createElement('div');
    row.className = 'link';
    row.innerHTML = `<span class="u">${url}</span>
      <button title="Copy"><svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg></button>`;
    row.querySelector('button').onclick = () => navigator.clipboard.writeText(url);
    wrap.appendChild(row);
  }
  navigator.clipboard.writeText(links.share).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'popup') return;
  if (msg.type === 'progress') {
    $('#progress').classList.remove('hide');
    $('#fill').style.width = Math.round(msg.pct || 0) + '%';
    $('#stageNote').textContent = {
      creating: 'Creating the video on Bunny',
      uploading: 'Uploading to Bunny',
      encoding: 'Bunny is encoding',
    }[msg.stage] || msg.stage;
  }
  if (msg.type === 'done' && msg.links) showLinks(msg.links);
  if (msg.type === 'error') {
    setStatus('Failed');
    $('#stageNote').innerHTML = '<b>Publishing failed.</b> ' + msg.why;
  }
});

boot();
