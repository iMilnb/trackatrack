/**
 * AUDIO RECORDER — records the master output (post MAIN tap) via MediaRecorder.
 * LOOP RECORDER — on-the-fly beat loops captured from Master / Deck A / Deck B
 * with overdub (dub), undo/redo, delete, looped playback through the master bus.
 */

export class AudioRecorder {
  constructor(engine) {
    this.engine = engine;
    this.rec = null;
    this.chunks = [];
    this.t0 = 0;
    this.takes = []; // {url, size, dur}
    this.lastElapsed = 0;
    this.supported = typeof MediaRecorder !== "undefined";
  }

  start() {
    if (!this.supported || this.rec) return;
    const mimes = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", ""];
    const mimeType = mimes.find((m) => !m || MediaRecorder.isTypeSupported(m));
    this.chunks = [];
    this.rec = new MediaRecorder(this.engine.recDest.stream, mimeType ? { mimeType } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.t0 = performance.now();
  }

  get recording() { return !!this.rec; }
  get elapsed() { return this.rec ? (performance.now() - this.t0) / 1000 : this.lastElapsed; }
  get bytes() { let n = 0; for (const c of this.chunks) n += c.size; return n; }

  /** Stop the current file (seamless if newFile), returns the finished take. */
  cut(newFile = true) {
    if (!this.rec) return Promise.resolve(null);
    return new Promise((res) => {
      const r = this.rec;
      this.rec = null;
      const dur = this.elapsed;
      this.lastElapsed = dur;
      r.onstop = () => {
        const blob = new Blob(this.chunks, { type: r.mimeType || "audio/webm" });
        const url = URL.createObjectURL(blob);
        const take = { url, size: blob.size, dur };
        this.takes.push(take);
        if (newFile) this.start();
        res(take);
      };
      r.stop();
    });
  }
}

export class LoopRecorder {
  /**
   * engine      — Engine (ctx + loopBus)
   * tempoFn     — () => master tempo bpm
   * tapsFor(sel)— () => [AudioNode...] capture sources ('m' | '0' | '1')
   */
  constructor(engine, tempoFn, tapsFor) {
    this.engine = engine;
    this.tempoFn = tempoFn;
    this.tapsFor = tapsFor;
    this.source = "m";
    this.sizeBeats = 1;
    this.buf = null;
    this.undoStack = [];
    this.redoStack = [];
    this.proc = null;
    this.tapNodes = [];
    this.capturing = false; // 'rec' | 'dub'
    this.capBuf = null;
    this.capFill = 0;
    this.srcNode = null;
    this.dw = 0.7;
  }

  get playing() { return !!this.srcNode; }
  get sr() { return this.engine.ctx.sampleRate; }

  targetSamples() {
    const bpm = this.tempoFn() || 120;
    return Math.max(256, Math.round((this.sizeBeats * 60 / bpm) * this.sr));
  }

  _ensureProc() {
    if (this.proc) return;
    const ctx = this.engine.ctx;
    const proc = ctx.createScriptProcessor(2048, 2, 1);
    proc.onaudioprocess = (ev) => this._onAudio(ev);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    proc.connect(mute).connect(ctx.destination);
    this.proc = proc;
    this._retap();
  }

  _retap() {
    if (!this.proc) return;
    for (const n of this.tapNodes) { try { n.disconnect(this.proc); } catch (e) { /* ignore */ } }
    this.tapNodes = this.tapsFor(this.source) || [];
    for (const n of this.tapNodes) n.connect(this.proc);
  }

  setSource(sel) { this.source = sel; this._retap(); }

  _onAudio(ev) {
    if (!this.capturing || !this.capBuf) return;
    const inp = ev.inputBuffer;
    const L = inp.getChannelData(0);
    const R = inp.numberOfChannels > 1 ? inp.getChannelData(1) : L;
    const out = this.capBuf;
    const n = out.length;
    for (let i = 0; i < L.length; i++) {
      const idx = this.capFill + i;
      if (idx >= n) break;
      out[idx] = (L[i] + R[i]) * 0.5;
    }
    this.capFill += Math.min(L.length, n - this.capFill);
    if (this.capFill >= n) this._commit();
  }

  startRec() {
    this._ensureProc();
    this._stopNode();
    this.stop();
    this.capBuf = new Float32Array(this.targetSamples());
    this.capFill = 0;
    this.capturing = "rec";
  }

  startDub() {
    if (!this.buf) return this.startRec();
    this._ensureProc();
    this.capBuf = new Float32Array(this.buf.length);
    this.capFill = 0;
    this.capturing = "dub";
    if (!this.playing) this.play();
  }

  stopCapture() { if (this.capturing) this._commit(); }

  _commit() {
    const mode = this.capturing;
    this.capturing = false;
    const ctx = this.engine.ctx;
    const cap = this.capBuf;
    const filled = Math.min(this.capFill, cap.length);
    const dub = mode === "dub" && this.buf;
    const n = dub ? this.buf.length : Math.max(256, filled);
    const buf = ctx.createBuffer(2, n, this.sr);
    const ch = buf.getChannelData(0);
    if (dub) {
      const old = this.buf.getChannelData(0);
      ch.set(old.subarray(0, Math.min(old.length, n)));
      for (let i = 0; i < filled && i < n; i++) {
        const v = ch[i] + cap[i];
        ch[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
    } else {
      ch.set(cap.subarray(0, Math.min(filled, n)));
    }
    if (this.buf) { this.undoStack.push(this.buf); this.redoStack = []; }
    buf.getChannelData(1).set(ch);
    this.buf = buf;
    this.capBuf = null;
    this.play();
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this.buf);
    this.buf = this.undoStack.pop();
    if (this.playing) this.play();
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.buf);
    this.buf = this.redoStack.pop();
    if (this.playing) this.play();
  }

  delete() {
    this.stop();
    if (this.buf) { this.undoStack.push(this.buf); this.redoStack = []; }
    this.buf = null;
  }

  _stopNode() {
    if (this.srcNode) { try { this.srcNode.stop(); } catch (e) { /* ignore */ } this.srcNode.disconnect(); this.srcNode = null; }
  }

  play() {
    this._stopNode();
    if (!this.buf) return;
    const src = this.engine.ctx.createBufferSource();
    src.buffer = this.buf;
    src.loop = true;
    src.loopEnd = this.buf.duration;
    src.connect(this.engine.loopBus);
    src.start();
    this.srcNode = src;
  }

  stop() { this._stopNode(); }

  setDW(v) { this.dw = v; this.engine.loopBus.gain.value = v; }

  /** 0..1 progress for the bar: capture fill, else playback position. */
  progress() {
    if (this.capturing && this.capBuf) return this.capFill / this.capBuf.length;
    if (this.playing) {
      const n = this.buf.length;
      const at = (this.engine.ctx.currentTime * this.sr) % n;
      return at / n;
    }
    return this.buf ? 1 : 0;
  }

  get status() { return this.capturing || (this.playing ? "play" : this.buf ? "ready" : "off"); }
}
