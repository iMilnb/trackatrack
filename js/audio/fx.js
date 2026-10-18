/** FX chains (post-EQ / pre-fader per deck, serial pair on master), Traktor-style DryWet. */

export const FX_TYPES = {
  filter: { label: "Filter", p1: "CUTOFF", p2: "RESONANCE", d: [0.45, 0.18] },
  delay: { label: "Delay", p1: "TIME", p2: "FEEDBACK", d: [0.42, 0.5] },
  reverb: { label: "Reverb", p1: "DECAY", p2: "TONE", d: [0.45, 0.6] },
  bitcrush: { label: "Bitcrush", p1: "CRUSH", p2: "TONE", d: [0.4, 0.55] },
  guitar: { label: "Guitar", p1: "DRIVE", p2: "TONE", d: [0.35, 0.55] },
};

const expo = (v, a, b) => a * Math.pow(b / a, Math.min(Math.max(v, 0), 1)); // v 0..1 -> a..b log

export class FxChain {
  constructor(ctx) {
    this.ctx = ctx;
    this.in = ctx.createGain();
    this.out = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.in.connect(this.dry).connect(this.out);
    this.wet.connect(this.out);
    this.mix = 0.5;
    this.enabled = false;
    this.type = null;
    this.p1 = 0.5;
    this.p2 = 0.5;
    this._nodes = [];
    this._decayBuilt = 0;
    this._applyMix();
  }

  setEnabled(on) { this.enabled = on; this._applyMix(); }
  setMix(v) { this.mix = v; this._applyMix(); }
  _applyMix() {
    const t = this.ctx.currentTime, w = this.enabled ? this.mix : 0;
    const a = (Math.PI / 2) * w;
    this.dry.gain.setTargetAtTime(Math.cos(a), t, 0.008);
    this.wet.gain.setTargetAtTime(Math.sin(a) * 0.9, t, 0.008);
  }

  setType(type) {
    for (const n of this._nodes) n.disconnect();
    this._nodes = [];
    this.type = type || null;
    if (!type) return;
    const ctx = this.ctx;
    const F = FX_TYPES[type];
    this.p1 = F.d[0];
    this.p2 = F.d[1];
    if (type === "filter") {
      this.f = ctx.createBiquadFilter(); this.f.type = "lowpass";
      this.in.connect(this.f).connect(this.wet);
      this._nodes = [this.f];
    } else if (type === "delay") {
      this.dl = ctx.createDelay(2.5);
      this.fb = ctx.createGain();
      this.tone = ctx.createBiquadFilter(); this.tone.type = "lowpass"; this.tone.frequency.value = 4500;
      this.in.connect(this.dl);
      this.dl.connect(this.fb).connect(this.dl);
      this.dl.connect(this.tone).connect(this.wet);
      this._nodes = [this.dl, this.fb, this.tone];
    } else if (type === "reverb") {
      this.cv = ctx.createConvolver();
      this.tone = ctx.createBiquadFilter(); this.tone.type = "lowpass";
      this.in.connect(this.cv).connect(this.tone).connect(this.wet);
      this._nodes = [this.cv, this.tone];
      this._decayBuilt = 0;
    } else if (type === "bitcrush") {
      this.sh = ctx.createWaveShaper(); this.sh.oversample = "2x";
      this.tone = ctx.createBiquadFilter(); this.tone.type = "lowpass";
      this.in.connect(this.sh).connect(this.tone).connect(this.wet);
      this._nodes = [this.sh, this.tone];
    } else if (type === "guitar") {
      this.pre = ctx.createGain();
      this.sh = ctx.createWaveShaper(); this.sh.oversample = "2x";
      this.tone = ctx.createBiquadFilter(); this.tone.type = "lowpass";
      const curve = new Float32Array(2048);
      for (let i = 0; i < 2048; i++) {
        const x = (i / 2047) * 2 - 1;
        curve[i] = Math.tanh(3 * x) / Math.tanh(3);
      }
      this.sh.curve = curve;
      this.in.connect(this.pre).connect(this.sh).connect(this.tone).connect(this.wet);
      this._nodes = [this.pre, this.sh, this.tone];
    }
    this._apply();
  }

  setP1(v) { this.p1 = v; this._apply(); }
  setP2(v) { this.p2 = v; this._apply(); }

  _apply() {
    const t = this.ctx.currentTime;
    switch (this.type) {
      case "filter":
        this.f.frequency.setTargetAtTime(expo(this.p1, 40, 18000), t, 0.01);
        this.f.Q.setTargetAtTime(0.2 + 18 * this.p2 * this.p2, t, 0.01);
        break;
      case "delay":
        this.dl.delayTime.setTargetAtTime(expo(this.p1, 0.012, 1.5), t, 0.05);
        this.fb.gain.setTargetAtTime(this.p2 * 0.85, t, 0.02);
        break;
      case "reverb": {
        const decay = expo(this.p1, 0.3, 6);
        if (Math.abs(decay - this._decayBuilt) > 0.08) { this.cv.buffer = this._ir(decay); this._decayBuilt = decay; }
        this.tone.frequency.setTargetAtTime(expo(this.p2, 500, 16000), t, 0.01);
        break;
      }
      case "bitcrush": {
        const steps = Math.round(expo(this.p1, 2, 64));
        if (steps !== this._steps) {
          this._steps = steps;
          const curve = new Float32Array(2048);
          for (let i = 0; i < 2048; i++) {
            const x = (i / 2047) * 2 - 1;
            curve[i] = Math.round(x * steps) / steps;
          }
          this.sh.curve = curve;
        }
        this.tone.frequency.setTargetAtTime(expo(this.p2, 400, 14000), t, 0.01);
        break;
      }
      case "guitar": {
        const drive = 1 + 40 * this.p1 * this.p1;
        this.pre.gain.setTargetAtTime(drive, t, 0.01);
        this.tone.frequency.setTargetAtTime(expo(this.p2, 400, 9000), t, 0.01);
        break;
      }
    }
  }

  _ir(decay) {
    const sr = this.ctx.sampleRate, len = Math.max(1, (sr * (decay + 0.05)) | 0);
    const buf = this.ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, 2.2);
      }
    }
    return buf;
  }
}
