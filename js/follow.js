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

// Words that sound the same; recognizers often pick the wrong spelling.
const SOUND_ALIKE = new Map();
for (const g of ['there their theyre', 'to too two', 'for four fore', 'here hear', 'your youre', 'its its', 'our are hour',
  'then than', 'know no', 'right write rite', 'one won', 'by buy bye', 'whole hole', 'weather whether', 'where wear ware',
  'which witch', 'new knew', 'see sea', 'week weak', 'would wood', 'ate eight', 'peace piece', 'principal principle',
  'site sight cite', 'board bored', 'break brake', 'cell sell', 'fair fare', 'flour flower', 'mail male', 'meet meat',
  'pair pare pear', 'plain plane', 'role roll', 'sale sail', 'some sum', 'tail tale', 'wait weight', 'way weigh', 'wee we',
  'well wheel', 'lets let', 'whats what', 'thats that', 'weve we', 'theyll they', 'youll you', 'ill i', 'were where']) {
  const ws = g.split(' ');
  for (const a of ws) for (const b of ws) if (a !== b) SOUND_ALIKE.set(a + '|' + b, true);
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
  else if (SOUND_ALIKE.has(a + '|' + b)) s = 0.9;
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
        if (s2 >= Math.max(0.82, thr(u.key))) { v = D[prow - cols + j - 1] + matchScore(u, s2) - 0.1; if (v > best) { best = v; op = OP_H2; } }
      }
      if (j >= 2 && hk.length >= 5) {
        const u2 = units[a0 + j - 2];
        const s3 = sim(hk, u2.key + u.key);
        if (s3 >= Math.max(0.82, thr(hk))) { v = D[prow + j - 2] + matchScore(u, s3) + 0.3 - 0.1; if (v > best) { best = v; op = OP_S2; } }
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
  // A match reached by skipping 3+ script words (with nothing heard for them) only counts once another match
  // follows close by. Readers rarely skip words mid-phrase, but a re-read or a misheard word often lines up
  // with a word a little further on. (Words heard wrong in between are not skips.)
  for (let q = 1; q < solid.length; q++) {
    let dels = 0;
    for (let k = solid[q - 1].k + 1; k < solid[q].k; k++) if (ops[k].op === OP_DEL) dels++;
    if (dels < 3) continue;
    const nx = solid[q + 1];
    if (!(nx && nx.u0 - solid[q].u <= 2 && nx.i - solid[q].i <= 3)) { solid.length = q; break; }
  }
  const marks = new Map();
  const hitAt = new Uint8Array(H + 1);
  const hypUnit = new Int32Array(H + 1).fill(-1);
  const K = Math.min(6, H);
  if (!solid.length) return { end: a0, score: bv, marks, matches: 0, content: 0, trailing: H, first: -1, tailHit: 0, tailN: K, hypUnit };
  const fs = solid[0], ls = solid[solid.length - 1];
  // Skipped-word marks need clear evidence, because the recognizer often drops or mishears words: nothing heard
  // in that spot (heard-but-wrong words are a recognizer slip, not a skip), and at least two words in a row
  // missing (two content words at the start of an utterance, where the recognizer most often drops words).
  const markRun = (run, isLead, heard) => {
    if (!run.length) return;
    if (isLead && (opts.freeLead || run.length > 25)) return;
    let real = run.some((u) => !u.soft && !u.func) || run.filter((u) => !u.soft).length >= 3;
    if (heard) real = false;
    if (isLead ? run.filter((u) => !u.soft && !u.func).length < 2 : run.filter((u) => !u.soft).length < 2) real = false;
    for (const u of run) marks.set(u.u, real && !u.soft ? SKIP : READ);
  };
  // anything before the first solid match counts as not read yet (skipped, if it's a short stretch)
  // Words before the first solid match are only marked missed when plenty follows (3+ matches, 2+ content words);
  // a single coincidental match further on just moves the spot.
  if (solid.length >= 3 && solid.filter((e) => e.content).length >= 2) markRun(units.slice(a0, fs.u0), true, fs.i > 1);
  let matches = 0, content = 0, run = [], streak = 0, maxRun = 0, lastI = -9, lastU = -9;
  let heard = false;
  for (let k = fs.k; k <= ls.k; k++) {
    const o = ops[k];
    if (o.op === OP_INS) { streak = 0; heard = true; continue; }
    if (o.op === OP_DEL) { run.push(units[a0 + o.j - 1]); streak = 0; continue; }
    markRun(run, false, heard); run = [];
    heard = o.op === OP_DIAG && sim(h[o.i - 1], units[a0 + o.j - 1].key) < thr(units[a0 + o.j - 1].key);
    const u = units[a0 + o.j - 1];
    hypUnit[o.i] = u.u;
    const hitHere = o.op !== OP_DIAG || sim(h[o.i - 1], u.key) >= thr(u.key);
    streak = hitHere && o.i - lastI <= 2 && u.u - lastU <= 2 ? streak + 1 : (hitHere ? 1 : 0);
    if (streak > maxRun) maxRun = streak;
    lastI = o.i; lastU = u.u;
    if (o.op === OP_DIAG) {
      if (sim(h[o.i - 1], u.key) >= thr(u.key)) { marks.set(u.u, READ); matches++; hitAt[o.i] = 1; if (!u.func && !u.soft) content++; }
      else marks.set(u.u, u.soft || u.func ? READ : MAYBE);
    } else if (o.op === OP_S2) { marks.set(u.u - 1, READ); marks.set(u.u, READ); matches += 2; content++; hitAt[o.i] = 1; }
    else { marks.set(u.u, READ); matches++; hitAt[o.i] = hitAt[o.i - 1] = 1; if (!u.func) content++; }
  }
  let tailHit = 0;
  for (let k = H - K + 1; k <= H; k++) tailHit += hitAt[k];
  return { end: ls.u + 1, score: bv, marks, matches, content, trailing: H - ls.i, first: fs.u0, tailHit, tailN: K, hypUnit, maxRun };
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
    // trusted: how far the reader has really read. After an automatic jump it only moves once a few more
    // words have been read past the landing spot, so a wrong jump never confirms anything.
    this.trusted = this.pos; this.trustAfter = this.pos;
    this.sentOf = new Int32Array(model.N + 1).fill(-1);
    model.sentences.forEach((s, i) => { for (let u = s.u0; u < s.u1; u++) this.sentOf[u] = i; });
    // phraseStart[u]: first unit of the phrase (words between commas, semicolons or sentence ends) holding unit u
    this.phraseStart = new Int32Array(model.N + 1);
    let ps = 0;
    for (let u = 0; u < model.N; u++) {
      if (u > 0) {
        const t = model.tokens[model.units[u].ti], pt = model.tokens[model.units[u - 1].ti];
        if (pt !== t && (pt.endsPhrase || pt.pid !== t.pid)) ps = u;
      }
      this.phraseStart[u] = ps;
    }
    this.phraseStart[model.N] = ps;
    // syllables before each unit, for the reading pace
    this.cumSyl = new Float64Array(model.N + 1);
    for (let u = 0; u < model.N; u++) this.cumSyl[u + 1] = this.cumSyl[u] + (model.units[u].syl || 1);
    this.pace = { syl: 0, t: 0, p: this.pos };
  }

  // Your speaking pace in syllables per second, counted only while you're speaking (steps that come within a
  // second of each other), so pauses don't drag it down. Long words take longer to say than short ones, so
  // syllables predict where you are better than words do.
  notePace(p, now) {
    const pc = this.pace;
    if (p > pc.p && pc.t && now - pc.t < 1.2 && now > pc.t) {
      // a running ratio of syllables to seconds (not an average of bursty per-update speeds)
      const ds = this.cumSyl[Math.min(p, this.m.N)] - this.cumSyl[Math.min(pc.p, this.m.N)];
      if (ds / (now - pc.t) < 14) { pc.s = (pc.s || 0) * 0.93 + ds; pc.d = (pc.d || 0) * 0.93 + (now - pc.t); if (pc.d > 1.5) pc.syl = pc.s / pc.d; }
    }
    if (p !== pc.p) { pc.p = p; pc.t = now; }
  }
  sylRate() { return this.pace ? this.pace.syl : 0; }
  // Where you probably are `sec` seconds of speech after unit p, at your pace (a fractional unit).
  aheadOf(p, sec) {
    const N = this.m.N, rate = this.sylRate();
    if (!rate || sec <= 0) return p;
    const c = this.cumSyl, target = c[Math.min(Math.floor(p), N)] + rate * sec;
    let lo = Math.floor(p), hi = N;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c[mid] <= target) lo = mid; else hi = mid - 1; }
    if (lo >= N) return N;
    return lo + (target - c[lo]) / Math.max(1e-6, c[lo + 1] - c[lo]);
  }

  // Where a reader who stumbles is likely to start again, nearest first: the start of the phrase and of the
  // sentence they're in (or of the previous one, when they're right at the start of one).
  restartPoints(a) {
    const u = Math.min(a, this.m.N - 1), S = this.m.sentences, out = [];
    const add = (x) => { if (x >= 0 && x < a && a - x <= 40 && !out.includes(x)) out.push(x); };
    const p = this.phraseStart[u];
    add(p < a ? p : p > 0 ? this.phraseStart[p - 1] : -1);
    const si = this.sentOf[u];
    if (si >= 0) add(S[si].u0 < a ? S[si].u0 : si > 0 ? S[si - 1].u0 : -1);
    return out.sort((x, y) => y - x);
  }

  // At the start of a sentence (you've just finished the one before), do these first words of a new utterance
  // match the start of the previous sentence and not this one? Then that's where you are. One word is enough only
  // if it's a word with meaning (not "the", "we", "for" and the like).
  retakeStart(h) {
    const a = this.anchor, N = this.m.N, S = this.m.sentences, U = this.m.units;
    if (a <= 0 || a >= N) return -1;
    const si = this.sentOf[a];
    if (si < 1 || S[si].u0 !== a) return -1;
    const prev = S[si - 1];
    if (prev.u1 - prev.u0 < h.length + 1) return -1;
    // The first word must be right; of three words, one after it may differ (misheard, or "could" for "can").
    const eq = (k, u, i) => u < N && (U[u].key === k || sim(U[u].key, k) >= (i ? 0.6 : 0.85));
    const score = (u0) => h.reduce((n, k, i) => n + (eq(k, u0 + i, i) ? 1 : 0), 0);
    const ps = eq(h[0], prev.u0, 0) ? score(prev.u0) : 0, ns = score(a);
    if (ps < h.length - (h.length === 3 ? 1 : 0) || ns >= ps) return -1;
    if (h.length === 1 && (FUNC.has(h[0]) || h[0].length < 3)) return -1;
    return prev.u0;
  }

  eff(u) { return this.prov && this.prov.has(u) ? this.prov.get(u) : this.status[u]; }

  setPos(p, jump) {
    const now = performance.now() / 1000;
    if (jump) { this.hist = [{ t: now, p }]; this.jumped++; this.trustAfter = p + 8; if (p < this.trusted) this.trusted = p; if (this.pace) { this.pace.p = p; this.pace.t = 0; } }
    else {
      if (p > this.pos) { this.hist.push({ t: now, p }); if (this.pace) this.notePace(p, now); }
      if (p >= this.trustAfter && p > this.trusted) this.trusted = p;
    }
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
    this.trusted = u; this.trustAfter = u; // a jump you asked for is trusted right away
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
    let jump = false, restarted = false;
    if (h.length) {
      let r = align(this.m.units, this.anchor, h);
      // Retakes: right after finishing a sentence, the first word or two of a new utterance that match the start
      // of the sentence just read (and not the next one) mean you're reading it again. Follow at once, instead
      // of after three words.
      const rt = this.segSkip === 0 && h.length <= 3 ? this.retakeStart(h) : -1;
      if (rt >= 0) {
        let r2 = align(this.m.units, rt, h);
        // small words alone ("we can also") don't anchor an alignment, but the start of the sentence is known
        if (!r2 || r2.first !== rt) {
          const marks = new Map();
          for (let i = 0; i < h.length; i++) marks.set(rt + i, READ);
          r2 = { first: rt, end: rt + h.length, marks, matches: h.length, content: 0, trailing: 0, tailHit: h.length, tailN: h.length, score: h.length, hypUnit: [-1, ...h.map((_, i) => rt + i)], maxRun: h.length };
        }
        r = r2; this.anchor = rt; restarted = true; this.restarts = (this.restarts || 0) + 1;
      }
      // Pickups: a reader who stumbles usually starts the phrase or sentence again. If the words fit a restart
      // clearly better than continuing, follow the restart.
      if (r && !restarted && h.length <= 16) {
        for (const st of this.restartPoints(this.anchor)) {
          const r2 = align(this.m.units, st, h);
          if (r2 && r2.first >= 0 && r2.first <= st + 2 && r2.matches >= 3 && r2.score > r.score + 1.0) {
            r = r2; this.anchor = st; restarted = true; this.restarts = (this.restarts || 0) + 1; break;
          }
        }
      }
      let relocated = false;
      const lost = r && (r.trailing >= 3 || (h.length >= 4 && r.tailHit < r.tailN * 0.5));
      // doubt: most recent words only partly line up; look for a clearly better place without freezing here
      const doubt = r && !lost && !restarted && h.length >= 5 && r.tailHit <= r.tailN - 2;
      if ((!r || lost || doubt)) {
        if (h.length !== this.lastRelocLen) {
          this.lastRelocLen = h.length;
          let rel = this.relocate(h);
          if (rel && doubt && rel.kind === 'here') rel = null;
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
        if (!relocated && !doubt) this.off = true;
        else if (doubt) this.off = false;
      } else this.off = false;
      // When lost, keep the position unless the reader clearly read up to a point and then went off script.
      if (r && !relocated && (!lost || r.trailing >= 3)) {
        this.prov = r.marks; this.setPos(r.first >= 0 ? r.end : this.pos, restarted);
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
    // a rare word (4 or fewer places in the script) is enough to look at a spot; the alignment check decides
    tail.forEach((k, j) => {
      if (FUNC.has(k) || k.length < 3) return;
      const list = m.index.get(k);
      if (list && list.length <= 4) for (const u of list) { const c = u - j; if ((votes.get(c) || 0) < 2) votes.set(c, 2); }
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
    if (!best || best.score <= 1.5) return null;
    // Hysteresis: if the same words fit about as well right around the current spot, stay here. Scripts repeat
    // phrases in nearby sentences, and a few misheard words shouldn't hop the reader into the next one.
    const here = align(m.units, Math.max(0, this.pos - 12), tail, { freeLead: true, window: K + 24 });
    if (here && here.first >= 0 && Math.abs(here.first - this.pos) <= 24 && here.content >= 1 && here.matches >= 2) {
      const clearlyBetter = best.matches >= here.matches + 2 && best.score >= here.score + 1.5;
      if (!clearlyBetter) return { ...here, score: here.score, kind: 'here' };
    }
    // a forward jump past more than a few words needs more evidence: 4+ matches with 3+ content words,
    // or 5+ words in a row (a phrase like "now we can go on to the next one" is mostly small words)
    if (best.first - this.pos > 12 && !((best.matches >= 4 && best.content >= 3) || best.maxRun >= 5)) return null;
    return { ...best, kind: 'best' };
  }
}
