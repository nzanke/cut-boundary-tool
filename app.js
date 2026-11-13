// 境目ツール本体：動画の解析（カット検出＋TransNetV2）→ コマの帯で境目とパートを決める → 書き出す
import { openVideo } from './demux.js';

const $ = id => document.getElementById(id);
const BASE = new URL('./', location.href).href;
const MAIN = new Set(['アバン', 'Aパート', 'Bパート']);
const PARTS = ['', 'アバン', 'OP', 'Aパート', 'アイキャッチ', 'Bパート', 'ED', 'Cパート（本編に入れない）', '予告', 'その他'];
const STEP = 6, PER = 100, COLS = 10;
const VERSION = 1;

let file = null, KEY = '', meta = null;
let A = null;           // 解析結果 {n, fps, w, h, codec, sc, tp, g24}
let D = null;           // 帯のデータ {frames, cands, tw, th}
let ch = {}, parts = {}, done = false;
let gapEl = {}, thumbEl = [], cand = {}, yel = [], cur = -1, saveTimer = null;

// ---------- 保存（解析は IndexedDB、答えは localStorage） ----------
function idb() {
  return new Promise((res, rej) => { const r = indexedDB.open('cut-boundary-tool', 1); r.onupgradeneeded = () => r.result.createObjectStore('analysis'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function idbGet(k) { try { const db = await idb(); return await new Promise(res => { const q = db.transaction('analysis').objectStore('analysis').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch (e) { return null; } }
async function idbPut(k, v) { try { const db = await idb(); await new Promise(res => { const t = db.transaction('analysis', 'readwrite'); t.objectStore('analysis').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) { } }
function loadAnswers() {
  try { const s = JSON.parse(localStorage.getItem('cbt-ans:' + KEY) || 'null'); if (s) { ch = {}; for (const k in s.changes || {}) ch[+k] = s.changes[k]; parts = {}; for (const k in s.parts || {}) parts[+k] = s.parts[k]; done = !!s.done; if (s.ep && !$('ep').value) $('ep').value = s.ep; return true; } } catch (e) { }
  return false;
}
function saveAnswers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem('cbt-ans:' + KEY, JSON.stringify({ changes: ch, parts, done, ep: $('ep').value.trim(), at: Date.now() })); $('save').textContent = 'このブラウザに保存しました'; }
    catch (e) { $('save').textContent = '保存できませんでした（ブラウザの保存領域がいっぱいかもしれません）'; }
  }, 400);
}

// ---------- 状態の表示 ----------
function status(t, err) { $('status').textContent = t; $('status').className = err ? 'err' : ''; }
function prog(v, max) { const p = $('prog'); if (v == null) { p.hidden = true; return; } p.hidden = false; p.max = max || 1; p.value = v; }
const tc = f => { const s = f / A.fps; return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };

// ---------- 復号 ----------
async function decodeAll(onFrame, onProgress) {
  let count = 0, err = null;
  const dec = new VideoDecoder({ output: f => { try { onFrame(f, count++); } catch (e) { err = e; } finally { f.close(); } }, error: e => { err = e; } });
  const cfg = { codec: meta.codec, codedWidth: meta.width, codedHeight: meta.height, hardwareAcceleration: 'no-preference' };
  if (meta.description) cfg.description = meta.description;
  const sup = await VideoDecoder.isConfigSupported(cfg);
  if (!sup.supported) throw new Error('このブラウザではこの動画（' + meta.codec + '）を読めません。Chrome の最新版で試すか、H.264 の MP4 に変換してください');
  dec.configure(cfg);
  let first = true, last = 0;
  for await (const p of meta.packets()) {
    if (err) throw err;
    if (first && !p.key) continue; first = false;
    while (dec.decodeQueueSize > 12) await new Promise(r => dec.addEventListener('dequeue', r, { once: true }));
    dec.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: p.ts, data: p.data }));
    const now = performance.now(); if (now - last > 300) { last = now; onProgress(count); await new Promise(r => setTimeout(r, 0)); }
  }
  await dec.flush(); dec.close();
  if (err) throw err;
  return count;
}

// ---------- 1回目：全部のコマを読んで、カット検出の値と TransNetV2 の確率を出す ----------
async function analyze() {
  const n0 = meta.estFrames || 0;
  const sw = 256, sh = Math.max(2, Math.round(256 * meta.height / meta.width / 2) * 2);
  const cA = new OffscreenCanvas(240, 135).getContext('2d', { willReadFrequently: true });
  const cB = new OffscreenCanvas(sw, sh).getContext('2d', { willReadFrequently: true });
  const cC = new OffscreenCanvas(96, 72).getContext('2d', { willReadFrequently: true });
  for (const c of [cA, cB, cC]) { c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; }
  const sc = [], g24 = [];
  let prevY = null, prevMafd = 0;
  const FS = 27 * 48 * 3; let tbuf = new Uint8Array(500 * FS), tn = 0;
  const threads = self.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2))) : 1;
  const worker = new Worker('tn-worker.js');
  let tnDone = 0, tnProbs = null, tnErr = null, ready = false;
  const finished = new Promise(res => {
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'ready') ready = true;
      else if (m.type === 'progress') tnDone = m.done;
      else if (m.type === 'done') { tnProbs = m.probs; res(); }
      else if (m.type === 'error') { tnErr = m.message; res(); }
    };
  });
  worker.postMessage({ type: 'init', base: BASE, threads });
  const flushT = () => { if (!tn) return; worker.postMessage({ type: 'frames', data: tbuf, n: tn }, [tbuf.buffer]); tbuf = new Uint8Array(500 * FS); tn = 0; };
  const t0 = performance.now();
  const n = await decodeAll((f) => {
    // TransNetV2 の入力：240x135 に縮めてから 5x5 の平均で 48x27（面積平均）
    cA.drawImage(f, 0, 0, 240, 135);
    const a = cA.getImageData(0, 0, 240, 135).data, o = tn * FS;
    for (let y = 0; y < 27; y++) for (let x = 0; x < 48; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 5; dy++) { let p = ((y * 5 + dy) * 240 + x * 5) * 4; for (let dx = 0; dx < 5; dx++, p += 4) { r += a[p]; g += a[p + 1]; b += a[p + 2]; } }
      const q = o + (y * 48 + x) * 3; tbuf[q] = (r + 12) / 25; tbuf[q + 1] = (g + 12) / 25; tbuf[q + 2] = (b + 12) / 25;
    }
    tn++; if (tn === 500) flushT();
    // カット検出の値：ffmpeg の scene と同じ式（幅256の明るさ Y の差の平均 mafd と、その変化。YUV の動画では ffmpeg も Y だけを使う）
    cB.drawImage(f, 0, 0, sw, sh);
    const d = cB.getImageData(0, 0, sw, sh).data;
    const Y = new Uint8Array(sw * sh);
    for (let i = 0, p = 0; i < sw * sh; i++, p += 4) Y[i] = (66 * d[p] + 129 * d[p + 1] + 25 * d[p + 2] + 128 >> 8) + 16;
    let s = 0;
    if (prevY) {
      let sad = 0;
      for (let i = 0; i < Y.length; i++) sad += Math.abs(Y[i] - prevY[i]);
      const mafd = sad / Y.length, diff = Math.abs(mafd - prevMafd);
      s = Math.min(1, Math.max(0, Math.min(mafd, diff) / 100)); prevMafd = mafd;
    }
    prevY = Y; sc.push(s);
    // 足した境目の位置合わせ用：96x72 の灰色を 4x4 の平均で 24x18
    cC.drawImage(f, 0, 0, 96, 72);
    const c = cC.getImageData(0, 0, 96, 72).data, g = new Uint8Array(432);
    for (let y = 0; y < 18; y++) for (let x = 0; x < 24; x++) {
      let v = 0; for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 4; dx++) { const p = ((y * 4 + dy) * 96 + x * 4 + dx) * 4; v += 0.299 * c[p] + 0.587 * c[p + 1] + 0.114 * c[p + 2]; }
      g[y * 24 + x] = Math.round(v / 16);
    }
    g24.push(g);
  }, count => {
    const el = (performance.now() - t0) / 1000;
    status(`コマを読んでいます ${count}${n0 ? ' / 約' + n0 : ''}（TransNetV2 ${tnDone} コマ済み${ready ? '' : '、準備中'}）　${Math.round(el)}秒`);
    prog(count, n0 || count + 1);
  });
  flushT(); worker.postMessage({ type: 'end' });
  const t1 = performance.now();
  while (!tnProbs && !tnErr) {
    status(`TransNetV2 で計算しています ${tnDone} / ${n} コマ（スレッド ${threads}）`); prog(tnDone, n);
    await Promise.race([finished, new Promise(r => setTimeout(r, 1000))]);
    if (tnDone > 0 && performance.now() - t1 > 5000) {
      const rate = tnDone / ((performance.now() - t0) / 1000);
      status(`TransNetV2 で計算しています ${tnDone} / ${n} コマ（スレッド ${threads}、残り約${Math.ceil((n - tnDone) / rate / 60)}分）`);
    }
  }
  worker.terminate();
  if (tnErr) throw new Error('TransNetV2 の計算に失敗しました：' + tnErr);
  const G = new Uint8Array(n * 432); g24.forEach((g, i) => G.set(g, i * 432));
  return { v: VERSION, n, fps: meta.fps, w: meta.width, h: meta.height, codec: meta.codec, sc: Float32Array.from(sc), tp: tnProbs, g24: G };
}

// ---------- 候補（今の境目ビューアと同じ決め方） ----------
function candidates() {
  const n = A.n, p = A.tp, sc = A.sc;
  // 今の機械（cut_table.py）：scene 0.15 以上、前の候補から7コマ以上離れたもの
  const S = [0]; let last = -99;
  for (let i = 1; i < n; i++) if (sc[i] >= 0.15) { if (i - last > 6) S.push(i); last = i; }
  // TransNetV2：確率0.2以上の山（i と i+1 の間＝境目は i+1）
  const T = [];
  for (let i = 1; i < n - 1; i++) if (p[i] >= 0.2 && p[i] >= p[i - 1] && p[i] > p[i + 1]) T.push(i + 1);
  const usedT = new Set(); let cs = [];
  for (const f of S) { if (f === 0) continue; let best = null; for (const t of T) if (Math.abs(t - f) <= 2 && !usedT.has(t) && (best === null || Math.abs(t - f) < Math.abs(best - f))) best = t; if (best !== null) usedT.add(best); cs.push(f); }
  cs = [...new Set(cs.concat(T.filter(t => !usedT.has(t))))].sort((a, b) => a - b);
  const merged = []; for (const f of cs) { if (merged.length && f - merged[merged.length - 1] <= 3) continue; merged.push(f); }
  return merged.filter(f => f > 0 && f < n).map(f => { let m = 0; for (let i = Math.max(f - 3, 0); i < Math.min(f + 2, n); i++) m = Math.max(m, p[i]); return { f, k: m >= 0.85 ? 'g' : 'y', tn: Math.round(m * 100) / 100 }; });
}

// ---------- 2回目：帯に並べるコマの画像を作る ----------
async function buildSprites(cands) {
  const n = A.n, show = new Set();
  for (let f = 0; f < n; f += STEP) show.add(f); show.add(n - 1);
  for (const c of cands) for (let f = c.f - 6; f < c.f + 6; f++) if (f >= 0 && f < n) show.add(f);
  const frames = [...show].sort((a, b) => a - b), idx = new Map(frames.map((f, i) => [f, i]));
  const ar = A.w / A.h, tw = ar < 1.5 ? 120 : 144, th = ar < 1.5 ? 90 : 81;
  const sheets = []; let cur = null;
  const urls = new Array(Math.ceil(frames.length / PER));
  const pend = [];
  await decodeAll((f, i) => {
    const k = idx.get(i); if (k === undefined) return;
    const s = Math.floor(k / PER), q = k % PER;
    if (!sheets[s]) { const c = new OffscreenCanvas(tw * COLS, th * (PER / COLS)); sheets[s] = c.getContext('2d'); sheets[s].imageSmoothingQuality = 'high'; }
    sheets[s].drawImage(f, (q % COLS) * tw, Math.floor(q / COLS) * th, tw, th);
    if (q === PER - 1 || k === frames.length - 1) pend.push(sheets[s].canvas.convertToBlob({ type: 'image/jpeg', quality: 0.68 }).then(b => { urls[s] = URL.createObjectURL(b); sheets[s] = null; }));
  }, count => { status(`コマの画像を作っています ${count} / ${n}`); prog(count, n); });
  await Promise.all(pend);
  return { frames, tw, th, urls };
}

// ---------- 帯 ----------
function partOf(f) { let best = -1, name = ''; for (const k in parts) { const s = +k; if (s <= f && s > best && parts[k]) { best = s; name = parts[k]; } } return name; }
function anyParts() { return Object.values(parts).some(Boolean); }
function inMain(f) { if (!anyParts()) return true; return MAIN.has(partOf(f)); }
function state(f) { if (f in ch) return ch[f]; const c = cand[f]; if (!c) return 0; return c.k === 'g' ? 1 : null; }
function partSelect(f) {
  const s = document.createElement('select'); s.title = 'ここからのパート';
  for (const p of PARTS) { const o = document.createElement('option'); o.value = p; o.textContent = p ? 'ここから ' + p : 'パート…'; s.append(o); }
  s.value = parts[f] || ''; s.onclick = e => e.stopPropagation();
  s.onchange = () => { if (s.value) parts[f] = s.value; else delete parts[f]; refreshParts(); saveAnswers(); };
  return s;
}
function paint(f) {
  const g = gapEl[f]; if (!g) return; const c = cand[f], v = state(f);
  g.className = 'g'; g.textContent = '';
  if (v === 1) {
    g.classList.add('on'); if (c && c.k === 'g' && !(f in ch)) g.classList.add('mg'); else if (c && c.k === 'y') g.classList.add('my');
    if (parts[f]) g.classList.add('pt');
    g.append(tc(f) + '　', partSelect(f)); g.title = '境目（線を押すと外す）';
  } else {
    if (parts[f]) { delete parts[f]; setTimeout(refreshParts, 0); }
    if (v === null) { g.classList.add('y'); if (!inMain(f)) g.classList.add('xx'); g.title = '機械が迷った所：押すと境目'; }
    else if (c && c.k === 'y') { g.classList.add('s'); g.title = '同じカットにした（押すと境目）'; }
    else if (c && c.k === 'g') { g.classList.add('s'); g.title = '機械の境目を外した（押すと戻す）'; }
    else g.title = '押すと境目を付ける';
  }
  if (yel[cur] === f) g.classList.add('cur');
}
function counts() {
  let u = 0, a = 0, r = 0;
  for (const c of D.cands) if (c.k === 'y' && !(c.f in ch) && inMain(c.f)) u++;
  for (const k in ch) { const c = cand[k]; if (ch[k] === 1 && !c) a++; if (ch[k] === 0 && c && c.k === 'g') r++; }
  $('nu').textContent = u; $('na').textContent = a; $('nr').textContent = r;
  const ps = Object.keys(parts).filter(k => parts[k]).sort((x, y) => x - y).map(k => parts[k]);
  $('np').textContent = ps.length ? ps.join('→') : '未設定';
}
function refreshParts() {
  const head = document.querySelector('.head'); if (head) { head.classList.toggle('pt', !!parts[0]); }
  D.frames.forEach((f, i) => thumbEl[i].classList.toggle('x', !inMain(f)));
  for (const f in gapEl) paint(+f);
  counts();
}
function set(f, v) { const c = cand[f]; const base = c ? (c.k === 'g' ? 1 : null) : 0; if (v === base) delete ch[f]; else ch[f] = v; paint(f); counts(); saveAnswers(); }
function click(f) { set(f, state(f) === 1 ? 0 : 1); }
function go(dir) {
  if (!yel.length) return; const old = yel[cur]; let i = cur;
  for (let n = 0; n < yel.length; n++) { i = (i + dir + yel.length) % yel.length; if (state(yel[i]) === null && inMain(yel[i])) break; }
  cur = i; if (old !== undefined) paint(old); paint(yel[cur]);
  gapEl[yel[cur]].scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function build() {
  const strip = $('strip'); strip.textContent = ''; gapEl = {}; cand = {}; thumbEl = []; cur = -1;
  document.documentElement.style.setProperty('--ar', D.tw + '/' + D.th);
  D.cands.forEach(c => cand[c.f] = c); yel = D.cands.filter(c => c.k === 'y').map(c => c.f);
  const rows = PER / COLS, frag = document.createDocumentFragment();
  const head = document.createElement('div'); head.className = 'head'; head.append('0:00　', partSelect(0)); frag.append(head);
  D.frames.forEach((f, i) => {
    if (i > 0) { const g = document.createElement('div'); g.dataset.f = f; gapEl[f] = g; g.onclick = () => click(f); frag.append(g); }
    const t = document.createElement('div'); t.className = 't' + ((i > 0 && f - D.frames[i - 1] === 1) || (i + 1 < D.frames.length && D.frames[i + 1] - f === 1) ? ' d' : '');
    const s = Math.floor(i / PER), q = i % PER, cx = q % COLS, cy = Math.floor(q / COLS);
    t.style.backgroundImage = `url(${D.urls[s]})`;
    t.style.backgroundSize = `${COLS * 100}% ${rows * 100}%`;
    t.style.backgroundPosition = `${cx / (COLS - 1) * 100}% ${cy / (rows - 1) * 100}%`;
    t.title = `コマ ${f}（${tc(f)}）`; thumbEl.push(t); frag.append(t);
  });
  strip.append(frag);
  refreshParts();
  $('done').setAttribute('aria-pressed', done);
}

// ---------- 書き出し ----------
function frac(a, b) { let c = 0; for (let i = 0; i < 432; i++) if (Math.abs(A.g24[a * 432 + i] - A.g24[b * 432 + i]) > 12) c++; return c / 432; }
function result() {
  const fr = D.frames, prev = new Map(); for (let j = 1; j < fr.length; j++) prev.set(fr[j], fr[j - 1]);
  const starts = Object.keys(parts).filter(k => parts[k]).map(Number).sort((a, b) => a - b);
  if (!starts.length || starts[0] !== 0) starts.unshift(0);
  const plist = starts.map((f, i) => ({ f, end: (i + 1 < starts.length ? starts[i + 1] : A.n) - 1, name: parts[f] || (anyParts() ? '' : 'アバン') }));
  const mains = plist.filter(p => MAIN.has(p.name) || !anyParts());
  const lo = mains.length ? mains[0].f : 0, hi = mains.length ? mains[mains.length - 1].end : A.n - 1;
  const pf = new Set(mains.map(p => p.f));
  let final = [...pf].filter(f => f !== lo), undecided = [];
  for (const g of fr.slice(1)) {
    if (pf.has(g) || !inMain(g) || !mains.some(p => p.f <= g && g <= p.end)) continue;
    let v = g in ch ? ch[g] : (cand[g] ? (cand[g].k === 'g' ? 1 : null) : 0);
    if (v === null) { undecided.push(g); continue; }
    if (v === 1) {
      // 1コマずつ並んでいない所に足した境目は、間で画面が一番大きく変わるコマに合わせる
      const p = prev.get(g);
      if (p !== undefined && g - p > 1 && !cand[g]) { let best = g, bv = -1; for (let f = p + 1; f <= g; f++) { const v2 = frac(f - 1, f); if (v2 > bv) { bv = v2; best = f; } } final.push(best); }
      else final.push(g);
    }
  }
  final = [...new Set(final)].sort((a, b) => a - b);
  return { tool: 'cut-boundary-tool', version: VERSION, ep: $('ep').value.trim(), at: new Date().toISOString(),
    video: { name: file.name, size: file.size, frames: A.n, fps: A.fps, width: A.w, height: A.h, codec: A.codec },
    lo, hi, boundaries: final, undecided, done, parts: plist, changes: ch, cands: D.cands, step: STEP };
}
function exportJson() {
  const ep = $('ep').value.trim();
  if (!ep) { status('「回のID」を入れてから書き出してください（例：madoka-02）', true); $('ep').focus(); return; }
  if (!/^[A-Za-z0-9_.-]+$/.test(ep)) { status('回のIDは半角の英数字と - _ . だけにしてください', true); $('ep').focus(); return; }
  const r = result();
  const blob = new Blob([JSON.stringify(r)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '境目_' + ep + '.json'; document.body.append(a); a.click(); a.remove();
  status(`書き出しました：境目 ${r.boundaries.length}（本編 ${r.boundaries.length + 1} カット）、未決の黄 ${r.undecided.length}${anyParts() ? '' : '（パート未設定のため全体を本編として扱いました）'}`);
}

// ---------- 始め方 ----------
async function start(f) {
  file = f; KEY = f.name + '|' + f.size + '|' + f.lastModified;
  ch = {}; parts = {}; done = false;
  if (!$('ep').value) $('ep').value = '';
  $('intro').hidden = true; $('tools').hidden = true; $('help').hidden = true; $('strip').textContent = '';
  try {
    if (!('VideoDecoder' in window)) throw new Error('このブラウザは動画の読み取り（WebCodecs）に対応していません。パソコンの Chrome で開いてください');
    status('動画を開いています…');
    meta = await openVideo(f);
    A = await idbGet(KEY);
    if (!A || A.v !== VERSION) {
      A = await analyze();
      status('解析結果を保存しています…'); await idbPut(KEY, A);
    }
    const cands = candidates();
    const sp = await buildSprites(cands);
    D = { cands, frames: sp.frames, tw: sp.tw, th: sp.th, urls: sp.urls };
    loadAnswers();
    build(); prog(null);
    $('tools').hidden = false; $('help').hidden = false;
    status(`${f.name}：${A.n} コマ、候補 ${cands.length}（緑 ${cands.filter(c => c.k === 'g').length}、黄 ${cands.filter(c => c.k === 'y').length}）`);
    window.__cbt = { A, D, result };
  } catch (e) { console.error(e); prog(null); status(String(e && e.message || e), true); $('intro').hidden = false; }
}
$('file').onchange = e => { const f = e.target.files[0]; if (f) start(f); };
$('ep').oninput = () => { if (KEY) saveAnswers(); };
$('next').onclick = () => go(1); $('prev').onclick = () => go(-1);
$('done').onclick = () => { done = !done; $('done').setAttribute('aria-pressed', done); saveAnswers(); };
$('export').onclick = exportJson;
document.addEventListener('keydown', e => {
  if (!D || (e.target.closest && e.target.closest('input,select,button'))) return;
  if (e.key === 'j' || e.key === 'J') { go(1); e.preventDefault(); }
  else if (e.key === 'k' || e.key === 'K') { go(-1); e.preventDefault(); }
  else if ((e.key === '1' || e.key === '2') && yel[cur] !== undefined) { set(yel[cur], e.key === '1' ? 1 : 0); go(1); e.preventDefault(); }
});
window.__cbtStart = start;
// 動作確認用（答えを外から入れる）
window.__cbtTest = { set(c, p) { ch = {}; for (const k in c) ch[+k] = c[k]; parts = {}; for (const k in p) parts[+k] = p[k]; refreshParts(); }, result: () => result() };
