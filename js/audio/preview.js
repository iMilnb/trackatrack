/** Browser Preview Player: plays the selected track via the main output
 *  (Traktor routes preview to the cue/headphone bus; in the browser we mix into master). */
import { audioURL } from "../server-api.js";

export class PreviewPlayer {
  constructor(engine) {
    this.engine = engine;
    this.gain = engine.ctx.createGain();
    this.gain.gain.value = 0.8;
    this.gain.connect(engine.masterVol);
    this.src = null;
    this.buf = null;
    this.track = null;
    this.state = "off"; // off | loading | playing | paused
    this.startedAt = 0;
    this.offset = 0;
    this.onended = null;
  }

  get playing() { return this.state === "playing"; }
  get dur() { return this.buf ? this.buf.duration : 0; }
  get pos() {
    if (this.state !== "playing") return this.offset;
    return this.offset + (this.engine.ctx.currentTime - this.startedAt);
  }

  async _load(track) {
    this.state = "loading";
    const ab = await (await fetch(audioURL(track.path))).arrayBuffer();
    const buf = await this.engine.ctx.decodeAudioData(ab);
    if (this.track !== track) return false; // superseded
    this.buf = buf;
    this.offset = 0;
    return true;
  }

  /** Play the given track (or the loaded one when null). */
  async play(track) {
    if (track && this.track !== track) {
      this.stop();
      this.track = track;
      try {
        if (!(await this._load(track))) return;
      } catch (e) {
        this.state = "off";
        this.track = null;
        throw e;
      }
    }
    if (!this.buf) return;
    this._stopNode();
    const ctx = this.engine.ctx;
    this.src = ctx.createBufferSource();
    this.src.buffer = this.buf;
    this.src.connect(this.gain);
    const t = ctx.currentTime + 0.02;
    if (this.offset >= this.buf.duration) this.offset = 0;
    this.src.start(t, this.offset);
    this.startedAt = t;
    this.state = "playing";
    this.src.onended = () => {
      if (this.state === "playing") {
        this.state = "off";
        this.offset = 0;
        if (this.onended) this.onended();
      }
    };
  }

  pause() {
    if (this.state !== "playing") return;
    this.offset = this.pos;
    this._stopNode();
    this.state = "paused";
  }

  toggle(track) {
    if (this.state === "playing") { this.pause(); return Promise.resolve(false); }
    return this.play(track).then(() => true);
  }

  _stopNode() {
    if (this.src) {
      try { this.src.onended = null; this.src.stop(); } catch (e) { /* ignore */ }
      this.src.disconnect();
      this.src = null;
    }
  }

  stop(clear = true) {
    this._stopNode();
    this.state = "off";
    this.offset = 0;
    if (clear) { this.buf = null; this.track = null; }
  }

  setVol(v) { this.gain.gain.value = v * v * 1.4; }
}
