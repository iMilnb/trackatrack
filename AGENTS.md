# trackatrack

Browser DJ app: vanilla ES modules, **no build step, no npm, no framework**.
`server.py` (Python stdlib only) serves the app + music library. The user drives a
Pioneer **DDJ-SR** controller over Web MIDI and listens on its outputs (Linux +
PipeWire host). Browsers on the LAN open https://<host>:8443 (self-signed cert).
Popular desktop DJ software (2-deck view) inspired the UI.

## Run

```bash
cd ~/www/trackatrack
setsid nohup python3 server.py --port 8443 --ssl >> server-8443.out 2>&1 < /dev/null &
setsid nohup python3 server.py --port 8360        >> server-8360.out 2>&1 < /dev/null &   # plain HTTP, used by test tooling
```

- Flags: `--music-dir` (default `~/Music`), `--port`, `--host`, `--rescan`, `--ssl`, `--san`.
- `&`-backgrounding alone gets killed by tool-call timeouts — keep the `setsid nohup ... < /dev/null &` form.
- After JS/CSS changes the user must **Ctrl+F5** (no build, no cache-busting).
- server.py endpoints: `/api/library` (scan + ID3; cache `.library-cache-v2.json` — bump
  the version whenever `read_tags` fields change or results go stale), `/audio/<rel>`,
  `/decode/<rel>` (ffmpeg→WAV fallback for MP3s Chrome's strict decoder rejects), `/api/log`
  (browser console relay → `client.log`).

## Verify before committing (there is no test framework)

Headless Google Chrome is driven over raw CDP by two stdlib scripts (they launch Chrome
on debug ports 9333/9334 and grant MIDI):

```bash
# full e2e: loads a track on both decks, plays, asserts mPeak (real audio),
# hotcue/loop/kill/mixer-FX/unit flows, empty window.__errs
python3 tools/cdp_eval.py http://127.0.0.1:8360 "$(cat tools/reg.js)"

# screenshot
python3 tools/shot.py http://127.0.0.1:8360 /tmp/x.png --w 1920 --h 1080 --wait "document.querySelectorAll('#libtable tbody tr').length"
```

- A `playing` class is NOT proof of audio — assert `window.__engine.masterPeak() > 0`
  (reg.js does, via `mPeak`). An analyzer tap per graph stage localizes dead segments.
- Debug handles: `window.__engine`, `window.__decks` (array of `{deck, ...}` wrappers),
  `window.__hub` (MidiHub; inject controller traffic with `__hub._msg(new Uint8Array([st,d1,d2]))`),
  `window.__errs`.
- No `node` on this host — syntax-check via the CDP probe or careful review.

## Layout

- `README.md` + `docs/screenshot.png` — user-facing docs; README explains sound
  routing & controller usage to end users (keep both in sync when routing changes).
- `index.html`, `css/app.css` — single page, CSS grid; body rows and pane widths are
  hand-tuned pixel values (faders use percentage heights — see `.deckslot`/`#decks`
  comments before changing rows/columns).
- `js/main.js` — boot, mixer state, the MIDI dispatch `switch` (`case "<action>"`),
  `frame()` rAF loop (runs `ledSync()` every frame), strip/deck UI factories.
- `js/audio/` — `engine.js` (master chain + cue bus + FX units), `deck.js` (Deck class:
  transport, cue, loops, hotcues, scratch), `deck-processor.js` (AudioWorklet sample
  reader), `fx.js` (FxChain / FxUnit / PatternPlayer), `rec.js`, `preview.js`.
- `js/analysis/` — BPM/beatgrid worker. `js/library.js` — collection table (sort, search,
  folder tree). `js/midi/` — see below. Also `ui.js`, `waveform.js`, `util.js`, `idb.js`,
  `server-api.js`.
- `tools/` — `cdp_eval.py`, `shot.py`, `reg.js` (e2e), `gen-mapping.py`.

## UI design rules (owner requirements — non-negotiable)

1. The UI must match the reference screenshot of the popular DJ software it
   resembles
   (`docs.native-instruments.com/online-guides/traktor-pro-manual/en/image/uuid-08cd423b-c601-ec4d-ede9-d0818f953a47.jpg`).
   Nothing in the UI that is not in that image; the image wins over prose in the manual;
   never invent controls (an invented headphone-knob cluster and crossfader fade buttons
   were explicitly rejected and removed).
2. Deck A and Deck B must share a **byte-identical** layout (diff the two `.deck-t`
   innerHTML when refactoring deck UI).
3. Exactly two decks. Nothing below the crossfader. Library zone stays taller than the
   deck row.

## MIDI (js/midi/)

- `mapping.js` is **auto-generated** from Mixxx's DDJ-SX definition via
  `tools/gen-mapping.py` — do not hand-edit. SR-specific differences go in
  `mapping-override.json` (loaded after, later wins; note/status values are hex strings).
- DDJ-SR facts: SHIFT = `0x9n,0x3F`; channel CUE (headphone PFL) = `0x9n,0x54`;
  SLIP `0x40`; KEYLOCK `0x1A`; fader-from-zero `0x9n,0x66`; FX units live on MIDI
  channels 5/6 (`0x94`/`0x95`, knobs 14-bit MSB+LSB); SR has no pan/kill/fade-button
  hardware and does not echo LED messages.
- Pioneer relative jog ticks are **64-centered signed**: `dv = raw - 64` (65=+1, 63=-1).
- Jog semantics: top platter touch → scratch (`Deck.scratchStart/scratchTick/scratchEnd`);
  side ring (or untouched ticks) → pitch bend.
- Adding an action: extend `ACTION_NAMES` (monitor/learn UI), add a `case` in main.js
  dispatch; for a lightable button also add to `LED_ACTS` (midi.js) and `setLed(...)` in
  `ledSync` (main.js).

## Audio gotchas (hard-won — read before touching the graph)

- Bare `node.disconnect()` severs **all outputs** of a node, including internal wiring.
  A blanket `unit.in.disconnect()` in `applyFxRouting` once silenced the entire app
  (units are permanently inserted between deck and channel fader at boot).
- FxChain/FxUnit pass **dry** audio when FX is off — a "disabled" unit must still carry sound.
- Cue/headphone bus: **if OUT and PHONES selects pick the same device** and it is 4-channel,
  engine runs **single-stream mode** (`_sharedOn`): the master destination itself is set to
  4ch and a ChannelMerger sends master → ch1/2 and cue → ch3/4 (DDJ-SR: ch1/2 = MASTER OUT,
  ch3/4 = PHONES jack); the separate cue AudioContext stays suspended. Otherwise the cue
  travels master ctx → `MediaStreamDestination` → cue AudioContext (own device), rear-parked
  when its sink is ≥4ch. Two independent 2-stream routes on ONE PipeWire sink proved
  unreliable (both land on FL/FR) — do not re-split the shared stream.
- Chrome's `DeviceInfo.maxChannelCount` is unreliable on Linux — trust
  `cueCtx.destination.maxChannelCount` **after** `setSinkId`.
- Sink selections persist in **cookies** (`sink.master`, `sink.cue`; top-bar OUT/PHONES
  selects) so remote browsers keep their routing; legacy localStorage values are honored
  once as migration. **Chrome hides device labels AND randomizes deviceIds per page-load
  until mic permission is granted** — without it cookies can't restore and DDJ auto-pick
  fails; the first `pointerdown` fires a one-time `getUserMedia({audio:true})` to unlock
  labels/IDs, then re-fills the selects (`main.js` boot block).
- Chrome auto-suspens a context that renders silence ~30 s (its PipeWire stream
  disappears from `wpctl status` — expected, not a bug).
- ~40 library files are physically dead (all-zero bytes): nested `Defected Acapellas
  Vol 3 Classics/` folder + parts of `VA-For_Djs_Only_2007-03*`. Chrome also rejects some
  corrupt MP3s that ffmpeg recovers → that's why `/decode/` exists.

## Host/environment gotchas

- PipeWire: diagnose routing with `wpctl status` / `pw-dump` (stream channels, port links,
  which sink Chrome actually opened).
- The user is remote-ish: bug reports are terse one-liners; verify headlessly yourself
  first, then ask them to Ctrl+F5 and report.
- `pkill -f "server.py"` from a command whose own cmdline matches kills your own shell.
- `client.log` (browser console relay) churns constantly — keep it out of feature
  commits; `cert.*`, `server-*.out`, caches are gitignored.

## Workflow

- One commit per verified change; message states what + why. **Do not push unless asked.**
- `/tmp` is wiped on reboot — canonical e2e lives at `tools/reg.js`, not in `/tmp`.
- Destructive or layout-visible changes: run the e2e + a screenshot before committing;
  audio-path changes: additionally confirm `mPeak > 0`.
