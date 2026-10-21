import { getJSON } from "./server-api.js";
import { fmtTime, parseKey, camelotColor } from "./util.js";

const COLS = [
  { k: "#", w: 30 },
  { k: "load", w: 26 },
  { k: "title", label: "TITLE", sortable: true },
  { k: "artist", label: "ARTIST", sortable: true },
  { k: "genre", label: "GENRE", w: 90, sortable: true },
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
    this.tab = "collection"; // collection | history
    this.filt = { open: false, genre: null, artist: null, key: null, lo: "", hi: "", hide: true };
    this.favs = (() => {
      try { return JSON.parse(localStorage.getItem("ta-favs") || "[]"); } catch { return []; }
    })();
    this.history = (() => {
      try { return JSON.parse(localStorage.getItem("ta-history") || "[]"); } catch { return []; }
    })();
    this._build();
  }

  async load() {
    this.status("Loading Track Collection…");
    this.tracks = await getJSON("/api/tracks");
    this._buildTree();
    this.render();
    this.status(`Track Collection — ${this.tracks.length} tracks`);
  }

  _build() {
    this.root.innerHTML = `
      <div id="libtabs">
        <button class="libtab sel" data-tab="collection">Track Collection</button>
        <button class="libtab" data-tab="history">History</button>
      </div>
      <div id="libbody">
        <div id="tree"></div>
        <div id="libmain">
          <div id="libbar">
            <input id="search" type="search" placeholder="filter…" autocomplete="off" title="Search field — live search based on the tags of the tracks">
            <span id="libcount"></span>
            <span class="grow"></span>
            <span class="pvlab" title="Preview Player — preview tracks before loading them into a Deck (plays via main output)">PREVIEW</span>
            <button id="pvPlay" class="btn sm" title="Play / pause preview of the selected track">⏵</button>
            <button id="pvStop" class="btn sm" title="Stop preview">⏹</button>
            <div class="pvprog"><i id="pvFill"></i></div>
            <div id="pvVol"></div>
            <span class="hint">dbl-click / Enter = load to free deck</span>
          </div>
          <div id="tblwrap"><table id="libtable"><thead><tr></tr></thead><tbody></tbody></table></div>
          <div id="libstatus"><span id="libstat">Ready</span><span class="grow"></span><span id="libstat2"></span></div>
        </div>
      </div>`;
    this.treeEl = this.root.querySelector("#tree");
    this._bindTree();
    this.tbody = this.root.querySelector("#libtable tbody");
    this.root.querySelectorAll(".libtab").forEach((b) => b.addEventListener("click", () => {
      this.tab = b.dataset.tab;
      this._syncTabs();
      this.render();
    }));
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
    const favBlock = (d) => `<div class="tnode fav ${this.filterDir === d ? "sel" : ""}" data-dir="${esc(d)}" style="padding-left:8px">
        <span class="tstar-on">★</span><span class="texp"></span><span class="tname">${esc(d)}</span>
        <span class="tcount">${this.tracks.filter((t) => t.dir === d || t.dir.startsWith(d + "/")).length}</span></div>`;
    let html = this.favs.length
      ? `<div class="tnode sel" data-dir=""><span class="texp"></span><span class="tname">All Tracks</span><span class="tcount">${this.tracks.length}</span></div>` +
        `<div class="tsec">FAVORITES</div>` + this.favs.map(favBlock).join("") + `<div class="tsec">FOLDERS</div>`
      : `<div class="tnode sel" data-dir=""><span class="texp"></span><span class="tname">All Tracks</span><span class="tcount">${this.tracks.length}</span></div>`;
    for (const d of dirs) {
      const depth = d.split("/").length - 1;
      const count = this.tracks.filter((t) => t.dir === d || t.dir.startsWith(d + "/")).length;
      const hasKids = dirs.some((x) => x.length > d.length && x.startsWith(d + "/"));
      const fav = this.favs.includes(d);
      html += `<div class="tnode ${this.filterDir === d ? "sel" : ""}" data-dir="${esc(d)}" style="padding-left:${8 + depth * 14}px">
        <button class="tstar ${fav ? "on" : ""}" data-star="${esc(d)}" title="Add / remove from Favorites">★</button>
        <span class="texp">${hasKids ? "▸" : ""}</span><span class="tname">${esc(d.split("/").pop())}</span><span class="tcount">${count}</span></div>`;
    }
    this.treeEl.innerHTML = html;
  }

  _bindTree() {
    this.treeEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("tstar") || e.target.classList.contains("tstar-on")) {
        const d = e.target.dataset.star || e.target.closest(".tnode").dataset.dir;
        this.favs = this.favs.includes(d) ? this.favs.filter((x) => x !== d) : this.favs.concat(d);
        try { localStorage.setItem("ta-favs", JSON.stringify(this.favs)); } catch {}
        this._buildTree();
        return;
      }
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

  /** Status bar: progress, messages, overall status. */
  status(msg, msg2) {
    const a = this.root.querySelector("#libstat");
    const b = this.root.querySelector("#libstat2");
    if (a) a.textContent = msg;
    if (b && msg2 !== undefined) b.textContent = msg2;
  }

  _syncTabs() {
    this.root.querySelectorAll(".libtab").forEach((b) => b.classList.toggle("sel", b.dataset.tab === this.tab));
    this.treeEl.style.display = this.tab === "history" ? "none" : "";
    this.root.querySelector("#libbody").style.gridTemplateColumns = this.tab === "history" ? "0 1fr" : "210px 1fr";
  }

  /** Record a loaded track (History tab), newest first, deduped by id. */
  noteHistory(track) {
    if (!track) return;
    this.history = [track.id].concat(this.history.filter((id) => id !== track.id)).slice(0, 60);
    try { localStorage.setItem("ta-history", JSON.stringify(this.history)); } catch {}
  }

  /** Scroll to and highlight a loaded track (deck ♪ button). */
  reveal(track) {
    if (!track) return;
    this.tab = "collection";
    this._syncTabs();
    this.query = "";
    this.root.querySelector("#search").value = "";
    this.render();
    this._select(track.id);
    const tr = this.tbody.querySelector(`tr[data-id="${cssEsc(track.id)}"]`);
    if (tr) { tr.classList.add("reveal-pulse"); setTimeout(() => tr.classList.remove("reveal-pulse"), 900); }
  }

  filtered(skipFilter = false) {
    let ts = this.tracks;
    if (this.tab === "history") {
      const byId = new Map(this.tracks.map((t) => [t.id, t]));
      ts = this.history.map((id) => byId.get(id)).filter(Boolean);
    }
    if (this.filterDir) ts = ts.filter((t) => t.dir === this.filterDir || t.dir.startsWith(this.filterDir + "/"));
    if (this.query) {
      ts = ts.filter((t) =>
        `${t.title} ${t.artist} ${t.file}`.toLowerCase().includes(this.query));
    }
    if (!skipFilter && this.fActive() && this.filt.hide) ts = ts.filter((t) => this._fmatch(t));
    const { k, dir } = this.sort;
    if (this.tab !== "history") {
    const keyf = {
      title: (t) => t.title.toLowerCase(),
      artist: (t) => (t.artist || "\uffff").toLowerCase(),
      genre: (t) => (t.genre || "\uffff").toLowerCase(),
      file: (t) => t.file.toLowerCase(),
      bpm: (t) => t.bpm || 1e9,
      key: (t) => { const c = parseKey(t.key); return c ? c.num + (c.minor ? 0.5 : 0) : 1e9; },
      dur: (t) => t.duration || 1e9,
    }[k];
    if (keyf) ts = [...ts].sort((a, b) => (keyf(a) > keyf(b) ? dir : keyf(a) < keyf(b) ? -dir : 0));
    }
    return ts;
  }

  render() {
    const base = this.filt.open ? this.filtered(true) : null;
    const ts = this.filtered();
    const anyF = this.fActive();
    const dimOn = anyF && !this.filt.hide;
    const rows = ts.map((t, i) => {
      const cam = parseKey(t.key);
      const deckBadge = this.deckOf[t.id] != null
        ? `<span class="dbadge d${this.deckOf[t.id]}">${this.deckOf[t.id] === 0 ? "A" : "B"}</span>` : "";
      const dim = dimOn && !this._fmatch(t) ? " dim" : "";
      return `<tr data-id="${esc(t.id)}" class="${this.selected === t.id ? "sel" : ""}${dim}">
        <td class="num">${i + 1}</td><td class="badge">${deckBadge}</td>
        <td class="t-title">${esc(t.title)}</td><td class="t-artist">${esc(t.artist === t.title ? "" : t.artist)}</td>
        <td class="t-genre">${esc(t.genre || "")}</td>
        <td class="t-bpm">${t.bpm ? t.bpm.toFixed(1) : ""}</td>
        <td class="t-key" style="color:${cam ? camelotColor(cam) : "#555"}">${cam ? cam.text : ""}</td>
        <td class="t-dur">${fmtTime(t.duration)}</td>
        <td class="t-file">${esc(t.file)}</td></tr>`;
    });
    this.tbody.innerHTML = rows.join("");
    if (dimOn) {
      const n = ts.filter((t) => this._fmatch(t)).length;
      this.root.querySelector("#libcount").textContent = `${n}/${ts.length} tracks`;
    } else {
      this.root.querySelector("#libcount").textContent = `${ts.length} tracks`;
    }
  }

  fActive() {
    const f = this.filt;
    return !!(f.genre || f.artist || f.key || f.lo !== "" || f.hi !== "");
  }

  _fmatch(t) {
    const f = this.filt;
    if (f.genre && (t.genre || "") !== f.genre) return false;
    if (f.artist && (t.artist || "") !== f.artist) return false;
    if (f.key) {
      const c = parseKey(t.key);
      if (!c || c.text !== f.key) return false;
    }
    const lo = f.lo === "" ? null : +f.lo;
    const hi = f.hi === "" ? null : +f.hi;
    if (lo !== null || hi !== null) {
      if (t.bpm == null) return false;
      if (lo !== null && t.bpm < lo) return false;
      if (hi !== null && t.bpm > hi) return false;
    }
    return true;
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
