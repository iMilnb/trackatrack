/**
 * Offline analysis worker: colored waveform peaks (detail 4096 / overview 512 buckets)
 * + BPM & first-beat detection via lowband onset envelope autocorrelation.
 * input:  {id, L, R, sr, bpmHint}
 * output: {id, dMin,dMax,oMin,oMax,oColor,colors,bpm,firstBeat,strength}
 */
const NDET = 4096, NOV = 512, FFTN = 512;

function fft512(re) {
  const n = FFTN, im = new Float32Array(n);
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k];
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ar + br; im[i + k] = ai + bi;
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function analyze(L, R, sr, bpmHint) {
  const n = L.length;
  const mono = new Float32Array(n);
  for (let i = 0; i < n; i++) mono[i] = (L[i] + R[i]) * 0.5;

  // ---- detail peaks + per-bucket spectrum ----
  const bucket = Math.max(1, Math.ceil(n / NDET));
  const dMin = new Float32Array(NDET), dMax = new Float32Array(NDET);
  const colors = new Uint8Array(NDET * 3);
  const bands = new Float32Array(NDET * 4);
  const re = new Float32Array(FFTN);
  const binHz = sr / FFTN;
  const b1 = Math.max(2, Math.round(220 / binHz));   // ~220 Hz
  const b2 = Math.round(900 / binHz);
  const b3 = Math.round(3200 / binHz);
  for (let bi = 0; bi < NDET; bi++) {
    const s0 = bi * bucket, s1 = Math.min(n, s0 + bucket);
    if (s0 >= n) { dMin[bi] = 0; dMax[bi] = 0; continue; }
    let mn = 0, mx = 0;
    for (let i = s0; i < s1; i++) { const v = mono[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    dMin[bi] = mn; dMax[bi] = mx;
    const cs = Math.max(0, Math.min(n - FFTN, ((s0 + s1) >> 1) - (FFTN >> 1)));
    for (let i = 0; i < FFTN; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFTN);
      re[i] = mono[cs + i] * w;
    }
    fft512(re);
    let e0 = 0, e1 = 0, e2 = 0, e3 = 0;
    for (let k = 1; k < FFTN / 2; k++) {
      const e = re[k] * re[k];
      if (k < b1) e0 += e; else if (k < b2) e1 += e; else if (k < b3) e2 += e; else if (k < 160) e3 += e;
    }
    bands[bi * 4] = e0; bands[bi * 4 + 1] = e1; bands[bi * 4 + 2] = e2; bands[bi * 4 + 3] = e3;
  }
  // normalize bands globally, map to RGB
  const mean = [0, 0, 0, 0];
  for (let bi = 0; bi < NDET; bi++) for (let b = 0; b < 4; b++) mean[b] += bands[bi * 4 + b];
  for (let b = 0; b < 4; b++) mean[b] = Math.sqrt(mean[b] / NDET + 1e-12);
  const cl = (x) => Math.max(0, Math.min(1, x));
  for (let bi = 0; bi < NDET; bi++) {
    const w0 = Math.sqrt(bands[bi * 4] / (mean[0] + 1e-12));
    const w1 = Math.sqrt(bands[bi * 4 + 1] / (mean[1] + 1e-12));
    const w2 = Math.sqrt(bands[bi * 4 + 2] / (mean[2] + 1e-12));
    const w3 = Math.sqrt(bands[bi * 4 + 3] / (mean[3] + 1e-12));
    const has = dMin[bi] !== 0 || dMax[bi] !== 0;
    colors[bi * 3] = has ? 36 + 200 * cl(w0 * 0.85 + w1 * 0.18) : 40;
    colors[bi * 3 + 1] = has ? 36 + 190 * cl(w1 * 0.5 + w2 * 0.72 + w0 * 0.06) : 40;
    colors[bi * 3 + 2] = has ? 36 + 190 * cl(w3 * 0.85 + w2 * 0.12) : 46;
  }

  // ---- overview peaks (grouped from detail) ----
  const oMin = new Float32Array(NOV), oMax = new Float32Array(NOV);
  const oColor = new Uint8Array(NOV * 3);
  for (let oi = 0; oi < NOV; oi++) {
    const a = Math.floor((oi * NDET) / NOV), b = Math.max(a + 1, Math.floor(((oi + 1) * NDET) / NOV));
    let mn = 0, mx = 0, cr = 0, cg = 0, cb = 0;
    for (let i = a; i < b; i++) {
      if (dMin[i] < mn) mn = dMin[i];
      if (dMax[i] > mx) mx = dMax[i];
      cr += colors[i * 3]; cg += colors[i * 3 + 1]; cb += colors[i * 3 + 2];
    }
    oMin[oi] = mn; oMax[oi] = mx;
    oColor[oi * 3] = cr / (b - a); oColor[oi * 3 + 1] = cg / (b - a); oColor[oi * 3 + 2] = cb / (b - a);
  }

  // ---- BPM: lowband energy flux envelope + autocorrelation ----
  const hop = 128;
  const envRate = sr / hop;
  const len = Math.floor(n / hop);
  const env = new Float32Array(len);
  const aLP = 1 - Math.exp((-2 * Math.PI * 16) / envRate);
  let lp = 0;
  for (let i = 0; i < len; i++) {
    let e = 0;
    const s = i * hop;
    for (let j = 0; j < hop; j++) { const v = mono[s + j] || 0; e += v * v; }
    e /= hop;
    lp += aLP * (e - lp);
    env[i] = lp;
  }
  const d = new Float32Array(len);
  let dmax = 1e-9;
  for (let i = 1; i < len; i++) { const x = env[i] - env[i - 1]; d[i] = x > 0 ? x : 0; if (d[i] > dmax) dmax = d[i]; }
  for (let i = 0; i < len; i++) d[i] /= dmax;
  if (dmax <= 1e-8) {
    return { dMin, dMax, oMin, oMax, oColor, colors, bpm: 0, firstBeat: 0, strength: 0 };
  }

  const bpmLo = 70, bpmHi = 180;
  // coarse autocorrelation on 3x decimated (max-pooled) flux for speed
  const DEC = 3;
  const dlen = Math.max(1, Math.floor(len / DEC));
  const dd = new Float32Array(dlen);
  for (let i = 0; i < dlen; i++) {
    let m = 0;
    for (let j = 0; j < DEC; j++) { const v = d[i * DEC + j]; if (v > m) m = v; }
    dd[i] = m;
  }
  const decRate = envRate / DEC;
  const lagLo = Math.floor((60 * envRate) / bpmHi), lagHi = Math.ceil((60 * envRate) / bpmLo);
  const cLo = Math.floor((60 * decRate) / bpmHi), cHi = Math.ceil((60 * decRate) / bpmLo);
  let bestC = 0, bestScore = 0, meanR = 0, nR = 0;
  const ac = new Float32Array(cHi + 1);
  for (let lag = cLo; lag <= cHi; lag++) {
    let r = 0;
    for (let i = 0; i + lag < dlen; i++) r += dd[i] * dd[i + lag];
    r /= dlen;
    ac[lag] = r;
    const bpm = (60 * decRate) / lag;
    const w = Math.exp(-0.5 * Math.pow((bpm - 126) / 42, 2)) * 0.4 + 0.6;
    const sc = r * w;
    meanR += r; nR++;
    if (sc > bestScore) { bestScore = sc; bestC = lag; }
  }
  meanR /= Math.max(1, nR);
  if (bpmHint >= 40 && bpmHint <= 300) {
    bestC = Math.max(cLo, Math.min(cHi, Math.round((60 * decRate) / bpmHint)));
  } else {
    // octave correction: kick combs correlate at halves too, weighted weakly
    const dbl = Math.round(bestC / 2), half = Math.round(bestC * 2);
    const bpm0 = (60 * decRate) / Math.max(1, bestC);
    if (bpm0 < 92 && dbl >= cLo && ac[dbl] > ac[bestC] * 0.72) bestC = dbl;
    else if (bpm0 > 158 && half <= cHi && ac[half] > ac[bestC] * 0.85) bestC = half;
    else if (bpm0 < 100 && dbl >= cLo && ac[dbl] > ac[bestC] * 0.97) bestC = dbl;
  }
  if (!(bestC >= cLo && bestC <= cHi)) {
    bestC = Math.max(cLo, Math.min(cHi, Math.round((60 * decRate) / ((bpmHint >= 40 && bpmHint <= 300) ? bpmHint : 126))));
  }
  // refine on fine grid near the coarse pick
  const f0 = Math.max(lagLo, bestC * DEC - 8), f1 = Math.min(lagHi, bestC * DEC + 8);
  let bestLag = Math.max(lagLo, Math.min(lagHi, bestC * DEC)), bestR = -1;
  for (let lag = f0; lag <= f1; lag++) {
    let r = 0;
    for (let i = 0; i + lag < len; i++) r += d[i] * d[i + lag];
    if (r > bestR) { bestR = r; bestLag = lag; }
  }
  const bpm = (60 * envRate) / bestLag;
  // phase: comb alignment (d^2 weights sharpen onsets)
  let phi = 0, bestPhiScore = -1;
  for (let p = 0; p < bestLag; p++) {
    let s = 0, k = 0;
    for (let i = p; i < len; i += bestLag, k++) { const v = d[Math.round(i)]; s += v * v; }
    if (k > 2) s /= k;
    if (s > bestPhiScore) { bestPhiScore = s; phi = p; }
  }
  // firstBeat: first grid point carrying real onset energy (anchored, not modulo)
  let firstBeat = phi / envRate;
  const win = Math.max(2, Math.round(bestLag / 8));
  const es = [];
  let maxE = 0;
  for (let g = phi; g < len; g += bestLag) {
    let e = 0;
    for (let j = g - win; j <= g + win; j++) {
      const v = j >= 0 && j < len ? d[j] : 0;
      if (v > e) e = v;
    }
    es.push(e);
    if (e > maxE) maxE = e;
  }
  for (let k = 0; k < es.length; k++) {
    if (es[k] > maxE * 0.35) { firstBeat = (phi + k * bestLag) / envRate; break; }
  }
  const strength = Math.round((bestR / len / (meanR + 1e-9)) * 100) / 100;

  return {
    dMin, dMax, oMin, oMax, oColor, colors,
    bpm: Math.round(bpm * 100) / 100,
    firstBeat: Math.max(0, firstBeat),
    strength: Math.round(strength * 100) / 100,
  };
}

self.onmessage = (e) => {
  const { id, L, R, sr, bpmHint } = e.data;
  let nZ = 0;
  for (let i = 0; i < L.length; i += 44100) if (L[i] !== 0) nZ++;
  console.log(`[worker v6] in: id=${id} n=${L.length} sr=${sr} hint=${bpmHint} voicedBlocks=${nZ}`);
  const t0 = Date.now();
  const out = analyze(L, R, sr, bpmHint || 0);
  out.id = id;
  out.ms = Date.now() - t0;
  console.log(`[worker v6] out: id=${id} ${out.ms}ms bpm=${out.bpm}`);
  self.postMessage(out);
};
