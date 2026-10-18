export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function fmtTime(s) {
  if (s == null || !isFinite(s)) return "--:--";
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const MAJ_NUM = { C: 8, G: 9, D: 10, A: 11, E: 12, B: 1, "F#": 2, "C#": 3, "G#": 4, "D#": 5, "A#": 6, F: 7 };
const FLAT = { Db: "C#", Eb: "D#", Gb: "F#", Ab: "G#", Bb: "A#", Cb: "B", Fb: "E" };

/** Parse text keys ("Am", "8A", "Ab minor") -> {num, minor, text:"8m"} or null. */
export function parseKey(k) {
  if (!k) return null;
  let s = String(k).trim();
  let m = s.match(/^(\d+)([A-Bab])$/);
  if (m) return { num: +m[1], minor: m[2].toLowerCase() === "b", text: `${m[1]}${m[2].toLowerCase()}` };
  m = s.match(/^([A-G][#b]?)\s*(m|min|minor|maj|major)?$/i);
  if (!m) return null;
  let letter = m[1];
  if (FLAT[letter]) letter = FLAT[letter];
  const num = MAJ_NUM[letter[0]] != null && letter.length === 1 ? MAJ_NUM[letter[0]] : MAJ_NUM[letter];
  if (num == null) return null;
  const mode = (m[2] || "").toLowerCase();
  const minor = mode.startsWith("m") && mode !== "maj";
  return { num, minor, text: `${num}${minor ? "m" : "A"}` };
}

const HUES = [0, 30, 60, 100, 140, 170, 195, 220, 250, 280, 310, 335];
export function camelotColor(cam, dim = 1) {
  if (!cam) return `rgba(160,160,160,${dim})`;
  const h = HUES[(cam.num - 1 + 12) % 12];
  const l = cam.minor ? 42 : 52;
  return `hsla(${h},85%,${l}%,${dim})`;
}
