// Make a copy of a video that jumps quickly: a full picture every second (many recordings, Zoom's for one, have one
// every 30 seconds or so, and each jump then has to rebuild up to 30 seconds of frames). Runs on this device with
// the browser's own video encoder (via Mediabunny, loaded the first time it's needed); nothing is uploaded.
// The work is done in pieces of about two minutes, each saved as it finishes, so an interruption costs one piece.
// The pieces hold only the picture; joining them copies the original sound back in, untouched.
let mbP = null;
const lib = () => (mbP = mbP || import(new URL('vendor/mediabunny/mediabunny.min.mjs', location.href).href));
export const canConvert = () => typeof VideoEncoder !== 'undefined';

const PIECE_S = 120; // seconds per piece
export const MODES = {
  std: { label: 'Standard', width: 1280, q: 'QUALITY_LOW' },
  sharp: { label: 'Sharp', width: 1920, q: 'QUALITY_MEDIUM' },
};

// an in-memory file writer that also takes the few writes that go back (headers); older data is folded into Blobs
// so a long file doesn't sit in one big array
function memTarget(mb) {
  const parts = [], starts = []; // Uint8Arrays, or Blobs for folded stretches
  let size = 0, open = -1; // open: index of the first unfolded chunk past the first MB
  const HEAD = 1 << 20, FOLD = 32 << 20;
  const write = (pos, data) => {
    if (pos === size) { parts.push(data.slice()); starts.push(size); size += data.length; }
    else {
      let lo = 0, hi = starts.length - 1; // last chunk starting at or before pos
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1; }
      let i = lo, off = 0;
      while (off < data.length) {
        if (i >= parts.length) { const rest = data.slice(off); parts.push(rest); starts.push(size); size += rest.length; break; }
        const p = parts[i];
        if (p instanceof Blob) throw new Error('late write into folded data');
        const at = pos + off - starts[i];
        if (at < p.length) { const n = Math.min(p.length - at, data.length - off); p.set(data.subarray(off, off + n), at); off += n; }
        i++;
      }
    }
    if (open < 0) { const k = starts.findIndex((x) => x >= HEAD); if (k > 0) open = k; }
    if (open > 0 && parts.length - 1 > open && size - starts[open] > FOLD) {
      const upto = parts.length - 1; // keep the latest chunk open
      const b = new Blob(parts.slice(open, upto));
      parts.splice(open, upto - open, b); starts.splice(open, upto - open, starts[open]);
      open += 1;
    }
  };
  const target = new mb.StreamTarget(new WritableStream({ write: (c) => write(c.position, c.data) }));
  return { target, blob: (type) => new Blob(parts, { type }) };
}

// Settle as soon as the signal fires, even if the encoder is stuck (Android can take it away from a page in the
// background without saying so); the stuck work is told to cancel and left behind.
function untilAbort(work, signal, cancel) {
  if (!signal) return work;
  if (signal.aborted) { if (cancel) Promise.resolve().then(cancel).catch(() => {}); work.catch(() => {}); return Promise.reject(new DOMException('stopped', 'AbortError')); }
  return new Promise((res, rej) => {
    const f = () => { if (cancel) Promise.resolve().then(cancel).catch(() => {}); rej(new DOMException('stopped', 'AbortError')); };
    signal.addEventListener('abort', f, { once: true });
    work.then((v) => { signal.removeEventListener('abort', f); signal.aborted ? rej(new DOMException('stopped', 'AbortError')) : res(v); },
      (e) => { signal.removeEventListener('abort', f); rej(signal.aborted ? new DOMException('stopped', 'AbortError') : e); });
  });
}

async function open(file) {
  const mb = await lib();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video picture in this file');
  return { mb, input, track };
}

// Where the pieces start: at the original's own full pictures nearest each two minutes, so no piece has to
// rebuild frames from before its start.
export async function planQuick(file, PIECE = PIECE_S) {
  const { input, track, mb } = await open(file);
  const dur = await input.computeDuration();
  const sink = new mb.EncodedPacketSink(track);
  const bounds = [0];
  for (let t = PIECE; t < dur - PIECE / 4; t += PIECE) {
    const k = await sink.getKeyPacket(t, { metadataOnly: true });
    const at = k ? k.timestamp : t;
    if (at > bounds[bounds.length - 1] + PIECE / 4) bounds.push(at);
  }
  const first = await sink.getFirstPacket({ metadataOnly: true });
  bounds.push(dur);
  try { input.dispose(); } catch (e) { /* closed */ }
  return { dur, bounds, w: track.displayWidth, h: track.displayHeight };
}

// Encode the picture between start and end (seconds in the original) into a small video-only file.
export async function encodePiece(file, start, end, mode, { onProgress, signal } = {}) {
  const { mb, input, track } = await open(file);
  const m = MODES[mode] || MODES.std;
  const { target, blob } = memTarget(mb);
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
  const conv = await mb.Conversion.init({
    input, output, tracks: 'primary', trim: { start, end },
    audio: { discard: true },
    video: { keyFrameInterval: 1, forceTranscode: true, codec: 'avc', width: Math.min(track.displayWidth || m.width, m.width), quality: mb[m.q] },
  });
  if (!conv.isValid) throw new Error('this video can’t be converted here (' + conv.discardedTracks.map((d) => d.reason).join(', ') + ')');
  if (onProgress) conv.onProgress = onProgress;
  try { await untilAbort(conv.execute(), signal, () => conv.cancel()); }
  finally { setTimeout(() => { try { input.dispose(); } catch (e) { /* already closed */ } }, 0); }
  return blob('video/mp4');
}

// Check a finished piece against the original: same number of pictures, so nothing was dropped along the way.
export async function checkPiece(file, piece, start, end) {
  const { mb, track, input } = await open(file);
  const sink = new mb.EncodedPacketSink(track), o = { metadataOnly: true };
  let want = 0;
  const k = await sink.getKeyPacket(start, o);
  for await (const pk of sink.packets(k || undefined, undefined, o)) { if (pk.timestamp >= end) { if (pk.type === 'key') break; continue; } if (pk.timestamp >= start) want++; }
  const pin = new mb.Input({ source: new mb.BlobSource(piece), formats: mb.ALL_FORMATS });
  const pv = await pin.getPrimaryVideoTrack();
  let got = 0;
  try { if (pv) for await (const pk of new mb.EncodedPacketSink(pv).packets(undefined, undefined, o)) got++; }
  finally { try { pin.dispose(); input.dispose(); } catch (e) { /* closed */ } }
  return { ok: got >= want - 1, got, want };
}

// Time a short sample of each mode on this device: two lengths, so the fixed start-up cost of each piece and the
// cost per second of video can be told apart. Returns { mode: { perSec, perPiece, bytesPerSec } }.
export async function measure(file, plan, modes = ['std', 'sharp'], signal) {
  await lib();
  const mid = plan.bounds[Math.floor((plan.bounds.length - 1) / 2)];
  const at = Math.min(mid, Math.max(0, plan.dur - 12));
  const out = {};
  for (const mode of modes) {
    const run = async (len) => { const t = performance.now(); const b = await encodePiece(file, at, Math.min(plan.dur, at + len), mode, { signal }); return { s: (performance.now() - t) / 1000, bytes: b.size }; };
    await run(1); // warm up the decoder and encoder
    const a = await run(2), b = await run(8);
    const perSec = Math.max(0.01, (b.s - a.s) / 6);
    out[mode] = { perSec, perPiece: Math.max(0, a.s - 2 * perSec), bytesPerSec: Math.max(1, (b.bytes - a.bytes) / 6) };
  }
  return out;
}

// Join the pieces into one video and copy the original's sound in. Returns a Blob.
export function joinPieces(file, pieces, bounds, opts = {}) { return untilAbort(joinRun(file, pieces, bounds, opts), opts.signal); }
async function joinRun(file, pieces, bounds, { onProgress, signal } = {}) {
  const { mb, input, track: srcV } = await open(file);
  const srcA = await input.getPrimaryAudioTrack();
  const { target, blob } = memTarget(mb);
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
  const vs = new mb.EncodedVideoPacketSource('avc');
  output.addVideoTrack(vs, srcV.rotation ? { rotation: srcV.rotation } : undefined);
  let as = null, aSink = null, aCfg = null;
  if (srcA && srcA.codec) {
    as = new mb.EncodedAudioPacketSource(srcA.codec);
    output.addAudioTrack(as, srcA.languageCode && srcA.languageCode !== 'und' ? { languageCode: srcA.languageCode } : undefined);
    aSink = new mb.EncodedPacketSink(srcA);
    aCfg = await srcA.getDecoderConfig();
  }
  await output.start();
  const total = bounds[bounds.length - 1] || 1;
  let aIter = aSink ? aSink.packets()[Symbol.asyncIterator]() : null, aNext = aIter ? (await aIter.next()).value : null, aFirst = true;
  const audioUpTo = async (t) => {
    while (aNext && aNext.timestamp < t) {
      await as.add(aNext, aFirst ? { decoderConfig: aCfg } : undefined); aFirst = false;
      aNext = (await aIter.next()).value;
    }
  };
  let vFirst = true, cfg0 = null, last = -1;
  for (let i = 0; i < pieces.length; i++) {
    if (signal && signal.aborted) throw new DOMException('stopped', 'AbortError');
    const pin = new mb.Input({ source: new mb.BlobSource(pieces[i]), formats: mb.ALL_FORMATS });
    const pv = await pin.getPrimaryVideoTrack();
    const cfg = await pv.getDecoderConfig();
    if (!cfg0) cfg0 = cfg;
    else if (!sameCfg(cfg0, cfg)) throw new Error('pieces made with different settings');
    const off = bounds[i];
    for await (const pk of new mb.EncodedPacketSink(pv).packets()) {
      const ts = pk.timestamp + off;
      if (ts <= last + 1e-4) continue; // never let two pictures share a time
      last = ts;
      await audioUpTo(ts);
      await vs.add(pk.clone({ timestamp: ts }), vFirst ? { decoderConfig: cfg } : undefined); vFirst = false;
      if (onProgress) onProgress(Math.min(1, ts / total));
    }
    try { pin.dispose(); } catch (e) { /* closed */ }
  }
  await audioUpTo(Infinity);
  await output.finalize();
  try { input.dispose(); } catch (e) { /* closed */ }
  return blob('video/mp4');
}
function sameCfg(a, b) {
  if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
  const da = a.description ? new Uint8Array(a.description.buffer || a.description, a.description.byteOffset || 0, a.description.byteLength) : null;
  const db = b.description ? new Uint8Array(b.description.buffer || b.description, b.description.byteOffset || 0, b.description.byteLength) : null;
  if (!da || !db) return da === db;
  return da.length === db.length && da.every((v, i) => v === db[i]);
}
