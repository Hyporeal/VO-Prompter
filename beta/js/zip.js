// Minimal ZIP reader (for .docx) and writer (for exporting .docx). No outside libraries.

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export function readZipIndex(buf) {
  const d = new Uint8Array(buf);
  let eocd = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 65557); i--) {
    if (u32(d, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = u16(d, eocd + 10), cdOff = u32(d, eocd + 16);
  const entries = new Map();
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (u32(d, p) !== 0x02014b50) break;
    const method = u16(d, p + 10), compSize = u32(d, p + 20), nameLen = u16(d, p + 28),
      extraLen = u16(d, p + 30), commentLen = u16(d, p + 32), local = u32(d, p + 42);
    const name = new TextDecoder().decode(d.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { d, entries };
}

export async function readZipEntry(zip, name) {
  const e = zip.entries.get(name);
  if (!e) return null;
  const d = zip.d, l = e.local;
  const start = l + 30 + u16(d, l + 26) + u16(d, l + 28);
  const raw = d.subarray(start, start + e.compSize);
  if (e.method === 0) return raw.slice();
  if (e.method !== 8) throw new Error('Unsupported zip compression');
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([raw]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export async function readZipText(zip, name) {
  const b = await readZipEntry(zip, name);
  return b ? new TextDecoder().decode(b) : null;
}

let CRC_TABLE = null;
function crc32(data) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: Uint8Array | string }] -> Uint8Array (stored, uncompressed)
export function writeZip(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, a) => s + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
