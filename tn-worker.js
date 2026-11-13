// TransNetV2（ONNX）を裏で動かす。フレーム（48x27 RGB）を受け取り、コマごとの「切れ目の確率」を返す。
// 元の推論と同じ手順：先頭に1コマ目を25枚、末尾に最後のコマを足し、100コマの窓を50コマずつずらし、窓の25〜74番目を採る。
importScripts('lib/ort.wasm.min.js');
const FS = 27 * 48 * 3;
let sess = null, chunks = [], have = 0, nextWin = 0, ended = false, total = 0, busy = false, finished = false, pending = false;
const probs = [];
function frame(i, out, off) { // i 番目のコマ（範囲外は端のコマ）を out に写す
  if (i < 0) i = 0; if (i > have - 1) i = have - 1;
  let k = 0; while (i >= chunks[k].n) { i -= chunks[k].n; k++; }
  out.set(chunks[k].d.subarray(i * FS, (i + 1) * FS), off);
}
async function run() {
  if (!sess) return; if (busy) { pending = true; return; } busy = true; pending = false;
  try {
    const buf = new Uint8Array(100 * FS);
    while (true) {
      const s = nextWin * 50;               // 窓の先頭（詰め物を含めた位置）。コマ番号は s-25
      const needLast = s + 99 - 25;         // 窓に要るいちばん後ろのコマ
      if (!ended && needLast >= have) break;
      if (ended && s - 25 + 25 >= total) break;
      for (let j = 0; j < 100; j++) frame(s + j - 25, buf, j * FS);
      const out = await sess.run({ frames: new ort.Tensor('uint8', buf, [1, 100, 27, 48, 3]) });
      const p = out.prob.data;
      for (let j = 25; j < 75; j++) { const f = s + j - 25; if (f < (ended ? total : Infinity)) probs[f] = p[j]; }
      nextWin++;
      postMessage({ type: 'progress', done: Math.min(nextWin * 50, ended ? total : have) });
    }
    if (ended && nextWin * 50 >= total && !finished) { finished = true; postMessage({ type: 'done', probs: Float32Array.from(probs.slice(0, total)) }); }
  } catch (e) { postMessage({ type: 'error', message: String(e && e.message || e) }); }
  busy = false;
  if (pending) run();
}
onmessage = async e => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      ort.env.wasm.wasmPaths = m.base + 'lib/';
      ort.env.wasm.numThreads = m.threads;
      sess = await ort.InferenceSession.create(m.base + 'model/transnetv2.onnx', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      postMessage({ type: 'ready', threads: ort.env.wasm.numThreads });
      run();
    } catch (err) { postMessage({ type: 'error', message: 'モデルを読み込めませんでした：' + (err && err.message || err) }); }
  } else if (m.type === 'frames') {
    chunks.push({ d: m.data, n: m.n }); have += m.n; run();
  } else if (m.type === 'end') {
    ended = true; total = have; run();
  }
};
