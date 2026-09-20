const $ = (sel) => document.querySelector(sel);

function toast(message) {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function logLine(message, isError) {
  const term = $('#terminal');
  const line = document.createElement('div');
  line.className = 'line' + (isError ? ' err' : '');
  const ts = new Date().toLocaleTimeString('ja-JP');
  line.innerHTML = `<span class="ts">${ts}</span> ${message}`;
  term.appendChild(line);
  term.scrollTop = term.scrollHeight;
}

// ==================== Groqキー(localStorageのみ、サーバーには保存しない) ====================
const GROQ_KEY_STORAGE = 'mojioko:groqApiKey';
$('#groqKeyInput').value = localStorage.getItem(GROQ_KEY_STORAGE) || '';
$('#groqKeyInput').addEventListener('change', () => {
  localStorage.setItem(GROQ_KEY_STORAGE, $('#groqKeyInput').value.trim());
});

// ==================== 429レート制限の解析(services/rateLimitUtil.js を移植) ====================
function parseRetryAfterMs(message) {
  if (!message) return null;
  const mmss = message.match(/in\s+(\d+)m([\d.]+)s/i);
  if (mmss) return (parseInt(mmss[1], 10) * 60 + parseFloat(mmss[2])) * 1000;
  const secOnly = message.match(/in\s+([\d.]+)s/i);
  if (secOnly) return parseFloat(secOnly[1]) * 1000;
  return null;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==================== 出力整形(services/formatters.js を移植) ====================
function pad2(n) { return String(n).padStart(2, '0'); }
function secToHhmmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(sec / 3600))}:${pad2(Math.floor((sec % 3600) / 60))}:${pad2(sec % 60)}`;
}
function secToSrtTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}
function secToVttTime(sec) { return secToSrtTime(sec).replace(',', '.'); }
function extractDateTimeFromFileName(fileName) {
  if (!fileName) return null;
  const m = fileName.match(/(\d{4})-(\d{2})-(\d{2})[ T]?(\d{2})[_:](\d{2})[_:](\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}
function buildHeader(fileName) {
  return `【ファイル】${fileName || '不明'}\n【日時】${extractDateTimeFromFileName(fileName) || '不明'}\n\n`;
}
function formatOutput(fileName, segments, format) {
  const header = buildHeader(fileName);
  if (format === 'timestamp') return header + segments.map((s) => `[${secToHhmmss(s.start)}]  ${s.text.trim()}`).join('\n');
  if (format === 'srt') return segments.map((s, i) => `${i + 1}\n${secToSrtTime(s.start)} --> ${secToSrtTime(s.end)}\n${s.text.trim()}\n`).join('\n');
  if (format === 'vtt') return 'WEBVTT\n\n' + segments.map((s) => `${secToVttTime(s.start)} --> ${secToVttTime(s.end)}\n${s.text.trim()}\n`).join('\n');
  if (format === 'json') return JSON.stringify({ meta: { fileName, dateTime: extractDateTimeFromFileName(fileName) }, segments }, null, 2);
  return header + segments.map((s) => s.text.trim()).join('\n');
}

// ==================== ファイル選択 ====================
let currentFile = null;
const dropzone = $('#dropzone');
const fileInput = $('#fileInput');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) setFile(fileInput.files[0]); });
function setFile(file) {
  currentFile = file;
  $('#fileChip').style.display = 'flex';
  $('#fileChipName').textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB)`;
  $('#urlInput').value = '';
}
$('#fileChipClear').addEventListener('click', () => {
  currentFile = null;
  fileInput.value = '';
  $('#fileChip').style.display = 'none';
});

// ==================== Whisper呼び出し(429は自動で待って再送する) ====================
async function postWhisperWithRetry(body, headers, onWait) {
  const groqKey = localStorage.getItem(GROQ_KEY_STORAGE);
  if (!groqKey) throw new Error('Groq APIキーを入力してください');

  for (let attempt = 0; attempt <= 6; attempt++) {
    const res = await fetch('/api/whisper', {
      method: 'POST',
      headers: { ...(headers || {}), 'x-groq-key': groqKey },
      body,
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const message = data.error?.message || 'レート制限に達しました';
      const waitMs = parseRetryAfterMs(message) || 15000;
      if (onWait) onWait(waitMs, message);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || `HTTP ${res.status}`);
    }
    return res;
  }
  throw new Error('リトライ上限に達しました');
}

// ==================== 文字起こし本体 ====================
$('#startBtn').addEventListener('click', async () => {
  const format = $('#optFormat').value;
  const language = $('#optLanguage').value;
  const url = $('#urlInput').value.trim();

  if (!currentFile && !url) { toast('ファイルまたはURLを指定してください'); return; }
  if (!localStorage.getItem(GROQ_KEY_STORAGE)) { toast('Groq APIキーを入力してください'); return; }

  const btn = $('#startBtn');
  btn.disabled = true;
  $('#terminal').innerHTML = '';
  $('#resultCard').style.display = 'none';
  $('#progressWrap').style.display = 'block';
  $('#progressFill').style.width = '0%';

  const needsVerbose = ['timestamp', 'srt', 'vtt', 'json'].includes(format);
  const groqFormat = needsVerbose ? 'verbose_json' : format;
  const fileName = currentFile ? currentFile.name : (url.split('/').pop() || 'recording');

  const updateProgress = (done, total) => {
    $('#progressFill').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
    $('#progressText').textContent = `${done} / ${total}`;
  };
  const onWait = (waitMs, message) => logLine(`レート制限のため待機します(${Math.ceil(waitMs / 1000)}秒): ${message}`, true);

  try {
    let allSegments = [];

    if (currentFile && currentFile.size > 4 * 1024 * 1024) {
      logLine(`【${fileName}】音声を分割しています…`);
      const chunks = await splitAudioFile(currentFile, 120, (done, total) => {
        if (done === 1 || done === total || done % 5 === 0) logLine(`分割準備 ${done}/${total}`);
      });
      logLine(`${chunks.length}個のセグメントに分割しました`);
      updateProgress(0, chunks.length);

      for (let i = 0; i < chunks.length; i++) {
        logLine(`セグメント ${i + 1}/${chunks.length} を文字起こし中…`);
        const form = new FormData();
        form.append('file', chunks[i].blob, `chunk_${String(i).padStart(3, '0')}.wav`);
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', groqFormat);
        if (language !== 'auto') form.append('language', language);

        const res = await postWhisperWithRetry(form, {}, onWait);
        const data = needsVerbose ? await res.json() : { text: await res.text() };
        if (needsVerbose) {
          (data.segments || []).forEach((s) => allSegments.push({ ...s, start: s.start + chunks[i].offset, end: s.end + chunks[i].offset }));
        } else if (data.text) {
          allSegments.push({ start: chunks[i].offset, end: chunks[i].offset, text: data.text });
        }
        updateProgress(i + 1, chunks.length);
      }
    } else {
      logLine(`【${fileName}】処理を開始します`);
      updateProgress(0, 1);
      let body, headers = {};
      if (url && !currentFile) {
        body = JSON.stringify({ url, model: 'whisper-large-v3-turbo', response_format: groqFormat, ...(language !== 'auto' ? { language } : {}) });
        headers['Content-Type'] = 'application/json';
      } else {
        const form = new FormData();
        form.append('file', currentFile);
        form.append('model', 'whisper-large-v3-turbo');
        form.append('response_format', groqFormat);
        if (language !== 'auto') form.append('language', language);
        body = form;
      }
      const res = await postWhisperWithRetry(body, headers, onWait);
      const data = needsVerbose ? await res.json() : { text: await res.text() };
      allSegments = needsVerbose ? (data.segments || []) : [{ start: 0, end: 0, text: data.text || '' }];
      updateProgress(1, 1);
    }

    const outputText = formatOutput(fileName, allSegments, format);
    $('#resultText').value = outputText;
    $('#resultCard').style.display = 'block';
    logLine('完了しました');
    toast('文字起こしが完了しました');
  } catch (e) {
    logLine(`エラー: ${e.message}`, true);
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
});

// ==================== Google Drive連携 ====================
async function refreshDriveStatus() {
  try {
    const res = await fetch('/api/drive/status');
    const data = await res.json();
    if (!data.configured) {
      $('#driveStatusText').textContent = 'サーバー側でGoogle連携が未設定です(管理者に確認してください)';
      $('#driveConnectBtn').disabled = true;
      return;
    }
    if (data.defaultFolderId && !$('#driveFolderIdInput').value) {
      $('#driveFolderIdInput').value = data.defaultFolderId;
    }
    $('#driveStatusText').textContent = data.connected ? '連携済みです' : '未連携です';
    $('#driveConnectBtn').style.display = data.connected ? 'none' : 'inline-block';
    $('#driveDisconnectBtn').style.display = data.connected ? 'inline-block' : 'none';
  } catch (e) {
    $('#driveStatusText').textContent = `状態確認に失敗しました: ${e.message}`;
  }
}
refreshDriveStatus();

$('#driveConnectBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('/api/drive/auth-url');
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    window.open(data.url, '_blank', 'width=520,height=680');
    toast('連携完了後、このページで「一覧を取得」を押してください');
  } catch (e) {
    toast(e.message);
  }
});

$('#driveDisconnectBtn').addEventListener('click', async () => {
  await fetch('/api/drive/disconnect', { method: 'POST' });
  toast('連携を解除しました');
  refreshDriveStatus();
});

// フォルダID履歴(localStorageのみ、複数フォルダを切り替えて使うため)
const DRIVE_FOLDER_HISTORY_KEY = 'mojioko:driveFolderHistory';
function loadFolderHistory() {
  try { return JSON.parse(localStorage.getItem(DRIVE_FOLDER_HISTORY_KEY) || '[]'); } catch (e) { return []; }
}
function saveFolderHistory(list) {
  localStorage.setItem(DRIVE_FOLDER_HISTORY_KEY, JSON.stringify(list.slice(0, 10)));
}
async function rememberFolder(folderId) {
  const list = loadFolderHistory().filter((f) => f.id !== folderId);
  let name = folderId;
  try {
    const res = await fetch(`/api/drive/folder-name?folderId=${encodeURIComponent(folderId)}`);
    const data = await res.json();
    if (data.name) name = data.name;
  } catch (e) { /* ignore */ }
  list.unshift({ id: folderId, name });
  saveFolderHistory(list);
  renderFolderHistory();
}
function renderFolderHistory() {
  const el = $('#driveFolderHistory');
  const list = loadFolderHistory();
  el.innerHTML = '';
  list.forEach((f) => {
    const chip = document.createElement('span');
    chip.className = 'folder-chip';
    chip.innerHTML = `<span>${f.name}</span>`;
    chip.addEventListener('click', () => {
      $('#driveFolderIdInput').value = f.id;
      $('#driveListBtn').click();
    });
    const removeBtn = document.createElement('button');
    removeBtn.className = 'remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveFolderHistory(loadFolderHistory().filter((x) => x.id !== f.id));
      renderFolderHistory();
    });
    chip.appendChild(removeBtn);
    el.appendChild(chip);
  });
}
renderFolderHistory();

$('#driveListBtn').addEventListener('click', async () => {
  const folderId = $('#driveFolderIdInput').value.trim();
  if (!folderId) { toast('フォルダIDを入力してください'); return; }
  const listEl = $('#driveFileList');
  listEl.textContent = '取得中…';
  try {
    const res = await fetch(`/api/drive/list?folderId=${encodeURIComponent(folderId)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    listEl.innerHTML = '';
    if (!data.files.length) { listEl.textContent = 'ファイルが見つかりません'; return; }
    data.files.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'drive-file';
      row.innerHTML = `<span class="name">${f.name}</span>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = '読み込む';
      btn.addEventListener('click', () => loadDriveFileText(f.id, f.name));
      row.appendChild(btn);
      listEl.appendChild(row);
    });
    rememberFolder(folderId);
  } catch (e) {
    listEl.textContent = '';
    toast(e.message);
  }
});

async function loadDriveFileText(fileId, fileName) {
  try {
    const res = await fetch(`/api/drive/text?fileId=${encodeURIComponent(fileId)}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    $('#resultText').value = data.content;
    $('#resultCard').style.display = 'block';
    toast(`「${fileName}」を読み込みました`);
  } catch (e) {
    toast(e.message);
  }
}

$('#copyResultBtn').addEventListener('click', () => {
  navigator.clipboard.writeText($('#resultText').value);
  toast('コピーしました');
});
$('#downloadResultBtn').addEventListener('click', () => {
  const blob = new Blob([$('#resultText').value], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'transcript.txt';
  a.click();
  URL.revokeObjectURL(a.href);
});
