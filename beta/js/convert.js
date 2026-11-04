// Make a copy of a video that jumps quickly: a full picture every second (many recordings, Zoom's for one, have one
// every 30 seconds or so, and each jump then has to rebuild up to 30 seconds of frames). Runs on this device with
// the browser's own video encoder (via Mediabunny, loaded the first time it's needed); nothing is uploaded. The sound
// is copied as it is. The copy is held in memory until it's finished, then handed back as one file.
let mbP = null;
const lib = () => (mbP = mbP || import(new URL('../vendor/mediabunny/mediabunny.min.mjs', location.href).href));

export async function quickJumpCopy(file, { onProgress, signal } = {}) {
  const mb = await lib();
  if (typeof VideoEncoder === 'undefined') throw new Error('this browser can’t convert video');
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video picture in this file');
  // collect the output in pieces; the few writes that go back (headers) patch the pieces already there
  const parts = [], starts = [];
  let size = 0;
  const write = (pos, data) => {
    if (pos === size) { parts.push(data.slice()); starts.push(size); size += data.length; return; }
    let i = starts.length - 1;
    while (i > 0 && starts[i] > pos) i--;
    let off = 0;
    while (off < data.length && i < parts.length) {
      const p = parts[i], at = pos + off - starts[i], n = Math.min(p.length - at, data.length - off);
      p.set(data.subarray(off, off + n), at); off += n; i++;
    }
    if (off < data.length) { const rest = data.slice(off); parts.push(rest); starts.push(size); size += rest.length; }
  };
  const target = new mb.StreamTarget(new WritableStream({ write: (c) => write(c.position, c.data) }));
  const output = new mb.Output({ format: new mb.Mp4OutputFormat(), target });
  const w = track.displayWidth || 1280;
  const conv = await mb.Conversion.init({
    input, output, tracks: 'primary',
    video: { keyFrameInterval: 1, forceTranscode: true, codec: 'avc', width: Math.min(w, 1280), quality: mb.QUALITY_LOW },
  });
  if (!conv.isValid) throw new Error('this video can’t be converted here (' + conv.discardedTracks.map((d) => d.reason).join(', ') + ')');
  conv.onProgress = (p) => onProgress && onProgress(p);
  if (signal) signal.addEventListener('abort', () => conv.cancel(), { once: true });
  await conv.execute();
  return new Blob(parts, { type: 'video/mp4' });
}
