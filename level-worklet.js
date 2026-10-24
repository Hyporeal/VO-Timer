// Posts one RMS level (dBFS) per ~10 ms block, stamped with the block's start
// time on the audio clock.
class LevelProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = Math.round(sampleRate * 0.01);
    this.sum = 0;
    this.count = 0;
    this.blockStart = null;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.blockStart === null) this.blockStart = currentFrame;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i] * ch[i];
      this.count++;
      if (this.count >= this.block) {
        const rms = Math.sqrt(this.sum / this.count);
        this.port.postMessage({ t: this.blockStart / sampleRate, db: 20 * Math.log10(rms + 1e-9), f: this.count / sampleRate });
        this.blockStart = currentFrame + i + 1;
        this.sum = 0;
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor('level-processor', LevelProcessor);
