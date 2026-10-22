(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const pd = (el) => { el.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true})); el.dispatchEvent(new PointerEvent('pointerup', {bubbles: true})); };
  const out = {steps: [], errs: []};
  await sleep(2600);
  for (let i = 0; i < 24 && !q('#libtable tbody tr'); i++) await sleep(500);
  const rows = qa('#libtable tbody tr');
  out.steps.push('rows=' + rows.length);
  const good = (r) => !/kings_of_tomorrow|finally/i.test(r.textContent); // skip known-dead zero-byte files
  rows.filter(good)[0].dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
  pd(q('#deckslotB .deckmod'));
  await sleep(150);
  rows.filter(good)[1].dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
  const ready = (s) => { const m = q(s); return m.querySelector('.d-state').textContent === '' && m.querySelector('.d-remain').textContent !== '--:--'; };
  let okA = false, okB = false, waited = 0;
  for (let i = 0; i < 150; i++) { waited = i * 0.5;
    await sleep(500);
    okA = ready('#deckslotA'); okB = ready('#deckslotB');
    if (okA && okB) break;
  }
  out.steps.push('Aready=' + okA, 'Bready=' + okB, 'waitS=' + waited);
  q('#deckslotA .btn.play').click();
  q('#deckslotB .btn.play').click();
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (q('#deckslotA').classList.contains('playing') && q('#deckslotB').classList.contains('playing')) break;
  }
  out.playA = q('#deckslotA').classList.contains('playing');
  out.playB = q('#deckslotB').classList.contains('playing');
  out.audioRunning = q('#audioInd').classList.contains('b');
  let mp = 0;
  for (let i = 0; i < 6; i++) { await sleep(200); const e = window.__engine; if (e) mp = Math.max(mp, e.masterPeak()); }
  out.mPeak = +mp.toFixed(3); // REAL audio check — playing classes alone can hide a dead graph
  const hcA = q('#deckslotA .hc[data-h="0"]');
  pd(hcA);
  await sleep(500);
  out.hcSet = hcA.classList.contains('set');
  q('#deckslotA .lb[data-n="2"]').click();
  await sleep(400);
  out.loopBtnOn = q('#deckslotA .lb[data-n="2"]').classList.contains('on');
  q('#deckslotA .lact').click();
  await sleep(300);
  out.loopOffAfterActive = !q('#deckslotA .lb[data-n="2"]').classList.contains('on');
  const stripA = qa('#strips .strip')[0];
  stripA.querySelector('.k[data-k="hi"]').click();
  await sleep(100);
  out.killOn = stripA.querySelector('.k[data-k="hi"]').classList.contains('on');
  const mfx = stripA.querySelector('.s-mxsel'), mfxBtn = stripA.querySelector('.s-mxon');
  mfx.value = mfx.options[2].value;
  mfx.dispatchEvent(new Event('change', {bubbles: true}));
  await sleep(150);
  out.mixFxOn = mfxBtn.classList.contains('on');
  q('#xfLeft')?.click();
  await sleep(900);
  const cfg = qa('.u-config')[0];
  cfg.value = 'single';
  cfg.dispatchEvent(new Event('change', {bubbles: true}));
  await sleep(300);
  const pbs = qa('#unit1 .u-b');
  out.singleBtns = pbs.length;
  const uSel = q('#unit1 .u-sel');
  uSel.value = uSel.options[1].value;
  uSel.dispatchEvent(new Event('change', {bubbles: true}));
  await sleep(150);
  const fxOn = q('#unit1 .u-on');
  if (fxOn) { fxOn.click(); await sleep(200); out.fxOnAfterOn = fxOn.classList.contains('on'); }
  if (pbs.length) { pbs[1].click(); await sleep(150); }
  out.fxOnOn = fxOn.classList.contains('on'); out.fxLabel = fxOn.textContent;
  out.errs = [...window.__errs];
  return JSON.stringify(out, null, 1);
})()
