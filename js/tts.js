// Listen mode: reads sentences aloud with the tablet's voices and reports which word it's on.
// Word timing comes from the voice when it reports it; otherwise it's estimated from syllables.

// optional debug log (Settings → Debug log); a no-op unless switched on
export let dbg = () => {};
export function setDebug(fn) { dbg = fn || (() => {}); }

export function englishVoices() {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang))
    .sort((a, b) => (b.localService - a.localService) || a.name.localeCompare(b.name));
}

export class Speaker {
  constructor() { this.busy = false; this.gen = 0; this.timer = null; }
  static supported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }

  // chunks: [{ text, starts: [char offset per word], words: [word id], syl: [syllables per word] }]
  speak(chunks, opts, cb) {
    this.stop();
    const gen = ++this.gen;
    this.busy = true;
    const voice = englishVoices().find((v) => v.voiceURI === opts.voiceURI);
    const rate = opts.rate || 1;
    const next = (k) => {
      if (gen !== this.gen) return;
      if (k >= chunks.length) { this.busy = false; cb.end && cb.end(); return; }
      const c = chunks[k];
      const u = new SpeechSynthesisUtterance(c.text);
      if (voice) { u.voice = voice; u.lang = voice.lang; } else u.lang = 'en-US';
      u.rate = rate;
      let gotBoundary = false, started = 0, wi = -1;
      const totalSyl = c.syl.reduce((a, b) => a + b, 0) || 1;
      const setWord = (i) => { if (i !== wi && i >= 0 && i < c.words.length) { wi = i; cb.word && cb.word(c.words[i], k); } };
      dbg('voice', `say #${k} start · ${voice ? voice.name + (voice.localService ? ' (local)' : ' (online)') : 'default ' + u.lang} · rate ${rate}`);
      u.onstart = () => {
        dbg('voice', `#${k} started`);
        started = performance.now();
        setWord(0);
        clearInterval(this.timer);
        this.timer = setInterval(() => {
          if (gen !== this.gen || gotBoundary) return;
          const el = (performance.now() - started) / 1000;
          const est = (el * 4.3 * rate) / totalSyl; // ~4.3 syllables/s at normal speed
          let acc = 0, i = 0;
          for (; i < c.syl.length; i++) { acc += c.syl[i]; if (acc / totalSyl > est) break; }
          setWord(Math.min(i, c.words.length - 1));
        }, 80);
      };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        gotBoundary = true;
        let lo = 0, hi = c.starts.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (c.starts[mid] <= e.charIndex) lo = mid; else hi = mid - 1; }
        setWord(lo);
      };
      const done = () => { clearInterval(this.timer); if (gen === this.gen) setTimeout(() => next(k + 1), 30); };
      let bounds = 0;
      u.addEventListener('boundary', () => { if (++bounds === 1) dbg('voice', `#${k} first word boundary`); });
      u.onend = () => { dbg('voice', `#${k} ended · ${bounds} word boundaries`); done(); };
      u.onerror = (e) => { dbg('voice', `#${k} error ${e.error}`); if (e.error !== 'interrupted' && e.error !== 'canceled') done(); };
      speechSynthesis.speak(u);
    };
    // Chrome sometimes drops an utterance queued right after cancel()
    setTimeout(() => next(0), 60);
  }

  stop() {
    this.gen++;
    clearInterval(this.timer);
    if (this.busy) { this.busy = false; try { speechSynthesis.cancel(); } catch (e) { /* ignore */ } }
  }
}
