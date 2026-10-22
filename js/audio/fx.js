/** FX chains (post-EQ / pre-fader per deck, serial pair on master), DryWet crossfade like classic DJ mixers. */

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

/** DJ-software-style FX Unit: Single / Group / Pattern Player modes.
 *  Group mode: three FxChain slots in series + unit Dry/Wet crossfade.
 *  Pattern mode: synth 808 kit pattern player fed into the wet bus, sidechain duck on dry. */
export const FX_BUTTONS = {
  filter: [["LP", 0.35, 0.25], ["BP", 0.5, 0.6], ["HP", 0.62, 0.25]],
  delay: [["1/2", 0.66, 0.6], ["1/4", 0.42, 0.5], ["1/8", 0.22, 0.4]],
  reverb: [["ROOM", 0.3, 0.5], ["HALL", 0.68, 0.62], ["PLATE", 0.5, 0.75]],
  bitcrush: [["LO-FI", 0.75, 0.4], ["DEEP", 0.5, 0.55], ["GLITCH", 0.15, 0.7]],
  guitar: [["LIGHT", 0.25, 0.6], ["CRUNCH", 0.55, 0.5], ["FUZZ", 0.88, 0.45]],
};

const PAT_KIT = ["Kick", "Clave", "Snare", "Clap", "Hi-Hat C", "Hi-Hat O", "Shaker", "Ride"];
const PAT_DENSITY = [0.28, 0.5, 0.72];

export class PatternPlayer {
  constructor(ctx, tempoFn) {
    this.ctx = ctx;
    this.tempoFn = tempoFn || (() => 120);
    this.out = ctx.createGain();
    this.duckNode = ctx.createGain();
    this.vol = 0.8;
    this.pitch = 0; // semitones -12..+12
    this.decay = 0.5;
    this.duck = false;
    this.sample = 0;
    this.pattern = 0;
    this.playing = false;
    this._bufs = null;
    this._next = 0;
    this._step = 0;
    this._timer = null;
    this._vis = null;
  }

  get kit() { return PAT_KIT; }
  get patternCount() { return PAT_DENSITY.length; }

  _ensure() {
    if (this._bufs) return;
    const sr = this.ctx.sampleRate;
    const mk = (dur, fn) => {
      const n = Math.max(1, Math.floor(sr * dur));
      const b = this.ctx.createBuffer(1, n, sr);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = fn(i / sr);
      return b;
    };
    this._bufs = [
      mk(0.35, (t) => Math.sin(2 * Math.PI * (150 * Math.exp(-t * 22) + 40) * t) * Math.exp(-t * 9)),
      mk(0.12, (t) => Math.sin(2 * Math.PI * 2500 * t) * Math.exp(-t * 40)),
      mk(0.3, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 16) * 0.8 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 20) * 0.6),
      mk(0.3, (t) => (Math.random() * 2 - 1) * Math.exp(-(t % 0.03) * 30) * Math.exp(-t * 8)),
      mk(0.08, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 55)),
      mk(0.45, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 9)),
      mk(0.18, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 22) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 60 * t))),
      mk(0.6, (t) => (Math.random() * 2 - 1) * Math.exp(-t * 6) * 0.7 + Math.sin(2 * Math.PI * 5200 * t) * Math.exp(-t * 12) * 0.3),
    ];
  }

  static hash(a, b, c) {
    let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0;
    h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  steps(sample = this.sample, pattern = this.pattern) {
    const dens = PAT_DENSITY[pattern] || PAT_DENSITY[0];
    const out = [];
    for (let s = 0; s < 16; s++) {
      out.push(s % 4 === 0
        ? PatternPlayer.hash(sample, pattern, 99) < 0.85
        : PatternPlayer.hash(sample, pattern, s) < dens);
    }
    return out;
  }

  start() {
    this._ensure();
    if (this.playing) return;
    this.playing = true;
    this._next = this.ctx.currentTime + 0.05;
    this._step = 0;
    this._timer = setInterval(() => this._tick(), 30);
  }

  stop() {
    this.playing = false;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._vis = null;
  }

  _tick() {
    const bpm = this.tempoFn() || 120;
    const stepDur = 60 / bpm / 4;
    if (this._next < this.ctx.currentTime) this._next = this.ctx.currentTime + 0.02;
    const grid = this.steps();
    while (this._next < this.ctx.currentTime + 0.12) {
      if (grid[this._step % 16]) this._hit(this._next, stepDur);
      this._vis = this._step % 16;
      this._step++;
      this._next += stepDur;
    }
  }

  _hit(t0, stepDur) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._bufs[this.sample];
    src.playbackRate.value = Math.pow(2, this.pitch / 12);
    const env = this.ctx.createGain();
    const len = Math.max(0.04, stepDur * (1 + this.decay * 15));
    env.gain.setValueAtTime(this.vol, t0);
    env.gain.setTargetAtTime(0.0001, t0, len / 3);
    src.connect(env).connect(this.out);
    src.start(t0);
    src.stop(t0 + len + 0.1);
    if (this.duck) {
      const dg = this.duckNode.gain;
      const t = Math.max(this.ctx.currentTime, t0 - 0.005);
      dg.cancelScheduledValues(t);
      dg.setValueAtTime(0.35, t0);
      dg.setTargetAtTime(1, t0 + 0.02, Math.max(0.03, len / 4));
    }
  }

  setVol(v) { this.vol = v; }
  setPitch(st) { this.pitch = st; }
  setDecay(v) { this.decay = v; }
  setDuck(on) {
    this.duck = on;
    if (!on) {
      const dg = this.duckNode.gain;
      dg.cancelScheduledValues(this.ctx.currentTime);
      dg.setValueAtTime(1, this.ctx.currentTime);
    }
  }
  setSample(i) { this._ensure(); this.sample = ((i % 8) + 8) % 8; }
  setPattern(i) { this.pattern = ((i % PAT_DENSITY.length) + PAT_DENSITY.length) % PAT_DENSITY.length; }
}

export class FxUnit {
  constructor(ctx) {
    this.ctx = ctx;
    this.in = ctx.createGain();
    this.out = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.duckNode = ctx.createGain();
    this.in.connect(this.duckNode);
    this.duckNode.connect(this.dry).connect(this.out);
    this.slots = [new FxChain(ctx), new FxChain(ctx), new FxChain(ctx)];
    this.duckNode.connect(this.slots[0].in);
    this.slots[0].out.connect(this.slots[1].in);
    this.slots[1].out.connect(this.slots[2].in);
    this.slots[2].out.connect(this.wet).connect(this.out);
    this.pat = new PatternPlayer(ctx, () => (this.tempoFn ? this.tempoFn() : 120));
    this.pat.duckNode = this.duckNode;
    this.pat.out.connect(this.wet);
    this.dw = 0.5;
    this.mode = "group";
    this.snapshot = null;
    this._applyDw();
  }

  setDw(v) { this.dw = v; this._applyDw(); }
  _applyDw() {
    const t = this.ctx.currentTime, a = (Math.PI / 2) * (1 - this.dw);
    this.dry.gain.setTargetAtTime(Math.cos(a), t, 0.008);
    this.wet.gain.setTargetAtTime(Math.sin(a), t, 0.008);
  }

  setMode(m) {
    this.mode = m;
    if (m === "pattern") for (const s of this.slots) s.setEnabled(false);
    else {
      if (this.pat.playing) this.pat.stop();
      this.pat.setDuck(false);
    }
  }

  saveSnapshot() {
    this.snapshot = {
      dw: this.dw,
      slots: this.slots.map((s) => ({ type: s.type, enabled: s.enabled, mix: s.mix, p1: s.p1, p2: s.p2 })),
    };
  }

  recallSnapshot() {
    if (!this.snapshot) return false;
    this.setDw(this.snapshot.dw);
    this.slots.forEach((s, i) => {
      const o = this.snapshot.slots[i];
      s.setType(o.type);
      if (o.type) {
        s.setP1(o.p1);
        s.setP2(o.p2);
        s.setMix(o.mix);
        s.setEnabled(o.enabled);
      }
    });
    return true;
  }

  /** Reset all slot knobs to their effect defaults (RST). */
  reset() {
    for (const s of this.slots) {
      const F = FX_TYPES[s.type];
      if (!F) continue;
      s.setP1(F.d[0]);
      s.setP2(F.d[1]);
    }
  }
}
