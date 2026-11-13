// 動画を頭から復号して、1コマずつ onFrame(frame, コマ番号) に渡す（WebCodecs）
export async function decodeAll(meta, onFrame, onProgress) {
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
    const now = performance.now(); if (now - last > 300) { last = now; onProgress && onProgress(count); await new Promise(r => setTimeout(r, 0)); }
  }
  await dec.flush(); dec.close();
  if (err) throw err;
  return count;
}
