import { getJSON } from "./server-api.js";
import { fmtTime, parseKey, camelotColor } from "./util.js";

const COLS = [
  { k: "#", w: 30 },
  { k: "load", w: 26 },
  { k: "title", label: "TITLE", sortable: true },
  { k: "artist", label: "ARTIST", sortable: true },
  { k: "bpm", label: "BPM", w: 56, sortable: true },
  { k: "key", label: "KEY", w: 46, sortable: true },
  { k: "dur", label: "DUR", w: 52, sortable: true },
  { k: "file", label: "FILENAME", sortable: true },
];

/** Bottom library browser: folder tree + sortable/filterable track table. */
export class Library {
  constructor(root, { onLoad }) {
    this.root = root;
    this.onLoad = onLoad;
    this.tracks = [];
    this.filterDir = null;
    this.query = "";
    this.sort = { k: "title", dir: 1 };
    this.selected = null;
    this.deckOf = {}; // trackId -> deck index
    this.expanded = new Set();
    this._build();
  }

  async load() {
    this.tracks = await getJSON("/api/tracks");
    this._buildTree();
    this.render();
  }

  _build() {
    this.root.innerHTML = `
      <div id="tree"></div>
      <div id="libmain">
        <div id="libbar">
          <input id="search" type="search" placeholder="filter…" autocomplete="off">
          <span id="libcount"></span>
          <span class="hint">dbl-click / Enter = load to free deck</span>
        </div>
        <div id="tblwrap"><table id="libtable"><thead><tr></tr></thead><tbody></tbody></table></div>
      </div>`;
    this.treeEl = this.root.querySelector("#tree");
    this.tbody = this.root.querySelector("#libtable tbody");
    const hr = this.root.querySelector("#libtable thead tr");
    hr.innerHTML = COLS.map((c) => `<th data-k="${c.k}" style="${c.w ? `width:${c.w}px` : ""}">${c.label || ""}</th>`).join("");
    hr.addEventListener("click", (e) => {
      const th = e.target.closest("th");
      if (!th) return;
      const col = COLS.find((c) => c.k === th.dataset.k);
      if (!col?.sortable) return;
      if (this.sort.k === col.k) this.sort.dir *= -1;
      else this.sort = { k: col.k, dir: 1 };
      this.render();
    });
    this.root.querySelector("#search").addEventListener("input", (e) => {
      this.query = e.target.value.toLowerCase();
      this.render();
    });
    this.tbody.addEventListener("click", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      this._select(tr.dataset.id);
    });
    this.tbody.addEventListener("dblclick", (e) => {
      const tr = e.target.closest("tr");
      if (!tr) return;
      this._select(tr.dataset.id);
      this.loadSelected();
    });
  }

  _dirs() {
    const dirs = new Set();
    for (const t of this.tracks) {
      const parts = t.dir.split("/");
      let acc = "";
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        if (acc !== ".") dirs.add(acc);
      }
    }
    return [...dirs].sort();
  }

  _buildTree() {
    const dirs = this._dirs();
    let html = `<div class="tnode sel" data-dir=""><span class="tname">All Tracks</span><span class="tcount">${this.tracks.length}</span></div>`;
    for (const d of dirs) {
      const depth = d.split("/").length - 1;
      const count = this.tracks.filter((t) => t.dir === d || t.dir.startsWith(d + "/")).length;
      const hasKids = dirs.some((x) => x.length > d.length && x.startsWith(d + "/"));
      html += `<div class="tnode" data-dir="${esc(d)}" style="padding-left:${8 + depth * 14}px">
        <span class="texp">${hasKids ? "▸" : ""}</span><span class="tname">${esc(d.split("/").pop())}</span><span class="tcount">${count}</span></div>`;
    }
    this.treeEl.innerHTML = html;
    this.treeEl.addEventListener("click", (e) => {
      const n = e.target.closest(".tnode");
      if (!n) return;
      if (e.target.classList.contains("texp") && n.dataset.dir) {
        const kids = [...this.treeEl.querySelectorAll(".tnode")].filter(
          (x) => x.dataset.dir.startsWith(n.dataset.dir + "/")
        );
        const open = this.expanded.has(n.dataset.dir);
        if (open) { this.expanded.delete(n.dataset.dir); e.target.textContent = "▸"; }
        else { this.expanded.add(n.dataset.dir); e.target.textContent = "▾"; }
        for (const k of kids) k.style.display = open ? "" : "none";
        return;
      }
      this.treeEl.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel"));
      n.classList.add("sel");
      this.filterDir = n.dataset.dir || null;
      this.render();
    });
  }

  filtered() {
    let ts = this.tracks;
    if (this.filterDir) ts = ts.filter((t) => t.dir === this.filterDir || t.dir.startsWith(this.filterDir + "/"));
    if (this.query) {
      ts = ts.filter((t) =>
        `${t.title} ${t.artist} ${t.file}`.toLowerCase().includes(this.query));
    }
    const { k, dir } = this.sort;
    const keyf = {
      title: (t) => t.title.toLowerCase(),
      artist: (t) => (t.artist || "\uffff").toLowerCase(),
      file: (t) => t.file.toLowerCase(),
      bpm: (t) => t.bpm || 1e9,
      key: (t) => { const c = parseKey(t.key); return c ? c.num + (c.minor ? 0.5 : 0) : 1e9; },
      dur: (t) => t.duration || 1e9,
    }[k];
    if (keyf) ts = [...ts].sort((a, b) => (keyf(a) > keyf(b) ? dir : keyf(a) < keyf(b) ? -dir : 0));
    return ts;
  }

  render() {
    const ts = this.filtered();
    const rows = ts.map((t, i) => {
      const cam = parseKey(t.key);
      const deckBadge = this.deckOf[t.id] != null
        ? `<span class="dbadge d${this.deckOf[t.id]}">${this.deckOf[t.id] === 0 ? "A" : "B"}</span>` : "";
      return `<tr data-id="${esc(t.id)}" class="${this.selected === t.id ? "sel" : ""}">
        <td class="num">${i + 1}</td><td class="badge">${deckBadge}</td>
        <td class="t-title">${esc(t.title)}</td><td class="t-artist">${esc(t.artist === t.title ? "" : t.artist)}</td>
        <td class="t-bpm">${t.bpm ? t.bpm.toFixed(1) : ""}</td>
        <td class="t-key" style="color:${cam ? camelotColor(cam) : "#555"}">${cam ? cam.text : ""}</td>
        <td class="t-dur">${fmtTime(t.duration)}</td>
        <td class="t-file">${esc(t.file)}</td></tr>`;
    });
    this.tbody.innerHTML = rows.join("");
    this.root.querySelector("#libcount").textContent = `${ts.length} tracks`;
  }

  _select(id) {
    this.selected = id;
    this.tbody.querySelectorAll("tr.sel").forEach((x) => x.classList.remove("sel"));
    const tr = this.tbody.querySelector(`tr[data-id="${cssEsc(id)}"]`);
    if (tr) { tr.classList.add("sel"); tr.scrollIntoView({ block: "nearest" }); }
  }

  selectedTrack() {
    return this.tracks.find((t) => t.id === this.selected) || null;
  }

  moveSel(delta) {
    const ts = this.filtered();
    if (!ts.length) return;
    let i = ts.findIndex((t) => t.id === this.selected);
    i = i < 0 ? (delta > 0 ? 0 : ts.length - 1) : Math.max(0, Math.min(ts.length - 1, i + delta));
    this._select(ts[i].id);
  }

  loadSelected() {
    const t = this.selectedTrack();
    if (t) this.onLoad(t);
  }

  setDeckTrack(id, trackId) {
    for (const k of Object.keys(this.deckOf)) if (this.deckOf[k] === id) delete this.deckOf[k];
    if (trackId) this.deckOf[trackId] = id;
    this.render();
  }
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const cssEsc = (s) => window.CSS?.escape ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
