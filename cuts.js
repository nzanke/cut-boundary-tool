// カットの一覧：ショット長は自動、サイズ・アングル・BGオンリー・被写体の数を選ぶ。集計・絞り込み・記録の保存。
import { decodeAll } from './video.js';
import * as store from './store.js';

const $ = id => document.getElementById(id);
export const SIZES = [['XL', '超ロング'], ['L', 'ロング'], ['M', 'ミドル'], ['U', 'アップ'], ['XU', '超アップ'], ['CH', '途中で変化']];
export const ANGLES = [['', '水平'], ['a', 'アオリ'], ['u', '真下'], ['f', 'フカン'], ['o', '真上'], ['d', 'ダッチ']];
export const SUBJ = [['0', '0'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4以上'], ['G', '群衆']];
export const BINS = [[0, 1, '1秒未満'], [1, 2, '1〜2秒'], [2, 3, '2〜3秒'], [3, 5, '3〜5秒'], [5, 10, '5〜10秒'], [10, 1e9, '10秒以上']];
const MAIN = new Set(['アバン', 'Aパート', 'Bパート']);
const PERSHEET = 25, CW = 480, CH = 180;
const label = (L, v) => (L.find(x => x[0] === v) || [, v])[1];

let R = null, urls = [], editable = true, saveT = null, F = { size: new Set(), angle: new Set(), subj: new Set(), bg: 'all', min: '', max: '', part: '' };
export const sec = (c, fps) => (c.b - c.a + 1) / fps;
// アニメの尺の書き方（秒＋コマ、24コマ＝1秒）。23.976／24fps の動画は動画のコマ数そのまま、それ以外は秒数から直す
export const koma = (c, fps) => Math.abs(fps - 24) < 0.1 ? c.b - c.a + 1 : Math.round((c.b - c.a + 1) / fps * 24);
export const sk = k => Math.floor(k / 24) + '+' + (Math.round(k) % 24);
const skSec = (x, fps) => sk(Math.round(Math.abs(fps - 24) < 0.1 ? x * fps : x * 24));

// ---------- 境目からカットを作る ----------
export function cutsFromBoundaries(res) {
  const B = new Set(res.boundaries), cuts = [];
  const mains = res.parts.filter(p => MAIN.has(p.name));
  const spans = mains.length ? mains : [{ f: res.lo, end: res.hi, name: '本編' }];
  for (const p of spans) {
    let a = p.f;
    for (let f = p.f + 1; f <= p.end; f++) if (B.has(f)) { cuts.push({ a, b: f - 1, part: p.name }); a = f; }
    cuts.push({ a, b: p.end, part: p.name });
  }
  return cuts.map((c, i) => ({ n: i + 1, ...c, size: '', angle: '', bg: false, subj: '' }));
}
// 各カットの頭・中・尻のコマを1枚の画像（左に中の大きなコマ、右に頭と尻）にまとめ、25カットずつの画像にする
export async function makeSheets(meta, cuts, onProgress) {
  const want = new Map();
  cuts.forEach((c, i) => { const n = c.b - c.a + 1; [[Math.min(c.a + 2, c.b), 1], [c.a + (n >> 1), 0], [Math.max(c.b - 2, c.a), 2]].forEach(([f, j]) => { if (!want.has(f)) want.set(f, []); want.get(f).push([i, j]); }); });
  const last = Math.max(...want.keys());
  const sheets = [], pend = [], blobs = [];
  const left = cuts.map(() => 3);
  await decodeAll(meta, (fr, k) => {
    const w = want.get(k); if (!w) return;
    for (const [i, j] of w) {
      const s = Math.floor(i / PERSHEET), q = i % PERSHEET;
      if (!sheets[s]) { const cv = new OffscreenCanvas(CW, CH * Math.min(PERSHEET, cuts.length - s * PERSHEET)); sheets[s] = { ctx: cv.getContext('2d'), left: 3 * Math.min(PERSHEET, cuts.length - s * PERSHEET) }; sheets[s].ctx.imageSmoothingQuality = 'high'; sheets[s].ctx.fillStyle = '#000'; sheets[s].ctx.fillRect(0, 0, cv.width, cv.height); }
      const ctx = sheets[s].ctx, y = q * CH;
      if (j === 0) ctx.drawImage(fr, 0, y, 320, 180); else ctx.drawImage(fr, 320, y + (j - 1) * 90, 160, 90);
      if (--sheets[s].left === 0) pend.push(ctx.canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 }).then(b => { blobs[s] = b; sheets[s] = null; }));
    }
  }, n => onProgress && onProgress(n, last));
  await Promise.all(pend);
  return blobs;
}

// ---------- 集計 ----------
export function stats(rec, list) {
  const cuts = list || rec.cuts, fps = rec.video.fps, s = cuts.map(c => sec(c, fps)).sort((a, b) => a - b);
  const n = s.length, tot = s.reduce((a, b) => a + b, 0);
  const med = n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0;
  const cnt = (key, L) => Object.fromEntries(L.map(([v]) => [v, cuts.filter(c => (key === 'angle' ? (c.angle || '') : c[key]) === v).length]));
  return {
    n, total: tot, mean: n ? tot / n : 0, median: med, max: n ? s[n - 1] : 0,
    bins: BINS.map(([lo, hi]) => s.filter(x => x >= lo && x < hi).length),
    long10share: tot ? s.filter(x => x >= 10).reduce((a, b) => a + b, 0) / tot : 0,
    size: cnt('size', SIZES), sizeUnset: cuts.filter(c => !c.size && !c.bg).length,
    angle: cnt('angle', ANGLES), bg: cuts.filter(c => c.bg).length,
    subj: cnt('subj', SUBJ), subjUnset: cuts.filter(c => !c.subj && !c.bg).length,
  };
}
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 + '%' : '–';
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
function statsHtml(st, title) {
  const sz = SIZES.filter(x => x[0] !== 'CH').reduce((a, [v]) => a + st.size[v], 0);
  const row = (L, obj, base) => L.map(([v, t]) => `<td>${t}<br><b>${obj[v]}</b> <span>${pct(obj[v], base)}</span></td>`).join('');
  return `<h3>${title}</h3>
  <table class="st"><tr><td>カット<br><b>${st.n}</b></td><td>尺<br><b>${Math.floor(st.total / 60)}分${Math.round(st.total % 60)}秒</b></td><td>平均<br><b>${skSec(st.mean, R.video.fps)}</b> <span>${f1(st.mean)}秒</span></td><td>中央値<br><b>${skSec(st.median, R.video.fps)}</b> <span>${f1(st.median)}秒</span></td><td>最長<br><b>${skSec(st.max, R.video.fps)}</b> <span>${f1(st.max)}秒</span></td><td>10秒以上の尺<br><b>${pct(st.long10share, 1)}</b></td></tr></table>
  <table class="st"><tr><th>長さ</th>${BINS.map((b, i) => `<td>${b[2]}<br><b>${st.bins[i]}</b> <span>${pct(st.bins[i], st.n)}</span></td>`).join('')}</tr></table>
  <table class="st"><tr><th>サイズ<small>（割合は途中で変化を除く）</small></th>${row(SIZES.filter(x => x[0] !== 'CH'), st.size, sz)}<td>途中で変化<br><b>${st.size.CH}</b></td><td>未入力<br><b>${st.sizeUnset}</b></td></tr></table>
  <table class="st"><tr><th>アングル</th>${row(ANGLES, st.angle, st.n)}</tr></table>
  <table class="st"><tr><th>被写体</th><td>BGオンリー<br><b>${st.bg}</b> <span>${pct(st.bg, st.n)}</span></td>${row(SUBJ, st.subj, st.n)}<td>未入力<br><b>${st.subjUnset}</b></td></tr></table>`;
}

// ---------- 画面 ----------
// 秒数の欄：「3」「2.5」（秒）と「1+12」（秒＋コマ、24コマ＝1秒）のどちらでも読む
function parseT(v) { v = String(v).trim().replace(/[＋]/g, '+').replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xFEE0)); if (v === '') return null; const m = v.match(/^(\d+)\+(\d+)$/); if (m) return +m[1] + +m[2] / 24; const x = parseFloat(v); return isNaN(x) ? null : x; }
function match(c) {
  const s = koma(c, R.video.fps) / 24;
  if (F.size.size && !F.size.has(c.size || '-')) return false;
  if (F.angle.size && !F.angle.has(c.angle || '')) return false;
  if (F.subj.size && !F.subj.has(c.subj || '-')) return false;
  if (F.bg === 'bg' && !c.bg) return false; if (F.bg === 'nobg' && c.bg) return false;
  const lo = parseT(F.min), hi = parseT(F.max); if (lo !== null && s < lo - 1e-6) return false; if (hi !== null && s > hi + 1e-6) return false;
  if (F.part && c.part !== F.part) return false;
  return true;
}
function chips(el, L, set, extra) {
  el.textContent = '';
  for (const [v, t] of L.concat(extra || [])) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.className = 'chip'; b.setAttribute('aria-pressed', set.has(v));
    b.onclick = () => { set.has(v) ? set.delete(v) : set.add(v); b.setAttribute('aria-pressed', set.has(v)); render(); };
    el.append(b);
  }
}
function filtersInit() {
  chips($('fSize'), SIZES, F.size, [['-', '未入力']]);
  chips($('fAngle'), ANGLES, F.angle);
  chips($('fSubj'), SUBJ, F.subj, [['-', '未入力']]);
  $('fBg').value = F.bg; $('fMin').value = F.min; $('fMax').value = F.max;
  const ps = [...new Set(R.cuts.map(c => c.part))];
  $('fPart').innerHTML = '<option value="">すべてのパート</option>' + ps.map(p => `<option>${p}</option>`).join(''); $('fPart').value = F.part;
  $('fBg').onchange = () => { F.bg = $('fBg').value; render(); };
  $('fMin').oninput = () => { F.min = $('fMin').value; render(); };
  $('fMax').oninput = () => { F.max = $('fMax').value; render(); };
  $('fPart').onchange = () => { F.part = $('fPart').value; render(); };
  $('fClear').onclick = () => { F = { size: new Set(), angle: new Set(), subj: new Set(), bg: 'all', min: '', max: '', part: '' }; filtersInit(); render(); };
}
function btnRow(c, key, L, name) {
  const d = document.createElement('div'); d.className = 'row'; d.setAttribute('role', 'group'); d.setAttribute('aria-label', name);
  for (const [v, t] of L) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = t; b.disabled = !editable;
    const on = () => (c[key] || '') === v && (key !== 'angle' || true);
    b.setAttribute('aria-pressed', on());
    b.onclick = () => { c[key] = (c[key] || '') === v && key !== 'angle' ? '' : v; if (key !== 'angle' && c[key]) c.bg = false; changed(c); };
    d.append(b);
  }
  return d;
}
function card(c) {
  const el = document.createElement('div'); el.className = 'card' + (c.bg ? ' isbg' : ''); el.dataset.n = c.n;
  const s = Math.floor((c.n - 1) / PERSHEET), q = (c.n - 1) % PERSHEET, rows = Math.min(PERSHEET, R.cuts.length - s * PERSHEET);
  const im = document.createElement('div'); im.className = 'im';
  if (urls[s]) im.style.backgroundImage = `url(${urls[s]})`; im.dataset.s = s;
  im.style.backgroundSize = `100% ${rows * 100}%`; im.style.backgroundPosition = `0 ${rows > 1 ? q / (rows - 1) * 100 : 0}%`;
  const hd = document.createElement('div'); hd.className = 'hd';
  const t = c.a / R.video.fps;
  hd.innerHTML = `<b>C${c.n}</b> <span>${sk(koma(c, R.video.fps))}（${f1(sec(c, R.video.fps))}秒）</span> <span class="tc">${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}　${c.part}</span>`;
  el.append(im, hd);
  el.append(btnRow(c, 'size', SIZES, 'サイズ'), btnRow(c, 'angle', ANGLES, 'アングル'));
  const r = btnRow(c, 'subj', SUBJ, '被写体の数');
  const bg = document.createElement('button'); bg.type = 'button'; bg.textContent = 'BGオンリー'; bg.className = 'bgb'; bg.disabled = !editable; bg.setAttribute('aria-pressed', !!c.bg);
  bg.onclick = () => { c.bg = !c.bg; if (c.bg) { c.size = ''; c.subj = '0'; } changed(c); };
  r.prepend(bg); el.append(r);
  return el;
}
function changed(c) {
  const old = document.querySelector(`.card[data-n="${c.n}"]`); if (old) old.replaceWith(card(c));
  renderStats(); draft();
}
function renderStats() {
  const list = R.cuts.filter(match), all = stats(R);
  const open = $('stats').querySelector('details') ? $('stats').querySelector('details').open : true;
  $('stats').innerHTML = `<details${open ? ' open' : ''}><summary>集計（押すと開け閉め）</summary>` + statsHtml(all, '本編の集計') + (list.length !== R.cuts.length ? statsHtml(stats(R, list), `絞り込んだ ${list.length} カットの集計`) : '') + '</details>';
  $('nShown').textContent = `${list.length} / ${R.cuts.length} カットを表示`;
}
function render() {
  const g = $('cards'); g.textContent = '';
  const frag = document.createDocumentFragment(); for (const c of R.cuts) if (match(c)) frag.append(card(c));
  g.append(frag); renderStats();
}
function draft() { clearTimeout(saveT); saveT = setTimeout(() => { try { localStorage.setItem('cbt-rec:' + R.id, JSON.stringify({ cuts: R.cuts.map(({ n, size, angle, bg, subj }) => ({ n, size, angle, bg, subj })), memo: $('memo').value, at: Date.now() })); $('recSave').textContent = 'このブラウザに下書きを保存しました（記録への保存はまだです）'; } catch (e) { } }, 500); }
function loadDraft() {
  try { const d = JSON.parse(localStorage.getItem('cbt-rec:' + R.id) || 'null'); if (!d) return; const m = new Map(d.cuts.map(x => [x.n, x])); for (const c of R.cuts) { const x = m.get(c.n); if (x) Object.assign(c, { size: x.size, angle: x.angle, bg: x.bg, subj: x.subj }); } if (d.memo != null) R.memo = d.memo; } catch (e) { }
}
export function show(rec, sheetUrls, opt = {}) {
  R = rec; urls = sheetUrls; editable = opt.editable !== false;
  if (opt.draft !== false) loadDraft();
  $('cutTitle').textContent = `${rec.work || ''} ${rec.ep || ''}${rec.title ? '「' + rec.title + '」' : ''}（${rec.id}）`;
  $('memo').value = rec.memo || ''; $('memo').oninput = () => { R.memo = $('memo').value; draft(); };
  $('recSave').textContent = opt.saved ? '記録から開きました' : '';
  filtersInit(); render();
}
export function setSheetUrl(s, u) { urls[s] = u; document.querySelectorAll(`.im[data-s="${s}"]`).forEach(e => e.style.backgroundImage = `url(${u})`); }
export const current = () => R;

// ---------- 記録の文書 ----------
export function summaryText(rec) {
  const st = stats(rec), sz = SIZES.filter(x => x[0] !== 'CH').reduce((a, [v]) => a + st.size[v], 0);
  const L = [`# ${rec.work || ''} ${rec.ep || ''}${rec.title ? '「' + rec.title + '」' : ''}`, '', `- 回のID：${rec.id}`, `- 動画：${rec.video.name}（${rec.video.frames}コマ、${f1(rec.video.fps)}fps）`, `- 記録した日：${new Date().toISOString().slice(0, 10)}`, '',
    '## 集計（本編）', '', `カット ${st.n}、尺 ${Math.floor(st.total / 60)}分${Math.round(st.total % 60)}秒、平均 ${skSec(st.mean, rec.video.fps)}（${f1(st.mean)}秒）、中央値 ${skSec(st.median, rec.video.fps)}（${f1(st.median)}秒）、最長 ${skSec(st.max, rec.video.fps)}（${f1(st.max)}秒）、10秒以上のカットが尺に占める割合 ${pct(st.long10share, 1)}`, '',
    '| 長さ | ' + BINS.map(b => b[2]).join(' | ') + ' |', '|---|' + BINS.map(() => '---').join('|') + '|', '| カット | ' + st.bins.map((v, i) => `${v}（${pct(v, st.n)}）`).join(' | ') + ' |', '',
    '| サイズ | ' + SIZES.map(s => s[1]).join(' | ') + ' | 未入力 |', '|---|' + SIZES.map(() => '---').join('|') + '|---|', '| カット | ' + SIZES.map(([v]) => v === 'CH' ? st.size[v] : `${st.size[v]}（${pct(st.size[v], sz)}）`).join(' | ') + ` | ${st.sizeUnset} |`, '',
    '| アングル | ' + ANGLES.map(s => s[1]).join(' | ') + ' |', '|---|' + ANGLES.map(() => '---').join('|') + '|', '| カット | ' + ANGLES.map(([v]) => `${st.angle[v]}（${pct(st.angle[v], st.n)}）`).join(' | ') + ' |', '',
    `| 被写体 | BGオンリー | ` + SUBJ.map(s => s[1]).join(' | ') + ' |', '|---|---|' + SUBJ.map(() => '---').join('|') + '|', `| カット | ${st.bg}（${pct(st.bg, st.n)}） | ` + SUBJ.map(([v]) => `${st.subj[v]}（${pct(st.subj[v], st.n)}）`).join(' | ') + ' |', '',
    '## メモ', '', rec.memo || '（なし）', '', '## カット', '', '| カット | 開始 | 尺（秒+コマ） | 秒数 | パート | サイズ | アングル | BGオンリー | 被写体 |', '|---|---|---|---|---|---|---|---|---|'];
  for (const c of rec.cuts) { const t = c.a / rec.video.fps; L.push(`| ${c.n} | ${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')} | ${sk(koma(c, rec.video.fps))} | ${f1(sec(c, rec.video.fps))} | ${c.part} | ${c.size ? label(SIZES, c.size) : ''} | ${label(ANGLES, c.angle || '')} | ${c.bg ? '○' : ''} | ${c.subj ? label(SUBJ, c.subj) : ''} |`); }
  L.push('', '画像：img/ の各ファイルは25カットずつ（左に中のコマ、右上に頭、右下に尻）。');
  return L.join('\n');
}
export function indexEntry(rec) {
  const st = stats(rec);
  return { id: rec.id, work: rec.work, ep: rec.ep, title: rec.title, updated: new Date().toISOString(), n: st.n, total: st.total, mean: st.mean, median: st.median, long10share: st.long10share, bins: st.bins, size: st.size, sizeUnset: st.sizeUnset, angle: st.angle, bg: st.bg, subj: st.subj };
}
export async function saveRecord(blobs, onProgress) {
  const rec = R; rec.updated = new Date().toISOString();
  const idxText = await store.readText('records/index.json');
  const idx = idxText ? JSON.parse(idxText) : [];
  const entry = indexEntry(rec), k = idx.findIndex(x => x.id === rec.id);
  if (k >= 0) idx[k] = entry; else idx.push(entry);
  const files = [
    { path: `records/${rec.id}/record.json`, text: JSON.stringify({ ...rec, boundary: undefined }) },
    { path: `records/${rec.id}/README.md`, text: summaryText(rec) },
    { path: 'records/index.json', text: JSON.stringify(idx, null, 1) },
  ];
  if (rec.boundary) files.push({ path: `records/${rec.id}/boundary.json`, text: JSON.stringify(rec.boundary) });
  if (blobs) blobs.forEach((b, i) => files.push({ path: `records/${rec.id}/img/${String(i).padStart(2, '0')}.jpg`, blob: b }));
  await store.commit(files, `記録：${rec.work || ''} ${rec.ep || ''}（${rec.id}）`, blobs ? `records/${rec.id}/img/` : null, onProgress);
  try { localStorage.removeItem('cbt-rec:' + rec.id); } catch (e) { }
}
