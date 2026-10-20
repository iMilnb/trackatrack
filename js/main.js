import { Deck } from "./audio/deck.js";
import { HC_COLORS } from "./audio/deck.js";
import { DeckScope } from "./waveform.js";
import { Engine } from "./audio/engine.js";
import { FX_TYPES } from "./audio/fx.js";
import { AudioRecorder, LoopRecorder } from "./audio/rec.js";
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
    hcs: [...mod.querySelectorAll(".d-hcs .hc")],
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
  els.loopInd.addEventListener("click", () => deck.loopToggle());
  for (const b of els.hcs) {
    const hi = +b.dataset.h;
    b.style.setProperty("--hc", HC_COLORS[hi]);
    b.addEventListener("pointerdown", (e) => { if (e.button !== 2) deck.hotcuePress(hi); });
    window.addEventListener("pointerup", () => deck.hotcueRelease(hi));
    b.addEventListener("contextmenu", (e) => { e.preventDefault(); deck.hotcueClear(hi); });
  }
  deck._mref = () => masterTempo();
  q(".d-info").addEventListener("dblclick", () => mod.classList.toggle("d-compact"));
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
  const lock = q(".s-lock");
  lock.addEventListener("click", () => {
    deck.keyLock = !deck.keyLock;
    lock.classList.toggle("on", deck.keyLock);
  });
  const keyk = makeKnob({ label: "KEY", value: 0.5, onInput: (v) => deck.setTranspose((v - 0.5) * 12) });
  q(".s-keyk").appendChild(keyk.el);
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

// ---- global panels, header utilities, master-clock extras ----
let cruiseOn = false;
let audioTried = false;
let audioRec = null;
let loopRec = null;
let arMeterUI = null;

function nudgeClock(dtm) {
  const d = clockDeck();
  const t = masterTempo();
  if (!d || !d.bpm || !t) return;
  setTempoBoth(d, clamp((t + dtm) / d.bpm - 1, -0.08, 0.08));
}

function schedTick() {
  const ctx = engine.ctx;
  const bpm = masterTempo();
  if (!bpm) return;
  if (schedTick._next < ctx.currentTime) schedTick._next = ctx.currentTime + 0.05;
  while (schedTick._next < ctx.currentTime + 0.15) {
    const t0 = schedTick._next;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = schedTick._beat % 4 === 0 ? 1568 : 1046;
    g.gain.setValueAtTime(0.001, t0);
    g.gain.exponentialRampToValueAtTime(0.25, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
    o.connect(g).connect(engine.cueDest);
    o.start(t0);
    o.stop(t0 + 0.06);
    schedTick._beat = (schedTick._beat + 1) % 4;
    schedTick._next += 60 / bpm;
  }
}

function wirePrefs() {
  const m = $("#prefsModal");
  $("#prefsBtn").addEventListener("click", () => {
    $("#prefSr").textContent = (engine.ctx.sampleRate / 1000).toFixed(1) + " kHz";
    $("#prefLat").textContent = engine.ctx.baseLatency ? (engine.ctx.baseLatency * 1000).toFixed(1) + " ms" : "–";
    $("#prefLimiter").checked = engine.limiterOn;
    m.classList.remove("hidden");
  });
  $("#prefsClose").addEventListener("click", () => m.classList.add("hidden"));
  m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); });
  $("#prefLimiter").addEventListener("change", (e) => {
    engine.setLimiter(e.target.checked);
    $("#limBtn").classList.toggle("on", engine.limiterOn);
  });
}

function wireGlobalPanels() {
  const setSide = (side, show) => {
    if (side === "L") {
      $("#unit1").classList.toggle("hidden", show !== "u1");
      $("#lrec").classList.toggle("hidden", show !== "lrec");
      $("#selU1").classList.toggle("on", show === "u1");
      $("#selLRec").classList.toggle("on", show === "lrec");
    } else {
      $("#unit2").classList.toggle("hidden", show !== "u2");
      $("#arec").classList.toggle("hidden", show !== "arec");
      $("#selU2").classList.toggle("on", show === "u2");
      $("#selARec").classList.toggle("on", show === "arec");
    }
  };
  $("#selU1").addEventListener("click", () => setSide("L", "u1"));
  $("#selLRec").addEventListener("click", () => setSide("L", "lrec"));
  $("#selU2").addEventListener("click", () => setSide("R", "u2"));
  $("#selARec").addEventListener("click", () => setSide("R", "arec"));

  // LOOP RECORDER
  $("#lrec").appendChild($("#lrecTpl").content.cloneNode(true));
  loopRec = new LoopRecorder(engine, () => masterTempo() || 120,
    (sel) => (sel === "m" ? decks.map((d) => d.deck.vol) : [decks[+sel].deck.vol]));
  $("#lrSrc").addEventListener("change", (e) => loopRec.setSource(e.target.value));
  document.querySelectorAll(".lr-size").forEach((b) => b.addEventListener("click", () => {
    loopRec.sizeBeats = +b.dataset.b;
    document.querySelectorAll(".lr-size").forEach((x) => x.classList.toggle("on", x === b));
    if (loopRec.capturing) loopRec.stopCapture();
  }));
  $("#lrRec").addEventListener("click", () => {
    if (loopRec.capturing) loopRec.stopCapture();
    else if (loopRec.buf) loopRec.startDub();
    else loopRec.startRec();
  });
  $("#lrPlay").addEventListener("click", () => { if (loopRec.playing) loopRec.stop(); else loopRec.play(); });
  $("#lrDel").addEventListener("click", () => loopRec.delete());
  $("#lrUndo").addEventListener("click", () => loopRec.undo());
  $("#lrRedo").addEventListener("click", () => loopRec.redo());
  const lrk = makeKnob({ label: "D/W", value: 0.7, bipolar: false, onInput: (v) => loopRec.setDW(v) });
  $("#lrDW").appendChild(lrk.el);

  // AUDIO RECORDER
  $("#arec").appendChild($("#arecTpl").content.cloneNode(true));
  audioRec = new AudioRecorder(engine);
  if (!audioRec.supported) { $("#arRec").disabled = true; $("#arRec").title = "MediaRecorder unsupported"; }
  arMeterUI = makeMeter($("#arMeter"), false);
  const arg = makeKnob({ label: "GAIN", value: 0.5, bipolar: false, onInput: (v) => engine.setRecGain(v) });
  $("#arGainK").appendChild(arg.el);
  engine.setRecGain(0.5);
  $("#arRec").addEventListener("click", () => {
    if (audioRec.recording) audioRec.cut(false);
    else { engine.resume(); audioRec.start(); }
  });
  $("#arCut").addEventListener("click", () => { if (audioRec.recording) audioRec.cut(true); });

  // Master clock extras (doc: hover controls — TAP, tick, ±)
  const tapTimes = [];
  $("#tapBtn").addEventListener("click", () => {
    const now = performance.now();
    tapTimes.push(now);
    while (tapTimes.length && now - tapTimes[0] > 2400) tapTimes.shift();
    if (tapTimes.length >= 3) {
      const ivs = [];
      for (let i = 1; i < tapTimes.length; i++) ivs.push(tapTimes[i] - tapTimes[i - 1]);
      const bpm = clamp(60000 / (ivs.reduce((a, b) => a + b, 0) / ivs.length), 40, 250);
      const d = clockDeck();
      if (d && d.bpm) setTempoBoth(d, clamp(bpm / d.bpm - 1, -0.08, 0.08));
    }
  });
  $("#mDownBtn").addEventListener("click", () => nudgeClock(-0.5));
  $("#mUpBtn").addEventListener("click", () => nudgeClock(0.5));
  let tickOn = false;
  let tickTimer = null;
  $("#tickBtn").addEventListener("click", (e) => {
    tickOn = !tickOn;
    e.currentTarget.classList.toggle("on", tickOn);
    if (tickOn) {
      schedTick._next = engine.ctx.currentTime + 0.05;
      schedTick._beat = 0;
      tickTimer = setInterval(schedTick, 60);
    } else clearInterval(tickTimer);
  });

  // Header utility buttons
  $("#maxBrowserBtn").addEventListener("click", (e) => {
    const on = document.body.classList.toggle("maxb");
    e.currentTarget.classList.toggle("on", on);
  });
  $("#cruiseBtn").addEventListener("click", (e) => {
    cruiseOn = !cruiseOn;
    e.currentTarget.classList.toggle("on", cruiseOn);
  });
  $("#tipBtn").addEventListener("click", (e) => {
    const on = e.currentTarget.classList.toggle("on");
    if (on) document.querySelectorAll("[data-tip]").forEach((el) => { el.title = el.dataset.tip; delete el.dataset.tip; });
    else document.querySelectorAll("[title]").forEach((el) => { el.dataset.tip = el.title; el.removeAttribute("title"); });
  });

  wirePrefs();
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
  slot.deck._cruise = false;
  return slot.deck.load(track).then(() => {
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
  // Connection indicator: blue = all controllers connected, orange = some, unlit = none
  const conn = $("#connInd");
  const ddj = /ddj|pioneer/i.test(s);
  conn.classList.toggle("b", ddj);
  conn.classList.toggle("o", !ddj && !!s && s !== "off");
  const dev = $("#devInfo");
  if (dev) dev.textContent = "MIDI: " + (s === "off" ? "–" : s);
  conn.title = "Connection indicator — " + (s === "off" ? "no controllers" : s);
};

function midiFlash() {
  const el = $("#midiInd");
  el.classList.add("b");
  clearTimeout(midiFlash._t);
  midiFlash._t = setTimeout(() => el.classList.remove("b"), 120);
}

function handleMidi(a, c) {
  if (!handleMidi._t || performance.now() - handleMidi._t > 80) { handleMidi._t = performance.now(); midiFlash(); }
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
  const _t0 = performance.now();
  try {
  for (const { deck, scope, ruler, mod } of decks) {
    deck.tick();
    scope.draw();
    ruler.draw();
    mod.parentElement.classList.toggle("playing", deck.playing);
  }
  if (frame._lf === undefined || frame._lf !== focused) {
    frame._lf = focused;
    for (let i = 0; i < decks.length; i++) {
      decks[i].mod.classList.toggle("focused", i === focused);
      if (mixer.strips[i]) mixer.strips[i].el.classList.toggle("focused", i === focused);
    }
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
  if (arMeterUI && audioRec && audioRec.recording) arMeterUI.setPeak(engine.recLevel());
  if (loopRec) $("#lrFill").style.width = (loopRec.progress() * 100).toFixed(1) + "%";
  for (const u of fxUIs) {
    if (!u) continue;
    for (const s of u.slots) s.relabel();
  }
  const mt = masterTempo();
  const mtEl = $("#mTempo");
  const txt = mt ? mt.toFixed(2) : "––.––";
  if (mtEl.textContent !== txt) mtEl.textContent = txt;
  if (++tickN % 120 === 0) {
    $("#clock").textContent = new Date().toTimeString().slice(0, 8);
    const ai = $("#audioInd");
    const st = engine.ctx.state;
    ai.classList.toggle("b", st === "running");
    ai.classList.toggle("ok", false);
    ai.classList.toggle("o", st === "suspended" && audioTried);
    ai.classList.toggle("r", st !== "running" && st !== "suspended");
    const lf = $("#loadFill");
    const pct = clamp((frame._load || 0) / 16.67, 0, 1);
    lf.style.width = (pct * 100).toFixed(0) + "%";
    lf.classList.toggle("hot", pct > 0.5);
    lf.classList.toggle("max", pct > 0.85);
    $("#loadPct").textContent = Math.round(pct * 100) + "%";
    if (audioRec) {
      const e = audioRec.elapsed;
      const mm = String(Math.floor(e / 60)).padStart(2, "0");
      const ss = String(Math.floor(e % 60)).padStart(2, "0");
      $("#arDisp").textContent = `${mm}:${ss} \u00b7 ${(audioRec.bytes / 1048576).toFixed(1)} MB`;
      $("#arTakes").textContent = audioRec.takes.length + (audioRec.takes.length === 1 ? " take" : " takes");
      const last = audioRec.takes[audioRec.takes.length - 1];
      const dl = $("#arDl");
      if (last) { dl.classList.remove("hidden"); dl.href = last.url; }
      $("#recInd").classList.toggle("rec", audioRec.recording);
      $("#arRec").classList.toggle("rec-on", audioRec.recording);
    }
    $("#lrLen").textContent = loopRec && loopRec.buf ? loopRec.buf.duration.toFixed(1) + "s" : "\u2013";
  }
  // Cruise Mode: automatically play the next track from the list when the deck ends
  for (const { deck } of decks) {
    if (cruiseOn && deck._wasPlaying && !deck.playing && deck.track && deck.durSec &&
        !deck._cruise && deck.posSec >= deck.durSec - 0.5) {
      deck._cruise = true;
      const arr = library.filtered() || library.tracks;
      const i = arr.findIndex((t) => t.id === deck.track.id);
      const nt = arr[(i + 1) % arr.length] || deck.track;
      loadTrack(nt, deck.idx).then(() => decks[deck.idx] && decks[deck.idx].deck.play());
    }
    deck._wasPlaying = deck.playing;
  }
  ledSync();
  } catch (e) {
    if (!frame._eT || performance.now() - frame._eT > 3000) {
      frame._eT = performance.now();
      window.__errs.push("FRAME: " + (e && e.message || e));
    }
  }
  frame._load = (frame._load || 0) * 0.95 + Math.max(0, performance.now() - _t0) * 0.05;
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
    wireGlobalPanels();

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

  window.addEventListener("pointerdown", () => { audioTried = true; engine.resume(); });
  engine.resume();
  $("#clock").textContent = new Date().toTimeString().slice(0, 8);
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
