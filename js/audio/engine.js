import { FxUnit } from "./fx.js";

/** Master audio graph: deck outputs -> limiter -> meter -> output; separate cue bus for PFL.
 *  Two Traktor-style FX Units live at channel level: routed per mixer-channel assignment. */
export class Engine {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    this.ready = this.ctx.audioWorklet
      ? this.ctx.audioWorklet.addModule("js/audio/deck-processor.js")
      : Promise.reject(new Error("AudioWorklet unavailable (insecure context: use https:// or IP URL)"));
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
    this.limiterOn = true;
    this.masterVol.connect(this.limiter).connect(this.masterAnalyser).connect(ctx.destination);
    this.units = [new FxUnit(ctx), new FxUnit(ctx)]; // FX Unit 1 / 2 (global section), assignable to mixer channels
    this._buf = new Float32Array(this.masterAnalyser.fftSize);

    // cue bus: master-context MediaStream -> cue context (own output device)
    this.cueDest = ctx.createMediaStreamDestination();
    // MIX knob semantics: headphones = MIX*cue + (1-MIX)*master  (VOL = cueGain)
    this.cueSend = ctx.createGain();
    this.cueSend.connect(this.cueDest);
    this.cueMixGain = ctx.createGain();
    this.masterAnalyser.connect(this.cueMixGain).connect(this.cueDest);
    this._cueLevel = 0.7;
    this._cueMix = null;
    this.cueGain = null;
    // Single-stream mode: when OUT and PHONES pick the SAME 4ch device (DDJ-SR case),
    // both mixes travel as ONE 4ch stream through the master destination
    // (ch1/2 = master out, ch3/4 = phones jack). Two independent AudioContext streams
    // on the same PipeWire sink do NOT reliably get separate channel pairs — PipeWire
    // lands both on FL/FR and the cue comes out of the speakers again.
    this.cueSharedIn = ctx.createGain();
    this.cueSend.connect(this.cueSharedIn);
    this.cueMixGain.connect(this.cueSharedIn);
    this.cueSharedLvl = ctx.createGain();
    this.cueSharedLvl.gain.value = this._cueLevel * this._cueLevel * 1.6;
    this.cueSharedIn.connect(this.cueSharedLvl);
    this._shMerger = null;
    this._shOn = false;
    this._buildCueCtx(false);

    this.masterDeck = 0;
    this.quantize = 4; // beats; 0 = off

    // AUDIO RECORDER: post-master tap -> gain -> MediaStreamDestination (+ meter analyser)
    this.recGain = ctx.createGain();
    this.masterVol.connect(this.recGain);
    this.recDest = ctx.createMediaStreamDestination();
    this.recGain.connect(this.recDest);
    this.recAnalyser = ctx.createAnalyser();
    this.recAnalyser.fftSize = 512;
    this.recGain.connect(this.recAnalyser);
    this._rbuf = new Float32Array(this.recAnalyser.fftSize);

    // LOOP RECORDER: playback bus injects into master chain
    this.loopBus = ctx.createGain();
    this.loopBus.gain.value = 0.7;
    this.loopBus.connect(this.masterVol);
  }

  // DDJ-SR family USB soundcards are 4ch: ch1/2 = master out, ch3/4 = phones jack.
  // With a 4ch sink, PipeWire maps a plain stereo stream to FL/FR = master out, so
  // the cue mix would land on the speakers. rear=true parks cue in the RL/RR pair.
  _buildCueCtx(rear) {
    if (this.cueCtx) { this.cueCtx.close().catch(() => {}); this.cueCtx = null; }
    try {
      this.cueCtx = rear
        ? new AudioContext({ latencyHint: "interactive", channelCount: 4 })
        : new AudioContext({ latencyHint: "interactive" });
      this._cueRear = rear;
    } catch {
      this.cueCtx = new AudioContext({ latencyHint: "interactive" });
      this._cueRear = false;
    }
    this.cueSrc = this.cueCtx.createMediaStreamSource(this.cueDest.stream);
    this.cueGain = this.cueCtx.createGain();
    this.cueGain.gain.value = this._cueLevel * this._cueLevel * 1.6;
    if (this._cueRear) {
      const sp = this.cueCtx.createChannelSplitter(2);
      const mg = this.cueCtx.createChannelMerger(4);
      this.cueSrc.connect(this.cueGain).connect(sp);
      sp.connect(mg, 0, 2); // L -> RL (ch3 = phones L)
      sp.connect(mg, 1, 3); // R -> RR (ch4 = phones R)
      mg.connect(this.cueCtx.destination);
    } else {
      this.cueSrc.connect(this.cueGain).connect(this.cueCtx.destination);
    }
    if (this._cueMix != null) this.setCueMix(this._cueMix);
    this.cueCtx.resume().catch(() => {});
  }

  resume() {
    this.ctx.resume().catch(() => {});
    if (!this._shOn) this.cueCtx.resume().catch(() => {});
  }

  setMasterVolume(v) { this.masterVol.gain.value = v * v * 1.4; }
  setCueLevel(v) { this._cueLevel = v; this.cueGain.gain.value = v * v * 1.6; if (this.cueSharedLvl) this.cueSharedLvl.gain.value = v * v * 1.6; }
  setCueMix(v) {
    this._cueMix = v;
    this.cueSend.gain.value = v;
    this.cueMixGain.gain.value = 1 - v;
  }

  setLimiter(on) {
    this.limiterOn = on;
    this.masterVol.disconnect();
    this.limiter.disconnect();
    if (on) this.masterVol.connect(this.limiter).connect(this.masterAnalyser);
    else this.masterVol.connect(this.masterAnalyser);
    this.masterVol.connect(this.recGain);
  }

  async setMasterSink(id) {
    try { if (this.ctx.setSinkId) await this.ctx.setSinkId(id); } catch (e) { console.warn("master sink", e); }
  }
  async setCueSink(id, maxCh = 2, shared = false) {
    if (shared && await this._sharedOn()) return;
    this._sharedOff();
    const rear = maxCh >= 4;
    if (this.cueCtx && this._cueRear !== rear) this._buildCueCtx(rear);
    try { if (this.cueCtx.setSinkId) await this.cueCtx.setSinkId(id); } catch (e) { console.warn("cue sink", e); }
    // DeviceInfo.maxChannelCount is unreliable on Linux (often 2/undefined);
    // destination.maxChannelCount reflects the ACTUAL output sink after setSinkId.
    const live = this.cueCtx.destination.maxChannelCount || 0;
    if (live > 0 && (live >= 4) !== this._cueRear) {
      this._buildCueCtx(live >= 4);
      try { if (this.cueCtx.setSinkId) await this.cueCtx.setSinkId(id); } catch (e) { console.warn("cue sink 2", e); }
      if (this._cueRear) { const ok = await this._sharedOn(); if (ok) return; } // 4ch shared beats dual-stream rear park
    }
    this.cueCtx.resume().catch(() => {});
  }

  // master+cue on one 4ch stream through the master destination: master on ch1/2,
  // cue parked on ch3/4 (= DDJ-SR phones jack). Returns false if the sink can't do 4ch.
  async _sharedOn() {
    const dest = this.ctx.destination;
    if (dest.maxChannelCount < 4) return false;
    if (!this._shMerger) this._shMerger = this.ctx.createChannelMerger(4);
    if (!this._shOn) {
      this.masterAnalyser.disconnect(this.ctx.destination);
      this.masterAnalyser.connect(this._shMerger, 0, 0); // master L/R -> ch1/2
      this.cueSharedLvl.connect(this._shMerger, 0, 2); // cue L/R -> ch3/4
      this._shMerger.connect(dest);
      this._shOn = true;
      console.log("cue routing: shared 4ch (phones on rear pair)");
    }
    try { dest.channelCountMode = "explicit"; dest.channelCount = 4; } catch (e) { console.warn("4ch out", e); }
    this.cueCtx.suspend().catch(() => {}); // parallel cue stream must not double-play on ch1/2
    return true;
  }

  _sharedOff() {
    if (!this._shOn) return;
    this._shMerger.disconnect(this.ctx.destination);
    this.masterAnalyser.connect(this.ctx.destination);
    try { this.ctx.destination.channelCount = 2; } catch (e) { console.warn("2ch out", e); }
    this._shOn = false;
    this.cueCtx.resume().catch(() => {});
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

  setRecGain(v) { this.recGain.gain.value = v * 2; }
  recLevel() {
    this.recAnalyser.getFloatTimeDomainData(this._rbuf);
    let p = 0;
    for (let i = 0; i < this._rbuf.length; i++) { const a = Math.abs(this._rbuf[i]); if (a > p) p = a; }
    return p;
  }
}
