import { MAPPING } from "./mapping.js";
import { getJSONOrNull } from "../server-api.js";

/** Actions that expect 14-bit MSB+LSB pairs (SX sends two CCs). */
const PAIRED = new Set(["tempo", "vol", "gain", "hi", "mid", "low", "deckfilter", "crossfader", "xfCurve"]);
/** Actions whose on-screen UI should follow incoming MIDI values. */
export const UI_SYNCED = PAIRED;
const LED_ACTS = ["play", "cue", "sync", "shift", "quantize", "reverse", "loopIn", "loopOut", "autoLoop", "slip", "hotcue", "keylock"];
/** Actions carried as 14-bit MSB+LSB pairs beyond PAIRED (FX knobs on ch 5/6). */
const PAIR_LIKE = (a) => PAIRED.has(a) || /^u[12]\.dw$/.test(a) || /^u[12]\.s[123]\.(mix|p1|p2)$/.test(a);
export const BEATLOOP_SIZES = [0.5, 1, 2, 4, 8, 16, 32, 64];

export const ACTION_NAMES = [
  "play", "cue", "sync", "shift", "load", "reverse", "quantize", "keylock", "slip", "vinyl", "hotcue", "deckfilter", "faderstart",
  "loopIn", "loopOut", "loopExit", "loopHalve", "loopDouble", "autoLoop", "beatloop",
  "tempo", "vol", "gain", "hi", "mid", "low", "filter", "needle", "jogTick", "crossfader",
  ...[1, 2].flatMap((u) => [
    `u${u}.dw`, `u${u}.rst`,
    ...[1, 2, 3].flatMap((s) => [`u${u}.s${s}.on`, `u${u}.s${s}.type`, `u${u}.s${s}.mix`, `u${u}.s${s}.p1`, `u${u}.s${s}.p2`]),
  ]),
];

export class MidiHub {
  constructor(onAction, onRaw) {
    this.onAction = onAction;
    this.onRaw = onRaw || (() => {});
    this.status = "off";
    this.onStatus = null;
    this.idx = new Map();
    this.ledIdx = new Map();
    this._msb = new Map();
    this._overrides = [];
    this._learnResolve = null;
    this.learn = false;
    this.input = null;
    this.output = null;
    this._sent = new Map();
  }

  async init() {
    if (!navigator.requestMIDIAccess) return this._setStatus("unsupported");
    let access;
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return this._setStatus("denied");
    }
    this.access = access;
    access.onstatechange = () => this._pickPorts();
    await this._loadOverrides();
    this.reindex();
    this._pickPorts();
  }

  async _loadOverrides() {
    try {
      const ls = JSON.parse(localStorage.getItem("ta-midi-overrides") || localStorage.getItem("tj-midi-overrides") || "[]");
      this._overrides.push(...ls);
    } catch { /* ignore */ }
    const file = await getJSONOrNull("js/midi/mapping-override.json");
    if (Array.isArray(file)) this._overrides.push(...file);
  }

  addOverride(entry) {
    this._overrides.push(entry);
    localStorage.setItem("ta-midi-overrides", JSON.stringify(this._overrides));
    this.reindex();
  }

  reindex() {
    this.idx = new Map();
    this.ledIdx = new Map();
    const add = (e) => {
      const s = typeof e.s === "string" ? parseInt(e.s, 16) : e.s;
      const d = typeof e.d === "string" ? parseInt(e.d, 16) : e.d;
      const ent = { s, d, a: e.a, deck: e.deck, i: e.i | 0, f: e.f | 0 };
      this.idx.set(`${s},${d}`, ent);
      if (ent.f) return;
      const ledKey = (ent.a === "beatloop" || ent.a === "hotcue") ? `${ent.deck}:${ent.a}:${ent.i}` : `${ent.deck}:${ent.a}`;
      if (LED_ACTS.includes(ent.a) || ent.a === "beatloop") {
        if (!this.ledIdx.has(ledKey)) this.ledIdx.set(ledKey, ent);
      }
    };
    for (const e of MAPPING) add(e);
    for (const e of this._overrides) add(e);
  }

  _pickPorts() {
    if (!this.access) return;
    let inp = null, out = null;
    for (const p of this.access.inputs.values()) {
      if (/ddj|pioneer/i.test(p.name)) { inp = p; break; }
      if (!inp) inp = p;
    }
    for (const p of this.access.outputs.values()) {
      if (/ddj|pioneer/i.test(p.name)) { out = p; break; }
      if (!out) out = p;
    }
    if (this.input) this.input.onmidimessage = null;
    this.input = inp;
    this.output = out;
    if (inp) {
      inp.onmidimessage = (m) => this._msg(m.data);
      this._setStatus(inp.name || "connected");
    } else {
      this._setStatus("no device");
    }
  }

  _setStatus(s) {
    this.status = s;
    if (this.onStatus) this.onStatus(s);
  }

  _msg(data) {
    const [st, d1, d2] = [data[0], data[1], data[2] || 0];
    const type = st & 0xf0;
    if (this.learn && (type === 0x90 || type === 0xb0 || type === 0x80)) {
      const res = this._learnResolve;
      this._learnResolve = null;
      if (res) res({ s: st, d: d1 });
      return;
    }
    let e = this.idx.get(`${st},${d1}`);
    if (window.__ptrace && (st & 0xf0) !== 0xf0) window.__ptrace.push({ L: "M", inc: "rx", src: `${st},${d1},${d2}`, t: performance.now() });
    const ek = `${st},${d1},${d2 > 0 ? 1 : 0}`;
    const ets = this._sent.get(ek);
    if (ets !== undefined && performance.now() - ets < 200) {
      this._sent.delete(ek);
      if (window.__ptrace) window.__ptrace.push({ L: "M", inc: "echo", src: ek, t: performance.now() });
      return;
    }
    let noteOffAlias = false;
    if (!e && type === 0x80) {
      e = this.idx.get(`${st + 0x10},${d1}`); // 0x8n note-off for a 0x9n mapping
      noteOffAlias = !!e;
    }
    this.onRaw({ st, d1, d2, e });
    if (!e) return;
    const ctx = { deck: e.deck, value: null, pressed: null, index: e.i, shift: !!e.f };
    if (e.a.endsWith("@lsb")) {
      const base = e.a.slice(0, -4);
      const msb = this._msb.get(`${e.deck}:${base}`) || 0;
      ctx.value = (msb | d2) / 16383;
      this.onAction(base, ctx);
    } else if (PAIR_LIKE(e.a)) {
      this._msb.set(`${e.deck}:${e.a}`, d2 << 7);
      ctx.value = d2 / 127;
      this.onAction(e.a, ctx); // coarse value now; refined when LSB arrives
    } else if (type === 0x90 || type === 0xb0 || type === 0x80) {
      ctx.pressed = type === 0x90 ? d2 > 0 : type === 0x80 ? false : d2 >= 64;
      ctx.value = type === 0xb0 ? d2 / 127 : ctx.pressed;
      if (noteOffAlias && ctx.pressed !== false) return;
      this.onAction(e.a, ctx);
    }
  }

  learnNext() {
    this.learn = true;
    return new Promise((res) => { this._learnResolve = res; });
  }

  cancelLearn() {
    this.learn = false;
    const r = this._learnResolve;
    this._learnResolve = null;
    if (r) r(null);
  }

  setLED(deck, act, on, index = 0) {
    if (!this.output) return;
    const key = (act === "beatloop" || act === "hotcue") ? `${deck}:${act}:${index}` : `${deck}:${act}`;
    const e = this.ledIdx.get(key);
    if (!e) return;
    try {
      this.output.send([e.s, e.d, on ? 0x7f : 0x00]);
      this._sent.set(`${e.s},${e.d},${on ? 1 : 0}`, performance.now());
    } catch { /* closed port */ }
  }
}
