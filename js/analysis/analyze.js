import { idbGet, idbPut } from "../idb.js";

const worker = new Worker("js/analysis/analysis-worker.js");
const waiters = new Map();
let seq = 0;

worker.onmessage = (e) => {
  const w = waiters.get(e.data.id);
  if (w) { waiters.delete(e.data.id); w.res(e.data); }
};
const stub = (id) => ({
  id, stub: true, bpm: 0, firstBeat: 0, strength: 0,
  dMin: new Float32Array(4096), dMax: new Float32Array(4096),
  oMin: new Float32Array(512), oMax: new Float32Array(512),
  oColor: new Uint8Array(1536), colors: new Uint8Array(12288),
});
worker.onerror = (e) => {
  console.error("analysis worker error:", e.message || e);
  for (const [id, w] of waiters) { waiters.delete(id); w.res(stub(id)); }
};

/**
 * Analyze a decoded track (L/R may be TRANSFERRED to the worker).
 * ID3 BPM wins over detection; peaks/colors/detection are cached in IndexedDB.
 */
export async function analyzeTrack(track, { L, R, sr }) {
  const key = `v2:${track.id}:${track.size}`;
  const cached = await idbGet(key);
  if (cached) {
    console.log(`[analyze] cache hit ${key}`);
    if (track.bpm) cached.bpm = track.bpm;
    return cached;
  }
  const id = ++seq;
  console.log(`[analyze] -> worker id=${id} n=${L.length} key=${key}`);
  const an = await new Promise((res) => {
    waiters.set(id, { res });
    worker.postMessage({ id, L, R, sr, bpmHint: track.bpm || 0 }, [L.buffer, R.buffer]);
  });
  delete an.id; delete an.ms;
  if (track.bpm) an.bpm = track.bpm;
  an.key = key;
  if (!an.stub) idbPut(key, an);
  else delete an.stub;
  return an;
}
