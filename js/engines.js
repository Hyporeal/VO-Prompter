// Speech engines. Both report text through cb.partial(text) (the utterance so far) and cb.final(text).
//   OnDeviceEngine: Vosk running in the browser. Audio never leaves the tablet; works offline after the first load.
//   GoogleEngine:   Chrome's built-in recognition. Sends audio to Google; needs internet.

export const MODEL_URL = 'models/vosk-model-small-en-us-0.15.tar.gz';
export const MODEL_CACHE = 'vo-prompter-model-v1';
const MODEL_BYTES = 41205354;

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

async function modelBlobUrl(onProgress) {
  let cache = null;
  try { cache = await caches.open(MODEL_CACHE); } catch (e) { /* no Cache API */ }
  if (cache) {
    const hit = await cache.match(MODEL_URL);
    if (hit) return URL.createObjectURL(await hit.blob());
  }
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error('Couldn’t download the speech model (' + r.status + ')');
  const total = +r.headers.get('content-length') || MODEL_BYTES;
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress && onProgress({ phase: 'download', frac: Math.min(1, got / total) });
  }
  let blob = new Blob(chunks, { type: 'application/gzip' });
  // If the server unzipped it in transit, zip it again: the engine expects a .tar.gz
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (!(head[0] === 0x1f && head[1] === 0x8b) && 'CompressionStream' in window) {
    blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob();
    blob = new Blob([blob], { type: 'application/gzip' });
  }
  if (cache) { try { await cache.put(MODEL_URL, new Response(blob)); } catch (e) { /* storage full: works this session */ } }
  return URL.createObjectURL(blob);
}

export async function modelIsCached() {
  try { const c = await caches.open(MODEL_CACHE); return !!(await c.match(MODEL_URL)); } catch (e) { return false; }
}

// ---------- mic ----------
// Bluetooth earbuds switch to phone-call mode when their mic is used, so prefer the tablet's own mic.
const NOT_BUILTIN = /bluetooth|\bbt\b|sco|hands-?free|buds|liberty|anker|airpods|usb|wired/i;
async function findBuiltInMic() {
  try {
    const ins = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.label && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    const ok = ins.filter((d) => !NOT_BUILTIN.test(d.label));
    const pick = ok.find((d) => /speakerphone|built-?in|internal|bottom|microphone/i.test(d.label)) || ok.find((d) => !/headset/i.test(d.label) || /earpiece/i.test(d.label));
    return pick ? pick.deviceId : null;
  } catch (e) { return null; }
}
function openStream(deviceId) {
  const audio = { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return navigator.mediaDevices.getUserMedia({ audio });
}
async function openMic(source) {
  let stream;
  if (source === 'builtin') {
    let id = await findBuiltInMic();
    try { stream = await openStream(id); } catch (e) { if (!id) throw e; stream = await openStream(null); }
    const label = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : '';
    if (!id && NOT_BUILTIN.test(label)) {
      id = await findBuiltInMic();
      if (id) { stream.getTracks().forEach((t) => t.stop()); stream = await openStream(id); }
    }
  } else stream = await openStream(null);
  const tr = stream.getAudioTracks()[0];
  return { stream, label: tr ? tr.label : '' };
}
// Chrome on Android leaves Bluetooth earbuds in call mode after their mic closes. Opening the built-in
// mic for a moment hands the "communication device" back so the earbuds return to normal audio.
async function resetCallMode() {
  try {
    const id = await findBuiltInMic();
    if (id) { const s = await openStream(id); await new Promise((r) => setTimeout(r, 200)); s.getTracks().forEach((t) => t.stop()); }
  } catch (e) { /* mic unavailable */ }
}

export class OnDeviceEngine {
  constructor(cb) { this.cb = cb; this.model = null; this.loading = null; this.active = false; }
  get name() { return 'On tablet'; }
  async load(onProgress) {
    if (this.model) return this.model;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      await loadScript('vendor/vosk.js');
      const url = await modelBlobUrl(onProgress);
      onProgress && onProgress({ phase: 'init' });
      const model = await Promise.race([
        window.Vosk.createModel(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('The speech model took too long to start')), 180000)),
      ]);
      URL.revokeObjectURL(url);
      this.model = model;
      return model;
    })();
    try { return await this.loading; } finally { this.loading = null; }
  }
  async start(opts) {
    await this.load(opts.onProgress);
    const { stream, label } = await openMic(opts.micSource);
    this.stream = stream; this.micLabel = label; this.usedNonBuiltin = opts.micSource !== 'builtin' || NOT_BUILTIN.test(label);
    try { await this.startAudio(stream); } catch (e) { this.stop(); throw e; } // never leave the mic open after a failed start
  }
  async startAudio(stream) {
    let ctx;
    try { ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' }); } catch (e) { ctx = new AudioContext({ latencyHint: 'interactive' }); }
    let src;
    try { src = ctx.createMediaStreamSource(stream); } catch (e) {
      ctx.close(); ctx = new AudioContext({ latencyHint: 'interactive' }); src = ctx.createMediaStreamSource(stream);
    }
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('capture-worklet.js');
    const node = new AudioWorkletNode(ctx, 'vop-capture');
    const sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(node).connect(sink).connect(ctx.destination);
    const rec = new this.model.KaldiRecognizer(ctx.sampleRate);
    this.rec = rec;
    let lastPartial = '';
    rec.on('partialresult', (m) => {
      const t = m.result && m.result.partial;
      if (t && t !== lastPartial) { lastPartial = t; this.cb.partial(t); }
    });
    rec.on('result', (m) => { lastPartial = ''; const t = m.result && m.result.text; this.cb.final(t || ''); });
    rec.on('error', (m) => this.cb.error && this.cb.error(String(m.error || 'Speech error')));
    node.port.onmessage = (e) => {
      if (!this.active) return;
      try { rec.acceptWaveformFloat(e.data.pcm, ctx.sampleRate); } catch (err) { /* worker gone */ }
      this.cb.level && this.cb.level(e.data.rms);
    };
    this.node = node;
    await ctx.resume();
    this.active = true;
  }
  stop() {
    const wasActive = this.active;
    this.active = false;
    if (this.node) { this.node.port.onmessage = null; this.node = null; }
    if (this.rec) {
      const rec = this.rec; this.rec = null;
      try { rec.retrieveFinalResult(); } catch (e) { /* ignore */ }
      setTimeout(() => { try { rec.remove(); } catch (e) { /* ignore */ } }, 1500);
    }
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null; }
    if (wasActive && this.usedNonBuiltin) resetCallMode();
  }
  unload() { this.stop(); if (this.model) { try { this.model.terminate(); } catch (e) { /* ignore */ } this.model = null; } }
}

export class GoogleEngine {
  constructor(cb) { this.cb = cb; this.active = false; }
  get name() { return 'Google'; }
  static supported() { return !!(window.SpeechRecognition || window.webkitSpeechRecognition); }
  async start() {
    if (!GoogleEngine.supported()) throw new Error('This browser doesn’t offer Google speech recognition.');
    this.active = true;
    this.make();
  }
  make() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    r.lang = 'en-US'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    let done = 0, interimText = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) {
          if (i >= done) { done = i + 1; interimText = ''; this.cb.final(res[0].transcript); }
        } else if (i >= done) interim += ' ' + res[0].transcript;
      }
      interim = interim.trim();
      if (interim && interim !== interimText) { interimText = interim; this.cb.partial(interim); }
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { this.active = false; this.cb.error && this.cb.error('Mic permission was refused. Allow it in the browser’s site settings, then try again.'); }
      else if (e.error === 'network') this.cb.error && this.cb.error('Google speech needs an internet connection.');
    };
    r.onend = () => {
      if (interimText) { this.cb.final(interimText); interimText = ''; }
      if (this.active) setTimeout(() => { if (this.active) this.make(); }, 150);
      else this.cb.ended && this.cb.ended();
    };
    try { r.start(); } catch (e) { /* already started */ }
    this.r = r;
  }
  stop() { this.active = false; try { this.r && this.r.stop(); } catch (e) { /* ignore */ } }
  unload() { this.stop(); }
}
