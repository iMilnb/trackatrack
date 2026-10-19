import { Deck } from "./audio/deck.js";
import { DeckScope } from "./waveform.js";
import { Engine } from "./audio/engine.js";
import { FX_TYPES } from "./audio/fx.js";
import { Library } from "./library.js";
import { MidiHub, BEATLOOP_SIZES } from "./midi/midi.js";
import { initMonitor } from "./midi/monitor.js";
import { makeKnob, makeVFader, makeHFader, makeMeter } from "./ui.js";
import { parseKey, camelotColor, clamp } from "./util.js";

const $ = (s) => document.querySelector(s);

const engine = new Engine();
const decks = [];
let focused = 0;

const mixer = {
  vol: [1, 1],
  xf: 0.5,
  strips: [],
  xfFader: null,
  linked: false,
};

// master clock (Global section)
const mclock = { auto: true, idx: 0 };

function xfGain(i) {
  return i === 0 ? Math.cos(mixer.xf * Math.PI / 2) : Math.sin(mixer.xf * Math.PI / 2);
}
function applyMixer() {
  const t = engine.ctx.currentTime;
  for (const { deck } of decks) {
    const g = mixer.vol[deck.idx] ** 2 * xfGain(deck.idx);
    deck.vol.gain.setTargetAtTime(g, t, 0.015);
  }
}

// ---- FX unit routing (channel inserts) ----
function applyFxRouting() {
  for (const { deck } of decks) if (deck.fxIn) deck.fxIn.disconnect();
  for (const u of engine.units) { u.in.disconnect(); u.out.disconnect(); }
  for (const { deck } of decks) {
    if (deck.route != null) {
      const u = engine.units[deck.route];
      deck.fxIn.connect(u.in);
      u.out.connect(deck.vol);
    } else {
      deck.fxIn.connect(deck.vol);
    }
  }
  for (const s of mixer.strips) refreshStripFx(s);
}
function refreshStripFx(s) {
  if (!s) return;
  s.sfx1.classList.toggle("on", s.deck.route === 0);
  s.sfx2.classList.toggle("on", s.deck.route === 1);
}

function setTempoBoth(d, p) {
  d.setTempoPct(p);
  d.els.tFader && d.els.tFader.set(p);
  if (mixer.linked) {
    const o = decks[1 - d.idx] && decks[1 - d.idx].deck;
    if (o && o !== d) { o.setTempoPct(p); o.els.tFader && o.els.tFader.set(p); }
  }
}

// ---- beat ruler ----
function makeRuler(deck, cv) {
  const c = cv.getContext("2d");
  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, cv.clientWidth * dpr | 0), h = Math.max(1, cv.clientHeight * dpr | 0);
    if (cv.width !== w) cv.width = w;
    if (cv.height !== h) cv.height = h;
    c.clearRect(0, 0, w, h);
    if (!deck.bpm) return;
    const vis = 8, ppb = w / vis;
    const b0 = deck.beats - vis / 2;
    const ref = Math.round(deck.firstBeat);
    for (let b = Math.ceil(b0); b < b0 + vis; b++) {
      const x = (b - b0) * ppb;
      const isBar = ((b - ref) % 4 + 4) % 4 === 0;
      c.fillStyle = isBar ? "#cfd2d8" : "#5a5d63";
      c.fillRect(x - dpr / 2, isBar ? h * 0.08 : h * 0.3, dpr, isBar ? h * 0.84 : h * 0.4);
    }
    c.fillStyle = deck.playing ? "#a8e04a" : "#8a8d94";
    c.fillRect(w / 2 - dpr / 2, 0, dpr, h);
  };
  let dragging = false, lastX = 0;
  cv.addEventListener("pointerdown", (e) => {
    dragging = true; lastX = e.clientX;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener("pointermove", (e) => {
    if (!dragging || !deck.bpm) return;
    const dx = e.clientX - lastX; lastX = e.clientX;
    deck.firstBeat -= dx / (cv.clientWidth / 8);
  });
  window.addEventListener("pointerup", () => (dragging = false));
  return { draw };
}

// ---- decks ----
function buildDeck(i, letter, slotSel) {
  const mod = $("#deckTpl").content.firstElementChild.cloneNode(true);
  $(slotSel).appendChild(mod);
  const q = (s) => mod.querySelector(s);
  const els = {
    letter: q(".d-letter"), title: q(".d-title"), artist: q(".d-artist"),
    remain: q(".d-remain"), dur: q(".d-dur"), bpm: q(".d-bpm"), key: q(".d-key"),
    state: q(".d-state"), play: q(".play"), cue: q(".cue"), cup: q(".cup"),
    flx: q(".flx"), rev: q(".rev"), sync: q(".sync"), master: q(".master"),
    loopBtns: [...mod.querySelectorAll(".lb")], lin: q(".lin"), lout: q(".lout"),
    loopInd: q(".d-loopind"), tPct: q(".t-pct"),
  };
  const deck = new Deck(i, letter, engine, els);
  const scope = new DeckScope(deck, q(".d-detail"), q(".d-ov"), q(".z-lbl"));
  const ruler = makeRuler(deck, q(".d-ruler"));
  const tf = makeVFader({ min: -0.08, max: 0.08, value: 0, onInput: (p) => setTempoBoth(deck, p) });
  els.tFader = tf;
  q(".tempo").appendChild(tf.el);

  q(".play").addEventListener("click", () => deck.toggle());
  q(".cue").addEventListener("pointerdown", () => deck.pressCue(true));
  window.addEventListener("pointerup", () => deck.pressCue(false));
  q(".cup").addEventListener("click", () => deck.pressCup());
  q(".flx").addEventListener("click", () => { deck.flx = !deck.flx; });
  q(".rev").addEventListener("pointerdown", () => deck.pressRev(true));
  window.addEventListener("pointerup", () => deck.pressRev(false));
  q(".sync").addEventListener("click", () => doSync(deck));
  q(".master").addEventListener("click", () => {
    for (const o of decks) o.deck.setMaster(o.deck === deck);
    mclock.idx = deck.idx;
  });
  q(".to-cue").addEventListener("click", () => deck.toCue());
  q(".reveal").addEventListener("click", () => library.reveal(deck.track));
  for (const b of els.loopBtns) b.addEventListener("click", () => deck.loopSetBeats(+b.dataset.n));
  els.lin.addEventListener("click", () => deck.loopIn());
  els.lout.addEventListener("click", () => deck.loopOut());
  q(".lhalf").addEventListener("click", () => deck.loopHalve());
  q(".ldbl").addEventListener("click", () => deck.loopDouble());
  q(".z-in").addEventListener("click", () => scope.zoom(2));
  q(".z-out").addEventListener("click", () => scope.zoom(0.5));
  q(".prev").addEventListener("click", () => stepLoad(deck, -1));
  q(".next").addEventListener("click", () => stepLoad(deck, 1));
  mod.addEventListener("pointerdown", () => { focused = i; });
  decks.push({ deck, scope, ruler, mod, els });
}

function stepLoad(deck, dir) {
  library.moveSel(dir);
  const t = library.selectedTrack();
  if (t) loadTrack(t, deck.idx);
}

// ---- mixer strips ----
function buildStrip(i, letter) {
  const el = $("#stripTpl").content.firstElementChild.cloneNode(true);
  el.classList.add("l" + letter);
  $("#strips").appendChild(el);
  const q = (s) => el.querySelector(s);
  q(".s-letter").textContent = letter;
  const deck = decks[i].deck;
  const knobs = {};
  for (const [k, label, cb] of [
    ["gain", "GAIN", (v) => deck.setGain(v)],
    ["hi", "HI", (v) => deck.setEq("hi", v)],
    ["mid", "MID", (v) => deck.setEq("mid", v)],
    ["low", "LOW", (v) => deck.setEq("low", v)],
    ["fltr", "FLTR", (v) => deck.setFilter(v)],
  ]) {
    const kn = makeKnob({ label, value: 0.5, onInput: cb });
    knobs[k] = kn;
    q(".s-knobs").appendChild(kn.el);
  }
  const setRoute = (r) => { deck.route = deck.route === r ? null : r; applyFxRouting(); };
  const sfx1 = q(".sfx1"), sfx2 = q(".sfx2");
  sfx1.addEventListener("click", () => setRoute(0));
  sfx2.addEventListener("click", () => setRoute(1));
  const vol = makeVFader({ min: 0, max: 1, value: 1, onInput: (v) => { mixer.vol[i] = v; applyMixer(); } });
  q(".s-vol").appendChild(vol.el);
  const meter = makeMeter(q(".s-meter"), true);
  const pfl = q(".pfl");
  pfl.addEventListener("click", () => {
    deck.setPfl(!deck.pfl);
    pfl.classList.toggle("on", deck.pfl);
  });
  mixer.strips[i] = { el, deck, knobs, vol, meter, pfl, sfx1, sfx2, keyEl: q(".s-key"), lastKey: "" };
}

// ---- FX units (global section) ----
const fxUIs = [];

function buildUnit(n, slotSel) {
  const unit = engine.units[n - 1];
  const tpl = $("#unitTpl").content.firstElementChild.cloneNode(true);
  const host = $(slotSel);
  host.replaceWith(tpl);
  tpl.id = "unit" + n;
  const q = (s) => tpl.querySelector(s);
  q(".u-num").textContent = n + ":";

  const dwKnob = makeKnob({ label: "D/W", value: 0.5, bipolar: false, onInput: (v) => unit.setDw(v) });
  q(".u-dw").appendChild(dwKnob.el);

  const typeOpts = `<option value="">—</option>` +
    Object.entries(FX_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  const slots = unit.slots.map((chain, si) => {
    const sel = document.createElement("select");
    sel.className = "u-sel";
    sel.innerHTML = typeOpts;
    q(".u-sels").appendChild(sel);
    const knob = makeKnob({ label: "P1", value: 0.5, bipolar: false, onInput: (v) => chain.setP1(v) });
    const btn = document.createElement("button");
    btn.className = "btn u-fxb";
    btn.textContent = "OFF";
    const pcol = document.createElement("div");
    pcol.className = "u-pcol";
    pcol.append(knob.el, btn);
    q(".u-param").appendChild(pcol);
    const relabel = () => {
      const F = FX_TYPES[chain.type];
      knob.el.querySelector(".knob-label").textContent = F ? F.p1 : "P1";
      btn.textContent = chain.enabled && F ? F.label : "OFF";
      btn.classList.toggle("on", chain.enabled && !!F);
    };
    const setType = (t) => {
      sel.value = t || "";
      chain.setType(t);
      if (t) knob.set(chain.p1, false);
      relabel();
    };
    const cycle = () => {
      const keys = Object.keys(FX_TYPES);
      setType(keys[keys.indexOf(chain.type) + 1] || keys[0]);
    };
    const toggle = () => { chain.setEnabled(!chain.enabled); relabel(); };
    btn.addEventListener("click", () => { if (chain.type) toggle(); });
    sel.addEventListener("change", () => setType(sel.value || null));
    return { chain, knob, btn, sel, setType, cycle, toggle, relabel };
  });

  const rst = () => { unit.reset(); for (const s of slots) s.knob.set(s.chain.p1, false); };
  q(".u-rstb").addEventListener("click", rst);

  fxUIs[n - 1] = { unit, slots, dwKnob, rst };
}

// ---- master control panel ----
function setQuantUI() {
  const on = engine.quantize > 0;
  $("#snapBtn").classList.toggle("on", on);
  const qb = $("#quantBtn");
  qb.textContent = on ? `QUANT ${engine.quantize}` : "QUANT";
  qb.classList.toggle("on", on);
}
function toggleSnap() {
  engine.quantize = engine.quantize > 0 ? 0 : 4;
  setQuantUI();
}
function cycleQuant() {
  const seq = [1, 2, 4, 8];
  const i = seq.indexOf(engine.quantize);
  engine.quantize = i < 0 ? 1 : seq[(i + 1) % 4];
  setQuantUI();
}
function toggleQuantize() { toggleSnap(); }

function clockDeck() {
  if (mclock.auto) {
    const s = decks.find((d) => d.deck.master && d.deck.bpm)
      || decks.find((d) => d.deck.playing && d.deck.bpm)
      || decks.find((d) => d.deck.bpm);
    return s ? s.deck : null;
  }
  const d = decks[mclock.idx] && decks[mclock.idx].deck;
  return d && d.bpm ? d : null;
}
function masterTempo() {
  const d = clockDeck();
  return d ? d.bpm * d.tempo : 0;
}
function wireMasterControl() {
  $("#snapBtn").addEventListener("click", toggleSnap);
  $("#quantBtn").addEventListener("click", cycleQuant);
  $("#linkBtn").addEventListener("click", (e) => {
    mixer.linked = !mixer.linked;
    e.target.classList.toggle("on", mixer.linked);
  });
  $("#autoBtn").addEventListener("click", () => {
    mclock.auto = true;
    $("#autoBtn").classList.add("on");
    $("#mclockBtn").classList.remove("on");
    $("#mTempo").classList.remove("manual");
  });
  $("#mclockBtn").addEventListener("click", () => {
    mclock.auto = false;
    mclock.idx = focused;
    $("#autoBtn").classList.remove("on");
    $("#mclockBtn").classList.add("on");
    $("#mTempo").classList.add("manual");
  });
  const mt = $("#mTempo");
  let drag = null;
  mt.addEventListener("pointerdown", (e) => {
    drag = { y: e.clientY, t: masterTempo() };
    mt.setPointerCapture(e.pointerId);
  });
  mt.addEventListener("pointermove", (e) => {
    if (!drag || !drag.t) return;
    const nt = clamp(drag.t + (drag.y - e.clientY) * 0.05, 40, 250);
    const d = clockDeck();
    if (!d || !d.bpm) return;
    setTempoBoth(d, clamp(nt / d.bpm - 1, -0.08, 0.08));
  });
  window.addEventListener("pointerup", () => (drag = null));

  const main = makeKnob({ label: "MAIN", value: 0.85, bipolar: false, onInput: (v) => engine.setMasterVolume(v) });
  $("#mainKnob").appendChild(main.el);
  engine.setMasterVolume(0.85);
  const lim = $("#limBtn");
  lim.addEventListener("click", () => {
    engine.setLimiter(!engine.limiterOn);
    lim.classList.toggle("on", engine.limiterOn);
  });
  setQuantUI();
}

// ---- tracks / decks ----
const library = new Library($("#library"), { onLoad: (t) => loadTrack(t) });

function pickFreeSlot() {
  const empty = decks.find((d) => !d.deck.track);
  if (empty) return empty;
  return decks.find((d) => d !== decks[focused] && !d.deck.playing) || decks[focused];
}

function loadTrack(track, targetIdx = null) {
  const slot = targetIdx != null ? decks[targetIdx] : pickFreeSlot();
  slot.deck.load(track).then(() => {
    library.noteHistory(track);
    library.setDeckTrack(slot.deck.idx, track.id);
  }).catch((e) => {
    console.error("load failed", e);
    slot.els.state.textContent = "LOAD ERROR";
  });
}

function getMaster(excludeIdx) {
  const sel = decks.filter((d) => d.deck.idx !== excludeIdx && d.deck.bpm);
  return (sel.find((d) => d.deck.master) || sel.find((d) => d.deck.playing) || sel[0] || {}).deck || null;
}
function doSync(deck) {
  if (!mclock.auto && masterTempo() && deck.bpm) {
    setTempoBoth(deck, clamp(masterTempo() / deck.bpm - 1, -0.08, 0.08));
    deck.synced = true;
    return;
  }
  const m = getMaster(deck.idx);
  if (m) deck.syncTo(m);
}

// ---- MIDI ----
const ledCache = {};
const hub = new MidiHub(handleMidi, null);
initMonitor(hub);
hub.onStatus = (s) => {
  const el = $("#midiStatus");
  el.textContent = "MIDI " + s;
  const ok = /ddj|pioneer/i.test(s);
  el.classList.toggle("ok", ok);
  el.classList.toggle("err", !ok && s !== "off");
};

function handleMidi(a, c) {
  if (engine.ctx.state !== "running") engine.resume();
  const um = /^u([12])\.(?:s([123])\.)?(on|type|mix|p1|p2|dw|rst)$/.exec(a);
  if (um) {
    const u = fxUIs[+um[1] - 1];
    if (!u) return;
    const what = um[3];
    if (what === "dw") { u.unit.setDw(c.value); u.dwKnob.set(c.value, false); return; }
    if (what === "rst") { if (c.pressed !== false) u.rst(); return; }
    const s = um[2] ? u.slots[+um[2] - 1] : null;
    if (!s) return;
    switch (what) {
      case "on": if (s.chain.type) s.toggle(); break;
      case "type": if (c.pressed !== false) s.cycle(); break;
      case "mix": s.chain.setMix(c.value); break;
      case "p1": s.chain.setP1(c.value); s.knob.set(c.value, false); s.relabel(); break;
      case "p2": s.chain.setP2(c.value); break;
    }
    return;
  }
  const d = c.deck >= 0 ? decks[c.deck % 2].deck : null;
  if (!d && a !== "crossfader") return;
  switch (a) {
    case "play": if (c.pressed !== false) d.toggle(); break;
    case "cue": d.pressCue(c.pressed); break;
    case "sync": if (c.pressed !== false) doSync(d); break;
    case "shift": d.shift = c.pressed; break;
    case "load": if (c.pressed !== false) { const t = library.selectedTrack(); if (t) loadTrack(t, d.idx); } break;
    case "reverse": d.pressRev(c.pressed); break;
    case "quantize": if (c.pressed) toggleQuantize(); break;
    case "loopIn": if (c.pressed !== false) d.loopIn(); break;
    case "loopOut": if (c.pressed !== false) d.loopOut(); break;
    case "loopExit": if (c.pressed !== false) d.loopExit(); break;
    case "loopHalve": if (c.pressed !== false) d.loopHalve(); break;
    case "loopDouble": if (c.pressed !== false) d.loopDouble(); break;
    case "autoLoop": if (c.pressed !== false) d.loopSetBeats(4); break;
    case "beatloop": { if (c.pressed !== false) { const n = BEATLOOP_SIZES[c.index]; if (n) d.loopSetBeats(n); } } break;
    case "tempo": d.setTempoPct((c.value - 0.5) * 0.16); d.els.tFader.set((c.value - 0.5) * 0.08); break;
    case "vol": mixer.vol[d.idx] = c.value; mixer.strips[d.idx].vol.set(c.value); applyMixer(); break;
    case "gain": d.setGain(c.value); mixer.strips[d.idx].knobs.gain.set(c.value); break;
    case "hi": d.setEq("hi", c.value); mixer.strips[d.idx].knobs.hi.set(c.value); break;
    case "mid": d.setEq("mid", c.value); mixer.strips[d.idx].knobs.mid.set(c.value); break;
    case "low": d.setEq("low", c.value); mixer.strips[d.idx].knobs.low.set(c.value); break;
    case "filter": d.setFilter(c.value); mixer.strips[d.idx].knobs.fltr.set(c.value); break;
    case "needle": if (d.durSec) d.seekSec(c.value * d.durSec); break;
    case "crossfader": mixer.xf = c.value; if (mixer.xfFader) mixer.xfFader.set(c.value); applyMixer(); break;
    case "jogTick": {
      const dv = c.value > 64 ? c.value - 128 : c.value;
      d.bendStart(dv >= 0 ? 0.5 : -0.5);
      clearTimeout(d._bT);
      d._bT = setTimeout(() => d.bendEnd(), 130);
      break;
    }
  }
}

function setLed(i, act, on, index = 0) {
  const k = `${i}:${act}:${index}`;
  if (ledCache[k] === on) return;
  ledCache[k] = on;
  hub.setLED(i, act, on, index);
}
function ledSync() {
  for (const { deck } of decks) {
    const i = deck.idx;
    setLed(i, "play", deck.playing);
    setLed(i, "cue", deck.cue != null && deck.cue > 0);
    setLed(i, "sync", deck.synced);
    setLed(i, "reverse", deck.reversed);
    for (let p = 0; p < 8; p++) setLed(i, "beatloop", deck.loop.on && deck.loop.beats === BEATLOOP_SIZES[p], p);
  }
  setLed(0, "quantize", engine.quantize > 0);
}

// ---- frame loop ----
let masterMeter = null;
let tickN = 0;
function frame() {
  try {
  for (const { deck, scope, ruler, mod } of decks) {
    deck.tick();
    scope.draw();
    ruler.draw();
    mod.parentElement.classList.toggle("playing", deck.playing);
  }
  for (const s of mixer.strips) {
    if (!s) continue;
    s.meter.setPeak(s.deck.meterPeak());
    const cam = s.deck.track ? parseKey(s.deck.track.key) : null;
    const txt = cam ? cam.text : "";
    if (txt !== s.lastKey) {
      s.lastKey = txt;
      s.keyEl.textContent = txt;
      s.keyEl.style.color = cam ? camelotColor(cam) : "#555";
    }
  }
  if (masterMeter) masterMeter.setPeak(engine.masterPeak());
  for (const u of fxUIs) {
    if (!u) continue;
    for (const s of u.slots) s.relabel();
  }
  const mt = masterTempo();
  const mtEl = $("#mTempo");
  const txt = mt ? mt.toFixed(2) : "––.––";
  if (mtEl.textContent !== txt) mtEl.textContent = txt;
  if (++tickN % 30 === 0) {
    $("#clock").textContent = new Date().toTimeString().slice(0, 5);
    $("#audioInd").classList.toggle("ok", engine.ctx.state === "running");
  }
  ledSync();
  } catch (e) {
    if (!frame._eT || performance.now() - frame._eT > 3000) {
      frame._eT = performance.now();
      window.__errs.push("FRAME: " + (e && e.message || e));
    }
  }
  requestAnimationFrame(frame);
}

// ---- boot ----
(async function boot() {
  buildDeck(0, "A", "#deckslotA");
  buildDeck(1, "B", "#deckslotB");
  await Promise.all(decks.map((d) => d.deck.init()));
  buildUnit(1, "#unit1");
  buildUnit(2, "#unit2");
  try {
    buildStrip(0, "A");
    buildStrip(1, "B");
    decks[0].deck.route = 0;
    decks[1].deck.route = 1;
    applyFxRouting();
    mixer.xfFader = makeHFader({ min: 0, max: 1, value: 0.5, onInput: (v) => { mixer.xf = v; applyMixer(); } });
    $("#xfader").appendChild(mixer.xfFader.el);
    applyMixer();
    masterMeter = makeMeter($("#masterMeter"), false);

    const cueKnob = makeKnob({ label: "CUE", value: 0.7, bipolar: false, onInput: (v) => engine.setCueLevel(v) });
    $("#cueKnob").appendChild(cueKnob.el);
    engine.setCueLevel(0.7);
    wireMasterControl();

    try {
      const devs = await Promise.race([
        engine.listOutputs(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("enumerate timeout")), 3000)),
      ]);
      const opts = '<option value="">System default</option>' +
        devs.map((d, i) => `<option value="${d.deviceId}">${d.label || "output " + (i + 1)}</option>`).join("");
      $("#masterOut").innerHTML = opts;
      $("#cueOut").innerHTML = opts;
      $("#masterOut").addEventListener("change", (e) => engine.setMasterSink(e.target.value));
      $("#cueOut").addEventListener("change", (e) => engine.setCueSink(e.target.value));
    } catch (e) { console.warn("device enum failed", e); }

    $("#monBtn").addEventListener("click", () => initMonitor.toggle && initMonitor.toggle());
    $("#fsBtn").addEventListener("click", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    });

    library.load().catch((e) => console.error(e));
    hub.init();
  } catch (e) {
    window.__errs.push("BOOT: " + (e && e.stack || e));
    console.error("boot error", e);
  }

  window.addEventListener("pointerdown", () => engine.resume());
  engine.resume();
  $("#clock").textContent = new Date().toTimeString().slice(0, 5);
  window.addEventListener("keydown", (e) => {
    const t = e.target.tagName;
    if (t === "INPUT" || t === "SELECT" || t === "TEXTAREA") return;
    if (e.code === "Space") { decks[focused].deck.toggle(); e.preventDefault(); }
    else if (e.key === "Enter") library.loadSelected();
    else if (e.key === "ArrowDown") { library.moveSel(1); e.preventDefault(); }
    else if (e.key === "ArrowUp") { library.moveSel(-1); e.preventDefault(); }
    else if (e.key === "l" || e.key === "L") library.loadSelected();
  });
  requestAnimationFrame(frame);

  if (/test=load/.test(location.search)) {
    const start = () => {
      const t = library.tracks[0];
      loadTrack(t, 0);
      const dk = decks[0].deck;
      setInterval(() => {
        document.title = `TEST state=${dk.state} dur=${dk.durSec ? dk.durSec.toFixed(1) : "-"} bpm=${dk.bpm || "-"} fb=${dk.firstBeat.toFixed(3)} pos=${dk.posSec.toFixed(2)} play=${dk.playing}`;
      }, 400);
    };
    const waitT = setInterval(() => { if (library.tracks.length) { clearInterval(waitT); start(); } }, 100);
  }
})();
