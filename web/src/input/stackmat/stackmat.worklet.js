// The AudioWorklet behind the stackmat / MoYu timer input (src/input/stackmat/audio.ts): collects
// 1024 microphone samples at a time and hands them to the page, off the main thread. A plain file
// (imported with ?url) rather than a blob: URL, so the Content-Security-Policy can keep scripts to
// cubr.dev's own files.
class CubrStackmat extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch)
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf);
          this.buf = new Float32Array(1024);
          this.n = 0;
        }
      }
    return true;
  }
}
registerProcessor('cubr-stackmat', CubrStackmat);
