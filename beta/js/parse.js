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

// Word (.docx), EPUB, OpenDocument (.odt), RTF, PDF, web pages, subtitles (.srt/.vtt), Final Draft (.fdx),
// Fountain, Markdown and plain text. Everything is read on the device.
export async function fileToParagraphs(file) {
  const name = (file.name || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 8));
  if (head[0] === 0x50 && head[1] === 0x4b) { // a zip: Word, EPUB or OpenDocument
    const zip = readZipIndex(buf);
    if (zip.entries.has('word/document.xml')) return docxToParagraphs(buf, zip);
    if (zip.entries.has('META-INF/container.xml')) return epubToParagraphs(zip);
    if (zip.entries.has('content.xml')) return odtToParagraphs(zip);
    throw new Error('this kind of file isn’t supported (try .docx, .epub, .odt, .pdf, .rtf or .txt)');
  }
  if (ext === 'pdf' || String.fromCharCode(...head.slice(0, 5)) === '%PDF-') return pdfToParagraphs(buf);
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new Error('this is an older Word file (.doc). Save it as .docx in Word (File → Save As) and open that');
  }
  let text = decodeText(buf);
  if (ext === 'rtf' || /^\s*\{\\rtf/.test(text)) return rtfToParagraphs(text);
  if (ext === 'fdx' || /^\s*(<\?xml[^>]*>\s*)?<FinalDraft/i.test(text)) return fdxToParagraphs(text);
  if (/^(html?|xhtml)$/.test(ext) || /^\s*(<!doctype html|<html)/i.test(text)) return htmlToParagraphs(text, ext === 'xhtml');
  if (ext === 'srt' || ext === 'vtt' || /^WEBVTT/.test(text) || /^\s*\d+\s*\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text)) return subtitlesToParagraphs(text);
  if (ext === 'fountain') return fountainToParagraphs(text);
  if (ext === 'md' || ext === 'markdown') text = markdownToText(text);
  return textToParagraphs(text);
}

export function textToParagraphs(text) {
  return text.replace(/\r\n?/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
}

// UTF-8 or UTF-16 by their marks; older Windows files that aren't valid UTF-8 are read as Windows-1252.
function decodeText(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b).replace(/^﻿/, ''); }
  catch (e) { return new TextDecoder('windows-1252').decode(b); }
}

function markdownToText(t) {
  return t.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*```.*$/gm, '')
    .replace(/\\([\[\]'"*_#\\.!-])/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')            // images
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1')       // links keep their text
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')   // bold
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2') // italics
    .replace(/(^|\W)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/^\s{0,3}>\s?/gm, '')                    // quotes
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');       // list markers
}

// ---------- web pages and EPUB ----------
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'aside', 'main', 'nav', 'blockquote', 'pre', 'ul', 'ol', 'li',
  'dl', 'dt', 'dd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'figure', 'figcaption', 'caption', 'address', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'body', 'center']);
const SKIP_TAGS = new Set(['script', 'style', 'head', 'noscript', 'template', 'svg', 'math', 'del', 's', 'strike', 'rt', 'rp', 'button', 'select', 'iframe', 'object', 'video', 'audio']);
export function htmlToParagraphs(html, xhtml) {
  let doc = new DOMParser().parseFromString(html, xhtml ? 'application/xhtml+xml' : 'text/html');
  if (xhtml && doc.getElementsByTagName('parsererror').length) doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  let buf = '', pre = 0;
  const BR = '\u2028'; // a line break the page asked for (<br>, or a new line inside <pre>)
  const flush = (heading) => {
    for (const line of buf.split(BR)) { const t = line.replace(/\s+/g, ' ').trim(); if (t) out.push(heading ? '# ' + t : t); }
    buf = '';
  };
  const hidden = (el) => { const st = (el.getAttribute && el.getAttribute('style')) || ''; return el.hidden || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(st) || /line-through/i.test(st); };
  function walk(node) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { buf += pre ? c.nodeValue.replace(/\n/g, BR) : c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      const tag = (c.localName || '').toLowerCase();
      if (SKIP_TAGS.has(tag) || hidden(c)) continue;
      if (tag === 'br') { buf += BR; continue; }
      if (tag === 'pre') { flush(); pre++; walk(c); pre--; flush(); continue; }
      if (/^h[1-6]$/.test(tag)) { flush(); walk(c); flush(true); continue; }
      if (BLOCK_TAGS.has(tag)) { flush(); walk(c); flush(); continue; }
      if (tag === 'td' || tag === 'th') { buf += ' '; walk(c); buf += ' '; continue; }
      walk(c);
    }
  }
  walk(doc.body || doc.documentElement);
  flush();
  return out;
}

async function epubToParagraphs(zip) {
  const container = await readZipText(zip, 'META-INF/container.xml');
  const rootPath = (container.match(/full-path\s*=\s*"([^"]+)"/) || [])[1];
  if (!rootPath) throw new Error('this EPUB has no contents list');
  const opf = new DOMParser().parseFromString(await readZipText(zip, rootPath) || '', 'application/xml');
  const base = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';
  const items = new Map();
  for (const it of opf.getElementsByTagNameNS('*', 'item')) items.set(it.getAttribute('id'), { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '' });
  const out = [];
  for (const ref of opf.getElementsByTagNameNS('*', 'itemref')) {
    if (ref.getAttribute('linear') === 'no') continue;
    const it = items.get(ref.getAttribute('idref'));
    if (!it || !/html/.test(it.type)) continue;
    const path = decodeURIComponent(new URL(it.href, 'http://x/' + base).pathname.slice(1));
    const html = await readZipText(zip, path);
    if (html) out.push(...htmlToParagraphs(html, /xhtml|xml/.test(it.type)));
  }
  return out;
}

// ---------- OpenDocument text (.odt) ----------
async function odtToParagraphs(zip) {
  const xml = await readZipText(zip, 'content.xml');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // styles that strike text through or hide it
  const gone = new Set();
  for (const st of doc.getElementsByTagNameNS('*', 'style')) {
    const tp = [...st.children].find((c) => c.localName === 'text-properties');
    if (!tp) continue;
    const lt = tp.getAttribute('style:text-line-through-style'), disp = tp.getAttribute('text:display');
    if ((lt && lt !== 'none') || disp === 'none') gone.add(st.getAttribute('style:name'));
  }
  const out = [];
  const inline = (el) => {
    let t = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { t += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      const n = c.localName;
      if (n === 's') t += ' '.repeat(+(c.getAttribute('text:c') || 1));
      else if (n === 'tab') t += ' ';
      else if (n === 'line-break') t += '\n';
      else if (n === 'note' || n === 'annotation' || n === 'tracked-changes') continue;
      else if (n === 'span' && gone.has(c.getAttribute('text:style-name'))) continue;
      else t += inline(c);
    }
    return t;
  };
  const push = (t, h) => { for (const line of t.split('\n')) { const s = line.replace(/\s+/g, ' ').trim(); if (s) out.push(h ? '# ' + s : s); } };
  const walk = (el) => {
    for (const c of el.children) {
      const n = c.localName;
      if (n === 'h') push(inline(c), true);
      else if (n === 'p') { if (!gone.has(c.getAttribute('text:style-name'))) push(inline(c)); }
      else if (n === 'tracked-changes' || n === 'sequence-decls' || n === 'variable-decls') continue;
      else walk(c);
    }
  };
  const body = doc.getElementsByTagNameNS('*', 'text')[0];
  if (!body) throw new Error('this OpenDocument file has no text');
  walk(body);
  return out;
}

// ---------- RTF ----------
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'headerl', 'headerr', 'headerf', 'footer', 'footerl', 'footerr', 'footerf',
  'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'filetbl',
  'revtbl', 'shp', 'shpinst', 'nonshppict', 'footnote', 'annotation', 'atnid', 'atnauthor', 'pgdsctbl', 'mmathPr', 'fldinst', 'xe', 'tc', 'bkmkstart', 'bkmkend']);
const RTF_CHAR = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', tab: ' ', emspace: ' ', enspace: ' ', qmspace: ' ' };
export function rtfToParagraphs(rtf) {
  const cp1252 = new TextDecoder('windows-1252');
  let out = '', i = 0, toSkip = 0;
  let st = { skip: false, uc: 1, strike: false, hidden: false };
  const stack = [];
  const emit = (ch) => { if (toSkip > 0) { toSkip--; return; } if (!st.skip && !st.strike && !st.hidden) out += ch; };
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') { stack.push({ ...st }); i++; continue; }
    if (ch === '}') { st = stack.pop() || st; i++; toSkip = 0; continue; }
    if (ch === '\\') {
      const nx = rtf[i + 1];
      if (/[a-zA-Z]/.test(nx || '')) {
        const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i + 1, i + 40));
        const word = m[1], arg = m[2] !== undefined ? +m[2] : null;
        i += 1 + m[0].length;
        if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') { if (!st.skip) out += '\n'; }
        else if (word === 'cell') emit(' ');
        else if (word === 'u') { const c = arg < 0 ? arg + 65536 : arg; if (!st.skip && !st.strike && !st.hidden) out += String.fromCharCode(c); toSkip = st.uc; }
        else if (word === 'uc') st.uc = arg ?? 1;
        else if (word === 'strike' || word === 'striked' || word === 'strikedl') st.strike = arg !== 0;
        else if (word === 'v') st.hidden = arg !== 0;
        else if (word === 'plain') { st.strike = false; st.hidden = false; }
        else if (RTF_CHAR[word]) emit(RTF_CHAR[word]);
        else if (RTF_SKIP.has(word)) st.skip = true;
        continue;
      }
      if (nx === '*') { st.skip = true; i += 2; continue; }
      if (nx === "'") { const h = parseInt(rtf.substr(i + 2, 2), 16); if (!isNaN(h)) emit(cp1252.decode(new Uint8Array([h]))); i += 4; continue; }
      if (nx === '\n' || nx === '\r') { if (!st.skip) out += '\n'; i += 2; continue; }
      if (nx === '~') { emit(' '); i += 2; continue; }
      if (nx === '_') { emit('-'); i += 2; continue; }
      if (nx === '-') { i += 2; continue; }
      emit(nx || ''); i += 2; continue;
    }
    if (ch === '\r' || ch === '\n') { i++; continue; }
    emit(ch); i++;
  }
  return textToParagraphs(out);
}

// ---------- subtitles: each cue becomes a line that starts with its time ----------
export function subtitlesToParagraphs(text) {
  const out = [];
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    const k = lines.findIndex((l) => /-->/.test(l));
    if (k < 0) continue;
    const m = lines[k].match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/);
    if (!m) continue;
    const h = +(m[1] || 0), mi = +m[2], s = +m[3], ms = m[4].padEnd(3, '0');
    const words = lines.slice(k + 1).join(' ').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
    if (!words) continue;
    const p2 = (n) => String(n).padStart(2, '0');
    out.push(`${p2(h)}:${p2(mi)}:${p2(s)}.${ms} ${words}`);
  }
  return out;
}

// ---------- screenplays: Final Draft (.fdx) and Fountain ----------
// Dialogue is the text to read; scene headings become section headings; character names, transitions and
// action show as notes (not read), and parentheticals as [(…)].
export function fdxToParagraphs(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const content = doc.getElementsByTagName('Content')[0] || doc.documentElement;
  const out = [];
  for (const p of content.getElementsByTagName('Paragraph')) {
    if (p.parentNode && !/^(Content|DualDialogue)$/.test(p.parentNode.localName)) continue;
    if (p.getElementsByTagName('DualDialogue').length) continue; // its two speeches are listed on their own
    const type = p.getAttribute('Type') || '';
    const text = [...p.getElementsByTagName('Text')].map((t) => t.textContent).join('').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (type === 'Scene Heading') out.push('# ' + text);
    else if (type === 'Character' || type === 'Transition' || type === 'Shot' || type === 'Action' || type === 'Cast List') out.push('// ' + text);
    else if (type === 'Parenthetical') out.push('[' + text + ']');
    else out.push(text);
  }
  return out;
}
export function fountainToParagraphs(text) {
  const t = text.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\[\[[\s\S]*?\]\]/g, '');
  const lines = t.split('\n');
  const out = [];
  let inDialogue = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i], l = raw.trim();
    if (!l) { inDialogue = false; continue; }
    if (/^(title|credit|author|source|draft date|contact):/i.test(l) && i < 12) continue;
    if (/^=/.test(l)) continue; // synopsis
    if (/^#/.test(l)) { out.push('# ' + l.replace(/^#+\s*/, '')); continue; }
    if (/^\./.test(l) || /^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[ .]/i.test(l)) { out.push('# ' + l.replace(/^\./, '')); continue; }
    if (/^>.*<$/.test(l)) { out.push(l.slice(1, -1).trim()); continue; }
    if (/^>/.test(l) || (/^[A-Z\s]+TO:$/.test(l))) { out.push('// ' + l.replace(/^>\s*/, '')); continue; }
    const next = (lines[i + 1] || '').trim();
    if (!inDialogue && (/^@/.test(l) || (/^[A-Z0-9 ._'’-]+(\s*\([^)]*\))?\s*\^?$/.test(l) && /[A-Z]/.test(l) && next && (i === 0 || !lines[i - 1].trim())))) {
      out.push('// ' + l.replace(/^@/, '')); inDialogue = true; continue;
    }
    if (inDialogue && /^\(.*\)$/.test(l)) { out.push('[' + l + ']'); continue; }
    if (inDialogue) { out.push(l.replace(/^~/, '')); continue; }
    out.push('// ' + l.replace(/^!/, ''));
  }
  return out;
}

// ---------- PDF (text only, with PDF.js, loaded the first time a PDF is opened) ----------
// Lines are rebuilt from where the text sits on each page; a bigger gap than usual, an indent or a short line
// that ends a sentence starts a new paragraph. Page numbers are dropped.
let pdfjsP = null;
async function pdfToParagraphs(buf) {
  if (!pdfjsP) pdfjsP = import(new URL('../vendor/pdfjs/pdf.min.mjs', location.href).href).then((m) => { m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', location.href).href; return m; });
  const pdfjs = await pdfjsP;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false }).promise;
  const out = [], sizes = []; // sizes: [paragraph index, font size] to find headings once the body text size is known
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const lines = [];
    for (const it of tc.items) {
      if (!it.str || !it.transform) continue;
      const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      let line = lines.find((l) => Math.abs(l.y - y) < h * 0.45);
      if (!line) { line = { y, h, items: [] }; lines.push(line); }
      line.items.push({ x, w: it.width || 0, s: it.str, h });
    }
    lines.sort((a, b) => b.y - a.y);
    const built = lines.map((l) => {
      l.items.sort((a, b) => a.x - b.x);
      let s = '', end = -1e9;
      for (const it of l.items) {
        if (s && it.x - end > it.h * 0.18 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
        s += it.s; end = it.x + it.w;
      }
      return { y: l.y, h: l.h, x: l.items[0] ? l.items[0].x : 0, right: end, s: s.replace(/\s+/g, ' ').trim() };
    }).filter((l) => l.s && !/^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(l.s));
    if (!built.length) continue;
    // normal line spacing, as a multiple of the font size: a low percentile of the gaps, so pages made mostly of
    // one-line paragraphs still show their wrapped lines' spacing
    const ratios = [];
    for (let i = 1; i < built.length; i++) ratios.push((built[i - 1].y - built[i].y) / Math.max(built[i - 1].h, built[i].h));
    ratios.sort((a, b) => a - b);
    const normal = ratios.length ? Math.max(1, ratios[Math.floor(ratios.length * 0.2)]) : 1.2;
    const left = Math.min(...built.map((l) => l.x)), right = Math.max(...built.map((l) => l.right));
    let para = '', paraH = 0;
    built.forEach((l, i) => {
      const prev = built[i - 1];
      const hm = prev ? Math.max(prev.h, l.h) : l.h;
      const brk = !prev || (prev.y - l.y) / hm > normal * 1.2 + 0.1
        || Math.abs(prev.h - l.h) > hm * 0.15                                  // a heading or other change of size
        || (l.x - left > l.h * 1.2 && prev.x - left < l.h * 0.5)                  // an indented first line
        || /^(\[|#|\/\/|\d{1,2}:\d{2}(:\d{2})?\b)/.test(l.s)                    // a direction, heading, note or timestamp
        || (/[.!?:"”]$/.test(prev.s) && prev.right < right - (right - left) * 0.2); // a short line that ends a sentence
      if (brk && para) { out.push(para); sizes.push(paraH); para = ''; }
      if (!para) paraH = l.h; else paraH = Math.min(paraH, l.h);
      if (para && /[a-z]-$/.test(para) && /^[a-z]/.test(l.s)) para = para.slice(0, -1) + l.s; // a word split over two lines
      else para += (para ? ' ' : '') + l.s;
    });
    if (para) { out.push(para); sizes.push(paraH); }
  }
  try { doc.destroy(); } catch (e) { /* ignore */ }
  // a short paragraph in clearly bigger type than the body text is a heading
  const body = sizes.slice().sort((a, b) => a - b)[Math.floor(sizes.length / 2)] || 0;
  return out.map((t, i) => (body && sizes[i] >= body * 1.18 && t.length <= 90 && !/^[[#]|^\/\//.test(t) ? '# ' + t : t));
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

export async function docxToParagraphs(buf, zipIn) {
  const zip = zipIn || readZipIndex(buf);
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
