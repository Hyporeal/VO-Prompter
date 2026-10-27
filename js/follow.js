// Follows the reader through the script by aligning recognized words to the script's spoken units.
//
// The recognizer sends a growing "partial" for the current utterance and then a "final". Each update is
// aligned from the utterance's anchor (where the reader was when it started). If the last few words don't
// fit, the follower looks for them elsewhere in the script (re-reads, jumps ahead).

import { hypKeys, FUNC } from './parse.js';

export const UNREAD = 0, READ = 1, SKIP = 2, MAYBE = 3;

function lev(a, b) {
  const la = a.length, lb = b.length;
  let prev = new Array(lb + 1), cur = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    cur[0] = i;
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[lb];
}

let simCache = new Map(), simCount = 0;
export function sim(a, b) {
  if (a === b) return 1;
  let row = simCache.get(a);
  if (!row) { row = new Map(); simCache.set(a, row); }
  const c = row.get(b);
  if (c !== undefined) return c;
  let s;
  if (((a === 'oh' || a === 'o') && b === 'zero') || ((b === 'oh' || b === 'o') && a === 'zero')) s = 1;
  else if (Math.min(a.length, b.length) <= 2) s = 0;
  else if (Math.abs(a.length - b.length) > Math.max(a.length, b.length) * 0.5) s = 0;
  else {
    s = 1 - lev(a, b) / Math.max(a.length, b.length);
    if (Math.min(a.length, b.length) >= 4 && Math.abs(a.length - b.length) <= 3 && (a.startsWith(b) || b.startsWith(a))) s = Math.max(s, 0.8);
  }
  if (++simCount > 200000) { simCache = new Map(); simCount = 0; }
  row.set(b, s);
  return s;
}
const thr = (key) => (key.length <= 4 ? 0.74 : 0.68);
const INS = 0.5;
const matchScore = (u, s) => (u.func ? 0.5 : 1.2) + (s - 0.7) * 0.5;
const subScore = (u) => (u.soft ? -0.4 : -1.0);
const delCost = (u) => (u.soft ? 0.15 : u.func ? 0.35 : 0.6);
const leadCost = (u) => (u.soft ? 0.1 : u.func ? 0.25 : 0.4);

const OP_DIAG = 1, OP_INS = 2, OP_DEL = 3, OP_H2 = 4, OP_S2 = 5;

// Align hyp keys to units starting at a0. Returns { end, score, marks, matches, content, trailing, first }.
export function align(units, a0, h, opts = {}) {
  const H = h.length;
  const W = Math.min(units.length - a0, opts.window || (H + 15 + Math.ceil(H * 0.3)));
  if (W <= 0 || H === 0) return null;
  const cols = W + 1;
  const D = new Float32Array((H + 1) * cols);
  const B = new Uint8Array((H + 1) * cols);
  const lead = opts.freeLead ? () => 0 : leadCost;
  D[0] = 0;
  for (let j = 1; j <= W; j++) { D[j] = D[j - 1] - lead(units[a0 + j - 1]); B[j] = OP_DEL; }
  for (let i = 1; i <= H; i++) {
    const row = i * cols, prow = row - cols, hk = h[i - 1];
    D[row] = D[prow] - INS; B[row] = OP_INS;
    for (let j = 1; j <= W; j++) {
      const u = units[a0 + j - 1];
      const s = sim(hk, u.key);
      let best = D[prow + j - 1] + (s >= thr(u.key) ? matchScore(u, s) : subScore(u)), op = OP_DIAG;
      let v = D[prow + j] - INS;
      if (v > best) { best = v; op = OP_INS; }
      v = D[row + j - 1] - delCost(u);
      if (v > best) { best = v; op = OP_DEL; }
      if (i >= 2 && u.key.length >= 5) {
        const s2 = sim(h[i - 2] + hk, u.key);
        if (s2 >= thr(u.key)) { v = D[prow - cols + j - 1] + matchScore(u, s2) - 0.1; if (v > best) { best = v; op = OP_H2; } }
      }
      if (j >= 2 && hk.length >= 5) {
        const u2 = units[a0 + j - 2];
        const s3 = sim(hk, u2.key + u.key);
        if (s3 >= thr(hk)) { v = D[prow + j - 2] + matchScore(u, s3) + 0.3 - 0.1; if (v > best) { best = v; op = OP_S2; } }
      }
      D[row + j] = best; B[row + j] = op;
    }
  }
  let bj = 0, bv = -Infinity;
  const last = H * cols;
  for (let j = 0; j <= W; j++) if (D[last + j] > bv + 1e-6) { bv = D[last + j]; bj = j; }
  // backtrack
  const ops = [];
  let i = H, j = bj;
  while (i > 0 || j > 0) {
    const op = B[i * cols + j];
    ops.push({ op, i, j });
    if (op === OP_DIAG) { i--; j--; } else if (op === OP_INS) i--; else if (op === OP_DEL) j--;
    else if (op === OP_H2) { i -= 2; j--; } else if (op === OP_S2) { i--; j -= 2; } else break;
  }
  ops.reverse();
  // Only "solid" matches move the reading spot: a content word, or a word right next to another match.
  // Stray words (a cough, someone in the room, a misheard "the") can't drag the spot forward through the text.
  const ev = [];
  ops.forEach((o, k) => {
    if (o.op !== OP_DIAG && o.op !== OP_S2 && o.op !== OP_H2) return;
    const u = units[a0 + o.j - 1];
    if (o.op === OP_DIAG) {
      const sm = sim(h[o.i - 1], u.key), hit = sm >= thr(u.key);
      ev.push({ k, i: o.i, u: u.u, u0: u.u, hit, content: hit && !u.func && !u.soft, unit: u });
    } else ev.push({ k, i: o.i, u: u.u, u0: o.op === OP_S2 ? u.u - 1 : u.u, hit: true, content: o.op === OP_S2 || !u.func, unit: u, op: o.op });
  });
  const hits = ev.filter((e) => e.hit);
  const solid = hits.filter((e, q) => e.content
    || (q > 0 && e.u0 - hits[q - 1].u <= 1 && e.i - hits[q - 1].i <= 2)
    || (q + 1 < hits.length && hits[q + 1].u0 - e.u <= 1 && hits[q + 1].i - e.i <= 2));
  const marks = new Map();
  const hitAt = new Uint8Array(H + 1);
  const hypUnit = new Int32Array(H + 1).fill(-1);
  const K = Math.min(6, H);
  if (!solid.length) return { end: a0, score: bv, marks, matches: 0, content: 0, trailing: H, first: -1, tailHit: 0, tailN: K, hypUnit };
  const fs = solid[0], ls = solid[solid.length - 1];
  const markRun = (run, isLead) => {
    if (!run.length) return;
    if (isLead && (opts.freeLead || run.length > 25)) return;
    const real = run.some((u) => !u.soft && !u.func) || run.filter((u) => !u.soft).length >= 3;
    for (const u of run) marks.set(u.u, real && !u.soft ? SKIP : READ);
  };
  // anything before the first solid match counts as not read yet (skipped, if it's a short stretch)
  markRun(units.slice(a0, fs.u0), true);
  let matches = 0, content = 0, run = [];
  for (let k = fs.k; k <= ls.k; k++) {
    const o = ops[k];
    if (o.op === OP_INS) continue;
    if (o.op === OP_DEL) { run.push(units[a0 + o.j - 1]); continue; }
    markRun(run, false); run = [];
    const u = units[a0 + o.j - 1];
    hypUnit[o.i] = u.u;
    if (o.op === OP_DIAG) {
      if (sim(h[o.i - 1], u.key) >= thr(u.key)) { marks.set(u.u, READ); matches++; hitAt[o.i] = 1; if (!u.func && !u.soft) content++; }
      else marks.set(u.u, u.soft || u.func ? READ : MAYBE);
    } else if (o.op === OP_S2) { marks.set(u.u - 1, READ); marks.set(u.u, READ); matches += 2; content++; hitAt[o.i] = 1; }
    else { marks.set(u.u, READ); matches++; hitAt[o.i] = hitAt[o.i - 1] = 1; if (!u.func) content++; }
  }
  let tailHit = 0;
  for (let k = H - K + 1; k <= H; k++) tailHit += hitAt[k];
  return { end: ls.u + 1, score: bv, marks, matches, content, trailing: H - ls.i, first: fs.u0, tailHit, tailN: K, hypUnit };
}

export class Follower {
  constructor(onChange) { this.onChange = onChange || (() => {}); this.m = null; }

  setModel(model, status, pos) {
    this.m = model;
    this.status = status && status.length === model.N ? status : new Uint8Array(model.N);
    this.pos = Math.max(0, Math.min(pos || 0, model.N));
    this.anchor = this.pos;
    this.segSkip = 0; this.segLen = 0; this.prov = null; this.off = false;
    this.hist = [{ t: performance.now() / 1000, p: this.pos }];
    this.lastRelocLen = -1;
    this.jumped = 0;
  }

  eff(u) { return this.prov && this.prov.has(u) ? this.prov.get(u) : this.status[u]; }

  setPos(p, jump) {
    const now = performance.now() / 1000;
    if (jump) { this.hist = [{ t: now, p }]; this.jumped++; }
    else if (p > this.pos) { this.hist.push({ t: now, p }); }
    this.pos = p;
  }

  // units per second over the last few seconds; falls to 0 when the reader stops
  rate() {
    const now = performance.now() / 1000;
    while (this.hist.length > 1 && now - this.hist[0].t > 3) this.hist.shift();
    if (this.hist.length < 2) return { rate: 0, lastT: this.hist.length ? this.hist[0].t : now };
    const a = this.hist[0], b = this.hist[this.hist.length - 1];
    return { rate: Math.max(0, (b.p - a.p) / Math.max(0.8, now - a.t)), lastT: b.t };
  }

  jumpTo(u, clearAhead = true) {
    if (!this.m) return;
    u = Math.max(0, Math.min(u, this.m.N));
    if (this.prov) this.commit();
    this.anchor = u; this.segSkip = this.segLen; this.prov = null; this.off = false;
    if (clearAhead) this.status.fill(UNREAD, u);
    this.setPos(u, true);
    this.onChange({ jump: true });
  }

  commit() {
    if (this.prov) for (const [u, s] of this.prov) this.status[u] = s;
    this.prov = null;
  }

  clearMarks() { this.status.fill(UNREAD); this.prov = null; this.onChange({}); }

  input(text, final) {
    if (!this.m || !this.m.N) return;
    const keys = hypKeys(text || '');
    this.segLen = keys.length;
    const h = keys.slice(this.segSkip);
    let jump = false;
    if (h.length) {
      const r = align(this.m.units, this.anchor, h);
      let relocated = false;
      const lost = r && (r.trailing >= 3 || (h.length >= 4 && r.tailHit < r.tailN * 0.5));
      if ((!r || lost)) {
        if (h.length !== this.lastRelocLen) {
          this.lastRelocLen = h.length;
          const rel = this.relocate(h);
          if (rel) {
            relocated = true; jump = true;
            if (this.prov) this.commit();
            const gap = rel.first - this.pos;
            if (gap > 0 && gap <= 25) {
              const run = this.m.units.slice(this.pos, rel.first);
              const real = run.some((u) => !u.soft && !u.func) || run.length >= 3;
              for (const u of run) if (!this.status[u.u]) this.status[u.u] = real && !u.soft ? SKIP : READ;
            }
            for (const [u, s] of rel.marks) this.status[u] = s;
            this.anchor = rel.end; this.segSkip = keys.length; this.prov = null; this.off = false;
            this.lastRelocLen = -1;
            this.setPos(rel.end, true);
          }
        }
        if (!relocated) this.off = true;
      } else this.off = false;
      // When lost, keep the position unless the reader clearly read up to a point and then went off script.
      if (r && !relocated && (!lost || r.trailing >= 3)) {
        this.prov = r.marks; this.setPos(r.first >= 0 ? r.end : this.pos, false);
        // Long utterance: lock in all but the last few words so each update stays quick.
        if (!lost && h.length > 30) {
          const cut = h.length - 14;
          let cu = -1;
          for (let i = cut; i >= 1 && cu < 0; i--) if (r.hypUnit[i] >= 0) cu = r.hypUnit[i];
          if (cu >= this.anchor) {
            for (const [u, st] of r.marks) if (u <= cu) this.status[u] = st;
            this.anchor = cu + 1; this.segSkip += cut;
          }
        }
      }
    }
    if (final) {
      this.commit();
      this.anchor = this.pos; this.segSkip = 0; this.segLen = 0; this.lastRelocLen = -1;
    }
    this.onChange({ jump });
  }

  // Find where the last few recognized words are in the script.
  relocate(h) {
    const m = this.m, K = Math.min(7, h.length), tail = h.slice(-K);
    const votes = new Map();
    tail.forEach((k, j) => {
      if (FUNC.has(k) || k.length < 3) return;
      const list = m.index.get(k);
      if (!list || list.length > 400) return;
      for (const u of list) {
        const c = u - j;
        votes.set(c, (votes.get(c) || 0) + 1);
        votes.set(c - 1, (votes.get(c - 1) || 0) + 0.5);
        votes.set(c + 1, (votes.get(c + 1) || 0) + 0.5);
      }
    });
    const cands = [...votes].filter(([, v]) => v >= 2)
      .sort((a, b) => b[1] - a[1] || Math.abs(a[0] - this.pos) - Math.abs(b[0] - this.pos)).slice(0, 12);
    let best = null;
    for (const [c] of cands) {
      const a0 = Math.max(0, Math.min(m.N - 1, c - 3));
      const r = align(m.units, a0, tail, { freeLead: true, window: K + 10 });
      if (!r || r.first < 0) continue;
      // Nearby spots are cheap; far jumps need a much stronger match, because phrases repeat in scripts
      // and a misheard word shouldn't throw the reader to a later copy of the same phrase.
      const dist = Math.abs(r.first - this.pos), far = dist > 60;
      const score = r.score - (far ? 2.5 + 0.004 * (dist - 60) : 0.002 * dist);
      if (far && (r.matches < 5 || r.content < 3)) continue;
      if (r.content >= 2 && r.matches >= 3 && r.trailing <= 1 && (!best || score > best.score)) best = { ...r, score };
    }
    return best && best.score > 1.5 ? best : null;
  }
}
