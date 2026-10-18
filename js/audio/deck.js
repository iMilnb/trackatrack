import { clamp, fmtTime, parseKey, camelotColor } from "../util.js";
import { audioURL } from "../server-api.js";
import { FxChain } from "./fx.js";
import { analyzeTrack } from "../analysis/analyze.js";

const LOOP_SIZES = [0.5, 1, 2, 4, 8, 16, 32];

/**
 * One deck: worklet playback of a decoded track + transport, cue, loops,
 * tempo, EQ and PFL routing. UI element refs come from the cloned template.
 */
export class Deck {
  constructor(idx, letter, engine, els) {
    this.idx = idx;
    this.letter = letter;
    this.engine = engine;
    this.els = els;
    this.track = null;
    this.analysis = null;
    this.state = "empty"; // empty|loading|analyzing|ready
    this.playing = false;
    this.tempo = 1; // rate at center (1 +- 0.08)
    this.bendAmt = 0;
    this.reversed = false;
    this.flx = false;
    this.synced = false;
    this.master = false;
    this.bpm = null;
    this.firstBeat = 0;
    this.durSec = null;
    this.sr = 44100;
    this._pos = 0; // sample
    this._posT = performance.now();
    this.cue = null; // sample index
    this._cueHold = false;
    this.loop = { on: false, start: 0, end: 0, beats: 0 };
    this.zoomBeats = 32;
    this.pfl = false;
    this.fx = new FxChain(engine.ctx); // post-EQ, pre-fader (PFL taps stay pre-FX)
    this._onLoaded = null;
    els.letter.textContent = letter;
  }

  async init() {
    await this.engine.ready;
    const ctx = this.engine.ctx;
    this.node = new AudioWorkletNode(ctx, "deck-source", { outputChannelCount: [2] });
    this.p = {
      rate: this.node.parameters.get("rate"),
      play: this.node.parameters.get("play"),
      loopOn: this.node.parameters.get("loopOn"),
      loopStart: this.node.parameters.get("loopStart"),
      loopEnd: this.node.parameters.get("loopEnd"),
    };
    this.trim = ctx.createGain();
    this.lo = ctx.createBiquadFilter(); this.lo.type = "lowshelf"; this.lo.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = "peaking"; this.mid.frequency.value = 1100; this.mid.Q.value = 0.9;
    this.hi = ctx.createBiquadFilter(); this.hi.type = "highshelf"; this.hi.frequency.value = 3500;
    this.preFader = ctx.createGain();
    this.vol = ctx.createGain(); this.vol.gain.value = 0; // xf/fader owned by mixer
    this.node.connect(this.trim).connect(this.lo).connect(this.mid).connect(this.hi).connect(this.preFader);
    this.preFader.connect(this.fx.in);
    this.fx.out.connect(this.vol).connect(this.engine.masterVol);
    this.pflGain = ctx.createGain(); this.pflGain.gain.value = 0;
    this.preFader.connect(this.pflGain).connect(this.engine.cueDest);
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 1024;
    this._m_buf = new Float32Array(1024);
    this.vol.connect(this.meter);
    this.node.port.onmessage = (e) => this._workletMsg(e.data);
  }

  _workletMsg(m) {
    if (m.cmd === "pos") { this._pos = m.v; this._posT = performance.now(); }
    else if (m.cmd === "ended") { this.playing = false; this._setPlayParam(false); }
    else if (m.cmd === "loaded") { if (this._onLoaded) this._onLoaded(); }
  }

  // ---- transport ----
  get rateVal() { return this.tempo * (1 + this.bendAmt); }
  get pos() { return this._pos; }
  get posSec() {
    let p = this._pos;
    if (this.playing) p += this.reversed ? -this.rateVal : this.rateVal;
    return clamp(p / this.sr, 0, this.durSec || 0);
  }
  get spb() { return this.bpm ? 60 / this.bpm : 0; }
  beatsAt(tSec) { return this.spb ? (tSec - this.firstBeat) / this.spb : 0; }
  get beats() { return this.beatsAt(this.posSec); }

  _setPlayParam(p) { this.p.play.setValueAtTime(p ? 1 : 0, this.engine.ctx.currentTime); }
  _setRateParam() { this.p.rate.setValueAtTime(this.reversed ? -this.rateVal : this.rateVal, this.engine.ctx.currentTime); }

  async load(track, { autoplay = false } = {}) {
    this.pause();
    this.track = track;
    this.analysis = null;
    this.state = "loading";
    this.errMsg = "";
    this.bpm = track.bpm || null;
    this.firstBeat = 0;
    this.cue = 0;
    this._pos = 0;
    this._posT = performance.now();
    this.durSec = null;
    this.loop = { on: false, start: 0, end: 0, beats: 0 };
    this.synced = false;
    this._paintStatic();
    const tLoad0 = performance.now();
    const ab = await (await fetch(audioURL(track.path))).arrayBuffer();
    if (this.track !== track) return; // superseded
    console.log(`[deck ${this.letter}] fetched ${(performance.now() - tLoad0) | 0}ms (${(ab.byteLength / 1e6).toFixed(1)}MB), decoding...`);
    this.state = "decoding";
    this._paintStatic();
    let buf = null, err = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = this.engine.ctx;
      if (ctx.state === "closed") { err = new Error("AudioContext closed"); break; }
      if (ctx.state !== "running") { this.engine.resume(); await new Promise((r) => setTimeout(r, 350)); }
      try {
        buf = await Promise.race([
          ctx.decodeAudioData(ab.slice(0)), // decode detaches the buffer; keep ab for retry
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20000)),
        ]);
        err = null;
        break;
      } catch (e) { err = e; }
    }
    if (!buf) {
      this.errMsg = err ? `${err.name === "Error" ? "" : err.name + ": "}${err.message || err}` : "unknown";
      console.error(`[deck ${this.letter}] decode failed:`, this.errMsg);
      if (this.track === track) { this.state = "error"; this._paintStatic(); }
      return;
    }
    if (this.track !== track) return;
    if (!buf || !buf.length) { this.state = "error"; this._paintStatic(); return; }
    console.log(`[deck ${this.letter}] decoded ${(performance.now() - tLoad0) | 0}ms (dur=${buf.duration.toFixed(1)}s sr=${buf.sampleRate}), analyzing...`);
    this.sr = buf.sampleRate;
    this.durSec = buf.duration;
    const L = new Float32Array(buf.length), R = new Float32Array(buf.length);
    L.set(buf.getChannelData(0));
    R.set(buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0));
    const L2 = new Float32Array(L), R2 = new Float32Array(R);
    this.node.port.postMessage({ cmd: "load", L, R }, [L.buffer, R.buffer]);
    this.state = "analyzing";
    const tAn0 = performance.now();
    analyzeTrack(track, { L: L2, R: R2, sr: this.sr }).then((an) => {
      console.log(`[deck ${this.letter}] analysis done ${(performance.now() - tAn0) | 0}ms (bpm=${an.bpm} n=${L2.length})`);
      if (this.track !== track) return;
      this.analysis = an;
      this.bpm = an.bpm || this.bpm;
      this.firstBeat = an.firstBeat || 0;
      this.state = "ready";
      this._paintStatic();
    });
    if (autoplay) this.play();
    this._paintStatic();
  }

  play() {
    if (!this.track || !this.durSec) return;
    if (this.posSec >= (this.durSec || 0) - 0.05) this.seekSec(0);
    this.playing = true;
    this._setPlayParam(true);
  }
  pause() { this.playing = false; this._setPlayParam(false); }
  toggle() { this.playing ? this.pause() : this.play(); }
  seekSec(s) {
    this._pos = clamp(s, 0, this.durSec || 0) * this.sr;
    this._posT = performance.now();
    this.node.port.postMessage({ cmd: "pos", v: Math.round(this._pos) });
  }
  seekBeat(b) { if (this.spb) this.seekSec(this.firstBeat + b * this.spb); }

  // ---- tempo ----
  setTempoPct(p) { // -0.08 .. +0.08
    this.tempo = 1 + clamp(p, -0.08, 0.08);
    this.synced = false;
    this._setRateParam();
    this.els.tPct.textContent = `${(p * 100 >= 0 ? "+" : "")}${(p * 100).toFixed(1)}%`;
  }
  bendStart(dir) { this.bendAmt = clamp(dir, -1, 1) * 0.08; this._setRateParam(); }
  bendEnd() { this.bendAmt = 0; this._setRateParam(); }

  // ---- cue / cue+play / reverse ----
  pressCue(pressed) {
    if (pressed) {
      if (this.playing && this.flx) {
        this.seekSec((this.cue || 0) / this.sr);
      } else if (this.playing) {
        if (this.cue == null) this.cue = this._pos;
        this.pause(); this.seekSec(this.cue / this.sr);
      } else {
        if (this.cue == null) this.cue = this._pos;
        this.seekSec(this.cue / this.sr);
        this._cueHold = true;
        this.play();
      }
    } else if (this._cueHold) {
      this._cueHold = false;
      this.pause();
      this.seekSec((this.cue || 0) / this.sr);
    }
  }
  pressCup() {
    if (this.cue == null) this.cue = this._pos;
    this.seekSec(this.cue / this.sr);
    this.play();
  }
  toCue() { this.seekSec((this.cue || 0) / this.sr); }
  pressRev(pressed) {
    if (pressed === this.reversed) return;
    this.reversed = pressed;
    this._setRateParam();
  }

  // ---- loops ----
  quantizeSample(posSamples) {
    const q = this.engine.quantize;
    if (!q || !this.spb) return posSamples;
    const bq = this.beatsAt(posSamples / this.sr);
    const target = Math.ceil(bq / q - 1e-6) * q;
    return Math.round((this.firstBeat + target * this.spb) * this.sr);
  }
  loopSetBeats(n) {
    if (!this.spb) return;
    if (this.loop.on && this.loop.beats === n) return this.loopExit();
    const s = this.quantizeSample(this._pos);
    this.loop = { on: true, start: s, end: s + n * this.spb * this.sr, beats: n };
    this._applyLoop();
  }
  loopExit() { this.loop.on = false; this._applyLoop(); }
  loopIn() {
    if (!this.spb) return;
    this.loop.start = this.quantizeSample(this._pos);
    this.loop.beats = 0;
    this._applyLoop();
  }
  loopOut() {
    if (!this.spb) return;
    this.loop.end = Math.max(this.loop.start + this.spb * this.sr * 0.25, this.quantizeSample(this._pos));
    this.loop.on = true;
    if (this.loop.end <= this.loop.start) return this.loopExit();
    this._applyLoop();
  }
  loopHalve() {
    if (!this.loop.on) return;
    if (this.loop.beats > 0 && LOOP_SIZES.includes(this.loop.beats / 2)) return this.loopSetBeats(this.loop.beats / 2);
    this.loop.start = this._pos;
    this.loop.beats = 0;
    this._applyLoop();
  }
  loopDouble() {
    if (!this.loop.on || this.loop.beats <= 0) return;
    const dbl = this.loop.beats * 2;
    if (dbl > 128) return;
    this.loopSetBeats(dbl);
  }
  _applyLoop() {
    const t = this.engine.ctx.currentTime;
    this.p.loopOn.setValueAtTime(this.loop.on ? 1 : 0, t);
    this.p.loopStart.setValueAtTime(Math.min(this.loop.start, this.loop.end - 1), t);
    this.p.loopEnd.setValueAtTime(Math.max(this.loop.start, this.loop.end), t);
  }

  // ---- sync ----
  async syncTo(other) {
    if (!other || !other.bpm || !this.bpm) return;
    const ratio = other.bpm * other.tempo / this.bpm;
    this.tempo = clamp(ratio, 0.4, 2);
    this.synced = true;
    this._setRateParam();
    const pct = this.tempo - 1;
    this.els.tFader.set(pct);
    this.els.tPct.textContent = `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(1)}%`;
    // phase align to master's current beat
    const mb = other.beatsAt(other.posSec);
    const deltaBeats = mb - this.beatsAt(this.posSec);
    this.firstBeat += deltaBeats * this.spb;
  }
  setMaster(on) {
    this.master = on;
    this.els.master.classList.toggle("on", on);
  }

  // ---- mixer params (0..1) ----
  setGain(v) { this.trim.gain.value = 0.25 + v * 2; }
  setEq(kind, v) {
    const db = v < 0.5 ? -(0.5 - v) * 2 * 34 : (v - 0.5) * 2 * 10;
    const node = kind === "low" ? this.lo : kind === "mid" ? this.mid : this.hi;
    node.gain.value = db;
  }
  setPfl(on) {
    this.pfl = on;
    this.pflGain.gain.setTargetAtTime(on ? 1 : 0, this.engine.ctx.currentTime, 0.01);
  }

  meterPeak() {
    this.meter.getFloatTimeDomainData(this._m_buf);
    let p = 0;
    for (let i = 0; i < 512; i++) { const a = Math.abs(this._m_buf[i]); if (a > p) p = a; }
    return p;
  }

  // ---- UI paint ----
  _paintStatic() {
    const e = this.els;
    const t = this.track;
    e.title.textContent = t ? t.title : "–";
    e.artist.textContent = t && t.artist && t.artist !== t.title ? t.artist : "";
    const cam = t ? parseKey(t.key) : null;
    e.key.textContent = cam ? cam.text : (t && t.key ? t.key : "");
    e.key.style.color = cam ? camelotColor(cam) : "#666";
    e.bpm.textContent = this.bpm ? this.bpm.toFixed(2) : this.state === "analyzing" ? "…" : "–";
  }

  tick() {
    const e = this.els;
    e.play.classList.toggle("on", this.playing);
    e.cue.classList.toggle("on", this.cue != null && this.cue > 0 && !this.playing);
    e.flx.classList.toggle("on", this.flx);
    e.rev.classList.toggle("on", this.reversed);
    e.sync.classList.toggle("on", this.synced);
    for (const b of e.loopBtns) {
      b.classList.toggle("on", this.loop.on && this.loop.beats === +b.dataset.n);
    }
    e.lin.classList.toggle("on", this.loop.on && this.loop.beats === 0 && this.loop.start > 0);
    e.loopInd.textContent = this.loop.on
      ? (this.loop.beats ? `${this.loop.beats < 1 ? "½" : this.loop.beats}` : "m")
      : "";
    if (this.durSec) {
      const rem = this.durSec - this.posSec;
      e.remain.textContent = `-${fmtTime(rem)}`;
      e.dur.textContent = fmtTime(this.durSec);
    } else {
      e.remain.textContent = "--:--";
      e.dur.textContent = "";
    }
    e.state.textContent =
      this.state === "loading" ? "FETCHING…" : this.state === "decoding" ? "DECODING…"
        : this.state === "analyzing" ? "ANALYZING…" : this.state === "error" ? `DECODE ERROR: ${(this.errMsg || "?").slice(0, 26)}` : "";
  }
}

export { LOOP_SIZES };
