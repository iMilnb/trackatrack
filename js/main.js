import { Engine } from "./audio/engine.js";
import { Deck } from "./audio/deck.js";
import { FX_TYPES } from "./audio/fx.js";
import { Library } from "./library.js";
import { MidiHub, BEATLOOP_SIZES } from "./midi/midi.js";
import { initMonitor } from "./midi/monitor.js";
import { DeckScope } from "./waveform.js";
import { makeKnob, makeVFader, makeHFader, makeMeter } from "./ui.js";
import { parseKey, camelotColor } from "./util.js";

const $ = (s) => document.querySelector(s);

const engine = new Engine();
const decks = [];
let focused = 0;

const mixer = {
  vol: [1, 1],
  xf: 0.5,
  assign: ["xf", "xf"],
  strips: [],
  xfFader: null,
};

function xfGain(i) {
  if (mixer.assign[i] !== "xf") return 1;
  return i === 0 ? Math.cos(mixer.xf * Math.PI / 2) : Math.sin(mixer.xf * Math.PI / 2);
}
function applyMixer() {
  const t = engine.ctx.currentTime;
  for (const { deck } of decks) {
    const g = mixer.vol[deck.idx] ** 2 * xfGain(deck.idx);
    deck.vol.gain.setTargetAtTime(g, t, 0.015);
  }
}

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
  const tf = makeVFader({ min: -0.08, max: 0.08, value: 0, onInput: (p) => deck.setTempoPct(p) });
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
  q(".master").addEventListener("click", () => { for (const o of decks) o.deck.setMaster(o.deck === deck); });
  q(".to-cue").addEventListener("click", () => deck.toCue());
  for (const b of els.loopBtns) b.addEventListener("click", () => deck.loopSetBeats(+b.dataset.n));
  els.lin.addEventListener("click", () => deck.loopIn());
  els.lout.addEventListener("click", () => deck.loopOut());
  q(".z-in").addEventListener("click", () => scope.zoom(2));
  q(".z-out").addEventListener("click", () => scope.zoom(0.5));
  q(".g-back").addEventListener("click", () => { deck.firstBeat -= deck.spb; });
  q(".g-fwd").addEventListener("click", () => { deck.firstBeat += deck.spb; });
  mod.addEventListener("pointerdown", () => { focused = i; });
  decks.push({ deck, scope, mod, els });
}

function buildStrip(i, letter) {
  const el = $("#stripTpl").content.firstElementChild.cloneNode(true);
  $("#strips").appendChild(el);
  const q = (s) => el.querySelector(s);
  q(".s-letter").textContent = letter;
  const deck = decks[i].deck;
  const knobs = {};
  for (const [k, label, val] of [["gain", "GAIN", 0.5], ["hi", "HI", 0.5], ["mid", "MID", 0.5], ["low", "LOW", 0.5]]) {
    const kn = makeKnob({
      label, value: val,
      onInput: (v) => (k === "gain" ? deck.setGain(v) : deck.setEq(k, v)),
    });
    knobs[k] = kn;
    q(".s-knobs").appendChild(kn.el);
  }
  const vol = makeVFader({ min: 0, max: 1, value: 1, onInput: (v) => { mixer.vol[i] = v; applyMixer(); } });
  q(".s-vol").appendChild(vol.el);
  const meter = makeMeter(q(".s-meter"), true);
  const pfl = q(".pfl");
  pfl.addEventListener("click", () => {
    deck.setPfl(!deck.pfl);
    pfl.classList.toggle("on", deck.pfl);
  });
  mixer.strips[i] = { el, deck, knobs, vol, meter, pfl, keyEl: q(".s-key"), lastKey: "" };
}

// ---- FX rack ----
const fxSlots = [];

function fxSlotUI(rack, name, chain) {
  const el = document.createElement("div");
  el.className = "fxmod";
  el.innerHTML = `
    <div class="fx-h"><span class="fx-title">${name}</span><button class="btn fx-on">FX</button></div>
    <select class="fx-type"><option value="">\u2014</option>${
      Object.entries(FX_TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("")}</select>
    <div class="fx-knobs"></div>`;
  rack.appendChild(el);
  const onB = el.querySelector(".fx-on"), sel = el.querySelector(".fx-type");
  const knobs = {};
  for (const [key, lbl, cb] of [["mix", "MIX", (v) => chain.setMix(v)], ["p1", "P1", (v) => chain.setP1(v)], ["p2", "P2", (v) => chain.setP2(v)]]) {
    const kn = makeKnob({ label: lbl, value: 0.5, bipolar: false, onInput: cb });
    knobs[key] = kn;
    el.querySelector(".fx-knobs").appendChild(kn.el);
  }
  const relabel = () => {
    const F = FX_TYPES[chain.type];
    knobs.p1.el.querySelector(".knob-label").textContent = F ? F.p1 : "P1";
    knobs.p2.el.querySelector(".knob-label").textContent = F ? F.p2 : "P2";
    if (F) { knobs.p1.set(F.d[0], false); knobs.p2.set(F.d[1], false); }
  };
  const setType = (t) => { sel.value = t || ""; chain.setType(t); relabel(); };
  const cycle = () => {
    const keys = Object.keys(FX_TYPES);
    setType(keys[keys.indexOf(chain.type) + 1] || keys[0]);
  };
  const setOn = (on) => { chain.setEnabled(on); onB.classList.toggle("on", on); };
  onB.addEventListener("click", () => setOn(!chain.enabled));
  sel.addEventListener("change", () => setType(sel.value || null));
  const slot = { name, chain, ui: { el, onB, sel, knobs }, setType, cycle, setOn };
  fxSlots.push(slot);
  return slot;
}

function buildFxRack() {
  const rack = $("#fxrack");
  fxSlotUI(rack, "DECK A", decks[0].deck.fx);
  fxSlotUI(rack, "DECK B", decks[1].deck.fx);
  fxSlotUI(rack, "MASTER 1", engine.masterFx[0]);
  fxSlotUI(rack, "MASTER 2", engine.masterFx[1]);
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
  slot.deck.load(track).catch((e) => {
    console.error("load failed", e);
    slot.els.state.textContent = "LOAD ERROR";
  });
  library.setDeckTrack(slot.deck.idx, track.id);
}

function getMaster(excludeIdx) {
  const sel = decks.filter((d) => d.deck.idx !== excludeIdx && d.deck.bpm);
  return (sel.find((d) => d.deck.master) || sel.find((d) => d.deck.playing) || sel[0] || {}).deck || null;
}
function doSync(deck) {
  const m = getMaster(deck.idx);
  if (m) deck.syncTo(m);
}

// ---- MIDI ----
const ledCache = {};
const hub = new MidiHub(handleMidi, null);
initMonitor(hub);
hub.onStatus = (s) => {
  const el = $("#midiStatus");
  el.textContent = "MIDI: " + s;
  el.classList.toggle("ok", /ddj|pioneer/i.test(s));
};

function handleMidi(a, c) {
  if (engine.ctx.state !== "running") engine.resume();
  const fxm = /^fx(On|Type|Mix|P1|P2)([ABCD])$/.exec(a);
  if (fxm) {
    const s = fxSlots["ABCD".indexOf(fxm[2])];
    if (!s) return;
    switch (fxm[1]) {
      case "On": s.setOn(!s.chain.enabled); break;
      case "Type": if (c.pressed !== false) s.cycle(); break;
      case "Mix": s.chain.setMix(c.value); s.ui.knobs.mix.set(c.value, false); break;
      case "P1": s.chain.setP1(c.value); s.ui.knobs.p1.set(c.value, false); break;
      case "P2": s.chain.setP2(c.value); s.ui.knobs.p2.set(c.value, false); break;
    }
    return;
  }
  const d = c.deck >= 0 ? decks[c.deck % 2].deck : null;
  if (!d && a !== "crossfader" && a !== "xfCurve") return;
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
    case "needle": if (d.durSec) d.seekSec(c.value * d.durSec); break;
    case "crossfader": mixer.xf = c.value; if (mixer.xfFader) mixer.xfFader.set(c.value); applyMixer(); break;
    case "xfAssign": if (c.pressed) { mixer.assign[d.idx] = c.index === 2 ? "free" : "xf"; applyMixer(); } break;
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

function toggleQuantize() {
  engine.quantize = engine.quantize > 0 ? 0 : 4;
  const b = $("#qBtn");
  b.textContent = `Q:${engine.quantize || "off"}`;
  b.classList.toggle("on", engine.quantize > 0);
}

// ---- frame loop ----
let masterMeter = null;
function frame() {
  for (const { deck, scope } of decks) { deck.tick(); scope.draw(); }
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
  masterMeter.setPeak(engine.masterPeak());
  for (const s of fxSlots) s.ui.onB.classList.toggle("on", s.chain.enabled);
  ledSync();
  requestAnimationFrame(frame);
}

// ---- boot ----
(async function boot() {
  buildDeck(0, "A", "#deckslotA");
  buildDeck(1, "B", "#deckslotB");
  await Promise.all(decks.map((d) => d.deck.init()));
  buildFxRack();
  try {
  buildStrip(0, "A");
  buildStrip(1, "B");  mixer.xfFader = makeHFader({ min: 0, max: 1, value: 0.5, onInput: (v) => { mixer.xf = v; applyMixer(); } });
  $("#xfader").appendChild(mixer.xfFader.el);
  applyMixer();
  masterMeter = makeMeter($("#masterMeter"), false);

  engine.setMasterVolume(+$("#masterVol").value);
  engine.setCueLevel(+$("#cueLevel").value);
  $("#masterVol").addEventListener("input", (e) => engine.setMasterVolume(+e.target.value));
  $("#cueLevel").addEventListener("input", (e) => engine.setCueLevel(+e.target.value));

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

  library.load().catch((e) => console.error(e));
  hub.init();
  } catch (e) {
    window.__errs.push("BOOT: " + (e && e.stack || e));
    console.error("boot error", e);
  }

  window.addEventListener("pointerdown", () => engine.resume());
  engine.resume();
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
