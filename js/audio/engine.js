import { FxChain } from "./fx.js";

/** Master audio graph: deck outputs -> master FX x2 -> limiter -> meter -> output; separate cue bus for PFL. */
export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.ready = this.ctx.audioWorklet.addModule("js/audio/deck-processor.js");
    const ctx = this.ctx;
    this.masterVol = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -4;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;
    this.masterFx = [new FxChain(ctx), new FxChain(ctx)]; // serial master FX units
    this.masterVol.connect(this.masterFx[0].in);
    this.masterFx[0].out.connect(this.masterFx[1].in);
    this.masterFx[1].out.connect(this.limiter).connect(this.masterAnalyser).connect(ctx.destination);
    this._buf = new Float32Array(this.masterAnalyser.fftSize);

    // cue bus: master-context MediaStream -> cue context (own output device)
    this.cueDest = ctx.createMediaStreamDestination();
    this.cueCtx = new AudioContext();
    this.cueSrc = this.cueCtx.createMediaStreamSource(this.cueDest.stream);
    this.cueGain = this.cueCtx.createGain();
    this.cueGain.gain.value = 0.7;
    this.cueSrc.connect(this.cueGain).connect(this.cueCtx.destination);

    this.masterDeck = 0;
    this.quantize = 4; // beats; 0 = off
  }

  resume() {
    this.ctx.resume().catch(() => {});
    this.cueCtx.resume().catch(() => {});
  }

  setMasterVolume(v) { this.masterVol.gain.value = v * v * 1.4; }
  setCueLevel(v) { this.cueGain.gain.value = v * v * 1.6; }

  async setMasterSink(id) {
    try { if (this.ctx.setSinkId) await this.ctx.setSinkId(id); } catch (e) { console.warn("master sink", e); }
  }
  async setCueSink(id) {
    try { if (this.cueCtx.setSinkId) await this.cueCtx.setSinkId(id); } catch (e) { console.warn("cue sink", e); }
  }

  async listOutputs() {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === "audiooutput");
  }

  masterPeak() {
    this.masterAnalyser.getFloatTimeDomainData(this._buf);
    let p = 0;
    for (let i = 0; i < this._buf.length; i++) { const a = Math.abs(this._buf[i]); if (a > p) p = a; }
    return p;
  }
}
