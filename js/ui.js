import { clamp } from "./util.js";

/** Rotary knob: drag vertically or wheel to change. value in [0,1]. */
export function makeKnob({ label = "", value = 0.5, bipolar = true, onInput }) {
  const wrap = document.createElement("div");
  wrap.className = "knobwrap";
  wrap.innerHTML = `<div class="knob"><div class="knob-dial"></div></div><div class="knob-label">${label}</div>`;
  const dial = wrap.querySelector(".knob-dial");
  let v = value;
  const paint = () => {
    const deg = -135 + v * 270;
    dial.style.transform = `rotate(${deg}deg)`;
    dial.classList.toggle("centered", bipolar && Math.abs(v - 0.5) < 0.015);
  };
  const set = (nv, fire = true) => {
    v = clamp(nv, 0, 1);
    paint();
    if (fire && onInput) onInput(v);
  };
  let dragging = false, startY = 0, startV = 0;
  const el = wrap.querySelector(".knob");
  el.addEventListener("pointerdown", (e) => {
    dragging = true; startY = e.clientY; startV = v;
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    set(startV + (startY - e.clientY) / 150);
  });
  el.addEventListener("pointerup", () => (dragging = false));
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(v - Math.sign(e.deltaY) * 0.03); }, { passive: false });
  el.addEventListener("dblclick", () => set(0.5));
  paint();
  return { el: wrap, set: (nv) => set(nv, false), get: () => v };
}

/** Vertical fader (input[type=range] with vertical writing mode). */
export function makeVFader({ min = 0, max = 1, value = 1, step = 0.001, onInput }) {
  const el = document.createElement("input");
  el.type = "range";
  el.className = "vfader";
  el.min = min; el.max = max; el.step = step; el.value = value;
  el.addEventListener("input", () => onInput && onInput(+el.value));
  return { el, set: (v) => { el.value = v; }, get: () => +el.value };
}

export function makeHFader({ min = 0, max = 1, value = 0.5, step = 0.001, onInput }) {
  const el = document.createElement("input");
  el.type = "range";
  el.className = "hfader";
  el.min = min; el.max = max; el.step = step; el.value = value;
  el.addEventListener("input", () => onInput && onInput(+el.value));
  return { el, set: (v) => { el.value = v; }, get: () => +el.value };
}

/** Simple dB peak meter on a small canvas. */
export function makeMeter(canvas, vertical = true) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  let hold = -60, holdAt = 0;
  return {
    setPeak(peakLin) {
      const db = peakLin > 1e-6 ? 20 * Math.log10(peakLin) : -60;
      const now = performance.now();
      if (db > hold) { hold = db; holdAt = now; }
      else hold = Math.max(db, hold - (now - holdAt) * 0.00012 > -60 ? Math.max(db, hold - 6 * ((now - holdAt) / 1000)) : -60);
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#101014";
      ctx.fillRect(0, 0, w, h);
      const frac = clamp((hold + 60) / 60, 0, 1);
      const len = (vertical ? h : w) * frac;
      const grad = vertical
        ? ctx.createLinearGradient(0, h, 0, 0)
        : ctx.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, "#2f3");
      grad.addColorStop(0.72, "#cf3");
      grad.addColorStop(0.9, "#fc2");
      grad.addColorStop(1, "#f33");
      ctx.fillStyle = grad;
      if (vertical) ctx.fillRect(0, h - len, w, len);
      else ctx.fillRect(0, 0, len, h);
      if (hold > -0.5) {
        ctx.fillStyle = "#f33";
        if (vertical) ctx.fillRect(0, 0, w, 3 * dpr);
        else ctx.fillRect(w - 3 * dpr, 0, 3 * dpr, h);
      }
    },
  };
}

export function btn(wrap, sel) { return wrap.querySelector(sel); }
