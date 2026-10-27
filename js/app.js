import { fileToParagraphs, textToParagraphs, buildModel, computeTimes, timeAt, unitAtTime, fmtTime, paragraphsToDocx, paragraphsToText } from './parse.js';
import { Follower, UNREAD } from './follow.js';
import { OnDeviceEngine, GoogleEngine, modelIsCached } from './engines.js';
import { Speaker, englishVoices } from './tts.js';
import { PiperSpeaker, PIPER_VOICES, voiceIsDownloaded } from './piper.js';
import * as store from './store.js';

const VERSION = '1.1.10';
const $ = (s) => document.querySelector(s);

const DEFAULTS = {
  textSize: 28, said: 'hl', guide: 'under', span: 'word', theme: 'dark',
  engine: 'device', micSource: 'builtin', marks: 'skips',
  ttsUnit: 'sentence', ttsVoice: 'android:', ttsRate: 1, linesAbove: 3, scrollEvery: 2, scrollStyle: 'pause', markStrength: 'faint', offNotice: 'off', showRate: false, textFrac: null, sideFrac: null, lastProject: null,
};
const settings = store.loadSettings(DEFAULTS);
if (settings.guide === 'off') { settings.guide = 'under'; settings.span = 'off'; }
if (settings.voiceURI !== undefined) { settings.ttsVoice = 'android:' + settings.voiceURI; delete settings.voiceURI; }
const saveSettings = () => store.saveSettings(settings);

// ---------- state ----------
let project = null;
let model = null;
let tokEls = [], gapEls = [], tokCls = [], gapCls = [];
const paraEls = new Map();
let mode = 'read';
let listening = false, micBusy = false;
let sound = false, follow = true, resumeAfterSound = false;
const engines = {};
let engine = null;
let tts = null;
let editing = null;
let videoURL = null;
let wakeLock = null;

const follower = new Follower(onFollow);
const speakers = { android: new Speaker(), piper: new PiperSpeaker() };
const ttsBusy = () => speakers.android.busy || speakers.piper.busy;
function voiceChoice() {
  const v = settings.ttsVoice || 'android:';
  return v.startsWith('piper:') ? { kind: 'piper', voiceId: v.slice(6) } : { kind: 'android', voiceURI: v.slice(8) };
}
const video = $('#video');
const scriptEl = $('#script');
const docEl = $('#doc');

// ---------- small helpers ----------
function toast(msg, ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#notices').appendChild(t);
  setTimeout(() => t.remove(), ms);
}
const hasVideo = () => !!video.getAttribute('src');
const newId = () => 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

class RateTracker {
  constructor() { this.hist = []; }
  push(p) { const t = performance.now() / 1000; const l = this.hist[this.hist.length - 1]; if (!l || p > l.p) this.hist.push({ t, p }); else if (p < l.p) this.hist = [{ t, p }]; }
  rate() {
    const now = performance.now() / 1000;
    while (this.hist.length > 1 && now - this.hist[0].t > 3) this.hist.shift();
    if (this.hist.length < 2) return { rate: 0, lastT: this.hist.length ? this.hist[0].t : now };
    const a = this.hist[0], b = this.hist[this.hist.length - 1];
    return { rate: Math.max(0, (b.p - a.p) / Math.max(0.8, now - a.t)), lastT: b.t };
  }
}

// Keeps the screen on while listening, reading aloud or playing video. One request at a time, so a release and a
// new request can't cross; if the system drops the lock, it's asked for again.
let wakeWanted = false, wakeBusy = false;
async function syncWake() {
  if (wakeBusy || !('wakeLock' in navigator)) return;
  wakeBusy = true;
  try {
    for (;;) {
      if (wakeWanted && !wakeLock && !document.hidden) {
        const l = await navigator.wakeLock.request('screen');
        wakeLock = l; l.addEventListener('release', () => { if (wakeLock === l) wakeLock = null; });
      } else if (!wakeWanted && wakeLock) { const l = wakeLock; wakeLock = null; await l.release(); }
      else break;
    }
  } catch (e) { /* not allowed right now; tried again shortly */ }
  finally { wakeBusy = false; }
}
const wantAwake = () => { wakeWanted = listening || ttsBusy() || (hasVideo() && !video.paused) || (hasVideo() && follow && (listening || !!tts)); syncWake(); };

// ---------- settings → page ----------
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--script-size', settings.textSize + 'px');
  docEl.classList.toggle('said-hl', settings.said === 'hl');
  docEl.classList.toggle('said-dim', settings.said === 'dim');
  docEl.classList.toggle('said-sent', settings.said === 'sent' || settings.said === 'sent2');
  const ms = { faint: ['40%', '1.5px'], medium: ['70%', '2px'], strong: ['100%', '2.5px'] }[settings.markStrength] || ['40%', '1.5px'];
  docEl.style.setProperty('--mark-a', ms[0]); docEl.style.setProperty('--mark-w', ms[1]);
  docEl.classList.toggle('guide-under', settings.guide === 'under');
  docEl.classList.toggle('guide-fill', settings.guide === 'fill');
  docEl.classList.toggle('marks', settings.marks !== 'off');
  docEl.classList.toggle('marks-all', settings.marks === 'all');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#111316';
}

// ---------- rendering ----------
function renderEmpty() {
  docEl.textContent = '';
  const box = document.createElement('div');
  box.className = 'empty';
  box.innerHTML = `<h1>Open a script to start</h1>
    <p>Word (.docx) or text files. Bracketed text like [SLIDE: …] isn't read. Timestamps like 00:01:30 at the start of a line tie the script to the video.</p>
    <div class="btns"><button class="btn primary" data-act="open">Open a script…</button></div>
    <div class="proj-list" id="emptyList"></div>`;
  docEl.appendChild(box);
  box.querySelector('[data-act="open"]').onclick = () => $('#fileScript').click();
  fillProjectList(box.querySelector('#emptyList'));
}

function isEdited(pid) {
  if (!project) return false;
  const p = project.paras.find((x) => x.id === pid);
  return !(pid in project.orig) || (p && project.orig[pid] !== p.text);
}

function renderDoc() {
  docEl.textContent = '';
  paraEls.clear();
  editing = null;
  if (!project || !model) { renderEmpty(); return; }
  const T = model.tokens.length;
  tokEls = new Array(T); gapEls = new Array(T).fill(null); tokCls = new Array(T).fill(''); gapCls = new Array(T).fill('');
  const frag = document.createDocumentFragment();
  for (const b of model.blocks) {
    const p = document.createElement('p');
    p.className = 'para k-' + b.kind;
    p.dataset.pid = b.pid;
    let lastTok = -1;
    for (const part of b.parts) {
      if (part.type === 'w') {
        const s = document.createElement('span');
        s.className = 'w'; s.dataset.t = part.ti; s.textContent = model.tokens[part.ti].text;
        tokEls[part.ti] = s; p.appendChild(s); lastTok = part.ti;
      } else if (part.type === 'gap') {
        const g = document.createElement('span');
        g.className = 'g'; g.textContent = part.text; p.appendChild(g);
        if (lastTok >= 0 && !gapEls[lastTok]) gapEls[lastTok] = g;
      } else if (part.type === 'stamp') {
        const s = document.createElement('span');
        s.className = 'stamp'; s.textContent = fmtTime(part.t); s.dataset.time = part.t; s.title = 'Video time: tap to jump the video here';
        p.appendChild(s);
        lastTok = -1;
      } else {
        const s = document.createElement('span');
        s.className = 'ns'; s.textContent = part.text; p.appendChild(s);
        p.appendChild(document.createTextNode(' '));
        lastTok = -1;
      }
    }
    if (isEdited(b.pid)) { const d = document.createElement('span'); d.className = 'edited-dot'; d.title = 'Edited'; p.appendChild(d); }
    frag.appendChild(p);
    paraEls.set(b.pid, p);
  }
  if (mode === 'edit') {
    const add = document.createElement('button');
    add.className = 'btn add-end'; add.textContent = 'Add a paragraph at the end';
    add.onclick = () => addParagraph(null);
    frag.appendChild(add);
  }
  docEl.appendChild(frag);
  guideA = guideB = -1; lastFollowPos = follower.pos; lineMemo.t = -1;
  blockByPid = new Map(model.blocks.map((b) => [b.pid, b]));
  updateClasses();
  paint();
}

// ---------- painting ----------
// Class changes are batched into one paint per frame (from the tick loop), and only words that could have
// changed are touched. updateClasses() asks for a full repaint.
let dirtyLo = Infinity, dirtyHi = -1, dirtyAll = false;
let guideA = -1, guideB = -1, lastFollowPos = 0, lastAnchor = 0, lastTrusted = 0;
let blockByPid = new Map();
const LAG = { device: 0.4, google: 0.7 }; // typical seconds between saying a word and the recognizer reporting it
function updateClasses() { dirtyAll = true; }
function markDirtyTokens(a, b) { if (a < dirtyLo) dirtyLo = a; if (b > dirtyHi) dirtyHi = b; }
function markDirtyUnits(u0, u1) {
  if (!model || !model.N) return;
  const c = (u) => model.units[Math.max(0, Math.min(model.N - 1, u))].ti;
  markDirtyTokens(c(u0) - 1, c(u1) + 1);
}
// While listening, the guide runs slightly ahead of the last recognized word by the recognizer's usual delay,
// so it sits on the word you're saying rather than the one you just finished. It never crosses a sentence end.
function guideUnit() {
  const u = Math.min(shown.pos, model.N - 1);
  if (!listening) { gHold.pos = u; gHold.base = u; return u; }
  let p = u;
  const r = follower.rate();
  const since = performance.now() / 1000 - r.lastT;
  if (r.rate > 0 && since < 0.9) {
    const lead = Math.min(1.2, r.rate * (LAG[settings.engine] || 0.4));
    p = u + Math.floor(lead + 0.35);
    const sent = model.sentences[model.tokens[model.units[u].ti].sent];
    if (sent) p = Math.min(p, sent.u1 - 1);
  }
  p = Math.max(u, Math.min(model.N - 1, p));
  // never step back just because you paused; only when the shown spot itself moves back
  if (u < gHold.base) gHold.pos = p; else gHold.pos = Math.max(gHold.pos, p);
  gHold.base = u;
  return gHold.pos;
}
const gHold = { pos: 0, base: 0 };
// The words on the same screen line as token t (depends on text size and wrapping). Cached per token and layout.
let lineMemo = { t: -1, key: '', range: [-1, -1] };
function lineRange(t) {
  const key = settings.textSize + 'x' + scriptEl.clientWidth;
  if (lineMemo.t === t && lineMemo.key === key) return lineMemo.range;
  const { tokens } = model;
  const el = tokEls[t];
  if (!el) return [t, t];
  const top = el.offsetTop, tol = settings.textSize * 0.5, pid = tokens[t].pid;
  let a = t, b = t;
  while (a > 0 && tokens[a - 1].pid === pid && tokEls[a - 1] && Math.abs(tokEls[a - 1].offsetTop - top) < tol) a--;
  while (b < tokens.length - 1 && tokens[b + 1].pid === pid && tokEls[b + 1] && Math.abs(tokEls[b + 1].offsetTop - top) < tol) b++;
  lineMemo = { t, key, range: [a, b] };
  return lineMemo.range;
}
function guideRange() {
  if (mode !== 'read' || settings.span === 'off' || !model || follower.pos >= model.N) return [-1, -1];
  const { tokens, units } = model;
  let t0 = units[guideUnit()].ti;
  let t1 = t0;
  if (settings.span === 'phrase') {
    let n = 0;
    while (t1 < tokens.length - 1 && n < 5 && !tokens[t1].endsPhrase && tokens[t1 + 1].pid === tokens[t0].pid) { t1++; n++; }
  } else if (settings.span === 'line') {
    [t0, t1] = lineRange(t0);
  } else if (settings.span === 'sentence') {
    const s = model.sentences[tokens[t0].sent];
    if (s) { t0 = s.t0; t1 = s.t1 - 1; }
  } else if (settings.span === 'para') {
    const b = blockByPid.get(tokens[t0].pid);
    if (b) { t0 = b.t0; t1 = b.t1 - 1; }
  }
  return [t0, t1];
}
// Sentence dimming: a sentence counts as finished once the reading spot is past its end.
function sentDone(si) {
  const S = model.sentences, k = settings.said === 'sent2' ? si + 1 : si;
  return k < S.length && S[k].u1 <= stable.pos; // the settled spot, so a brief jump ahead never completes a sentence
}
// Missed-word and misread marks show only once their sentence is confirmed finished (the recognizer has
// committed past its end), so marks never flicker while you're still reading the sentence.
function tokState(t) {
  const { tokens, units } = model;
  const tok = tokens[t];
  const sent = tok.sent >= 0 ? model.sentences[tok.sent] : null;
  const confirmed = !!sent && sent.u1 <= follower.anchor && Math.min(sent.u1 + 2, model.N) <= follower.trusted;
  let said = tok.spoken, skip = false, maybe = false;
  for (let u = tok.u0; u < tok.u1; u++) {
    const st = follower.eff(u);
    if (st === UNREAD || u >= shown.pos) said = false;
    else if (st === 2) { said = false; if (confirmed && !units[u].soft && follower.status[u] === 2) skip = true; }
    else if (st === 3 && confirmed && follower.status[u] === 3) maybe = true;
  }
  return { said, skip, maybe };
}
function paint() {
  if (!model || !tokEls.length) return;
  const T = model.tokens.length;
  const [ga, gb] = guideRange();
  if (ga !== guideA || gb !== guideB) {
    if (guideA >= 0) markDirtyTokens(guideA, guideB);
    if (ga >= 0) markDirtyTokens(ga, gb);
    guideA = ga; guideB = gb;
  }
  let lo, hi;
  if (dirtyAll) { lo = 0; hi = T - 1; } else { lo = Math.max(0, dirtyLo - 1); hi = Math.min(T - 1, dirtyHi); }
  dirtyAll = false; dirtyLo = Infinity; dirtyHi = -1;
  const sentMode = settings.said === 'sent' || settings.said === 'sent2';
  if (hi >= lo) {
    let next = tokState(lo);
    for (let t = lo; t <= hi; t++) {
      const cur = next;
      next = t + 1 < T ? tokState(t + 1) : null;
      const el = tokEls[t];
      if (!el) continue;
      let c = 'w';
      if (sentMode) { const si = model.tokens[t].sent; if (si >= 0 && sentDone(si)) c += ' done'; }
      else if (cur.said) c += ' said';
      if (cur.skip) c += ' skip';
      if (cur.maybe && cur.said) c += ' maybe';
      if (t >= guideA && t <= guideB) c += ' next';
      let inTts = false;
      if (tts) { inTts = t >= tts.t0 && t < tts.t1; if (inTts) c += ' tts-sent'; if (t === tts.cur) c += ' tts-word'; }
      if (c !== tokCls[t]) { el.className = c; tokCls[t] = c; }
      const g = gapEls[t];
      if (g) {
        let gc = 'g';
        if (sentMode) { const si = model.tokens[t].sent; if (si >= 0 && sentDone(si)) gc += ' done'; }
        else if (cur.said && next && next.said) gc += ' said';
        if (t >= guideA && t < guideB) gc += ' next';
        if (inTts && t + 1 < tts.t1) gc += ' tts-sent';
        if (gc !== gapCls[t]) { g.className = gc; gapCls[t] = gc; }
      }
    }
  }
}

// ---------- scrolling ----------
let userScrollUntil = 0, anim = null;
function smoothScrollTo(top, dur = 280) {
  top = Math.max(0, Math.min(top, scriptEl.scrollHeight - scriptEl.clientHeight));
  const from = scriptEl.scrollTop, d = top - from;
  if (Math.abs(d) < 1) return;
  if (Math.abs(d) > scriptEl.clientHeight * 2) { scriptEl.scrollTop = top; return; }
  const t0 = performance.now();
  anim = { top };
  const step = (now) => {
    if (!anim || anim.top !== top) return;
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    scriptEl.scrollTop = from + d * e;
    if (k < 1) requestAnimationFrame(step); else anim = null;
  };
  requestAnimationFrame(step);
}
// Scrolling keeps a few lines above the reading line (Settings: lines above) and only moves when the reading
// line has gone down a set number of lines (Settings: scroll every). It scrolls back up only if the reading line
// leaves the top of the screen, so small corrections from the recognizer never bounce the page.
function keepInView(el, force) {
  if (!el) return;
  const sr = scriptEl.getBoundingClientRect(), r = el.getBoundingClientRect();
  const lineH = settings.textSize * 1.5;
  const top = sr.top + 10;
  const want = top + lineH * settings.linesAbove;
  let delta;
  if (force) delta = r.top - want;
  else if (r.top < top - 2) delta = r.top - want;
  else if (r.top - want >= lineH * (settings.scrollEvery - 0.5) || r.bottom > sr.bottom - lineH * 0.3) delta = r.top - want;
  else return;
  if (Math.abs(delta) < 2) return;
  if (!force && performance.now() < userScrollUntil) { $('#backPill').hidden = false; return; }
  $('#backPill').hidden = true;
  smoothScrollTo(scriptEl.scrollTop + delta);
}
const onUserScroll = () => { userScrollUntil = performance.now() + 4000; anim = null; };
scriptEl.addEventListener('wheel', onUserScroll, { passive: true });
scriptEl.addEventListener('touchmove', onUserScroll, { passive: true });
$('#backPill').onclick = () => { userScrollUntil = 0; scrollToCurrent(true); };
function currentEl() {
  if (!model) return null;
  if (tts && tts.cur >= 0) return tokEls[tts.cur];
  const p = Math.min(follower.pos, model.N - 1);
  return p >= 0 ? tokEls[model.units[p].ti] : null;
}
const scrollToCurrent = (force) => { if (force) syncStable(); keepInView(currentEl(), force); };
// Start, taps and arrow keys move the page straight to the reading spot, in every scroll style.
function syncStable() { stable.pos = stable.cand = follower.pos; stable.t = performance.now(); scrollSent = -1; shown.pos = follower.pos; shown.fwdCand = -1; shown.backT = 0; }
// The shown reading spot (guide and read highlight): small steps forward follow at once, bigger jumps must hold
// for 350 ms, and it moves back only after 700 ms, so the guide picks a place and stays there.
const shown = { pos: 0, fwdCand: -1, fwdT: 0, backT: 0 };
function updateShown() {
  const now = performance.now(), p = follower.pos || 0, prev = shown.pos || 0;
  if (!listening || !model) { shown.pos = p; shown.fwdCand = -1; shown.backT = 0; }
  else if (p >= shown.pos) {
    shown.backT = 0;
    if (p - shown.pos <= 6) { shown.pos = p; shown.fwdCand = -1; }
    else if (shown.fwdCand < 0 || Math.abs(p - shown.fwdCand) > 3) { shown.fwdCand = p; shown.fwdT = now; }
    else if (now - shown.fwdT > 350) { shown.pos = p; shown.fwdCand = -1; }
  } else {
    shown.fwdCand = -1;
    if (!shown.backT) shown.backT = now;
    else if (now - shown.backT > 700) { shown.pos = p; shown.backT = 0; }
  }
  if (shown.pos !== prev && model && model.N) markDirtyUnits(Math.min(prev, shown.pos) - 1, Math.max(prev, shown.pos) + 1);
}

// While reading (or in Listen mode), the page follows a reading spot that has held for a moment, so a spot that
// jumps ahead and back never moves the page. Styles: 'pause' waits for a break in your speech before moving
// (unless the line runs out of room), 'step' moves right away, 'slow' drifts up gently and continuously.
const stable = { pos: 0, cand: -1, t: 0 };
let lastScrollT = 0, slowAcc = 0, scrollSent = -1;
function autoScroll() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - (lastScrollT || now)) / 1000); lastScrollT = now;
  if (!model || !model.N) return;
  let el, lastWord;
  if (tts && tts.cur >= 0) { el = tokEls[tts.cur]; lastWord = 0; }
  else if (listening) {
    el = tokEls[model.units[Math.min(stable.pos, model.N - 1)].ti];
    const h = follower.hist; lastWord = h.length ? h[h.length - 1].t * 1000 : 0;
  } else return;
  if (!el) return;
  const sr = scriptEl.getBoundingClientRect(), r = el.getBoundingClientRect();
  const lineH = settings.textSize * 1.5, top = sr.top + 10, want = top + lineH * settings.linesAbove;
  const below = r.top - want, roomOut = r.bottom > sr.bottom - lineH * 0.6, aboveTop = r.top < top - 2;
  if (now < userScrollUntil) { if (aboveTop || r.top > sr.bottom) $('#backPill').hidden = false; return; }
  $('#backPill').hidden = true;
  if (aboveTop) { if (!anim) smoothScrollTo(scriptEl.scrollTop + (r.top - want), 450); return; }
  const slow = settings.scrollStyle === 'slow';
  // Scroll every N sentences: when you reach the Nth new sentence, its first line moves to the reading position,
  // which keeps the sentence you're reading (and the next, if there's room) in view. A sentence too long to fit
  // still scrolls line by line before you run out of room.
  const sentN = /^s\d$/.test(String(settings.scrollEvery)) ? +String(settings.scrollEvery).slice(1) : 0;
  let move = below, due;
  if (sentN && !(tts && tts.cur >= 0)) {
    const si = model.tokens[model.units[Math.min(stable.pos, model.N - 1)].ti].sent;
    if (si >= 0) {
      if (scrollSent < 0 || si < scrollSent || si - scrollSent >= sentN) scrollSent = si;
      const sEl = tokEls[model.sentences[scrollSent].t0];
      move = Math.min(below, (sEl ? sEl.getBoundingClientRect().top : r.top) - want);
    }
    due = move > (slow ? 1 : lineH * 0.5);
    if (roomOut) { move = below; due = true; }
  } else due = slow ? below > 1 : (below >= lineH * (settings.scrollEvery - 0.5) || roomOut);
  if (slow) {
    if (!due || anim) { slowAcc = 0; return; }
    if (move > lineH * 5) { slowAcc = 0; smoothScrollTo(scriptEl.scrollTop + move, 350); return; } // far away: go there
    const speed = Math.min(lineH * 1.6, Math.max(lineH * 0.35, move * 0.7)) * (roomOut ? 3 : 1);
    slowAcc += speed * dt;
    if (slowAcc >= 1) { const step = Math.floor(slowAcc); slowAcc -= step; scriptEl.scrollTop += Math.min(step, move); }
    return;
  }
  if (anim || !due) return;
  if (settings.scrollStyle === 'pause' && !roomOut && now - lastWord < 450) return;
  smoothScrollTo(scriptEl.scrollTop + move, settings.scrollStyle === 'pause' ? 450 : 300);
}

// ---------- following ----------
let saveTimer = null;
function onFollow(e) {
  if (!model) return;
  if (e && e.jump) dirtyAll = true;
  else {
    const lo = Math.min(follower.anchor, lastAnchor, lastFollowPos, follower.pos, lastTrusted);
    const sl = model.sentences[model.tokens[model.units[Math.min(lo, model.N - 1)].ti].sent];
    markDirtyUnits(sl ? Math.min(lo, sl.u0) : lo, Math.max(follower.pos, lastFollowPos) + 1);
  }
  lastAnchor = follower.anchor; lastTrusted = follower.trusted;
  if (settings.said === 'sent' || settings.said === 'sent2') {
    const u = Math.min(follower.pos, model.N - 1), si = model.tokens[model.units[u].ti].sent;
    const s0 = model.sentences[Math.max(0, si - 2)];
    if (s0) markDirtyTokens(s0.t0, model.units[u].ti + 1);
  }
  lastFollowPos = follower.pos;
  if (e && e.jump && !listening) seekVideoToPos();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 1500);
}

function engineFor(kind) {
  if (!engines[kind]) {
    const cb = {
      partial: (t) => follower.input(t, false),
      final: (t) => follower.input(t, true),
      level: (rms) => { const v = Math.min(1, Math.sqrt(rms) * 3.2); $('#micDot').style.transform = `scale(${1 + v * 0.9})`; },
      error: (msg) => { toast(msg, 5000); stopListening(); },
    };
    engines[kind] = kind === 'google' ? new GoogleEngine(cb) : new OnDeviceEngine(cb);
  }
  return engines[kind];
}

function renderMic() {
  const b = $('#btnMic');
  b.hidden = mode !== 'read';
  renderSpeak();
  b.classList.toggle('on', listening);
  b.classList.toggle('loading', micBusy);
  b.setAttribute('aria-pressed', listening ? 'true' : 'false');
  if (!micBusy) $('#micLbl').textContent = listening ? 'Listening' : 'Start';
  if (!listening) $('#micDot').style.transform = '';
}
// Off-script notice (optional, dim): shows only after being off script for a moment and stays until you've
// been back on for a moment, so it never flashes.
let offSince = 0, onSince = 0, offShown = false;
function updateOffChip() {
  const now = performance.now(), off = listening && follower.off;
  if (off) { if (!offSince) offSince = now; onSince = 0; } else { if (!onSince) onSince = now; offSince = 0; }
  const want = settings.offNotice !== 'off' && (offShown ? !(onSince && now - onSince > 800) : (offSince && now - offSince > 1500));
  if (!!want !== offShown) { offShown = !!want; $('#offScript').hidden = !offShown; }
}

let startGen = 0;
async function startListening() {
  if (listening || micBusy) return;
  if (!model || !model.N) { toast('Open a script first.'); return; }
  if (mode !== 'read') setMode('read');
  if (sound) { resumeAfterSound = false; setSound(false); }
  stopTTS();
  micBusy = true; renderMic();
  const gen = ++startGen;
  $('#micLbl').textContent = 'Starting…';
  const eng = engineFor(settings.engine === 'google' ? 'google' : 'device');
  let showedLoad = false;
  try {
    await eng.start({
      micSource: settings.micSource,
      onProgress: (p) => {
        if (p.phase === 'download') {
          if (!showedLoad) { showedLoad = true; openLoad('Getting the speech model', 'One-time download (41 MB). After this it works offline.'); }
          $('#lBar').style.width = Math.round(p.frac * 100) + '%';
          $('#micLbl').textContent = Math.round(p.frac * 100) + '%';
        } else if (p.phase === 'init') {
          if (showedLoad) $('#lText').textContent = 'Starting the speech engine…';
          $('#micLbl').textContent = 'Starting…';
        }
      },
    });
  } catch (err) {
    try { eng.stop(); } catch (e) { /* already stopped */ }
    micBusy = false; renderMic(); closeLoad();
    const msg = err && err.name === 'NotAllowedError' ? 'Mic permission was refused. Allow it in the browser’s site settings, then try again.' : (err && err.message) || String(err);
    toast(msg, 5000);
    return;
  }
  closeLoad();
  if (gen !== startGen) { eng.stop(); return; } // stopped or paused while starting
  engine = eng;
  micBusy = false; listening = true;
  follower.commit(); follower.anchor = follower.pos; follower.segSkip = 0; follower.segLen = 0;
  setFollow(true);
  renderMic(); wantAwake();
  userScrollUntil = 0; scrollToCurrent(true);
}

function stopListening() {
  startGen++;
  if (engine) engine.stop();
  const was = listening;
  listening = false; micBusy = false;
  follower.commit(); follower.off = false; follower.anchor = follower.pos;
  renderMic(); wantAwake();
  if (was) { updateClasses(); saveProject(); }
}

// ---------- video ----------
function setVideoSrc(blob) {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(blob);
  video.src = videoURL;
  video.muted = !sound;
  document.body.classList.remove('no-video');
  layout();
}
function clearVideo() {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = null;
  video.removeAttribute('src'); video.load();
  document.body.classList.add('no-video');
  if (model) model.times = computeTimes(model, NaN);
  layout();
}
video.addEventListener('loadedmetadata', () => {
  layout();
  if (model) model.times = computeTimes(model, video.duration);
  updateVTime();
  if (model && !model.anchors.length) toast('No timestamps in this script, so the video is spread evenly across it.');
  seekVideoToPos();
});
video.addEventListener('timeupdate', () => { updateVTime(); markVideoSpot(); });
video.addEventListener('play', () => { renderPlay(); wantAwake(); });
video.addEventListener('pause', () => { renderPlay(); wantAwake(); });
function updateVTime() { $('#vTime').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`; }
function renderPlay() { const playing = !video.paused; $('#icoPlay').toggleAttribute('hidden', playing); $('#icoPause').toggleAttribute('hidden', !playing); $('#vPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play'); }

function seekVideoToPos() {
  if (!hasVideo() || !model || !model.times || video.readyState < 1) return;
  const p = tts && tts.cur >= 0 ? model.tokens[tts.cur].u0 : follower.pos;
  video.currentTime = timeAt(model.times, p);
  vRate = 0;
}

function setFollow(on) {
  follow = on;
  $('#vFollow').setAttribute('aria-pressed', on ? 'true' : 'false');
  vRate = 0;
  if (!on) { video.playbackRate = 1; $('#vRate').hidden = true; }
  else { clearVideoSpot(); seekVideoToPos(); }
}

function setSound(on) {
  sound = on;
  video.muted = !on;
  if (on) {
    if (listening) { resumeAfterSound = true; stopListening(); }
    stopTTS();
    setFollow(false);
  } else if (resumeAfterSound) {
    resumeAfterSound = false;
    if (mode === 'read') startListening();
  }
  $('#vSound').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#vSoundLbl').textContent = on ? 'Sound on' : 'Sound off';
  $('#icoWaves').toggleAttribute('hidden', !on); $('#icoMute').toggleAttribute('hidden', on);
}

let vSpotPid = null;
function clearVideoSpot() { if (vSpotPid && paraEls.get(vSpotPid)) paraEls.get(vSpotPid).classList.remove('vidhere'); vSpotPid = null; }
function markVideoSpot() {
  if (follow || !model || !model.times || !hasVideo()) { clearVideoSpot(); return; }
  const u = unitAtTime(model.times, video.currentTime);
  const pid = model.tokens[model.units[u].ti].pid;
  if (pid === vSpotPid) return;
  clearVideoSpot();
  vSpotPid = pid;
  const el = paraEls.get(pid);
  if (el) { el.classList.add('vidhere'); if (!video.paused && !listening) keepInView(el, false); }
}

// Video follows the reading position: speed eases up and down to stay with the reader, no jumps.
let vRate = 0, lastTick = 0, lastRateShown = '';
function driver() {
  if (!model) return null;
  if (mode === 'listen') {
    if (!tts || tts.cur < 0) return null;
    const r = tts.tracker.rate();
    return { pos: model.tokens[tts.cur].u0, rate: r.rate, lastT: r.lastT };
  }
  if (mode === 'read' && listening) { const r = follower.rate(); return { pos: follower.pos, rate: r.rate, lastT: r.lastT }; }
  return { pos: follower.pos, rate: 0, lastT: 0 };
}
// The settled reading spot: follows the live spot once it has held for 400 ms (instantly when not listening).
function updateStable() {
  const now = performance.now(), prev = stable.pos;
  if (!listening) stable.pos = stable.cand = follower.pos;
  else if (follower.pos !== stable.cand) { stable.cand = follower.pos; stable.t = now; }
  else if (now - stable.t > 400) stable.pos = stable.cand;
  if (stable.pos !== prev && model && model.N && (settings.said === 'sent' || settings.said === 'sent2')) {
    const a = Math.min(prev, stable.pos), b = Math.max(prev, stable.pos);
    const si = model.tokens[model.units[Math.min(a, model.N - 1)].ti].sent, s0 = model.sentences[Math.max(0, si - 1)];
    markDirtyUnits(s0 ? s0.u0 : a, b + 1);
  }
}
let wakeCheck = 0;
function tick() {
  requestAnimationFrame(tick);
  if (performance.now() - wakeCheck > 2000) { wakeCheck = performance.now(); if (wakeWanted && !wakeLock) syncWake(); }
  updateShown();
  updateStable();
  paint();
  updateOffChip();
  autoScroll();
  const now = performance.now() / 1000;
  const dt = Math.min(0.1, now - lastTick || 0.016);
  lastTick = now;
  if (!follow || !hasVideo() || !model || !model.times || video.readyState < 2 || video.seeking) return;
  const d = driver();
  if (!d) { if (!video.paused) video.pause(); return; }
  let p = d.pos;
  if (d.rate > 0) p += Math.min(2.5, d.rate * (now - d.lastT));
  const target = timeAt(model.times, p);
  const err = target - video.currentTime;
  if (err > 30 || err < -4) { video.currentTime = target; vRate = 0; return; }
  const slope = timeAt(model.times, p + 1) - timeAt(model.times, p);
  const desired = slope * d.rate + err / 1.2;
  vRate += (desired - vRate) * Math.min(1, dt / 0.35);
  if (desired <= 0.05 || (vRate < 0.15 && err < 0.3)) {
    if (!video.paused) video.pause();
    if (vRate < 0) vRate = 0;
    if (lastRateShown) { $('#vRate').hidden = true; lastRateShown = ''; }
    return;
  }
  const r = Math.max(0.25, Math.min(16, vRate));
  if (Math.abs(r - video.playbackRate) > video.playbackRate * 0.04) video.playbackRate = r;
  if (video.paused) video.play().catch(() => {});
  const label = '×' + (r < 10 ? r.toFixed(1) : Math.round(r));
  if (!settings.showRate) { if (lastRateShown) { $('#vRate').hidden = true; lastRateShown = ''; } }
  else if (label !== lastRateShown) { $('#vRate').textContent = label; $('#vRate').hidden = false; lastRateShown = label; }
}
requestAnimationFrame(tick);

$('#vPlay').onclick = () => {
  if (!hasVideo()) return;
  if (video.paused) { setFollow(false); video.playbackRate = 1; video.play().catch(() => {}); }
  else { setFollow(false); video.pause(); }
};
$('#vBack').onclick = () => { if (!hasVideo()) return; setFollow(false); video.currentTime = Math.max(0, video.currentTime - 5); };
$('#vFwd').onclick = () => { if (!hasVideo()) return; setFollow(false); video.currentTime = Math.min(video.duration || 0, video.currentTime + 5); };
$('#vFollow').onclick = () => { if (follow) setFollow(false); else { video.pause(); setFollow(true); } };
$('#vSound').onclick = () => setSound(!sound);

// ---------- layout ----------
// Portrait: the bar sets how tall the script area is; the video sits right under it, with empty space below if
// it's moved up (so text is never behind or under the video). Landscape: the video is on the right; the bar sets its width.
const mainEl = $('#main'), sideEl = $('#side'), paneEl = $('#videoPane');
const GRIP = 18;
const isLand = () => window.innerWidth > window.innerHeight;
function layout() {
  const land = isLand();
  mainEl.classList.toggle('land', land);
  $('#grip').setAttribute('aria-orientation', land ? 'vertical' : 'horizontal');
  if (!hasVideo()) { scriptEl.style.flex = ''; sideEl.style.width = ''; paneEl.style.height = ''; return; }
  const ar = video.videoWidth && video.videoHeight ? video.videoHeight / video.videoWidth : 9 / 16;
  const W = mainEl.clientWidth, H = mainEl.clientHeight;
  if (land) {
    scriptEl.style.flex = '';
    let w = settings.sideFrac ? settings.sideFrac * W : W * 0.45;
    w = Math.round(Math.max(260, Math.min(W - GRIP - 280, w)));
    sideEl.style.width = w + 'px';
    const ctl = $('.vctl').offsetHeight || 60;
    paneEl.style.height = Math.round(Math.min(w * ar, H - ctl) + ctl) + 'px';
  } else {
    sideEl.style.width = '';
    paneEl.style.height = 'auto';
    const ctl = $('.vctl').offsetHeight || 60;
    const natural = W * ar + ctl;
    let T = settings.textFrac != null ? settings.textFrac * H : H - GRIP - natural;
    T = Math.round(Math.max(Math.min(90, H * 0.3), Math.min(H - GRIP - 140, T)));
    scriptEl.style.flex = `0 0 ${T}px`;
    paneEl.style.height = Math.round(Math.min(natural, H - GRIP - T)) + 'px';
  }
}
let layoutTimer = null;
window.addEventListener('resize', () => { layout(); clearTimeout(layoutTimer); layoutTimer = setTimeout(() => scrollToCurrent(true), 200); });
(() => {
  const grip = $('#grip');
  let drag = null, lastTap = 0;
  grip.addEventListener('pointerdown', (e) => {
    const now = performance.now();
    if (now - lastTap < 350) { // double-tap resets
      if (isLand()) settings.sideFrac = null; else settings.textFrac = null;
      saveSettings(); layout(); scrollToCurrent(true); lastTap = 0; return;
    }
    lastTap = now;
    drag = { rect: mainEl.getBoundingClientRect() };
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = drag.rect;
    if (isLand()) settings.sideFrac = Math.max(0.15, Math.min(0.8, (r.right - e.clientX - GRIP / 2) / r.width));
    else settings.textFrac = Math.max(0.05, Math.min(0.95, (e.clientY - r.top - GRIP / 2) / r.height));
    layout();
  });
  const end = () => { if (drag) { drag = null; saveSettings(); scrollToCurrent(true); } };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
})();

// ---------- listen mode (TTS) ----------
function stopTTS() {
  if (!tts && !ttsBusy()) return;
  speakers.android.stop(); speakers.piper.stop();
  closeLoad();
  setTimeout(renderSpeak, 0);
  tts = null;
  updateClasses(); wantAwake();
}
function speakFrom(ti) {
  const vc = voiceChoice();
  if (vc.kind === 'android' && !Speaker.supported()) { toast('This browser can’t read text aloud.'); return; }
  const tok = model.tokens[ti];
  if (!tok || tok.sent < 0) return;
  const S = model.sentences;
  let sents = settings.ttsUnit === 'para' ? S.filter((s) => s.pid === tok.pid && s.t1 > ti)
    : settings.ttsUnit === 'cont' ? S.slice(tok.sent) : [S[tok.sent]];
  sents = sents.filter(Boolean);
  if (!sents.length) return;
  if (tts && ti >= tts.t0 && ti < tts.t1 && ttsBusy()) { pauseTTS(); return; } // tap the sentence being read to pause
  const items = sents.map((s) => {
    let text = '';
    const starts = [], words = [], syl = [];
    for (let t = s.t0; t < s.t1; t++) {
      const tk = model.tokens[t];
      if (!tk.spoken) continue;
      if (text) text += ' ';
      starts.push(text.length); text += tk.text; words.push(t);
      let n = 0; for (let u = tk.u0; u < tk.u1; u++) n += model.units[u].syl; syl.push(n);
    }
    return { chunk: { text, starts, words, syl }, range: [s.t0, s.t1] };
  }).filter((x) => x.chunk.words.length);
  if (!items.length) return;
  stopTTS();
  if (sound) setSound(false);
  const ranges = items.map((x) => x.range);
  tts = { t0: ranges[0][0], t1: ranges[0][1], ranges, cur: -1, tracker: new RateTracker() };
  follower.jumpTo(model.tokens[tts.t0].u0, false);
  if (hasVideo()) { setFollow(true); }
  speakers[vc.kind].speak(items.map((x) => x.chunk), { ...vc, rate: settings.ttsRate }, ttsCallbacks({
    word: (t, k) => {
      if (!tts) return;
      const r = tts.ranges[k];
      if (r && r[0] !== tts.t0) { markDirtyTokens(tts.t0, tts.t1); tts.t0 = r[0]; tts.t1 = r[1]; }
      tts.cur = t; tts.tracker.push(model.tokens[t].u0); markDirtyTokens(tts.t0, tts.t1);
    },
    end: () => { if (tts) markDirtyTokens(tts.t0, tts.t1); tts = null; wantAwake(); renderSpeak(); },
  }));
  updateClasses(); wantAwake(); renderSpeak();
}
// Pause keeps your place: the reading spot moves to the sentence being read, and Read aloud picks up there.
function pauseTTS() {
  const t = tts ? (tts.cur >= 0 ? tts.cur : tts.t0) : -1;
  stopTTS();
  if (t >= 0) { const s = model.sentences[model.tokens[t].sent]; if (s) follower.jumpTo(s.u0, false); }
  renderSpeak();
}
function renderSpeak() {
  const b = $('#btnSpeak');
  b.hidden = mode !== 'listen';
  const on = !!tts && ttsBusy();
  b.classList.toggle('on', on);
  $('#speakLbl').textContent = on ? 'Pause' : 'Read aloud';
}
$('#btnSpeak').onclick = () => {
  if (!model || !model.N) return;
  if (tts && ttsBusy()) { pauseTTS(); return; }
  const u = Math.min(follower.pos, model.N - 1);
  speakFrom(model.units[u].ti);
};

// ---------- edit mode ----------
function openEditor(pid) {
  if (editing) { if (editing.pid === pid) return; commitEditor(true); }
  const p = paraEls.get(pid);
  const para = project.paras.find((x) => x.id === pid);
  if (!p || !para) return;
  const ed = document.createElement('div');
  ed.className = 'editor';
  const ta = document.createElement('textarea');
  ta.value = para.text;
  ta.setAttribute('aria-label', 'Edit paragraph');
  const btns = document.createElement('div');
  btns.className = 'ed-btns';
  const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; btns.appendChild(b); return b; };
  mk('Done', 'primary', () => commitEditor(true));
  mk('Cancel', '', () => commitEditor(false));
  if (pid in project.orig && project.orig[pid] !== para.text) mk('Back to original', '', () => { ta.value = project.orig[pid]; autosize(); });
  mk('Add paragraph below', '', () => { commitEditor(true); addParagraph(pid); });
  mk('Delete paragraph', 'danger', () => { ta.value = ''; commitEditor(true); });
  ed.append(ta, btns);
  p.replaceWith(ed);
  const autosize = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 4 + 'px'; };
  ta.addEventListener('input', autosize);
  autosize();
  ta.focus();
  editing = { pid, ed, ta };
}
function commitEditor(save) {
  if (!editing) return;
  const { pid, ta } = editing;
  editing = null;
  if (save) {
    const parts = textToParagraphs(ta.value);
    const i = project.paras.findIndex((x) => x.id === pid);
    if (i >= 0) {
      if (!parts.length) project.paras.splice(i, 1);
      else {
        project.paras[i] = { id: pid, text: parts[0] };
        project.paras.splice(i + 1, 0, ...parts.slice(1).map((text) => ({ id: newId(), text })));
      }
    }
  }
  rebuild();
}
function addParagraph(afterPid) {
  const i = afterPid ? project.paras.findIndex((x) => x.id === afterPid) + 1 : project.paras.length;
  const id = newId();
  project.paras.splice(i, 0, { id, text: 'New paragraph' });
  rebuild();
  openEditor(id);
  if (editing) { editing.ta.select(); editing.ed.scrollIntoView({ block: 'center' }); }
}

// keep read marks and the reading spot across edits, by paragraph
function snapshot() {
  const st = {}, txt = {};
  if (model) {
    for (const b of model.blocks) {
      if (b.u1 <= b.u0) continue;
      let s = '';
      for (let u = b.u0; u < b.u1; u++) s += follower.eff(u);
      st[b.pid] = s;
      const p = model.paras.find((x) => x.id === b.pid); txt[b.pid] = p ? p.text : '';
    }
  }
  let pos = null;
  if (model && model.N) {
    const u = Math.min(follower.pos, model.N - 1);
    const b = model.blocks.find((x) => u >= x.u0 && u < x.u1);
    if (b) pos = { pid: b.pid, off: follower.pos - b.u0 };
  }
  return { st, txt, pos };
}
function restore(m, snap) {
  const status = new Uint8Array(m.N);
  let pos = 0;
  for (const b of m.blocks) {
    const s = snap.st[b.pid];
    const para = m.paras.find((x) => x.id === b.pid);
    if (s && s.length === b.u1 - b.u0 && (!snap.txt || snap.txt[b.pid] === undefined || snap.txt[b.pid] === para.text)) {
      for (let k = 0; k < s.length; k++) status[b.u0 + k] = +s[k];
    }
    if (snap.pos && snap.pos.pid === b.pid) pos = Math.min(b.u1, b.u0 + snap.pos.off);
  }
  return { status, pos };
}
function rebuild() {
  const snap = snapshot();
  snap.txt = Object.fromEntries(Object.entries(snap.txt));
  model = buildModel(project.paras.map((p) => ({ ...p })), hasVideo() ? video.duration : NaN);
  const r = restore(model, snap);
  follower.setModel(model, r.status, r.pos);
  renderDoc();
  saveProject();
}

// ---------- projects ----------
async function saveProject() {
  if (!project || !model) return;
  const snap = snapshot();
  project.status = snap.st;
  project.statusText = snap.txt;
  project.pos = snap.pos;
  project.updated = Date.now();
  try { await store.putProject(project); } catch (e) { /* storage full */ }
}

async function loadProject(p) {
  stopListening(); stopTTS(); resumeWanted = false;
  project = p;
  settings.lastProject = p.id; saveSettings();
  model = buildModel(p.paras.map((x) => ({ ...x })), NaN);
  const r = restore(model, { st: p.status || {}, txt: p.statusText, pos: p.pos });
  follower.setModel(model, r.status, r.pos);
  $('#title').textContent = p.name;
  document.title = p.name + ' · VO Prompter';
  renderDoc();
  clearVideo();
  if (p.videoName) {
    try { const v = await store.getVideo(p.id); if (v && v.blob) setVideoSrc(v.blob); } catch (e) { /* missing */ }
    if (!hasVideo()) toast('The video for this script isn’t on the tablet anymore. Add it again in Files.');
  }
  requestAnimationFrame(() => scrollToCurrent(true));
}

async function openScriptFile(file) {
  let paras;
  try { paras = await fileToParagraphs(file); } catch (e) { toast('Couldn’t read that file: ' + (e.message || e), 5000); return; }
  if (!paras.length) { toast('No text found in that file.'); return; }
  const id = 's' + Date.now().toString(36);
  const p = {
    id, name: file.name.replace(/\.[^.]+$/, ''), fileName: file.name,
    paras: paras.map((text, i) => ({ id: 'a' + i, text })), orig: {}, pos: null, status: {}, videoName: null, updated: Date.now(),
  };
  p.paras.forEach((x) => { p.orig[x.id] = x.text; });
  try { await store.putProject(p); } catch (e) { toast('Couldn’t save the script on the tablet; it will work until you close the app.'); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadProject(p);
  const m = model;
  toast(`${m.N} words to read${m.anchors.length ? `, ${m.anchors.length} video timestamps` : ''}.`);
}

async function openVideoFile(file) {
  if (!project) { toast('Open a script first.'); return; }
  setVideoSrc(file);
  project.videoName = file.name;
  saveProject();
  try { await store.putVideo(project.id, file); }
  catch (e) { toast('Couldn’t keep the video on the tablet; you’ll need to add it again next time.', 5000); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  renderFiles();
}

async function fillProjectList(el) {
  if (!el) return;
  let list = [];
  try { list = await store.listProjects(); } catch (e) { /* no storage */ }
  el.textContent = '';
  if (!list.length) { if (el.id === 'projList') el.innerHTML = '<p class="note">None yet.</p>'; return; }
  for (const it of list) {
    const row = document.createElement('div');
    row.className = 'proj-item' + (project && project.id === it.id ? ' current' : '');
    const t = document.createElement('div'); t.className = 't';
    t.textContent = it.name;
    const sm = document.createElement('small'); sm.textContent = new Date(it.updated).toLocaleString() + (it.hasVideo ? ' · with video' : '');
    t.appendChild(sm);
    const open = document.createElement('button'); open.className = 'btn'; open.textContent = project && project.id === it.id ? 'Open now' : 'Open';
    open.disabled = !!(project && project.id === it.id);
    open.onclick = async () => { const p = await store.getProject(it.id); if (p) { $('#dlgFiles').close(); loadProject(p); } };
    const del = document.createElement('button'); del.className = 'btn danger'; del.textContent = 'Delete';
    del.onclick = () => confirmDo('Delete this script?', `“${it.name}”, its edits and its video will be removed from the tablet.`, 'Delete', async () => {
      await store.deleteProject(it.id);
      if (project && project.id === it.id) { stopListening(); stopTTS(); project = null; model = null; clearVideo(); $('#title').textContent = 'No script open'; renderDoc(); }
      fillProjectList(el);
    });
    row.append(t, open, del);
    el.appendChild(row);
  }
}

function download(name, data, type) {
  const blob = new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---------- modes ----------
function setMode(m) {
  if (m === mode) return;
  if (mode === 'edit' && editing) commitEditor(true);
  if (m !== 'read' && listening) stopListening();
  if (m !== 'listen') stopTTS();
  const wasEdit = mode === 'edit' || m === 'edit';
  mode = m;
  for (const [id, v] of [['#mRead', 'read'], ['#mListen', 'listen'], ['#mEdit', 'edit']]) $(id).setAttribute('aria-pressed', v === m ? 'true' : 'false');
  docEl.classList.toggle('mode-edit', m === 'edit');
  renderMic();
  if (wasEdit) renderDoc(); else updateClasses();
  if (m === 'listen') toast('Tap a sentence to hear it.', 2200);
  if (m === 'edit') toast('Tap a paragraph to edit it.', 2200);
}
$('#mRead').onclick = () => setMode('read');
$('#mListen').onclick = () => setMode('listen');
$('#mEdit').onclick = () => setMode('edit');
$('#btnMic').onclick = () => { resumeWanted = false; if (listening || micBusy) stopListening(); else startListening(); };

docEl.addEventListener('click', (e) => {
  if (!model || !project) return;
  const stamp = e.target.closest('.stamp');
  const w = e.target.closest('.w');
  const para = e.target.closest('.para');
  if (mode === 'edit') { if (para) openEditor(para.dataset.pid); return; }
  if (stamp && hasVideo()) {
    const t = +stamp.dataset.time;
    const pb = model.blocks.find((b) => b.pid === para.dataset.pid);
    if (pb && pb.u1 > pb.u0) follower.jumpTo(pb.u0, false);
    video.currentTime = t; vRate = 0;
    return;
  }
  if (!w) return;
  const ti = +w.dataset.t;
  const tok = model.tokens[ti];
  if (mode === 'listen') { speakFrom(ti); return; }
  // read mode: jump the reading spot and the video
  const wasPlaying = hasVideo() && !video.paused && !follow;
  follower.jumpTo(tok.u0, true);
  if (hasVideo() && model.times) { video.currentTime = timeAt(model.times, tok.u0); vRate = 0; if (wasPlaying) video.play().catch(() => {}); }
  userScrollUntil = 0;
  scrollToCurrent(true);
});

// keyboard and page-turners: Space starts/stops, arrows move by sentence
document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('textarea, input, select, dialog')) return;
  if (!model) return;
  const sentAt = () => { const u = Math.min(follower.pos, model.N - 1); return u >= 0 ? model.tokens[model.units[u].ti].sent : -1; };
  if (e.key === ' ' && mode === 'read') { e.preventDefault(); $('#btnMic').click(); }
  else if (e.key === ' ' && mode === 'listen') { e.preventDefault(); $('#btnSpeak').click(); }
  else if (e.key === 'ArrowDown' || e.key === 'PageDown') {
    e.preventDefault();
    const s = model.sentences[sentAt() + 1];
    if (s) { follower.jumpTo(s.u0, false); seekVideoToPos(); userScrollUntil = 0; scrollToCurrent(true); }
  } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
    e.preventDefault();
    const cur = model.sentences[sentAt()];
    const s = cur && follower.pos > cur.u0 + 1 ? cur : model.sentences[Math.max(0, sentAt() - 1)];
    if (s) { follower.jumpTo(s.u0, false); seekVideoToPos(); userScrollUntil = 0; scrollToCurrent(true); }
  } else if (e.key === 'Escape') stopTTS();
});

// The mic pauses while Settings or Files is open, when the app loses focus, or when the screen goes off,
// and comes back on afterwards if it was on.
const pauseReasons = new Set();
let resumeWanted = false;
function pauseMic(reason) {
  pauseReasons.add(reason);
  if (listening || micBusy) { resumeWanted = true; stopListening(); }
}
function resumeMic(reason) {
  pauseReasons.delete(reason);
  if (pauseReasons.size || !resumeWanted) return;
  resumeWanted = false;
  if (mode === 'read' && !sound && project) startListening();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { pauseMic('hidden'); stopTTS(); saveProject(); }
  else { resumeMic('hidden'); wantAwake(); }
});
window.addEventListener('blur', () => pauseMic('blur'));
window.addEventListener('focus', () => resumeMic('blur'));
for (const id of ['#dlgSettings', '#dlgFiles']) $(id).addEventListener('close', () => resumeMic('dialog'));

// ---------- dialogs ----------
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'dlgLoad') d.close(); });
  const c = d.querySelector('[data-close]');
  if (c) c.onclick = () => d.close();
}
function openLoad(title, text) { $('#lTitle').textContent = title; $('#lText').textContent = text; $('#lBar').style.width = '0%'; if (!$('#dlgLoad').open) $('#dlgLoad').showModal(); }
function closeLoad() { if ($('#dlgLoad').open) $('#dlgLoad').close(); }
$('#lHide').onclick = closeLoad;
let confirmFn = null;
function confirmDo(title, text, yes, fn) {
  $('#cTitle').textContent = title; $('#cText').textContent = text; $('#cYes').textContent = yes;
  confirmFn = fn; $('#dlgConfirm').showModal();
}
$('#cYes').onclick = async () => { $('#dlgConfirm').close(); const f = confirmFn; confirmFn = null; if (f) await f(); };
$('#cNo').onclick = () => { confirmFn = null; $('#dlgConfirm').close(); };

function renderFiles() {
  const has = !!project;
  $('#fOpenVideo').disabled = !has;
  $('#fOpenVideo').textContent = project && project.videoName ? 'Replace video…' : 'Add video…';
  $('#fRemoveVideo').hidden = !(project && project.videoName);
  $('#fVideoNote').textContent = !has ? 'Open a script first.' : project.videoName ? `Video: ${project.videoName}` : 'No video. Add the video the script’s timestamps refer to.';
  for (const id of ['#fExportDocx', '#fExportTxt', '#fClearMarks']) $(id).disabled = !has;
  fillProjectList($('#projList'));
}
$('#btnFiles').onclick = () => { pauseMic('dialog'); renderFiles(); $('#dlgFiles').showModal(); };
$('#fOpenScript').onclick = () => $('#fileScript').click();
$('#fOpenVideo').onclick = () => $('#fileVideo').click();
$('#fRemoveVideo').onclick = () => confirmDo('Remove the video?', 'The video is removed from this script on the tablet. Your file elsewhere isn’t touched.', 'Remove', async () => {
  await store.deleteVideo(project.id); project.videoName = null; clearVideo(); saveProject(); renderFiles();
});
$('#fileScript').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { $('#dlgFiles').open && $('#dlgFiles').close(); openScriptFile(f); } };
$('#fileVideo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openVideoFile(f); };
$('#fExportDocx').onclick = () => download(project.name + ' (edited).docx', paragraphsToDocx(project.paras.map((p) => p.text)), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
$('#fExportTxt').onclick = () => download(project.name + ' (edited).txt', paragraphsToText(project.paras.map((p) => p.text)), 'text/plain');
$('#fClearMarks').onclick = () => { follower.clearMarks(); follower.jumpTo(0, true); saveProject(); toast('Read marks cleared.'); };

// The first download of a natural voice shows progress; any voice error is shown as a notice.
function ttsCallbacks(cb) {
  let shown = false;
  return {
    ...cb,
    progress: (f) => {
      if (!shown) { shown = true; openLoad('Getting the voice', 'One-time download (about 60 MB). After this it works offline.'); }
      $('#lBar').style.width = Math.round(f * 100) + '%';
      if (f >= 1) $('#lText').textContent = 'Starting the voice…';
    },
    word: (...a) => { if (shown) { shown = false; closeLoad(); } cb.word && cb.word(...a); },
    end: () => { closeLoad(); cb.end && cb.end(); },
    error: (msg) => { closeLoad(); toast(msg, 5000); },
  };
}
function fillVoices() {
  const sel = $('#selVoice');
  sel.textContent = '';
  const ga = document.createElement('optgroup'); ga.label = 'Android voice';
  const def = document.createElement('option'); def.value = 'android:'; def.textContent = 'Android voice (set in Android settings)'; ga.appendChild(def);
  for (const v of englishVoices()) { const o = document.createElement('option'); o.value = 'android:' + v.voiceURI; o.textContent = `${v.name}${v.localService ? '' : ' (online)'}`; ga.appendChild(o); }
  const gp = document.createElement('optgroup'); gp.label = 'Natural voices (on tablet)';
  for (const v of PIPER_VOICES) {
    const o = document.createElement('option'); o.value = 'piper:' + v.id; o.textContent = v.name; gp.appendChild(o);
    voiceIsDownloaded(v.id).then((d) => { if (d) o.textContent = v.name + ' ✓'; });
  }
  sel.append(ga, gp);
  sel.value = [...sel.options].some((o) => o.value === settings.ttsVoice) ? settings.ttsVoice : 'android:';
  $('#voiceNote').textContent = voiceChoice().kind === 'piper'
    ? 'Natural voice: runs on the tablet. Downloads once (about 60 MB, ✓ = already on the tablet), then works offline. Each sentence takes a moment to prepare.'
    : 'Android voice: Chrome on Android lists languages, not voices. The voice it uses is the one picked in Android Settings: search “Text-to-speech”, choose Speech Services by Google, then its settings → Install voice data → English (United States) to pick or download a higher-quality voice.';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);

async function syncSettingsUI() {
  $('#sText').value = settings.textSize; $('#oText').textContent = settings.textSize + ' px';
  $('#selSaid').value = settings.said; $('#selGuide').value = settings.guide; $('#selSpan').value = settings.span;
  $('#selTheme').value = settings.theme; $('#selEngine').value = settings.engine; $('#selMic').value = settings.micSource;
  $('#selMarks').value = settings.marks; $('#selUnit').value = settings.ttsUnit;
  $('#selOff').value = settings.offNotice;
  $('#selScrollStyle').value = settings.scrollStyle; $('#selRate').value = settings.showRate ? 'on' : 'off';
  $('#selAbove').value = String(settings.linesAbove); $('#selEvery').value = String(settings.scrollEvery); $('#selMarkStr').value = settings.markStrength;
  $('#sRate').value = settings.ttsRate; $('#oRate').textContent = '×' + (+settings.ttsRate).toFixed(2);
  $('#engineNote').textContent = settings.engine === 'google'
    ? 'Android speech: Chrome’s speech recognition, which is Google’s. More accurate than the on-tablet engine, but it sends your audio to Google and usually needs internet.'
    : 'On tablet: your voice stays on the tablet and it works offline. The first start downloads a 41 MB speech model once.';
  fillVoices();
  const cached = await modelIsCached();
  $('#aboutLine').textContent = `VO Prompter ${VERSION} · speech model ${cached ? 'downloaded' : 'not downloaded yet'}`;
}
$('#btnSettings').onclick = () => { pauseMic('dialog'); syncSettingsUI(); $('#dlgSettings').showModal(); };
const bindSel = (id, key, after) => { $(id).onchange = (e) => { settings[key] = e.target.value; saveSettings(); applySettings(); updateClasses(); syncSettingsUI(); if (after) after(); }; };
$('#sText').oninput = (e) => { settings.textSize = +e.target.value; $('#oText').textContent = settings.textSize + ' px'; applySettings(); };
$('#sText').onchange = () => { saveSettings(); scrollToCurrent(true); };
bindSel('#selSaid', 'said'); bindSel('#selGuide', 'guide'); bindSel('#selSpan', 'span'); bindSel('#selTheme', 'theme');
bindSel('#selMarks', 'marks'); bindSel('#selMarkStr', 'markStrength'); bindSel('#selOff', 'offNotice');
bindSel('#selScrollStyle', 'scrollStyle');
$('#selRate').onchange = (e) => { settings.showRate = e.target.value === 'on'; saveSettings(); };
for (const [id, key] of [['#selAbove', 'linesAbove'], ['#selEvery', 'scrollEvery']]) {
  $(id).onchange = (e) => { const v = e.target.value; settings[key] = /^\d+$/.test(v) ? +v : v; saveSettings(); scrollToCurrent(true); };
}
bindSel('#selEngine', 'engine', () => { if (listening) { stopListening(); startListening(); } });
bindSel('#selMic', 'micSource', () => { if (listening) { stopListening(); startListening(); } });
bindSel('#selUnit', 'ttsUnit'); bindSel('#selVoice', 'ttsVoice');
$('#sRate').oninput = (e) => { settings.ttsRate = +e.target.value; $('#oRate').textContent = '×' + settings.ttsRate.toFixed(2); };
$('#sRate').onchange = saveSettings;
$('#btnTestVoice').onclick = () => {
  const vc = voiceChoice();
  if (vc.kind === 'android' && !Speaker.supported()) { toast('This browser can’t read text aloud.'); return; }
  speakers.android.stop(); speakers.piper.stop();
  speakers[vc.kind].speak([{ text: 'This is how the voice sounds at this speed.', starts: [0], words: [-1], syl: [12] }], { ...vc, rate: settings.ttsRate },
    ttsCallbacks({ end: () => syncSettingsUI() }));
};

// ---------- uninstall ----------
$('#btnWipe').onclick = () => confirmDo('Remove all app data?', 'Deletes every script, edit, video and setting from this tablet, plus the downloaded speech model and voices. This can’t be undone.', 'Remove everything', async () => {
  $('#dlgSettings').close();
  stopListening(); stopTTS();
  for (const k of Object.keys(engines)) { try { engines[k].unload(); } catch (e) { /* ignore */ } }
  clearVideo();
  await store.wipeAll();
  try { for (const k of await caches.keys()) await caches.delete(k); } catch (e) { /* ignore */ }
  try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* ignore */ }
  try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); } catch (e) { /* ignore */ }
  document.body.innerHTML = `<div class="gone"><h1>App data removed</h1>
    <p class="note">Everything VO Prompter stored on this tablet is gone. To remove the app icon too:</p>
    <ol><li>Long-press the VO Prompter icon on the home screen.</li><li>Tap <b>Uninstall</b> (or <b>App info</b> → <b>Uninstall</b>).</li></ol>
    <p class="note">If you only used it in a browser tab, just close the tab.</p>
    <div class="btns"><button class="btn" onclick="location.reload()">Start fresh instead</button></div></div>`;
});

// ---------- start ----------
applySettings();
layout();
renderMic();
setSound(false);
setFollow(true);
(async () => {
  let p = null;
  try { if (settings.lastProject) p = await store.getProject(settings.lastProject); } catch (e) { /* no storage */ }
  if (p) await loadProject(p); else renderDoc();
})();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// for automated checks
window.__vop = {
  follower, get model() { return model; }, get state() { return { mode, listening, follow, sound, pos: follower.pos, off: follower.off, vTime: video.currentTime, vRate: video.playbackRate, paused: video.paused }; },
  input: (t, f) => follower.input(t, f),
};
