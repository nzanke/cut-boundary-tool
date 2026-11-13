// 過去の記録：一覧・開く・回どうし／作品どうしの比較
import * as store from './store.js';
import { SIZES, ANGLES, SUBJ, BINS, show, setSheetUrl, sk } from './cuts.js';

const $ = id => document.getElementById(id);
let IDX = [];
const pct = (a, b) => b ? (Math.round(a / b * 1000) / 10) + '%' : '–';
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);

export async function loadList() {
  $('recMsg').textContent = '記録を読み込んでいます…';
  try {
    const t = await store.readText('records/index.json');
    IDX = t ? JSON.parse(t) : [];
    $('recMsg').textContent = IDX.length ? '' : 'まだ記録がありません。「新しい回」で動画を読み、カットを決めて保存すると、ここに並びます。';
  } catch (e) { $('recMsg').textContent = String(e.message || e); IDX = []; }
  renderTable();
}
function agg(rows) { // 作品ごとにまとめる（カット数で重みづけ）
  const by = new Map();
  for (const r of rows) {
    const k = r.work || '（作品名なし）';
    if (!by.has(k)) by.set(k, { id: '', work: k, ep: '', title: rows.filter(x => (x.work || '（作品名なし）') === k).length + '話', n: 0, total: 0, mean: 0, median: null, long10: 0, bins: BINS.map(() => 0), size: {}, sizeUnset: 0, angle: {}, bg: 0, subj: {} });
    const a = by.get(k);
    a.n += r.n; a.total += r.total; a.long10 += r.long10share * r.total; a.bg += r.bg; a.sizeUnset += r.sizeUnset;
    r.bins.forEach((v, i) => a.bins[i] += v);
    for (const o of ['size', 'angle', 'subj']) for (const k2 in r[o]) a[o][k2] = (a[o][k2] || 0) + r[o][k2];
  }
  return [...by.values()].map(a => ({ ...a, mean: a.n ? a.total / a.n : 0, long10share: a.total ? a.long10 / a.total : 0 }));
}
function renderTable() {
  const byWork = $('byWork').checked;
  const rows = byWork ? agg(IDX) : [...IDX].sort((a, b) => (a.work || '').localeCompare(b.work || '', 'ja') || String(a.ep).localeCompare(String(b.ep), 'ja', { numeric: true }));
  const sz = r => SIZES.filter(x => x[0] !== 'CH').reduce((a, [v]) => a + (r.size[v] || 0), 0);
  const head = `<tr><th>${byWork ? '作品' : '回'}</th><th>カット</th><th>尺</th><th>平均</th>${byWork ? '' : '<th>中央値</th>'}<th>2秒未満</th><th>10秒以上の尺</th>`
    + SIZES.filter(x => x[0] !== 'CH').map(s => `<th>${s[1]}</th>`).join('') + ANGLES.filter(x => x[0]).map(a => `<th>${a[1]}</th>`).join('')
    + `<th>BGオンリー</th>` + SUBJ.map(s => `<th>被写体${s[1]}</th>`).join('') + (byWork ? '' : '<th></th>') + '</tr>';
  const body = rows.map(r => `<tr><td class="nm">${byWork ? `${r.work}<br><small>${r.title}</small>` : `${r.work || ''} ${r.ep || ''}<br><small>${r.title || ''}（${r.id}）</small>`}</td>
    <td>${r.n}</td><td>${Math.floor(r.total / 60)}分</td><td><b>${sk(Math.round(r.mean * 24))}</b><br>${f1(r.mean)}秒</td>${byWork ? '' : `<td>${sk(Math.round(r.median * 24))}<br>${f1(r.median)}秒</td>`}
    <td>${pct(r.bins[0] + r.bins[1], r.n)}</td><td>${pct(r.long10share, 1)}</td>`
    + SIZES.filter(x => x[0] !== 'CH').map(([v]) => `<td>${pct(r.size[v] || 0, sz(r))}</td>`).join('')
    + ANGLES.filter(x => x[0]).map(([v]) => `<td>${pct(r.angle[v] || 0, r.n)}</td>`).join('')
    + `<td>${pct(r.bg, r.n)}</td>` + SUBJ.map(([v]) => `<td>${pct(r.subj[v] || 0, r.n)}</td>`).join('')
    + (byWork ? '' : `<td><button type="button" data-open="${r.id}">開く</button></td>`) + '</tr>').join('');
  $('recTable').innerHTML = rows.length ? `<table class="cmp"><thead>${head}</thead><tbody>${body}</tbody></table><p class="note">サイズの割合は、サイズを入れたカット（途中で変化を除く）の中の割合。アングル・BGオンリー・被写体は全カットの中の割合。</p>` : '';
  $('recTable').querySelectorAll('[data-open]').forEach(b => b.onclick = () => openRecord(b.dataset.open));
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
    const next = async () => { while (k < ns) { const s = k++; const b = await store.readBlob(`records/${id}/img/${String(s).padStart(2, '0')}.jpg`); if (b) setSheetUrl(s, URL.createObjectURL(b)); } };
    await Promise.all([next(), next(), next()]);
  } catch (e) { $('recMsg').textContent = String(e.message || e); }
}
export function init() { $('byWork').onchange = renderTable; $('recReload').onclick = loadList; }
