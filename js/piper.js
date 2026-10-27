// Natural voices for Listen mode: Piper neural voices running on the tablet
// (onnxruntime-web for the voice, an espeak-ng build for pronunciation). A voice downloads once (about 60 MB)
// from the Piper voice library and is kept on the tablet; after that it works offline. Nothing is uploaded.

export const PIPER_VOICES = [
  { id: 'en_US-ryan-medium', name: 'Ryan (US, male)', path: 'en/en_US/ryan/medium' },
  { id: 'en_US-lessac-medium', name: 'Lessac (US, female)', path: 'en/en_US/lessac/medium' },
  { id: 'en_US-joe-medium', name: 'Joe (US, male)', path: 'en/en_US/joe/medium' },
  { id: 'en_US-john-medium', name: 'John (US, male)', path: 'en/en_US/john/medium' },
  { id: 'en_US-norman-medium', name: 'Norman (US, male)', path: 'en/en_US/norman/medium' },
  { id: 'en_US-hfc_male-medium', name: 'HFC (US, male)', path: 'en/en_US/hfc_male/medium' },
  { id: 'en_US-kristin-medium', name: 'Kristin (US, female)', path: 'en/en_US/kristin/medium' },
  { id: 'en_US-amy-medium', name: 'Amy (US, female)', path: 'en/en_US/amy/medium' },
  { id: 'en_US-hfc_female-medium', name: 'HFC (US, female)', path: 'en/en_US/hfc_female/medium' },
  { id: 'en_GB-alan-medium', name: 'Alan (UK, male)', path: 'en/en_GB/alan/medium' },
  { id: 'en_GB-cori-medium', name: 'Cori (UK, female)', path: 'en/en_GB/cori/medium' },
];
// A fixed revision of the Piper voice library (its v1.0.0 release), so a downloaded voice never changes.
// Voices saved by earlier versions used the library's "main" address; those copies are still used.
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/375a0fe641dea077c2a47b4e9a056d6da521eed3/';
const HF_OLD = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
export const VOICE_CACHE = 'vo-prompter-voices-v1';

// Loads a script once; a failed load is removed so the next attempt really retries.
const scriptLoads = new Map();
function loadScript(src) {
  if (scriptLoads.has(src)) return scriptLoads.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src;
    s.onload = resolve;
    s.onerror = () => { s.remove(); scriptLoads.delete(src); reject(new Error('Couldn’t load ' + src + '. Check the connection and try again.')); };
    document.head.appendChild(s);
  });
  scriptLoads.set(src, p);
  return p;
}

async function cachedFetch(path, onProgress) {
  const url = HF + path;
  let cache = null;
  try { cache = await caches.open(VOICE_CACHE); } catch (e) { /* no Cache API */ }
  if (cache) { const hit = (await cache.match(url)) || (await cache.match(HF_OLD + path)); if (hit) return hit.arrayBuffer(); }
  const r = await fetch(url);
  if (!r.ok) throw new Error('Couldn’t download the voice (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    if (onProgress && total) onProgress(Math.min(1, got / total));
  }
  const blob = new Blob(chunks);
  if (cache) { try { await cache.put(url, new Response(blob)); } catch (e) { /* storage full */ } }
  return blob.arrayBuffer();
}

export async function voiceIsDownloaded(id) {
  const v = PIPER_VOICES.find((x) => x.id === id);
  if (!v) return false;
  const path = v.path + '/' + v.id + '.onnx';
  try { const c = await caches.open(VOICE_CACHE); return !!((await c.match(HF + path)) || (await c.match(HF_OLD + path))); } catch (e) { return false; }
}

let ortP = null;
function getOrt() {
  if (!ortP) {
    ortP = loadScript('vendor/ort/ort.wasm.min.js').then(() => {
      const ort = window.ort;
      ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
      ort.env.wasm.numThreads = 1;
      return ort;
    });
    ortP.catch(() => { ortP = null; });
  }
  return ortP;
}

// One espeak-ng instance, reused for every sentence.
let phonP = null;
function getPhonemizer() {
  if (!phonP) {
    phonP = (async () => {
      await loadScript('vendor/piper/piper_phonemize.js');
      let handler = null;
      const mod = await window.createPiperPhonemize({
        print: (d) => { if (handler) handler(d); },
        printErr: () => {},
        locateFile: (u) => new URL('vendor/piper/' + u.split('/').pop(), location.href).href,
      });
      let queue = Promise.resolve();
      return (text, voice) => {
        const job = queue.then(() => new Promise((resolve, reject) => {
          handler = (d) => { handler = null; try { resolve(JSON.parse(d).phoneme_ids); } catch (e) { reject(e); } };
          try { mod.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']); }
          catch (e) { handler = null; reject(e); }
        }));
        queue = job.catch(() => {});
        return job;
      };
    })();
    phonP.catch(() => { phonP = null; });
  }
  return phonP;
}

let loaded = null; // { id, session, config }
export async function loadVoice(id, onProgress) {
  if (loaded && loaded.id === id) return loaded;
  const v = PIPER_VOICES.find((x) => x.id === id) || PIPER_VOICES[0];
  const base = v.path + '/' + v.id + '.onnx';
  const [ort, , config, model] = await Promise.all([
    getOrt(), getPhonemizer(),
    cachedFetch(base + '.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
    cachedFetch(base, onProgress),
  ]);
  if (loaded && loaded.session) { try { loaded.session.release(); } catch (e) { /* ignore */ } }
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  loaded = { id: v.id, session, config };
  return loaded;
}

export async function synth(voice, text, rate = 1) {
  const ort = await getOrt();
  const phonemize = await getPhonemizer();
  const ids = await phonemize(text, voice.config.espeak.voice);
  const inf = voice.config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / rate, inf.noise_w ?? 0.8]), [3]),
  };
  if (voice.config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await voice.session.run(feeds);
  return { pcm: out.output.data, sr: voice.config.audio.sample_rate };
}

// Long sentences are spoken in pieces (split after commas, semicolons and colons), so the first sound comes
// sooner and slower devices can keep up. Each piece keeps its own word list for the guide.
function splitChunk(c) {
  const n = c.words.length;
  if (n <= 10 || !c.starts) return [c];
  const out = [];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const end = i + 1 < n ? c.starts[i + 1] : c.text.length;
    const w = c.text.slice(c.starts[i], end).trim();
    const breakHere = (/[,;:]["'”’)]*$/.test(w) && i - a + 1 >= 4 && n - i - 1 >= 3) || i - a + 1 >= 14;
    if (breakHere || i === n - 1) {
      const t0 = c.starts[a], t1 = end;
      out.push({ text: c.text.slice(t0, t1).trim(), words: c.words.slice(a, i + 1), syl: c.syl.slice(a, i + 1), starts: c.starts.slice(a, i + 1).map((x) => x - t0), part: true });
      a = i + 1;
    }
  }
  return out;
}

// Same interface as the device-voice Speaker in tts.js.
export class PiperSpeaker {
  constructor() { this.gen = 0; this.busy = false; this.ctx = null; this.src = null; this.timer = null; this.warm = null; }
  stop() {
    this.gen++;
    clearInterval(this.timer);
    if (this.src) { try { this.src.stop(); } catch (e) { /* already stopped */ } this.src = null; }
    this.busy = false;
  }
  async speak(chunks, opts, cb) {
    this.stop();
    const gen = ++this.gen;
    this.busy = true;
    const finish = () => { if (gen === this.gen) { this.busy = false; clearInterval(this.timer); cb.end && cb.end(); } };
    let voice;
    try { voice = await loadVoice(opts.voiceId, cb.progress); } catch (e) { cb.error && cb.error(e.message || String(e)); finish(); return; }
    if (gen !== this.gen) return;
    // the first run of a voice can come out garbled on some phones: synthesize a throwaway word first
    if (!this.warm || this.warm.id !== voice.id) {
      this.warm = { id: voice.id, p: synth(voice, 'Ready.', 1).catch(() => {}) };
    }
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    await this.warm.p;
    if (gen !== this.gen) return;
    const rate = opts.rate || 1;
    // pieces, with the sentence index each belongs to (cb.word reports the sentence index)
    const pieces = [];
    chunks.forEach((c, k) => { for (const p of splitChunk(c)) pieces.push({ ...p, k }); });
    // keep up to two pieces being prepared ahead of the one playing
    const pending = [];
    const want = (i) => { while (pending.length <= i && pending.length < pieces.length) { const pc = pieces[pending.length]; pending.push(synth(voice, pc.text, rate)); } };
    want(2);
    let firstStart = true;
    for (let k = 0; k < pieces.length; k++) {
      const c = pieces[k];
      cb.word && cb.word(c.words[0], c.k); // the guide moves on while the piece is still being prepared
      let res;
      try { res = await pending[k]; } catch (e) { cb.error && cb.error('The voice couldn’t read that: ' + (e.message || e)); finish(); return; }
      if (gen !== this.gen) return;
      want(k + 2);
      const buf = this.ctx.createBuffer(1, res.pcm.length, res.sr);
      buf.copyToChannel(res.pcm, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.ctx.destination);
      this.src = src;
      const t0 = this.ctx.currentTime + (firstStart ? 0.12 : 0.02);
      firstStart = false;
      const dur = buf.duration, lead = Math.min(0.15, dur * 0.05), speech = Math.max(0.1, dur - lead - (c.part ? 0.1 : 0.2));
      const total = c.syl.reduce((a, b) => a + b, 0) || 1;
      let wi = -1;
      const onTick = () => {
        if (gen !== this.gen) return;
        const el = this.ctx.currentTime - t0 - lead;
        let acc = 0, i = 0;
        for (; i < c.syl.length; i++) { acc += c.syl[i]; if (acc / total > el / speech) break; }
        i = Math.max(0, Math.min(i, c.words.length - 1));
        if (i !== wi) { wi = i; cb.word && cb.word(c.words[i], c.k); }
      };
      await new Promise((resolve) => {
        src.onended = resolve;
        src.start(t0);
        clearInterval(this.timer);
        this.timer = setInterval(onTick, 50);
        onTick();
      });
      clearInterval(this.timer);
      if (gen !== this.gen) return;
    }
    finish();
  }
}
