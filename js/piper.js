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
const HF = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/';
export const VOICE_CACHE = 'vo-prompter-voices-v1';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.dataset.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Couldn’t load ' + src));
    document.head.appendChild(s);
  });
}

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open(VOICE_CACHE); } catch (e) { /* no Cache API */ }
  if (cache) { const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); }
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
  try { const c = await caches.open(VOICE_CACHE); return !!(await c.match(HF + v.path + '/' + v.id + '.onnx')); } catch (e) { return false; }
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
  const base = HF + v.path + '/' + v.id + '.onnx';
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

// Same interface as the Android-voice Speaker in tts.js.
export class PiperSpeaker {
  constructor() { this.gen = 0; this.busy = false; this.ctx = null; this.src = null; this.timer = null; }
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
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    const rate = opts.rate || 1;
    let next = synth(voice, chunks[0].text, rate);
    for (let k = 0; k < chunks.length; k++) {
      let res;
      try { res = await next; } catch (e) { cb.error && cb.error('The voice couldn’t read that: ' + (e.message || e)); finish(); return; }
      if (gen !== this.gen) return;
      if (k + 1 < chunks.length) next = synth(voice, chunks[k + 1].text, rate);
      const c = chunks[k];
      const buf = this.ctx.createBuffer(1, res.pcm.length, res.sr);
      buf.copyToChannel(res.pcm, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buf; src.connect(this.ctx.destination);
      this.src = src;
      const t0 = this.ctx.currentTime + 0.03;
      const dur = buf.duration, lead = Math.min(0.15, dur * 0.05), speech = Math.max(0.1, dur - lead - 0.2);
      const total = c.syl.reduce((a, b) => a + b, 0) || 1;
      let wi = -1;
      const onTick = () => {
        if (gen !== this.gen) return;
        const el = this.ctx.currentTime - t0 - lead;
        let acc = 0, i = 0;
        for (; i < c.syl.length; i++) { acc += c.syl[i]; if (acc / total > el / speech) break; }
        i = Math.max(0, Math.min(i, c.words.length - 1));
        if (i !== wi) { wi = i; cb.word && cb.word(c.words[i], k); }
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
