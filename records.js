// 過去の記録：一覧・開く・回どうし／作品どうしの比較
import * as store from './store.js';
import { SIZES, ANGLES, BINS, show, setSheetUrl, sk, backToWork, logStats, medianOf, indexEntry } from './cuts.js';

const $ = id => document.getElementById(id);
let IDX = [];
const pct = (a, b) => b ? (Math.round(a / b * 1000) / 10) + '%' : '–';
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);

export async function loadList() {
  $('recMsg').textContent = '記録を読み込んでいます…';
  try {
    const t = await store.readText('records/index.json');
    IDX = t ? JSON.parse(t) : [];
    // 古いページで保存された回は一覧に各カットの長さ・SDlog が無いので、記録の本体から計算して補う
    await Promise.all(IDX.filter(r => r.sdLog == null || !r.lens || !r.trans).map(async r => {
      try { const rec = JSON.parse(await store.readText(`records/${r.id}/record.json`)); const e = indexEntry(rec); Object.assign(r, { fps: e.fps, lens: e.lens, median: e.median, aslLog: e.aslLog, sdLog: e.sdLog, size: e.size, sizeUnset: e.sizeUnset, trans: e.trans }); } catch (e) { }
    }));
    $('recMsg').textContent = IDX.length ? '' : 'まだ記録がありません。「新しい回」で動画を読み、カットを決めて保存すると、ここに並びます。';
  } catch (e) { $('recMsg').textContent = String(e.message || e); IDX = []; }
  renderTable();
}
function agg(rows) { // 作品ごとにまとめる（カット数で重みづけ）
  const by = new Map();
  for (const r of rows) {
    const k = r.work || '（作品名なし）';
    if (!by.has(k)) by.set(k, { id: '', work: k, ep: '', title: rows.filter(x => (x.work || '（作品名なし）') === k).length + '話', n: 0, total: 0, mean: 0, median: null, secs: [], allLens: true, long10: 0, bins: BINS.map(() => 0), size: {}, sizeUnset: 0, angle: {}, trans: { pairs: 0, chg: 0, jump: 0 } });
    const a = by.get(k);
    a.n += r.n; a.total += r.total; a.long10 += r.long10share * r.total; a.sizeUnset += r.sizeUnset;
    if (r.trans) for (const k2 of ['pairs', 'chg', 'jump']) a.trans[k2] += r.trans[k2];
    if (r.lens && r.fps) a.secs.push(...r.lens.map(f => f / r.fps)); else a.allLens = false;
    r.bins.forEach((v, i) => a.bins[i] += v);
    for (const o of ['size', 'angle']) for (const k2 in r[o]) a[o][k2] = (a[o][k2] || 0) + r[o][k2];
  }
  // 中央値・SDlog は全カットの長さをまとめて計算（各カットの長さを持たない古い記録が混ざるときは出さない）
  return [...by.values()].map(a => ({ ...a, mean: a.n ? a.total / a.n : 0, long10share: a.total ? a.long10 / a.total : 0, ...(a.allLens && a.secs.length ? { median: medianOf(a.secs), ...logStats(a.secs) } : { median: null, sdLog: null }) }));
}
// ---------- 比較表：列の定義・並び替え・絞り込み ----------
const UI = (() => { try { return JSON.parse(localStorage.getItem('cbt-rec-ui') || '{}'); } catch (e) { return {}; } })();
UI.sort = UI.sort || null; UI.groups = UI.groups || { len: true, size: true, angle: true }; UI.q = UI.q || '';
const saveUI = () => { try { localStorage.setItem('cbt-rec-ui', JSON.stringify(UI)); } catch (e) { } };
const P = (a, b) => b ? a / b : null;                         // 割合（0〜1）。分母が0なら空
const szBase = r => SIZES.filter(x => x[0] !== 'CH').reduce((a, [v]) => a + ((r.size || {})[v] || 0), 0);
const fmtPct = v => v == null ? '<span class="na">–</span>' : (Math.round(v * 1000) / 10).toFixed(1);   // 単位（%）は見出しに書く
const fmtT = v => v == null ? '<span class="na">–</span>' : `${sk(Math.round(v * 24))}<small>${f1(v)}秒</small>`;
const COLS = [
  { g: 'len', k: 'n', t: 'カット数', v: r => r.n, f: v => v },
  { g: 'len', k: 'total', t: '尺', v: r => r.total, f: v => `${Math.floor(v / 60)}分` },
  { g: 'len', k: 'mean', t: '平均', v: r => r.mean, f: fmtT },
  { g: 'len', k: 'median', t: '中央値', v: r => r.median, f: fmtT },
  { g: 'len', k: 'sdLog', t: 'SDlog', tip: 'カット長の常用対数の標準偏差。大きいほど長短の差が大きい', v: r => r.sdLog, f: v => v == null ? '<span class="na">–</span>' : v.toFixed(3) },
  { g: 'len', k: 'short', t: '2秒未満<small>%</small>', tip: '2秒未満のカットの割合', v: r => P(r.bins[0] + r.bins[1], r.n), f: fmtPct, bar: 1 },
  { g: 'len', k: 'long10', t: '10秒以上<small>尺の%</small>', tip: '10秒以上のカットが尺に占める割合', v: r => r.long10share, f: fmtPct, bar: 1 },
  { g: 'size', k: 'sizeIn', t: 'サイズ<br>入力済み', tip: 'サイズを入れたカットの割合', v: r => P(r.n - (r.sizeUnset || 0), r.n), f: fmtPct },
  ...SIZES.filter(x => x[0] !== 'CH').map(([c, t]) => ({ g: 'size', k: 's' + c, t, v: r => P((r.size || {})[c] || 0, szBase(r)), f: fmtPct, bar: 1 })),
  { g: 'size', k: 'chg', t: 'サイズが<br>変わる', tip: '隣りあう人物のカットで、サイズが変わる割合', v: r => r.trans ? P(r.trans.chg, r.trans.pairs) : null, f: fmtPct, bar: 1 },
  { g: 'size', k: 'jump', t: '2段以上<br>変わる', tip: '隣りあう人物のカットで、サイズが2段以上変わる割合', v: r => r.trans ? P(r.trans.jump, r.trans.pairs) : null, f: fmtPct, bar: 1 },
  ...ANGLES.filter(x => x[0]).map(([c, t]) => ({ g: 'angle', k: 'a' + c, t, v: r => P((r.angle || {})[c] || 0, r.n), f: fmtPct, bar: 1 })),
];
const GROUPS = [['len', '長さ'], ['size', 'サイズ（%）'], ['angle', 'アングル（%）']];
function renderTable() {
  const byWork = UI.byWork = $('byWork').checked; saveUI();
  const q = UI.q.trim().toLowerCase();
  let rows = byWork ? agg(IDX) : [...IDX];
  if (q) rows = rows.filter(r => `${r.work || ''} ${r.ep || ''} ${r.title || ''} ${r.id || ''}`.toLowerCase().includes(q));
  const cols = COLS.filter(c => UI.groups[c.g]);
  const sc = UI.sort && cols.find(c => c.k === UI.sort.k);
  if (sc) rows.sort((a, b) => { const x = sc.v(a), y = sc.v(b); if (x == null) return 1; if (y == null) return -1; return (x - y) * UI.sort.d; });
  else rows.sort((a, b) => (a.work || '').localeCompare(b.work || '', 'ja') || String(a.ep || '').localeCompare(String(b.ep || ''), 'ja', { numeric: true }));
  const max = Object.fromEntries(cols.filter(c => c.bar).map(c => [c.k, Math.max(0, ...rows.map(r => c.v(r) || 0))]));
  if ($('recCount')) $('recCount').textContent = `${rows.length} ${byWork ? '作品' : '回'}`;
  if ($('recGroups')) $('recGroups').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', !!UI.groups[b.dataset.g]));
  if ($('recMode')) $('recMode').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', (b.dataset.m === 'work') === byWork));
  if (!rows.length) { $('recTable').innerHTML = IDX.length ? '<p class="note">当てはまる記録がありません</p>' : ''; return; }
  const gs = GROUPS.filter(([g]) => UI.groups[g]);
  const h1 = `<tr><th class="nm" rowspan="2">${byWork ? '作品' : '回'}</th>` + gs.map(([g, t]) => `<th class="grp g-${g}" colspan="${cols.filter(c => c.g === g).length}"><span>${t}</span></th>`).join('') + '</tr>';
  const h2 = '<tr>' + cols.map(c => { const on = UI.sort && UI.sort.k === c.k; return `<th class="g-${c.g}${on ? ' on' : ''}" data-k="${c.k}" title="${c.tip || ''}" aria-sort="${on ? (UI.sort.d > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button"><span>${c.t}</span><i aria-hidden="true">${on ? (UI.sort.d > 0 ? '↑' : '↓') : ''}</i></button></th>`; }).join('') + '</tr>';
  const body = rows.map(r => `<tr>${byWork
      ? `<td class="nm"><span class="w">${r.work}</span><span class="e">${r.title}</span></td>`
      : `<td class="nm"><button type="button" class="open" data-open="${r.id}" title="この回を開く"><span class="w">${r.work || ''}</span><span class="e">${r.ep || ''}${r.title ? '　' + r.title : ''}</span></button></td>`}`
    + cols.map(c => { const v = c.v(r), m = max[c.k]; return `<td class="g-${c.g}${c.bar ? ' bar' : ''}${UI.sort && UI.sort.k === c.k ? ' on' : ''}"${c.bar && v != null && m ? ` style="--w:${(v / m * 100).toFixed(1)}%"` : ''}>${c.f(v)}</td>`; }).join('') + '</tr>').join('');
  $('recTable').innerHTML = `<div class="tw"><table class="cmp"><thead>${h1}${h2}</thead><tbody>${body}</tbody></table></div>
    <p class="note">列の名前を押すと並び替え（もう一度押すと逆順、3回目で元の並び）。${byWork ? '' : '回の名前を押すと、その回のカードを開きます。'}数字は％。サイズの割合は、サイズを入れたカット（途中で変化を除く）の中での割合です。「サイズが変わる」「2段以上変わる」は、隣りあうカットが両方とも人物のサイズ（超ロング〜超アップ）のつなぎの中での割合。アングルは全カットの中での割合。数字の下の線は、表示中でいちばん大きい値に対する長さです。</p>`;
  $('recTable').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openRecord(b.dataset.open));
  $('recTable').querySelectorAll('th[data-k] button').forEach(b => b.onclick = () => {
    const k = b.parentElement.dataset.k;
    UI.sort = !UI.sort || UI.sort.k !== k ? { k, d: -1 } : UI.sort.d < 0 ? { k, d: 1 } : null;
    saveUI(); renderTable();
  });
}
export async function openRecord(id, onShown) {
  $('recMsg').textContent = '記録を開いています…';
  try {
    const t = await store.readText(`records/${id}/record.json`); if (!t) throw new Error('記録が見つかりません');
    const rec = JSON.parse(t);
    const ns = Math.ceil(rec.cuts.length / 25), urls = new Array(ns);
    window.dispatchEvent(new CustomEvent('cbt-view', { detail: 'cuts' }));
    show(rec, urls, { saved: true, draft: true });
    $('recMsg').textContent = '';
    let k = 0;
    const next = async () => { while (k < ns) { const s = k++; const b = await store.readBlob(`records/${id}/img/${String(s).padStart(2, '0')}.jpg`); if (b) setSheetUrl(s, URL.createObjectURL(b), rec); } };
    await Promise.all([next(), next(), next()]);
  } catch (e) { $('recMsg').textContent = String(e.message || e); }
}
export function init() {
  $('backWork').onclick = () => { backToWork(); window.scrollTo(0, 0); };
  $('byWork').checked = !!UI.byWork; $('byWork').onchange = renderTable; $('recReload').onclick = loadList;
  // 古いページ（キャッシュ）と混ざっても他のボタンが止まらないよう、無い要素は飛ばす
  if ($('recMode')) $('recMode').querySelectorAll('button').forEach(b => b.onclick = () => { $('byWork').checked = b.dataset.m === 'work'; renderTable(); });
  if ($('recGroups')) $('recGroups').querySelectorAll('button').forEach(b => b.onclick = () => { UI.groups[b.dataset.g] = !UI.groups[b.dataset.g]; if (!Object.values(UI.groups).some(Boolean)) UI.groups[b.dataset.g] = true; saveUI(); renderTable(); });
  if ($('recQ')) { $('recQ').value = UI.q; $('recQ').oninput = () => { UI.q = $('recQ').value; saveUI(); renderTable(); }; }
}
