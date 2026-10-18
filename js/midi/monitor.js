import { ACTION_NAMES } from "./midi.js";

/** MIDI monitor panel + learn mode for mapping overrides. */
export function initMonitor(hub) {
  const panel = document.createElement("div");
  panel.id = "monpanel";
  panel.hidden = true;
  panel.innerHTML = `
    <div id="monlog"></div>
    <div id="monlearn">
      <span id="monlearnstate">LEARN: idle</span>
      <select id="monact"></select>
      <select id="mondeck"><option value="-1">master</option><option value="0" selected>deck A</option><option value="1">deck B</option><option value="2">deck C</option><option value="3">deck D</option></select>
      <button id="monlearnbtn">Learn</button>
      <button id="monaddbtn" disabled>Add</button>
      <button id="monexport">Export</button>
      <button id="monclear">Clear</button>
    </div>
    <div id="monexport-box" hidden><textarea id="monexport-txt" rows="4"></textarea></div>`;
  document.body.appendChild(panel);
  panel.querySelector("#monact").innerHTML =
    ACTION_NAMES.map((a) => `<option>${a}</option>`).join("");

  const log = panel.querySelector("#monlog");
  const lines = [];
  let dirty = false;
  const rawOn = hub.onRaw;
  hub.onRaw = (rec) => {
    rawOn(rec);
    const act = rec.e ? rec.e.a + (rec.e.deck >= 0 ? ` (D${rec.e.deck + 1})` : " (master)") : "—";
    lines.push(`${hex(rec.st)} ${hex(rec.d1)} ${String(rec.d2).padStart(3)}  ${act}`);
    if (lines.length > 40) lines.shift();
    dirty = true;
  };
  setInterval(() => {
    if (!dirty || panel.hidden) return;
    dirty = false;
    log.textContent = lines.slice().reverse().join("\n");
  }, 250);

  const toggleBtn = document.getElementById("monBtn");
  toggleBtn.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggleBtn.classList.toggle("on", !panel.hidden);
  });

  const stateEl = panel.querySelector("#monlearnstate");
  const addBtn = panel.querySelector("#monaddbtn");
  const learnBtn = panel.querySelector("#monlearnbtn");
  let captured = null, armed = false, learnT = null;
  const disarm = (msg) => {
    if (!armed) return;
    armed = false;
    clearTimeout(learnT);
    learnBtn.classList.remove("on");
    if (msg) stateEl.textContent = msg;
    hub.cancelLearn(); // resolves learnNext with null
  };
  learnBtn.addEventListener("click", async () => {
    if (armed) { disarm("LEARN: cancelled"); return; }
    captured = null;
    addBtn.disabled = true;
    armed = true;
    learnBtn.classList.add("on");
    stateEl.textContent = "LEARN: move a control\u2026 (10s)";
    learnT = setTimeout(() => disarm("LEARN: timed out"), 10000);
    const got = await hub.learnNext();
    if (!got) return; // cancelled / timed out; state already set
    armed = false;
    clearTimeout(learnT);
    learnBtn.classList.remove("on");
    captured = got;
    stateEl.textContent = `LEARN: got ${hex(got.s)} ${hex(got.d)}`;
    addBtn.disabled = false;
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") disarm("LEARN: cancelled"); });
  addBtn.addEventListener("click", () => {
    if (!captured) return;
    hub.addOverride({
      s: captured.s, d: captured.d,
      a: panel.querySelector("#monact").value,
      deck: +panel.querySelector("#mondeck").value,
    });
    stateEl.textContent = "LEARN: added ✓ (also stored in localStorage)";
  });
  const expBox = panel.querySelector("#monexport-box");
  panel.querySelector("#monclear").addEventListener("click", () => {
    localStorage.removeItem("tj-midi-overrides");
    location.reload();
  });
  panel.querySelector("#monexport").addEventListener("click", () => {
    const raw = JSON.parse(localStorage.getItem("tj-midi-overrides") || "[]");
    panel.querySelector("#monexport-txt").value = JSON.stringify(
      raw.map((e) => ({ ...e, s: `0x${e.s.toString(16)}`, d: `0x${e.d.toString(16)}` })), null, 1);
    expBox.hidden = false;
  });

  return panel;
}

const hex = (n) => "0x" + n.toString(16).padStart(2, "0").toUpperCase();
