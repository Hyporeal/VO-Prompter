// How far apart a video's full pictures (keyframes) are, read from the MP4/MOV header without decoding anything.
// Phones with Chrome-based browsers (seen on Pixels) can freeze when jumping in a video whose full pictures are far
// apart, so the app warns about those. Returns { maxGap, avgGap } in seconds, or null when it can't tell.
async function readBox(blob, pos) {
  const h = new DataView(await blob.slice(pos, pos + 16).arrayBuffer());
  if (h.byteLength < 8) return null;
  let size = h.getUint32(0), head = 8;
  const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
  if (size === 1) { size = Number(h.getBigUint64(8)); head = 16; } else if (size === 0) size = blob.size - pos;
  return { type, pos, size, head };
}
// child boxes inside a parsed box's bytes
function children(dv, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p), head = 8;
    const type = String.fromCharCode(dv.getUint8(p + 4), dv.getUint8(p + 5), dv.getUint8(p + 6), dv.getUint8(p + 7));
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); head = 16; } else if (size === 0) size = end - p;
    if (size < head || p + size > end) break;
    out.push({ type, start: p + head, end: p + size });
    p += size;
  }
  return out;
}
const find = (dv, box, type) => children(dv, box.start, box.end).find((b) => b.type === type);

// Times (seconds) of the video's full pictures, or null when it can't tell ([] means every picture is a full one).
export async function keyframeTimes(blob) {
  try {
    // find the moov box among the top-level boxes
    let pos = 0, moov = null;
    for (let i = 0; i < 64 && pos < blob.size; i++) {
      const b = await readBox(blob, pos);
      if (!b || b.size < 8) return null;
      if (b.type === 'moov') { moov = b; break; }
      pos += b.size;
    }
    if (!moov || moov.size > 64e6) return null;
    const dv = new DataView(await blob.slice(moov.pos, moov.pos + moov.size).arrayBuffer());
    const root = { start: moov.head, end: moov.size };
    for (const trak of children(dv, root.start, root.end).filter((b) => b.type === 'trak')) {
      const mdia = find(dv, trak, 'mdia'); if (!mdia) continue;
      const hdlr = find(dv, mdia, 'hdlr'); if (!hdlr) continue;
      const kind = String.fromCharCode(dv.getUint8(hdlr.start + 8), dv.getUint8(hdlr.start + 9), dv.getUint8(hdlr.start + 10), dv.getUint8(hdlr.start + 11));
      if (kind !== 'vide') continue;
      const mdhd = find(dv, mdia, 'mdhd');
      const v1 = dv.getUint8(mdhd.start) === 1;
      const scale = dv.getUint32(mdhd.start + (v1 ? 20 : 12));
      const stbl = find(dv, find(dv, mdia, 'minf'), 'stbl'); if (!stbl) return null;
      const stts = find(dv, stbl, 'stts'), stss = find(dv, stbl, 'stss'), ctts = find(dv, stbl, 'ctts');
      if (!stts || !scale) return null;
      if (!stss) return []; // every picture is a full one
      // decode time of each keyframe
      const keys = [];
      const nk = dv.getUint32(stss.start + 4);
      for (let i = 0; i < nk; i++) keys.push(dv.getUint32(stss.start + 8 + i * 4));
      const times = [];
      let sample = 1, t = 0, k = 0;
      const ne = dv.getUint32(stts.start + 4);
      for (let e = 0; e < ne; e++) {
        const count = dv.getUint32(stts.start + 8 + e * 8), delta = dv.getUint32(stts.start + 12 + e * 8);
        while (k < keys.length && keys[k] < sample + count) { times.push(t + (keys[k] - sample) * delta); k++; }
        sample += count; t += count * delta;
      }
      // shown time = decode time + composition offset
      if (ctts) {
        const nc = dv.getUint32(ctts.start + 4);
        let s0 = 1, kk = 0;
        for (let e = 0; e < nc && kk < keys.length; e++) {
          const count = dv.getUint32(ctts.start + 8 + e * 8), off = dv.getInt32(ctts.start + 12 + e * 8);
          while (kk < keys.length && keys[kk] < s0 + count) { times[kk] += off; kk++; }
          s0 += count;
        }
      }
      for (let i = 0; i < times.length; i++) times[i] /= scale;
      times.end = t / scale;
      return times;
    }
    return null;
  } catch (e) { return null; }
}

export async function keyframeGap(blob) {
  const times = await keyframeTimes(blob);
  if (!times) return null;
  if (!times.length) return { maxGap: 0, avgGap: 0 };
  const all = [...times, times.end]; // the end counts as the last gap's end
  let maxGap = 0;
  for (let i = 1; i < all.length; i++) maxGap = Math.max(maxGap, all[i] - all[i - 1]);
  return { maxGap, avgGap: (all[all.length - 1] - all[0]) / Math.max(1, all.length - 1) };
}
