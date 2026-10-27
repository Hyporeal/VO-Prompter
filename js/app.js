import { fileToParagraphs, textToParagraphs, buildModel, computeTimes, timeAt, unitAtTime, fmtTime, paragraphsToDocx, paragraphsToText } from './parse.js';
import { Follower, UNREAD } from './follow.js';
import { OnDeviceEngine, GoogleEngine, modelIsCached } from './engines.js';
import { Speaker, englishVoices } from './tts.js';
import * as store from './store.js';

const VERSION = '1.0.1';
const $ = (s) => document.querySelector(s);

const DEFAULTS = {
  textSize: 28, said: 'hl', guide: 'under', span: 'word', theme: 'dark',
  engine: 'device', micSource: 'builtin', marks: 'skips',
  ttsUnit: 'sentence', voiceURI: '', ttsRate: 1, videoH: 0, lastProject: null,
};
const settings = store.loadSettings(DEFAULTS);
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
const speaker = new Speaker();
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

async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* not allowed right now */ }
}
const wantAwake = () => keepAwake(listening || speaker.busy || (hasVideo() && !video.paused));

// ---------- settings → page ----------
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--script-size', settings.textSize + 'px');
  if (settings.videoH) document.documentElement.style.setProperty('--video-h', settings.videoH + 'px');
  docEl.classList.toggle('said-hl', settings.said === 'hl');
  docEl.classList.toggle('said-dim', settings.said === 'dim');
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
  updateClasses();
}

function updateClasses() {
  if (!model || !tokEls.length) return;
  const { tokens, units, N } = model;
  const T = tokens.length;
  const pos = follower.pos;
  const nextTok = mode === 'read' && pos < N ? units[pos].ti : -1;
  let guideEnd = nextTok;
  if (nextTok >= 0 && settings.span === 'phrase') {
    let t = nextTok, n = 0;
    while (t < T - 1 && n < 5 && !tokens[t].endsPhrase && tokens[t + 1].pid === tokens[nextTok].pid) { t++; n++; }
    guideEnd = t;
  }
  const said = new Uint8Array(T);
  const flags = new Array(T);
  for (let t = 0; t < T; t++) {
    const tok = tokens[t];
    let isSaid = tok.spoken, skip = false, maybe = false;
    for (let u = tok.u0; u < tok.u1; u++) {
      const s = follower.eff(u);
      if (s === UNREAD) isSaid = false;
      else if (s === 2) { if (!units[u].soft) { skip = true; isSaid = false; } }
      else if (s === 3) maybe = true;
    }
    said[t] = isSaid ? 1 : 0;
    flags[t] = { skip, maybe };
  }
  for (let t = 0; t < T; t++) {
    const el = tokEls[t];
    if (!el) continue;
    let c = 'w';
    if (said[t]) c += ' said';
    if (flags[t].skip) c += ' skip';
    if (flags[t].maybe && said[t]) c += ' maybe';
    if (nextTok >= 0 && t >= nextTok && t <= guideEnd) c += ' next';
    let inTts = false;
    if (tts) { inTts = t >= tts.t0 && t < tts.t1; if (inTts) c += ' tts-sent'; if (t === tts.cur) c += ' tts-word'; }
    if (c !== tokCls[t]) { el.className = c; tokCls[t] = c; }
    const g = gapEls[t];
    if (g) {
      let gc = 'g';
      if (said[t] && t + 1 < T && said[t + 1]) gc += ' said';
      if (inTts && t + 1 < tts.t1) gc += ' tts-sent';
      if (gc !== gapCls[t]) { g.className = gc; gapCls[t] = gc; }
    }
  }
}

// ---------- scrolling ----------
let userScrollUntil = 0, anim = null;
function smoothScrollTo(top) {
  top = Math.max(0, Math.min(top, scriptEl.scrollHeight - scriptEl.clientHeight));
  const from = scriptEl.scrollTop, d = top - from;
  if (Math.abs(d) < 1) return;
  if (Math.abs(d) > scriptEl.clientHeight * 2) { scriptEl.scrollTop = top; return; }
  const t0 = performance.now(), dur = 280;
  anim = { top };
  const step = (now) => {
    if (!anim || anim.top !== top) return;
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    scriptEl.scrollTop = from + d * e;
    if (k < 1) requestAnimationFrame(step); else anim = null;
  };
  requestAnimationFrame(step);
}
// Put el's line one line below the top of the script area, so the previous line stays visible.
function keepInView(el, force) {
  if (!el) return;
  const sr = scriptEl.getBoundingClientRect(), r = el.getBoundingClientRect();
  const lineH = settings.textSize * 1.5;
  const want = sr.top + 14 + lineH * 1.1;
  const delta = r.top - want;
  if (!force && Math.abs(delta) < lineH * 0.45) return;
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
const scrollToCurrent = (force) => keepInView(currentEl(), force);

// ---------- following ----------
let saveTimer = null;
function onFollow(e) {
  updateClasses();
  $('#offScript').hidden = !(listening && follower.off);
  scrollToCurrent(false);
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
  b.classList.toggle('on', listening);
  b.classList.toggle('loading', micBusy);
  b.setAttribute('aria-pressed', listening ? 'true' : 'false');
  if (!micBusy) $('#micLbl').textContent = listening ? 'Listening' : 'Start';
  if (!listening) $('#micDot').style.transform = '';
  $('#offScript').hidden = !(listening && follower.off);
}

async function startListening() {
  if (listening || micBusy) return;
  if (!model || !model.N) { toast('Open a script first.'); return; }
  if (mode !== 'read') setMode('read');
  if (sound) { resumeAfterSound = false; setSound(false); }
  stopTTS();
  micBusy = true; renderMic();
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
    micBusy = false; renderMic(); closeLoad();
    const msg = err && err.name === 'NotAllowedError' ? 'Mic permission was refused. Allow it in the browser’s site settings, then try again.' : (err && err.message) || String(err);
    toast(msg, 5000);
    return;
  }
  closeLoad();
  engine = eng;
  micBusy = false; listening = true;
  follower.commit(); follower.anchor = follower.pos; follower.segSkip = 0; follower.segLen = 0;
  setFollow(true);
  renderMic(); wantAwake();
  userScrollUntil = 0; scrollToCurrent(true);
}

function stopListening() {
  if (engine) engine.stop();
  const was = listening;
  listening = false; micBusy = false;
  follower.commit(); follower.off = false;
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
}
function clearVideo() {
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = null;
  video.removeAttribute('src'); video.load();
  document.body.classList.add('no-video');
  if (model) model.times = computeTimes(model, NaN);
}
video.addEventListener('loadedmetadata', () => {
  if (model) model.times = computeTimes(model, video.duration);
  updateVTime();
  if (model && !model.anchors.length) toast('No timestamps in this script, so the video is spread evenly across it.');
  seekVideoToPos();
});
video.addEventListener('timeupdate', () => { updateVTime(); markVideoSpot(); });
video.addEventListener('play', () => { renderPlay(); wantAwake(); });
video.addEventListener('pause', () => { renderPlay(); wantAwake(); });
function updateVTime() { $('#vTime').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`; }
function renderPlay() { const playing = !video.paused; $('#icoPlay').hidden = playing; $('#icoPause').hidden = !playing; $('#vPlay').setAttribute('aria-label', playing ? 'Pause' : 'Play'); }

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
  $('#icoWaves').hidden = !on; $('#icoMute').hidden = on;
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
function tick() {
  requestAnimationFrame(tick);
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
  if (label !== lastRateShown) { $('#vRate').textContent = label; $('#vRate').hidden = false; lastRateShown = label; }
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

// resize the video by dragging the bar above it
(() => {
  const grip = $('#grip');
  let drag = null;
  grip.addEventListener('pointerdown', (e) => { drag = { y: e.clientY, h: $('#videoPane').getBoundingClientRect().height }; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const h = Math.max(120, Math.min(window.innerHeight * 0.75, drag.h + (drag.y - e.clientY)));
    document.documentElement.style.setProperty('--video-h', Math.round(h) + 'px');
    settings.videoH = Math.round(h);
  });
  const end = () => { if (drag) { drag = null; saveSettings(); } };
  grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
})();

// ---------- listen mode (TTS) ----------
function stopTTS() {
  if (!tts && !speaker.busy) return;
  speaker.stop();
  tts = null;
  updateClasses(); wantAwake();
}
function speakFrom(ti) {
  if (!Speaker.supported()) { toast('This browser can’t read text aloud.'); return; }
  const tok = model.tokens[ti];
  if (!tok || tok.sent < 0) return;
  let sents = settings.ttsUnit === 'para' ? model.sentences.filter((s) => s.pid === tok.pid) : [model.sentences[tok.sent]];
  sents = sents.filter(Boolean);
  if (!sents.length) return;
  if (tts && tts.t0 === sents[0].t0 && speaker.busy) { stopTTS(); return; }
  const chunks = sents.map((s) => {
    let text = '';
    const starts = [], words = [], syl = [];
    for (let t = s.t0; t < s.t1; t++) {
      const tk = model.tokens[t];
      if (!tk.spoken) continue;
      if (text) text += ' ';
      starts.push(text.length); text += tk.text; words.push(t);
      let n = 0; for (let u = tk.u0; u < tk.u1; u++) n += model.units[u].syl; syl.push(n);
    }
    return { text, starts, words, syl };
  }).filter((c) => c.words.length);
  if (sound) setSound(false);
  tts = { t0: sents[0].t0, t1: sents[sents.length - 1].t1, cur: -1, tracker: new RateTracker() };
  follower.jumpTo(model.tokens[tts.t0].u0, false);
  if (hasVideo()) { setFollow(true); }
  speaker.speak(chunks, { voiceURI: settings.voiceURI, rate: settings.ttsRate }, {
    word: (t) => { if (!tts) return; tts.cur = t; tts.tracker.push(model.tokens[t].u0); updateClasses(); keepInView(tokEls[t], false); },
    end: () => { tts = null; updateClasses(); wantAwake(); },
  });
  updateClasses(); wantAwake();
}

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
  stopListening(); stopTTS();
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
$('#btnMic').onclick = () => { if (listening || micBusy) stopListening(); else startListening(); };

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

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (listening) stopListening(); stopTTS(); saveProject(); }
  else wantAwake();
});

// ---------- dialogs ----------
for (const d of document.querySelectorAll('dialog')) {
  d.addEventListener('click', (e) => { if (e.target === d && d.id !== 'dlgLoad') d.close(); });
  const c = d.querySelector('[data-close]');
  if (c) c.onclick = () => d.close();
}
function openLoad(title, text) { $('#lTitle').textContent = title; $('#lText').textContent = text; $('#lBar').style.width = '0%'; if (!$('#dlgLoad').open) $('#dlgLoad').showModal(); }
function closeLoad() { if ($('#dlgLoad').open) $('#dlgLoad').close(); }
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
$('#btnFiles').onclick = () => { renderFiles(); $('#dlgFiles').showModal(); };
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

function fillVoices() {
  const sel = $('#selVoice');
  const vs = englishVoices();
  sel.textContent = '';
  const def = document.createElement('option'); def.value = ''; def.textContent = 'Tablet default'; sel.appendChild(def);
  for (const v of vs) { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = `${v.name}${v.localService ? '' : ' (online)'}`; sel.appendChild(o); }
  sel.value = vs.some((v) => v.voiceURI === settings.voiceURI) ? settings.voiceURI : '';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', fillVoices);

async function syncSettingsUI() {
  $('#sText').value = settings.textSize; $('#oText').textContent = settings.textSize + ' px';
  $('#selSaid').value = settings.said; $('#selGuide').value = settings.guide; $('#selSpan').value = settings.span;
  $('#selTheme').value = settings.theme; $('#selEngine').value = settings.engine; $('#selMic').value = settings.micSource;
  $('#selMarks').value = settings.marks; $('#selUnit').value = settings.ttsUnit;
  $('#sRate').value = settings.ttsRate; $('#oRate').textContent = '×' + (+settings.ttsRate).toFixed(2);
  $('#engineNote').textContent = settings.engine === 'google'
    ? 'Google: sends your audio to Google for recognition and needs internet.'
    : 'On tablet: your voice stays on the tablet. The first start downloads a 41 MB speech model once.';
  fillVoices();
  const cached = await modelIsCached();
  $('#aboutLine').textContent = `VO Prompter ${VERSION} · speech model ${cached ? 'downloaded' : 'not downloaded yet'}`;
}
$('#btnSettings').onclick = () => { syncSettingsUI(); $('#dlgSettings').showModal(); };
const bindSel = (id, key, after) => { $(id).onchange = (e) => { settings[key] = e.target.value; saveSettings(); applySettings(); updateClasses(); syncSettingsUI(); if (after) after(); }; };
$('#sText').oninput = (e) => { settings.textSize = +e.target.value; $('#oText').textContent = settings.textSize + ' px'; applySettings(); };
$('#sText').onchange = () => { saveSettings(); scrollToCurrent(true); };
bindSel('#selSaid', 'said'); bindSel('#selGuide', 'guide'); bindSel('#selSpan', 'span'); bindSel('#selTheme', 'theme');
bindSel('#selMarks', 'marks');
bindSel('#selEngine', 'engine', () => { if (listening) { stopListening(); startListening(); } });
bindSel('#selMic', 'micSource', () => { if (listening) { stopListening(); startListening(); } });
bindSel('#selUnit', 'ttsUnit'); bindSel('#selVoice', 'voiceURI');
$('#sRate').oninput = (e) => { settings.ttsRate = +e.target.value; $('#oRate').textContent = '×' + settings.ttsRate.toFixed(2); };
$('#sRate').onchange = saveSettings;
$('#btnTestVoice').onclick = () => {
  if (!Speaker.supported()) { toast('This browser can’t read text aloud.'); return; }
  speaker.speak([{ text: 'This is how the voice sounds at this speed.', starts: [0], words: [-1], syl: [12] }], { voiceURI: settings.voiceURI, rate: settings.ttsRate }, {});
};

// ---------- uninstall ----------
$('#btnWipe').onclick = () => confirmDo('Remove all app data?', 'Deletes every script, edit, video and setting from this tablet, plus the downloaded speech model. This can’t be undone.', 'Remove everything', async () => {
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
