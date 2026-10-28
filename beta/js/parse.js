// Script files -> paragraphs -> a model of tokens (what's shown) and units (what's spoken).
//
// Rules (see README):
//   [anything in brackets]      shown dimmed, not read
//   00:01:30 at a line's start  video timestamp for the words that follow (also 1:30)
//   # Heading / Word headings   section name, not read
//   // note                     not read
//   [SKIP] at a line's start    the line isn't read
//   [END]                       ends the script
//   START SESSION 3 and other all-caps lines with a number or session/part/take/pickup/break: markers, not read
//   strikethrough or hidden text in Word is dropped

import { readZipIndex, readZipText, writeZip } from './zip.js';

// ---------- file reading ----------

export async function fileToParagraphs(file) {
  const name = (file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 4));
  if (name.endsWith('.docx') || (head[0] === 0x50 && head[1] === 0x4b)) return docxToParagraphs(buf);
  let text = new TextDecoder().decode(buf).replace(/^﻿/, '');
  if (name.endsWith('.md')) text = text.replace(/\\([\[\]'"*_#\\.!-])/g, '$1');
  return textToParagraphs(text);
}

export function textToParagraphs(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function docxToParagraphs(buf) {
  const zip = readZipIndex(buf);
  const xml = await readZipText(zip, 'word/document.xml');
  if (!xml) throw new Error('This Word file has no document body');
  const headingStyles = new Set();
  const stylesXml = await readZipText(zip, 'word/styles.xml');
  if (stylesXml) {
    const sd = new DOMParser().parseFromString(stylesXml, 'application/xml');
    for (const st of sd.getElementsByTagNameNS(W, 'style')) {
      const id = st.getAttributeNS(W, 'styleId') || st.getAttribute('w:styleId');
      const nm = st.getElementsByTagNameNS(W, 'name')[0];
      const nv = nm ? (nm.getAttributeNS(W, 'val') || nm.getAttribute('w:val') || '') : '';
      if (/^(heading \d|title)$/i.test(nv) && id) headingStyles.add(id);
    }
  }
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const body = doc.getElementsByTagNameNS(W, 'body')[0];
  const out = [];
  const val = (el) => el.getAttributeNS(W, 'val') ?? el.getAttribute('w:val');
  const isOn = (el) => { const v = val(el); return v == null || !/^(false|0|off|none)$/i.test(v); };
  const runSkipped = (r) => {
    const rPr = [...r.children].find((c) => c.localName === 'rPr');
    if (!rPr) return false;
    return [...rPr.children].some((c) => (c.localName === 'strike' || c.localName === 'dstrike' || c.localName === 'vanish') && isOn(c));
  };
  const closestP = (n) => { for (let e = n.parentNode; e; e = e.parentNode) if (e.localName === 'p' && e.namespaceURI === W) return e; return null; };
  function handleP(p) {
    let style = '';
    const pPr = [...p.children].find((c) => c.localName === 'pPr');
    if (pPr) { const ps = [...pPr.children].find((c) => c.localName === 'pStyle'); if (ps) style = val(ps) || ''; }
    const heading = headingStyles.has(style) || /^(heading\d|title)$/i.test(style);
    let text = '';
    for (const r of p.getElementsByTagNameNS(W, 'r')) {
      if (closestP(r) !== p || runSkipped(r)) continue;
      for (const c of r.children) {
        switch (c.localName) {
          case 't': text += c.textContent; break;
          case 'tab': text += ' '; break;
          case 'br': case 'cr': text += '\n'; break;
          case 'noBreakHyphen': text += '-'; break;
          default: break;
        }
      }
    }
    for (const line of text.split('\n')) {
      const t = line.replace(/\s+/g, ' ').trim();
      if (t) out.push(heading ? '# ' + t : t);
    }
  }
  function walk(node) {
    for (const c of node.children) {
      if (c.namespaceURI !== W) continue;
      if (c.localName === 'p') handleP(c);
      else if (c.localName === 'tbl') { for (const p of c.getElementsByTagNameNS(W, 'p')) if (closestP(p) === null) handleP(p); }
      else if (c.localName === 'sdt' || c.localName === 'sdtContent' || c.localName === 'customXml') walk(c);
    }
  }
  walk(body);
  return out;
}

// ---------- exporting ----------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function paragraphsToText(paras) { return paras.join('\n\n') + '\n'; }

export function paragraphsToDocx(paras) {
  const body = paras.map((t) => {
    const h = /^#\s+/.test(t);
    const txt = h ? t.replace(/^#+\s+/, '') : t;
    return `<w:p>${h ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' : ''}<w:r><w:t xml:space="preserve">${esc(txt)}</w:t></w:r></w:p>`;
  }).join('');
  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style></w:styles>`;
  return writeZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
    { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'word/document.xml', data: docXml },
    { name: 'word/styles.xml', data: styles },
  ]);
}

// ---------- spoken-word normalization (shared with the follower) ----------

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
function intWords(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? intWords(n % 100) : [])];
  if (n < 1e6) return [...intWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? intWords(n % 1000) : [])];
  if (n < 1e9) return [...intWords(Math.floor(n / 1e6)), 'million', ...(n % 1e6 ? intWords(n % 1e6) : [])];
  return String(n).split('').map((d) => ONES[+d]);
}
const ORD = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' };
export function numberWords(s) {
  let t = s.replace(/[$,£€]/g, '');
  const pct = /%$/.test(t); if (pct) t = t.slice(0, -1);
  const ordm = t.match(/^(\d+)(st|nd|rd|th)$/i);
  if (ordm) {
    const w = intWords(parseInt(ordm[1], 10)); const last = w.pop();
    return [...w, ORD[last] || (last.endsWith('y') ? last.slice(0, -1) + 'ieth' : last + 'th')];
  }
  const m = t.match(/^(\d*)(?:\.(\d+))?$/);
  if (!m) return t.replace(/\d/g, (d) => ' ' + ONES[+d] + ' ').trim().split(/\s+/);
  const w = m[1] !== '' ? intWords(parseInt(m[1], 10)) : [];
  if (m[2] !== undefined) w.push('point', ...m[2].split('').map((d) => ONES[+d]));
  if (pct) w.push('percent');
  return w;
}

export const FUNC = new Set(('a an the and or nor of to in on at for with by from as is it its be been being we our us this that these those so but if ' +
  'then than there here are was were has have had do does did not no can will would should could may might must you your they them their he ' +
  'him his she her i me my what which who whom when where how all any each up out into over just also lets thats theres heres were weve well ' +
  'ill id im ive youre youll theyre isnt arent dont doesnt wont cant shall via per').split(' '));
const FILLERS = new Set(['um', 'uh', 'uhm', 'umm', 'er', 'erm', 'ah', 'hmm', 'mm', 'huh', 'unk']);

// One written word -> spoken keys. Returns [{ key, soft }].
export function wordKeys(raw) {
  let s = raw.replace(/[’‘`´]/g, "'").replace(/[“”«»"]/g, '').replace(/^[^\w$£€]+|[^\w%]+$/g, '');
  if (!s) return [];
  if (/^[$£€]?\d[\d,]*(\.\d+)?%?$/.test(s) || /^\d+(st|nd|rd|th)$/i.test(s) || /^\.\d+$/.test(s)) {
    return numberWords(s).map((key) => ({ key, soft: true }));
  }
  const out = [];
  for (const part of s.split(/[-/–]+/)) {
    if (!part) continue;
    if (/\d/.test(part)) { // mixed like V2, 21CFR
      for (const k of part.toLowerCase().replace(/(\d+)/g, ' $1 ').trim().split(/\s+/)) {
        if (/^\d+$/.test(k)) numberWords(k).forEach((key) => out.push({ key, soft: true }));
        else { const key = k.replace(/[^a-z]/g, ''); if (key) out.push({ key, soft: true }); }
      }
      continue;
    }
    const letters = part.replace(/[^A-Za-z']/g, '');
    const key = letters.toLowerCase().replace(/'/g, '');
    if (!key) continue;
    const acronym = /^[A-Z]{2,6}s?$/.test(letters) || /^[a-z][A-Z]{2,5}$/.test(letters);
    out.push({ key, soft: acronym });
  }
  return out;
}

// Recognizer text -> keys
export function hypKeys(text) {
  const out = [];
  for (const w of text.toLowerCase().replace(/[’‘]/g, "'").split(/\s+/)) {
    if (!w || w === '[unk]' || w === '<unk>') continue;
    for (const { key } of wordKeys(w)) if (!FILLERS.has(key)) out.push(key);
  }
  return out;
}

export function syllables(key) {
  const w = key.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 1;
  if (w.length <= 3) return 1;
  const t = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '');
  const m = t.match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}

// ---------- model ----------

const STAMP_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,3}))?(?=\s|$|\[)/;
const MARKER_RE = /\b(SESSION|PART|TAKE|PICK-?UP|PICKUPS|BREAK|SCENE|REEL|SEGMENT)\b|\d/;

function stampSeconds(m) {
  const a = +m[1], b = +m[2], c = m[3] !== undefined ? +m[3] : null;
  const frac = m[4] ? +('0.' + m[4]) : 0;
  return (c === null ? a * 60 + b : a * 3600 + b * 60 + c) + frac;
}
export function fmtTime(t) {
  if (!isFinite(t)) return '0:00';
  t = Math.max(0, Math.floor(t));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function classify(text, ended) {
  if (ended) return 'after-end';
  if (/^\[END\]$/i.test(text)) return 'end';
  if (/^#/.test(text)) return 'heading';
  if (/^\/\//.test(text)) return 'note';
  if (/^\[SKIP\]/i.test(text)) return 'skip';
  if (STAMP_RE.test(text) || /^\[/.test(text)) return 'spoken';
  if (!/[a-z]/.test(text) && /[A-Z]/.test(text) && text.split(/\s+/).length >= 2 && text.length <= 48 && MARKER_RE.test(text)) return 'marker';
  return 'spoken';
}

// paras: [{ id, text }]
export function buildModel(paras, videoDuration) {
  const blocks = [], tokens = [], units = [], anchors = [], sentences = [];
  const index = new Map();
  let pendingAnchor = null, ended = false, sentStart = 0;
  const endSentence = () => {
    if (tokens.length > sentStart) {
      const t0 = sentStart, t1 = tokens.length;
      const u0 = tokens[t0].u0, u1 = tokens[t1 - 1].u1;
      if (u1 > u0) sentences.push({ t0, t1, u0, u1, pid: tokens[t0].pid });
      for (let t = t0; t < t1; t++) tokens[t].sent = sentences.length - 1;
    }
    sentStart = tokens.length;
  };
  for (const p of paras) {
    let text = p.text;
    const kind = classify(text, ended);
    const block = { pid: p.id, kind, parts: [], t0: tokens.length, u0: units.length, anchor: null };
    if (kind === 'end') ended = true;
    if (kind !== 'spoken') {
      block.parts.push({ type: 'ns', text });
      block.t1 = tokens.length; block.u1 = units.length;
      blocks.push(block);
      continue;
    }
    const sm = text.match(STAMP_RE);
    if (sm) {
      pendingAnchor = stampSeconds(sm);
      block.parts.push({ type: 'stamp', text: sm[0], t: pendingAnchor });
      text = text.slice(sm[0].length).replace(/^\s+/, '');
    }
    // split into bracketed (not read) and spoken pieces
    const re = /\[[^\]]*\]?/g;
    let last = 0, m;
    const pieces = [];
    while ((m = re.exec(text))) {
      if (m.index > last) pieces.push({ spoken: true, s: text.slice(last, m.index) });
      pieces.push({ spoken: false, s: m[0] });
      last = m.index + m[0].length;
    }
    if (last < text.length) pieces.push({ spoken: true, s: text.slice(last) });
    for (const pc of pieces) {
      if (!pc.spoken) { block.parts.push({ type: 'ns', text: pc.s }); continue; }
      const wre = /([^\s—–]+)|(\s+|[—–]+|\s*-{2,3}\s*)/g;
      let wm;
      while ((wm = wre.exec(pc.s))) {
        if (wm[2] !== undefined) { block.parts.push({ type: 'gap', text: wm[2] }); continue; }
        let w = wm[1];
        if (/^-{2,}$/.test(w)) { block.parts.push({ type: 'gap', text: '—' }); continue; }
        if (/-{2,}/.test(w)) { // "word---word" from some converters
          const bits = w.split(/-{2,}/);
          bits.forEach((b, i) => { if (i) block.parts.push({ type: 'gap', text: '—' }); if (b) addToken(b, block, p.id); });
          continue;
        }
        addToken(w, block, p.id);
      }
    }
    block.t1 = tokens.length; block.u1 = units.length;
    if (block.u1 > block.u0) {
      endSentence();
    }
    blocks.push(block);
  }
  endSentence();

  function addToken(w, block, pid) {
    const keys = wordKeys(w);
    const tok = { ti: tokens.length, pid, text: w, u0: units.length, u1: units.length, sent: -1 };
    for (const k of keys) {
      const u = { u: units.length, ti: tok.ti, key: k.key, soft: k.soft, func: FUNC.has(k.key), syl: syllables(k.key) };
      units.push(u);
      if (!index.has(k.key)) index.set(k.key, []);
      index.get(k.key).push(u.u);
    }
    tok.u1 = units.length;
    tok.spoken = tok.u1 > tok.u0;
    tok.endsSentence = /[.!?]["'”’)\]]*$/.test(w) && !/^\d+\.\d+$/.test(w);
    tok.endsPhrase = tok.endsSentence || /[,;:)]["'”’]*$/.test(w);
    if (tok.spoken && pendingAnchor !== null) {
      if (!anchors.length || pendingAnchor > anchors[anchors.length - 1].t) {
        anchors.push({ u: tok.u0, t: pendingAnchor });
        block.anchor = block.anchor ?? pendingAnchor;
      }
      pendingAnchor = null;
    }
    tokens.push(tok);
    block.parts.push({ type: 'w', ti: tok.ti });
    if (tok.endsSentence) { endSentenceInline(); }
  }
  function endSentenceInline() { endSentence(); }

  const model = { paras, blocks, tokens, units, anchors, sentences, index, N: units.length };
  model.times = computeTimes(model, videoDuration);
  return model;
}

// Time in the video where each unit starts. times[N] is the end.
export function computeTimes(model, duration) {
  const { units, anchors, N } = model;
  if (!N) return null;
  const times = new Float64Array(N + 1);
  const cum = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) cum[i + 1] = cum[i] + units[i].syl;
  const dur = isFinite(duration) && duration > 0 ? duration : null;
  if (!anchors.length) {
    if (!dur) return null;
    for (let i = 0; i <= N; i++) times[i] = dur * cum[i] / cum[N];
    return times;
  }
  const a0 = anchors[0];
  for (let i = 0; i <= a0.u; i++) times[i] = a0.t;
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k], b = anchors[k + 1];
    const endU = b ? b.u : N;
    let endT;
    if (b) endT = b.t;
    else {
      const natural = a.t + (cum[N] - cum[a.u]) / 4.5;
      endT = dur && dur > a.t ? dur : natural;
    }
    const span = cum[endU] - cum[a.u] || 1;
    for (let i = a.u; i <= endU; i++) times[i] = a.t + (endT - a.t) * (cum[i] - cum[a.u]) / span;
  }
  return times;
}

export function timeAt(times, p) {
  if (!times) return 0;
  const n = times.length - 1;
  if (p <= 0) return times[0];
  if (p >= n) return times[n];
  const i = Math.floor(p), f = p - i;
  return times[i] + (times[i + 1] - times[i]) * f;
}

export function unitAtTime(times, t) {
  if (!times) return 0;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
  return Math.min(lo, times.length - 2);
}
