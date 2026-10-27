// Collects mic audio in 50 ms blocks and posts them (with a level reading) to the page.
class VopCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = Math.round(sampleRate * 0.05);
    this.buf = new Float32Array(this.n);
    this.i = 0;
    this.sum = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let k = 0; k < ch.length; k++) {
        const x = ch[k];
        this.buf[this.i++] = x;
        this.sum += x * x;
        if (this.i === this.n) {
          const pcm = this.buf;
          this.port.postMessage({ pcm, rms: Math.sqrt(this.sum / this.n) }, [pcm.buffer]);
          this.buf = new Float32Array(this.n);
          this.i = 0;
          this.sum = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('vop-capture', VopCapture);
