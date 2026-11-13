// 動画ファイルから映像のパケットを順に取り出す（MKV・WebM は自前の読み取り、MP4 は mp4box）。
// openVideo(file) → {codec, description, width, height, fps, estFrames, packets()}
// packets() は {data, ts（マイクロ秒）, key} を復号の順に返す非同期の繰り返し。

const CHUNK = 8 << 20;

class Reader {
  constructor(file) { this.f = file; this.pos = 0; this.buf = new Uint8Array(0); this.bufPos = 0; }
  get size() { return this.f.size; }
  async ensure(n) {
    const off = this.pos - this.bufPos;
    if (off >= 0 && off + n <= this.buf.length) return true;
    if (this.pos >= this.f.size) return false;
    const len = Math.min(Math.max(n, CHUNK), this.f.size - this.pos);
    this.buf = new Uint8Array(await this.f.slice(this.pos, this.pos + len).arrayBuffer());
    this.bufPos = this.pos;
    return this.buf.length >= n;
  }
  async bytes(n) {
    if (!(await this.ensure(n))) throw new Error('ファイルの終わりを越えて読もうとしました');
    const off = this.pos - this.bufPos; this.pos += n;
    return this.buf.subarray(off, off + n);
  }
  async byte() { return (await this.bytes(1))[0]; }
  skip(n) { this.pos += n; }
}

// EBML の可変長整数
async function vint(r, keepMarker) {
  const b0 = await r.byte();
  let len = 1, mask = 0x80;
  while (len <= 8 && !(b0 & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error('MKV の読み取りに失敗しました（壊れた要素）');
  let v = keepMarker ? b0 : (b0 & (mask - 1));
  let allOnes = (b0 & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { const b = await r.byte(); v = v * 256 + b; if (b !== 0xff) allOnes = false; }
  return { v, len, unknown: !keepMarker && allOnes };
}
function uint(b) { let v = 0; for (const x of b) v = v * 256 + x; return v; }
function float(b) { const dv = new DataView(b.buffer, b.byteOffset, b.length); return b.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }
const hex = n => n.toString(16).padStart(2, '0');

const ID = {
  EBML: 0x1A45DFA3, Segment: 0x18538067, Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
  Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2,
  Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, DefaultDuration: 0x23E383,
  Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, ReferenceBlock: 0xFB,
};
const LEVEL1 = new Set([0x114D9B74, 0x1549A966, 0x1654AE6B, 0x1F43B675, 0x1C53BB6B, 0x1941A469, 0x1043A770, 0x1254C367]);

function codecFromMkv(id, priv) {
  if (id === 'V_MPEG4/ISO/AVC') return 'avc1.' + hex(priv[1]) + hex(priv[2]) + hex(priv[3]);
  if (id === 'V_MPEGH/ISO/HEVC') return hevcString(priv);
  if (id === 'V_VP9') return 'vp09.00.10.08';
  if (id === 'V_VP8') return 'vp8';
  if (id === 'V_AV1') return av1String(priv);
  throw new Error('この映像の形式（' + id + '）には対応していません');
}
function hevcString(h) {
  const space = h[1] >> 6, tier = (h[1] >> 5) & 1, prof = h[1] & 0x1f;
  let compat = (h[2] << 24 | h[3] << 16 | h[4] << 8 | h[5]) >>> 0, rev = 0;
  for (let i = 0; i < 32; i++) { rev = (rev << 1) | (compat & 1); compat >>>= 1; }
  const cons = [...h.subarray(6, 12)];
  while (cons.length && cons[cons.length - 1] === 0) cons.pop();
  return 'hvc1.' + ['', 'A', 'B', 'C'][space] + prof + '.' + (rev >>> 0).toString(16) + '.' + (tier ? 'H' : 'L') + h[12] + cons.map(c => '.' + hex(c)).join('');
}
function av1String(c) {
  const prof = c[1] >> 5, level = c[1] & 0x1f, tier = c[2] >> 7, hb = (c[2] >> 6) & 1, tw = (c[2] >> 5) & 1;
  const bits = hb ? (prof === 2 && tw ? 12 : 10) : 8;
  return 'av01.' + prof + '.' + String(level).padStart(2, '0') + (tier ? 'H' : 'M') + '.' + String(bits).padStart(2, '0');
}

async function openMkv(file) {
  const r = new Reader(file);
  const info = { scale: 1e6, duration: 0 };
  let track = null, segEnd = file.size, firstCluster = -1;
  // ヘッダ
  let id = (await vint(r, true)).v; let sz = await vint(r);
  if (id !== ID.EBML) throw new Error('MKV・WebM の形式ではありません');
  r.skip(sz.v);
  id = (await vint(r, true)).v; sz = await vint(r);
  if (id !== ID.Segment) throw new Error('MKV の Segment が見つかりません');
  if (!sz.unknown) segEnd = r.pos + sz.v;
  // Cluster に着くまでの要素（Info・Tracks）を読む
  while (r.pos < segEnd) {
    const start = r.pos;
    id = (await vint(r, true)).v; sz = await vint(r);
    if (id === ID.Cluster) { firstCluster = start; break; }
    if (id === ID.Info) {
      const end = r.pos + sz.v;
      while (r.pos < end) {
        const cid = (await vint(r, true)).v, cs = await vint(r);
        const b = await r.bytes(cs.v);
        if (cid === ID.TimecodeScale) info.scale = uint(b);
        else if (cid === ID.Duration) info.duration = float(b);
      }
    } else if (id === ID.Tracks) {
      const end = r.pos + sz.v;
      while (r.pos < end) {
        const tid = (await vint(r, true)).v, ts = await vint(r);
        if (tid !== ID.TrackEntry) { r.skip(ts.v); continue; }
        const tend = r.pos + ts.v, t = {};
        while (r.pos < tend) {
          const cid = (await vint(r, true)).v, cs = await vint(r);
          if (cid === ID.Video) {
            const vend = r.pos + cs.v;
            while (r.pos < vend) {
              const vid = (await vint(r, true)).v, vs = await vint(r); const b = await r.bytes(vs.v);
              if (vid === ID.PixelWidth) t.w = uint(b); else if (vid === ID.PixelHeight) t.h = uint(b);
            }
            continue;
          }
          const b = await r.bytes(cs.v);
          if (cid === ID.TrackNumber) t.num = uint(b);
          else if (cid === ID.TrackType) t.type = uint(b);
          else if (cid === ID.CodecID) t.codec = new TextDecoder().decode(b).replace(/\0+$/, '');
          else if (cid === ID.CodecPrivate) t.priv = b.slice();
          else if (cid === ID.DefaultDuration) t.dd = uint(b);
        }
        if (t.type === 1 && !track) track = t;
      }
    } else r.skip(sz.unknown ? 0 : sz.v);
  }
  if (!track) throw new Error('映像のトラックが見つかりません');
  if (firstCluster < 0) throw new Error('映像のデータ（Cluster）が見つかりません');
  const fps = track.dd ? 1e9 / track.dd : 24000 / 1001;
  const durSec = info.duration * info.scale / 1e9;
  const codec = codecFromMkv(track.codec, track.priv || new Uint8Array(0));
  const desc = /^(avc1|hvc1)/.test(codec) ? track.priv : (track.codec === 'V_AV1' && track.priv && track.priv.length > 4 ? track.priv : undefined);
  async function* packets() {
    const rr = new Reader(file); rr.pos = firstCluster;
    let clusterTc = 0;
    while (rr.pos < segEnd && rr.pos < file.size) {
      const cid = (await vint(rr, true)).v, cs = await vint(rr);
      if (cid !== ID.Cluster) { rr.skip(cs.unknown ? 0 : cs.v); continue; }
      const cend = cs.unknown ? Infinity : rr.pos + cs.v;
      while (rr.pos < cend && rr.pos < file.size) {
        const save = rr.pos;
        const eid = (await vint(rr, true)).v;
        if (cs.unknown && LEVEL1.has(eid)) { rr.pos = save; break; }
        const es = await vint(rr);
        if (eid === ID.Timecode) { clusterTc = uint(await rr.bytes(es.v)); continue; }
        let blockBytes = null, key = false;
        if (eid === ID.SimpleBlock) { blockBytes = await rr.bytes(es.v); key = !!(blockBytes[0] & 0) ; }
        else if (eid === ID.BlockGroup) {
          const gend = rr.pos + es.v; let ref = false;
          while (rr.pos < gend) {
            const gid = (await vint(rr, true)).v, gs = await vint(rr);
            if (gid === ID.Block) blockBytes = (await rr.bytes(gs.v)).slice();
            else { if (gid === ID.ReferenceBlock) ref = true; rr.skip(gs.v); }
          }
          key = !ref;
          if (blockBytes) blockBytes = { group: true, b: blockBytes, key };
        } else { rr.skip(es.v); continue; }
        if (!blockBytes) continue;
        let b = blockBytes.group ? blockBytes.b : blockBytes;
        // ブロックの頭：トラック番号、時刻（16ビット）、フラグ
        let p = 0, len = 1, mask = 0x80; while (!(b[p] & mask)) { len++; mask >>= 1; }
        let tn = b[p] & (mask - 1); for (let i = 1; i < len; i++) tn = tn * 256 + b[p + i]; p += len;
        if (tn !== track.num) continue;
        const rel = (b[p] << 8 | b[p + 1]) << 16 >> 16; p += 2;
        const flags = b[p]; p += 1;
        if (flags & 0x06) throw new Error('映像のレーシング（複数フレームの詰め込み）には対応していません');
        if (!blockBytes.group) key = !!(flags & 0x80);
        const ts = (clusterTc + rel) * info.scale / 1000;
        yield { data: b.slice(p), ts, key };
      }
    }
  }
  return { kind: 'mkv', codec, description: desc, width: track.w, height: track.h, fps, estFrames: durSec ? Math.round(durSec * fps) : 0, packets };
}

async function openMp4(file) {
  const { createFile, DataStream, Endianness, MP4BoxBuffer } = await import('./lib/mp4box.all.mjs');
  const mp4 = createFile();
  let info = null, err = null;
  const queue = []; let ended = false, notify = null;
  mp4.onError = e => { err = e; };
  mp4.onReady = i => { info = i; };
  mp4.onSamples = (id, user, samples) => { for (const s of samples) queue.push(s); if (notify) notify(); };
  let pos = 0;
  async function feed() {
    if (pos >= file.size) { if (!ended) { mp4.flush(); ended = true; } return false; }
    const ab = await file.slice(pos, pos + CHUNK).arrayBuffer();
    const buf = MP4BoxBuffer.fromArrayBuffer(ab, pos);
    pos = mp4.appendBuffer(buf); if (pos == null) pos = file.size;
    return true;
  }
  while (!info && !err) { if (!(await feed())) break; }
  if (err || !info) throw new Error('MP4 の読み取りに失敗しました' + (err ? '（' + err + '）' : ''));
  const vt = info.videoTracks[0]; if (!vt) throw new Error('映像のトラックが見つかりません');
  const trak = mp4.getTrackById(vt.id);
  let description;
  for (const e of trak.mdia.minf.stbl.stsd.entries) {
    const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
    if (box) { const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN); box.write(s); description = new Uint8Array(s.buffer, 8); break; }
  }
  const fps = vt.nb_samples / (vt.samples_duration / vt.timescale || vt.duration / vt.timescale);
  mp4.setExtractionOptions(vt.id, null, { nbSamples: 500 });
  mp4.start();
  async function* packets() {
    while (true) {
      while (queue.length) {
        const s = queue.shift();
        yield { data: s.data, ts: 1e6 * s.cts / s.timescale, key: s.is_sync };
        mp4.releaseUsedSamples(vt.id, s.number);
      }
      if (ended && !queue.length) return;
      if (!(await feed()) && !queue.length) return;
    }
  }
  return { kind: 'mp4', codec: vt.codec, description, width: vt.video.width, height: vt.video.height, fps: fps || 24000 / 1001, estFrames: vt.nb_samples, packets };
}

export async function openVideo(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head[0] === 0x1A && head[1] === 0x45 && head[2] === 0xDF && head[3] === 0xA3) return openMkv(file);
  const box = String.fromCharCode(...head.subarray(4, 8));
  if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip'].includes(box)) return openMp4(file);
  throw new Error('MKV・WebM・MP4 の動画を選んでください');
}
