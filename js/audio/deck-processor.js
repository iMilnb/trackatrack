/**
 * Deck audio source: sample-accurate variable-speed reader of a preloaded buffer,
 * with looping. Runs inside an AudioWorklet.
 * messages:
 *   {cmd:'load', L, R, sr}            transfer two Float32Arrays
 *   {cmd:'pos', v}                    seek (sample index)
 * params: rate (a-rate, signed speed), play (k), loopOn (k), loopStart, loopEnd (k, samples)
 * posts:  {cmd:'pos', v} every 2nd quantum, {cmd:'ended'}
 */
class DeckProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "rate", defaultValue: 1, minValue: -8, maxValue: 8, automationRate: "a-rate" },
      { name: "play", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "loopOn", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
      { name: "loopStart", defaultValue: 0, minValue: 0, automationRate: "k-rate" },
      { name: "loopEnd", defaultValue: 0, minValue: 0, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.L = null; this.R = null; this.dur = 0;
    this.pos = 0; this.ended = false; this.tick = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.cmd === "load") {
        this.L = m.L; this.R = m.R; this.dur = m.L.length;
        this.pos = m.pos || 0; this.ended = false;
        this.port.postMessage({ cmd: "loaded", dur: this.dur });
      } else if (m.cmd === "pos") {
        this.pos = Math.max(0, Math.min(m.v, this.dur || m.v));
        this.ended = false;
      }
    };
  }
  process(inputs, outputs, params) {
    const out = outputs[0];
    const OL = out[0], OR = out[1];
    const L = this.L, R = this.R;
    if (!L) { OL.fill(0); OR.fill(0); return true; }
    const play = params.play[0];
    const loopOn = params.loopOn[0];
    const ls = params.loopStart[0], le = params.loopEnd[0];
    const len = le - ls;
    const rate = params.rate;
    const hasRateArr = rate.length > 1;
    let pos = this.pos;
    const dur = this.dur;
    for (let i = 0; i < 128; i++) {
      const r = hasRateArr ? rate[i] : rate[0];
      if (play > 0) {
        pos += r;
        if (loopOn > 0 && len > 0) {
          if (pos >= le) pos = ls + ((pos - ls) % len);
          else if (pos < ls) pos = le - ((le - pos) % len);
        } else if (pos >= dur) {
          pos = dur - 1;
          if (!this.ended) { this.ended = true; this.port.postMessage({ cmd: "ended" }); }
          OL.fill(0, i); OR.fill(0, i);
          break;
        } else if (pos <= 0 && r < 0) {
          pos = 0;
          if (!this.ended) { this.ended = true; this.port.postMessage({ cmd: "ended" }); }
          OL.fill(0, i); OR.fill(0, i);
          break;
        }
        const idx = pos | 0;
        const f = pos - idx;
        const i2 = idx + 1 < dur ? idx + 1 : idx;
        OL[i] = L[idx] + (L[i2] - L[idx]) * f;
        OR[i] = R[idx] + (R[i2] - R[idx]) * f;
      } else {
        OL[i] = 0; OR[i] = 0;
      }
    }
    this.pos = pos;
    if (++this.tick >= 2) {
      this.tick = 0;
      this.port.postMessage({ cmd: "pos", v: pos });
    }
    return true;
  }
}
registerProcessor("deck-source", DeckProcessor);
