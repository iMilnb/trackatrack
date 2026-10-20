/** Canvas renderers for one deck: scrolling detail + full overview. */
import { HC_COLORS } from "./audio/deck.js";

export class DeckScope {
  constructor(deck, detailCv, ovCv, zoomEl) {
    this.deck = deck;
    this.cv = detailCv;
    this.ctx = detailCv.getContext("2d");
    this.ovCv = ovCv;
    this.ovCtx = ovCv.getContext("2d");
    this.zoomEl = zoomEl;
    this.playheadFrac = 0.3;
    this._fit();
    window.addEventListener("resize", () => this._fit());
    this._bindPointer();
  }

  _fit() {
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.cv, this.ovCv]) {
      c.width = Math.max(1, Math.round(c.clientWidth * dpr));
      c.height = Math.max(1, Math.round(c.clientHeight * dpr));
    }
    this.dpr = dpr;
  }

  _bindPointer() {
    for (const cv of [this.cv, this.ovCv]) {
      let down = false, startFrac = 0, startPos = 0;
      const fracOf = (e) => (e.clientX - cv.getBoundingClientRect().left) / cv.getBoundingClientRect().width;
      const seekAt = (e) => {
        const d = this.deck;
        if (!d.durSec) return;
        if (cv === this.cv) {
          d.seekSec(Math.max(0, Math.min(d.durSec, startPos + (fracOf(e) - startFrac) * this._spanSec())));
        } else {
          d.seekSec(Math.max(0, Math.min(1, fracOf(e))) * d.durSec);
        }
      };
      cv.addEventListener("pointerdown", (e) => {
        down = true;
        cv.setPointerCapture(e.pointerId);
        startFrac = fracOf(e);
        startPos = this.deck.posSec;
        seekAt(e);
      });
      cv.addEventListener("pointermove", (e) => { if (down) seekAt(e); });
      const up = () => { down = false; };
      cv.addEventListener("pointerup", up);
      cv.addEventListener("pointercancel", up);
      cv.addEventListener("wheel", (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 0.5 : 2); }, { passive: false });
    }
  }

  zoom(f) {
    const d = this.deck;
    d.zoomBeats = Math.max(2, Math.min(128, d.zoomBeats * f));
    if (this.zoomEl) this.zoomEl.textContent = d.zoomBeats >= 1 ? d.zoomBeats : "½";
  }

  _spanSec() {
    const d = this.deck;
    return d.spb ? d.zoomBeats * d.spb : 30;
  }

  draw() {
    this._drawDetail();
    this._drawOverview();
  }

  _drawDetail() {
    const d = this.deck, g = this.ctx, W = this.cv.width, H = this.cv.height;
    g.fillStyle = "#0b0b0f";
    g.fillRect(0, 0, W, H);
    const an = d.analysis;
    const yMid = H / 2;
    if (!an || !d.durSec) {
      g.strokeStyle = "#232329";
      g.beginPath(); g.moveTo(0, yMid); g.lineTo(W, yMid); g.stroke();
      return;
    }
    const span = this._spanSec();
    const ppS = W / span;
    const phX = W * this.playheadFrac;
    const posSec = d.posSec;
    const bucketDur = d.durSec / 4096;
    const t0 = posSec - phX / ppS, t1 = posSec + (W - phX) / ppS;

    // alternating bar shading
    if (d.spb) {
      const barSec = d.spb * 4;
      let k = Math.floor((t0 - d.firstBeat) / barSec);
      g.fillStyle = "rgba(255,255,255,0.028)";
      while (true) {
        const b0 = d.firstBeat + k * barSec, b1 = b0 + barSec;
        const x0 = Math.max(0, (b0 - t0) * ppS + 0), x1 = Math.min(W, (b1 - t0) * ppS);
        if (x0 >= W) break;
        if (k % 2 === 0 && x1 > Math.max(0, x0)) g.fillRect(Math.max(0, x0), 0, x1 - Math.max(0, x0), H);
        k++;
      }
    }
    // loop region underlay
    if (d.loop.on) {
      const lx0 = (d.loop.start / d.sr - t0) * ppS;
      const lx1 = (d.loop.end / d.sr - t0) * ppS;
      g.fillStyle = "rgba(255,150,40,0.10)";
      g.fillRect(lx0, 0, Math.max(2, lx1 - lx0), H);
    }
    // colored peaks
    const colors = an.colors;
    const step = Math.max(1, Math.floor(1 / (ppS * bucketDur * 1.01))); // px per bucket at most 1
    for (let x = 0; x < W; x += step) {
      const t = t0 + x / ppS;
      const bi = Math.floor(t / bucketDur);
      if (bi < 0 || bi >= 4096) continue;
      const mn = an.dMin[bi], mx = an.dMax[bi];
      if (mn === 0 && mx === 0) continue;
      const y0 = yMid - mx * yMid * 0.94, y1 = yMid - mn * yMid * 0.94;
      g.fillStyle = `rgb(${colors[bi * 3]},${colors[bi * 3 + 1]},${colors[bi * 3 + 2]})`;
      g.fillRect(x, y0, step, Math.max(1.2 * this.dpr, y1 - y0));
    }
    // beat grid
    if (d.spb) {
      const first = Math.ceil(this.deck.beatsAt(t0)) - 1;
      for (let b = first; ; b++) {
        const x = phX + (d.firstBeat + b * d.spb - posSec) * ppS;
        if (x > W) break;
        if (x < 0) continue;
        const bar = ((b % 4) + 4) % 4 === 0;
        g.fillStyle = bar ? "rgba(235,235,245,0.55)" : "rgba(210,210,225,0.16)";
        g.fillRect(Math.round(x), 0, bar ? Math.round(this.dpr) : 1, bar ? H : 7 * this.dpr);
      }
    }
    // cue marker
    if (d.cue != null) {
      const x = phX + (d.cue / d.sr - posSec) * ppS;
      if (x >= -2 && x <= W + 2) {
        g.fillStyle = "#ff9c2e";
        g.fillRect(x, 0, 2, H);
        g.fillText("C", x + 3, 11 * this.dpr);
      }
    }
    // playhead
    g.fillStyle = "#f2f2f6";
    g.fillRect(phX - this.dpr / 2, 0, Math.max(1, this.dpr), H);
    g.fillStyle = "#f2f2f6";
    g.beginPath();
    g.moveTo(phX - 5 * this.dpr, 0); g.lineTo(phX + 5 * this.dpr, 0); g.lineTo(phX, 7 * this.dpr);
    g.closePath(); g.fill();
  }

  _drawOverview() {
    const d = this.deck, g = this.ovCtx, W = this.ovCv.width, H = this.ovCv.height;
    g.fillStyle = "#0b0b0f";
    g.fillRect(0, 0, W, H);
    const an = d.analysis;
    if (!an || !d.durSec) return;
    const yMid = H / 2;
    const step = Math.max(1, Math.floor(W / 512));
    for (let x = 0; x < W; x += step) {
      const bi = Math.min(511, Math.floor((x / W) * 512));
      const mn = an.oMin[bi], mx = an.oMax[bi];
      if (mn === 0 && mx === 0) continue;
      g.fillStyle = `rgb(${an.oColor[bi * 3]},${an.oColor[bi * 3 + 1]},${an.oColor[bi * 3 + 2]})`;
      g.fillRect(x, yMid - mx * yMid * 0.96, step, Math.max(1, (mx - mn) * yMid * 0.96));
    }
    if (d.loop.on) {
      const x0 = (d.loop.start / d.sr / d.durSec) * W, x1 = (d.loop.end / d.sr / d.durSec) * W;
      g.fillStyle = "rgba(255,150,40,0.25)";
      g.fillRect(x0, 0, Math.max(2, x1 - x0), H);
    }
    if (d.hc) for (let i = 0; i < 8; i++) {
      if (d.hc[i] == null) continue;
      g.fillStyle = HC_COLORS[i];
      g.fillRect(Math.round((d.hc[i] / d.sr / d.durSec) * W - this.dpr), 0, Math.round(2 * this.dpr), Math.round(7 * this.dpr));
    }
    if (d.cue != null) {
      g.fillStyle = "#ff9c2e";
      g.fillRect((d.cue / d.sr / d.durSec) * W, 0, Math.round(this.dpr), H);
    }
    const px = (d.posSec / d.durSec) * W;
    g.fillStyle = "rgba(255,255,255,0.25)";
    g.fillRect(0, 0, px, H);
    g.fillStyle = "#f2f2f6";
    g.fillRect(px - this.dpr / 2, 0, Math.max(1, this.dpr), H);
  }
}
