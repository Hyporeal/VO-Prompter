// Your own voice-over in Listen mode. Add a recording of your read (any audio file the browser can play, e.g. a
// WAV or MP3 export of the finished VO); the on-device speech engine finds when each script word is said in it
// (offline; nothing is uploaded). Listen can then play your recording for every sentence it covers, with the guide
// following the words. Recordings added later win where they overlap, so a pickup session replaces those lines.
import { hypKeys } from './parse.js';
import { align, sim } from './follow.js';

// ---------- 1) find the words and their times in a recording ----------
export async function recognizeFile(file, model, onProgress, cancelled) {
  const buf = await file.arrayBuffer();
  let audio;
  try { audio = await new OfflineAudioContext(1, 16000, 16000).decodeAudioData(buf); }
  catch (e) { throw new Error('This device can’t open that audio file. Try a WAV, MP3 or M4A export.'); }
  const pcm = audio.getChannelData(0), dur = audio.duration;
  const rec = new model.KaldiRecognizer(16000);
  rec.setWords(true);
  const words = [];
  let events = 0;
  rec.on('result', (m) => {
    events++;
    const r = m.result;
    if (r && r.result) for (const w of r.result) words.push([w.word, +w.start.toFixed(2), +w.end.toFixed(2)]);
  });
  rec.on('partialresult', () => { events++; });
  // one event comes back per piece of audio, plus one for the final result
  const N = 8000;
  let fed = 0;
  for (let i = 0; i < pcm.length; i += N) { rec.acceptWaveformFloat(pcm.slice(i, i + N), 16000); fed++; }
  rec.retrieveFinalResult();
  await new Promise((resolve, reject) => {
    const iv = setInterval(() => {
      onProgress && onProgress(Math.min(1, events / (fed + 1)));
      if (cancelled && cancelled()) { clearInterval(iv); reject(new Error('cancelled')); }
      if (events >= fed + 1) { clearInterval(iv); resolve(); }
    }, 250);
  });
  try { rec.remove(); } catch (e) { /* ignore */ }
  return { words, duration: dur };
}

// ---------- 2) line the words up with the script ----------
// Returns Float32Array [start, end] per script unit (NaN where the recording doesn't have it). Works utterance by
// utterance (words separated by pauses), each placed near where the previous one ended, or found anywhere in the
// script when it doesn't fit there (the first line, a skipped section, a pickup further back). When a passage is
// read more than once (pickups), the last reading wins.
export function mapRecording(m, words) {
  const N = m.N, times = new Float32Array(N * 2).fill(NaN);
  if (!words.length) return times;
  // utterances: split at pauses of 0.35 s or more
  const utts = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    if (cur.length && words[i][1] - words[i - 1][2] >= 0.35) { utts.push(cur); cur = []; }
    cur.push(words[i]);
  }
  if (cur.length) utts.push(cur);
  let pos = -1;
  for (const u of utts) {
    // heard keys, each with its time
    const h = [], ht = [];
    for (const [w, s, e] of u) { const ks = hypKeys(w); ks.forEach((k, j) => { h.push(k); ht.push([s + (e - s) * j / ks.length, s + (e - s) * (j + 1) / ks.length]); }); }
    if (!h.length) continue;
    let best = null;
    const tryAt = (a0, win) => {
      const r = align(m.units, Math.max(0, a0), h, { freeLead: true, window: win });
      if (r && r.first >= 0 && (!best || r.score > best.score)) best = r;
    };
    if (pos >= 0) tryAt(pos - 40, h.length + 80);
    if (!best || best.matches < Math.max(2, h.length * 0.5)) {
      // look anywhere: start where rarer heard words occur in the script
      const votes = new Map();
      h.forEach((k, j) => {
        const list = m.index.get(k);
        if (!list || list.length > 60 || k.length < 4) return;
        for (const x of list) votes.set(x - j, (votes.get(x - j) || 0) + 1);
      });
      [...votes].sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([c]) => tryAt(c - 5, h.length + 25));
    }
    if (!best || best.matches < 2) continue;
    for (let i = 1; i <= h.length; i++) {
      const un = best.hypUnit[i];
      if (un < 0 || sim(h[i - 1], m.units[un].key) < 0.6) continue;
      times[un * 2] = ht[i - 1][0]; times[un * 2 + 1] = ht[i - 1][1];
    }
    pos = best.end;
  }
  // fill single missing words inside covered stretches (misheard or dropped by the recognizer) by spreading time
  for (let un = 1; un < N - 1; un++) {
    if (!isNaN(times[un * 2])) continue;
    let a = un - 1, b = un + 1;
    while (b < N && isNaN(times[b * 2]) && b - un < 4) b++;
    if (isNaN(times[a * 2]) || b >= N || isNaN(times[b * 2])) continue;
    const t0 = times[a * 2 + 1], t1 = times[b * 2];
    if (!(t1 > t0) || t1 - t0 > 3) continue;
    const n = b - a - 1;
    for (let k = 0; k < n; k++) { times[(un + k) * 2] = t0 + (t1 - t0) * k / n; times[(un + k) * 2 + 1] = t0 + (t1 - t0) * (k + 1) / n; }
    un = b - 1;
  }
  return times;
}

// Share of the script's units a recording covers, and the sentences it covers (first-last index), for the list.
export function coverage(m, times) {
  let n = 0, first = -1, last = -1;
  for (let u = 0; u < m.N; u++) if (!isNaN(times[u * 2])) { n++; if (first < 0) first = u; last = u; }
  const sentOf = (u) => m.tokens[m.units[u].ti].sent;
  return { frac: n / Math.max(1, m.N), firstSent: first >= 0 ? sentOf(first) : -1, lastSent: last >= 0 ? sentOf(last) : -1 };
}

// ---------- 3) play it ----------
// Same interface as the other speakers. opts.takes: [{ url, times }] newest last; opts.fallback: { speaker, opts }
// is used for sentences no recording covers.
export class VoSpeaker {
  constructor() { this.gen = 0; this.busy = false; this.audio = new Audio(); this.audio.preload = 'auto'; this.fb = null; this.timer = null; }
  stop() {
    this.gen++;
    clearInterval(this.timer);
    try { this.audio.pause(); } catch (e) { /* ignore */ }
    if (this.fb) { this.fb.stop(); this.fb = null; }
    this.busy = false;
  }
  // the newest recording that has (nearly) all of this sentence
  pick(takes, m, words) {
    const units = words.map((t) => m.tokens[t].u0);
    for (let i = takes.length - 1; i >= 0; i--) {
      const tm = takes[i].times;
      const have = units.filter((u) => !isNaN(tm[u * 2])).length;
      if (have >= Math.max(1, units.length * 0.8) && !isNaN(tm[units[0] * 2]) && !isNaN(tm[units[units.length - 1] * 2 + 1])) return { take: takes[i], units };
    }
    return null;
  }
  async speak(chunks, opts, cb) {
    this.stop();
    const gen = ++this.gen;
    this.busy = true;
    const m = opts.model, a = this.audio;
    const finish = () => { if (gen === this.gen) { this.busy = false; clearInterval(this.timer); try { a.pause(); } catch (e) { /* ignore */ } cb.end && cb.end(); } };
    for (let k = 0; k < chunks.length; k++) {
      if (gen !== this.gen) return;
      const c = chunks[k];
      const hit = this.pick(opts.takes, m, c.words);
      if (!hit) {
        // no recording of this sentence: the chosen voice reads it
        const fb = opts.fallback;
        if (!fb) continue;
        this.fb = fb.speaker;
        await new Promise((resolve) => fb.speaker.speak([c], fb.opts, { word: (w) => cb.word && cb.word(w, k), end: resolve, error: (msg) => { cb.error && cb.error(msg); resolve(); }, progress: cb.progress }));
        this.fb = null;
        continue;
      }
      const tm = hit.take.times, us = hit.units;
      const starts = us.map((u) => tm[u * 2]);
      const t0 = Math.max(0, starts[0] - 0.12);
      let lastEnd = tm[us[us.length - 1] * 2 + 1];
      for (const u of us) if (tm[u * 2 + 1] > lastEnd) lastEnd = tm[u * 2 + 1];
      const t1 = lastEnd + 0.25;
      if (a.src !== hit.take.url) { a.src = hit.take.url; }
      a.playbackRate = opts.rate || 1;
      // keep playing straight on when the next sentence follows right after in the same recording
      const continuing = !a.paused && Math.abs(a.currentTime - t0) < 0.6;
      if (!continuing) {
        a.currentTime = t0;
        try { await a.play(); } catch (e) { cb.error && cb.error('Couldn’t play your recording: ' + (e.message || e)); finish(); return; }
      }
      cb.word && cb.word(c.words[0], k);
      await new Promise((resolve) => {
        let wi = -1;
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          if (gen !== this.gen) { clearInterval(this.timer); resolve(); return; }
          const t = a.currentTime;
          let i = 0;
          while (i + 1 < starts.length && !(starts[i + 1] > t) ) i++;
          // skip words that have no time (rare); keep the last one that started
          if (i !== wi) { wi = i; cb.word && cb.word(c.words[i], k); }
          if (t >= t1 || a.ended) { clearInterval(this.timer); resolve(); }
        }, 40);
      });
      if (gen !== this.gen) return;
      const nx = chunks[k + 1] && this.pick(opts.takes, m, chunks[k + 1].words);
      const nextT0 = nx && nx.take === hit.take ? nx.take.times[nx.units[0] * 2] - 0.12 : -1;
      if (!(nextT0 >= 0 && nextT0 - a.currentTime < 0.6 && nextT0 - a.currentTime > -0.3)) a.pause();
    }
    finish();
  }
}
