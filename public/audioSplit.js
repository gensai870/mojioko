// 大容量ファイルの自動分割(オンライン版 index.html から移植)。
// Vercelサーバーレス関数はリクエストボディに実質的な上限があるため、
// ブラウザ内で16kHzモノWAVにデコードし、CHUNK_SEC秒ごとに分割して逐次送信する。
// Whisperは16kHzモノで内部処理するため、この変換で文字起こし品質は劣化しない。
const CHUNK_SEC = 120; // 1チャンクの長さ(秒) → 16k*2byte*120 ≈ 3.66MB
const CHUNK_TRIGGER_BYTES = 4 * 1024 * 1024; // これを超えるファイルは分割
const TARGET_RATE = 16000;

// ── ディスパッチャ: 形式に応じて分割方式を選ぶ ──
async function splitAudioFile(file, chunkSec, onProgress) {
  const name = (file.name || '').toLowerCase();
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const isWav = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
             && head[8] === 0x57 && head[9] === 0x41 && head[10] === 0x56 && head[11] === 0x45;
  const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)
             || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)
             || name.endsWith('.mp3');
  const isOgg = (head[0] === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53)
             || name.endsWith('.ogg') || name.endsWith('.oga') || name.endsWith('.opus');
  try {
    if (isWav) { const r = await splitWavStreaming(file, chunkSec, onProgress); if (r && r.length) return r; }
    else if (isMp3) { const r = await splitMp3Streaming(file, chunkSec, onProgress); if (r && r.length) return r; }
    else if (isOgg) { const r = await splitOggStreaming(file, chunkSec, onProgress); if (r && r.length) return r; }
  } catch (e) {
    console.warn('streaming split failed, fallback to whole-decode:', e.message);
  }
  return await splitAudioWhole(file, chunkSec, onProgress);
}

async function splitWavStreaming(file, chunkSec, onProgress) {
  const hv = new DataView(await file.slice(0, 8192).arrayBuffer());
  const rdId = o => String.fromCharCode(hv.getUint8(o), hv.getUint8(o + 1), hv.getUint8(o + 2), hv.getUint8(o + 3));
  let off = 12, fmt = null, dataOff = null, dataLen = null;
  while (off + 8 <= hv.byteLength) {
    const id = rdId(off), sz = hv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      fmt = { format: hv.getUint16(off + 8, true), channels: hv.getUint16(off + 10, true), sampleRate: hv.getUint32(off + 12, true), bits: hv.getUint16(off + 22, true) };
    } else if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff === null || fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) return null;
  if (!dataLen || dataOff + dataLen > file.size) dataLen = file.size - dataOff;

  const { channels, sampleRate } = fmt;
  const blockAlign = channels * 2;
  const totalSamples = Math.floor(dataLen / blockAlign);
  const winSamples = chunkSec * sampleRate;
  const totalWins = Math.max(1, Math.ceil(totalSamples / winSamples));
  const chunks = [];
  for (let w = 0, s0 = 0; s0 < totalSamples; w++, s0 += winSamples) {
    const s1 = Math.min(s0 + winSamples, totalSamples);
    const byteStart = dataOff + s0 * blockAlign;
    const byteEnd = dataOff + s1 * blockAlign;
    const int16 = new Int16Array(await file.slice(byteStart, byteEnd).arrayBuffer());
    const frames = Math.floor(int16.length / channels);
    const mono = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += int16[f * channels + c];
      mono[f] = sum / channels / 32768;
    }
    const res = resampleLinear(mono, sampleRate, TARGET_RATE);
    chunks.push({ blob: pcmToWavBlob(res, TARGET_RATE), offset: s0 / sampleRate });
    if (onProgress) onProgress(w + 1, totalWins);
  }
  return chunks;
}

async function splitMp3Streaming(file, chunkSec, onProgress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let p = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const sz = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    p = 10 + sz;
  }
  const VER = { 3: 1, 2: 2, 0: 2.5 };
  const BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  const SR = { 1: [44100, 48000, 32000, 0], 2: [22050, 24000, 16000, 0], 2.5: [11025, 12000, 8000, 0] };

  const frames = [];
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) { p++; continue; }
    const verBits = (bytes[p + 1] >> 3) & 3, layer = (bytes[p + 1] >> 1) & 3;
    if (verBits === 1 || layer !== 1) { p++; continue; }
    const ver = VER[verBits];
    const brIdx = (bytes[p + 2] >> 4) & 0xf, srIdx = (bytes[p + 2] >> 2) & 3, pad = (bytes[p + 2] >> 1) & 1;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) { p++; continue; }
    const bitrate = (ver === 1 ? BR_V1 : BR_V2)[brIdx] * 1000;
    const sampleRate = SR[ver][srIdx];
    const spf = ver === 1 ? 1152 : 576;
    const len = (ver === 1 ? Math.floor(144 * bitrate / sampleRate) : Math.floor(72 * bitrate / sampleRate)) + pad;
    if (len < 4) { p++; continue; }
    frames.push({ start: p, len, dur: spf / sampleRate });
    p += len;
  }
  if (!frames.length) return null;

  const wins = [];
  let curStart = frames[0].start, curDur = 0, curEnd = frames[0].start, offset = 0;
  for (const fr of frames) {
    curEnd = fr.start + fr.len; curDur += fr.dur;
    if (curDur >= chunkSec) {
      wins.push({ byteStart: curStart, byteEnd: curEnd, offset });
      offset += curDur; curDur = 0; curStart = curEnd;
    }
  }
  if (curEnd > curStart && curDur > 0) wins.push({ byteStart: curStart, byteEnd: curEnd, offset });

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const chunks = [];
  try {
    for (let i = 0; i < wins.length; i++) {
      const w = wins[i];
      const slice = bytes.slice(w.byteStart, w.byteEnd);
      const decoded = await ac.decodeAudioData(slice.buffer);
      chunks.push(await renderMono16kWav(decoded, w.offset));
      if (onProgress) onProgress(i + 1, wins.length);
    }
  } finally { ac.close(); }
  return chunks;
}

async function splitOggStreaming(file, chunkSec, onProgress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const u32 = o => (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] * 0x1000000)) >>> 0;

  const pages = [];
  let p = 0;
  while (p + 27 <= bytes.length) {
    if (!(bytes[p] === 0x4f && bytes[p + 1] === 0x67 && bytes[p + 2] === 0x67 && bytes[p + 3] === 0x53)) { p++; continue; }
    const segCount = bytes[p + 26];
    if (p + 27 + segCount > bytes.length) break;
    let body = 0; for (let i = 0; i < segCount; i++) body += bytes[p + 27 + i];
    const granule = u32(p + 10) * 0x100000000 + u32(p + 6);
    pages.push({ start: p, end: p + 27 + segCount + body, granule });
    p += 27 + segCount + body;
  }
  if (pages.length < 2) return null;

  const firstBody = pages[0].start + 27 + bytes[pages[0].start + 26];
  const tag = String.fromCharCode.apply(null, bytes.slice(firstBody, firstBody + 8));
  let granRate = null;
  if (tag === 'OpusHead') granRate = 48000;
  else if (bytes[firstBody] === 1 && String.fromCharCode.apply(null, bytes.slice(firstBody + 1, firstBody + 7)) === 'vorbis') granRate = u32(firstBody + 12);
  if (!granRate) return null;

  let h = 0;
  while (h < pages.length && pages[h].granule === 0) h++;
  if (h === 0 || h >= pages.length) return null;
  const headerBytes = bytes.slice(pages[0].start, pages[h].end);

  const BYTE_CAP = 4 * 1024 * 1024;
  const wins = [];
  let startPage = h, startGran = 0;
  for (let i = h; i < pages.length; i++) {
    const gValid = pages[i].granule < 1e18;
    const durSoFar = gValid ? (pages[i].granule - startGran) / granRate : -1;
    const bytesSoFar = pages[i].end - pages[startPage].start + headerBytes.length;
    const isLast = i === pages.length - 1;
    if (isLast || durSoFar >= chunkSec || bytesSoFar >= BYTE_CAP) {
      wins.push({ startPage, endPage: i, offset: startGran / granRate });
      startPage = i + 1;
      if (gValid) startGran = pages[i].granule;
    }
  }

  const chunks = [];
  for (let w = 0; w < wins.length; w++) {
    const win = wins[w];
    if (win.startPage > win.endPage) continue;
    const blob = win.offset === 0
      ? new Blob([bytes.slice(pages[0].start, pages[win.endPage].end)], { type: 'audio/ogg' })
      : new Blob([headerBytes, bytes.slice(pages[win.startPage].start, pages[win.endPage].end)], { type: 'audio/ogg' });
    chunks.push({ blob, offset: win.offset });
    if (onProgress) onProgress(w + 1, wins.length);
  }
  return chunks;
}

async function renderMono16kWav(audioBuffer, offset) {
  const frames = Math.max(1, Math.ceil(audioBuffer.duration * TARGET_RATE));
  const oc = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = oc.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(oc.destination);
  src.start();
  const r = await oc.startRendering();
  return { blob: pcmToWavBlob(r.getChannelData(0), TARGET_RATE), offset };
}

function resampleLinear(mono, srcRate, dstRate) {
  if (srcRate === dstRate) return mono;
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.floor(mono.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    const a = mono[i0] || 0, b = (i0 + 1 < mono.length ? mono[i0 + 1] : a);
    out[i] = a + (b - a) * frac;
  }
  return out;
}

async function splitAudioWhole(file, chunkSec, onProgress) {
  const arrBuf = await file.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(arrBuf);
  } finally {
    ac.close();
  }
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const mono = await offline.startRendering();
  const data = mono.getChannelData(0);

  const chunkLen = chunkSec * TARGET_RATE;
  const totalWins = Math.max(1, Math.ceil(data.length / chunkLen));
  const chunks = [];
  for (let start = 0, w = 0; start < data.length; start += chunkLen, w++) {
    const slice = data.subarray(start, Math.min(start + chunkLen, data.length));
    chunks.push({ blob: pcmToWavBlob(slice, TARGET_RATE), offset: start / TARGET_RATE });
    if (onProgress) onProgress(w + 1, totalWins);
  }
  return chunks;
}

function pcmToWavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([view], { type: 'audio/wav' });
}
