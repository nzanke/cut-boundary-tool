// 記録の保存先（非公開の GitHub リポジトリ）。鍵（トークン）とリポジトリ名はこのブラウザの localStorage にだけ置く。
const API = 'https://api.github.com';
export function settings() {
  return { token: localStorage.getItem('cbt-token') || '', repo: localStorage.getItem('cbt-repo') || 'nzanke/cut-records' };
}
export function saveSettings(token, repo) {
  if (token !== undefined) { if (token) localStorage.setItem('cbt-token', token); else localStorage.removeItem('cbt-token'); }
  if (repo) localStorage.setItem('cbt-repo', repo);
}
async function gh(path, opt = {}) {
  const { token, repo } = settings();
  if (!token) throw new Error('記録の鍵（トークン）が入っていません。「設定」で入れてください');
  const r = await fetch(API + path.replace('{repo}', repo), { ...opt, headers: { Authorization: 'Bearer ' + token, Accept: opt.accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(opt.body ? { 'Content-Type': 'application/json' } : {}) } });
  if (r.status === 401) throw new Error('鍵（トークン）が使えません（期限切れか、打ち間違いかもしれません）');
  if (r.status === 403) throw new Error('鍵に書き込みの権限がありません（Contents を Read and write にしてください）');
  return r;
}
export async function check() {
  const r = await gh('/repos/{repo}');
  if (r.status === 404) throw new Error('リポジトリ ' + settings().repo + ' が見つかりません（名前か、鍵で選んだリポジトリを確かめてください）');
  const j = await r.json();
  return { private: j.private, name: j.full_name };
}
// ファイルを読む（無ければ null）
export async function readText(path) {
  const r = await gh('/repos/{repo}/contents/' + encodeURI(path), { accept: 'application/vnd.github.raw+json' });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('記録を読めませんでした（' + r.status + '）');
  return await r.text();
}
export async function readBlob(path) {
  const r = await gh('/repos/{repo}/contents/' + encodeURI(path), { accept: 'application/vnd.github.raw+json' });
  if (!r.ok) return null;
  return await r.blob();
}
const b64 = async blob => { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); };
const b64text = t => b64(new Blob([t]));
// 複数のファイルを1回のコミットで書く。files = [{path, text}|{path, blob}]、remove = 消すファイルのパスの前置き
export async function commit(files, message, removePrefix, onProgress) {
  let ref = await gh('/repos/{repo}/git/ref/heads/main');
  if (ref.status === 404 || ref.status === 409) {
    // 空のリポジトリ：最初のファイルを置いて main を作る
    const r0 = await gh('/repos/{repo}/contents/README.md', { method: 'PUT', body: JSON.stringify({ message: '記録を始める', content: await b64text('# カットの記録\n\n境目ツール（https://nzanke.github.io/cut-boundary-tool/）の記録です。\n') }) });
    if (!r0.ok) throw new Error('記録のリポジトリを始められませんでした（' + r0.status + '）');
    ref = await gh('/repos/{repo}/git/ref/heads/main');
  }
  if (!ref.ok) throw new Error('記録のリポジトリを読めませんでした（' + ref.status + '）');
  const head = (await ref.json()).object.sha;
  const base = await (await gh('/repos/{repo}/git/commits/' + head)).json();
  const tree = [];
  let k = 0;
  for (const f of files) {
    const content = f.blob ? await b64(f.blob) : await b64text(f.text);
    const r = await gh('/repos/{repo}/git/blobs', { method: 'POST', body: JSON.stringify({ content, encoding: 'base64' }) });
    if (!r.ok) throw new Error('ファイルを書けませんでした：' + f.path + '（' + r.status + '）');
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: (await r.json()).sha });
    onProgress && onProgress(++k, files.length);
  }
  if (removePrefix) {
    const old = await (await gh('/repos/{repo}/git/trees/' + base.tree.sha + '?recursive=1')).json();
    const keep = new Set(tree.map(t => t.path));
    for (const t of old.tree || []) if (t.type === 'blob' && t.path.startsWith(removePrefix) && !keep.has(t.path)) tree.push({ path: t.path, mode: '100644', type: 'blob', sha: null });
  }
  const nt = await gh('/repos/{repo}/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  if (!nt.ok) throw new Error('記録をまとめられませんでした（' + nt.status + '）');
  const c = await gh('/repos/{repo}/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: (await nt.json()).sha, parents: [head] }) });
  if (!c.ok) throw new Error('記録を保存できませんでした（' + c.status + '）');
  const u = await gh('/repos/{repo}/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: (await c.json()).sha }) });
  if (!u.ok) throw new Error('記録を保存できませんでした。ほかの画面で同時に保存したかもしれません。もう一度押してください（' + u.status + '）');
}
