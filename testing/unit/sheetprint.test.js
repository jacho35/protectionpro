// Diagram sheets by bus (frontend/js/sheetprint.js, no browser).
//   node testing/unit/sheetprint.test.js
const assert = require('assert');
global.escHtml = (s) => String(s);
const SP = require('../../frontend/js/sheetprint.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

// a model builder: parts are boxes, wires join port points
const mk = () => {
  const comps = [], wires = [];
  const add = (id, type, x, y, name, extra) => {
    const w = type === 'bus' ? (extra && extra.w) || 120 : 40, h = type === 'bus' ? 10 : 40;
    comps.push(Object.assign({
      id, type, name: name || id, x, y,
      switching: type === 'cb', cable: type === 'cable',
      bbox: { x0: x - w / 2 - 12, x1: x + w / 2 + (type === 'bus' ? 12 : 70), y0: y - h / 2 - 12, y1: y + h / 2 + 34 },
    }, extra && extra.c));
    return id;
  };
  const wire = (a, b, pa, pb) => { wires.push({ id: `w${wires.length}`, a, b, pa, pb: pb || pa }); };
  const at = (id) => comps.find(c => c.id === id);
  const link = (a, b) => { const ca = at(a), cb = at(b); wire(a, b, { x: ca.x, y: ca.y + 20 }, { x: cb.x, y: cb.y - 20 }); };
  return { comps, wires, add, wire, link };
};

// 33 kV bus -> cb -> T1 -> cb -> 11 kV bus -> cb -> T2 -> cb -> LV bus -> motor; utility on top
const chain = (m, tag, from, to, x, y0) => {
  const a = m.add('cb_a' + tag, 'cb', x, y0 + 60, 'Q-' + tag);
  const t = m.add('tx' + tag, 'transformer', x, y0 + 130, 'T' + tag);
  const b = m.add('cb_b' + tag, 'cb', x, y0 + 200, 'Qb-' + tag);
  m.link(from, a); m.link(a, t); m.link(t, b); m.link(b, to);
};
const network = (loads = 4, lvW = 400) => {
  const m = mk();
  m.add('u', 'utility', 400, -80, 'Utility');
  m.add('b33', 'bus', 400, 0, '33 kV BUS', { w: 700 });
  m.add('b11', 'bus', 400, 500, '11 kV BUS', { w: 700 });
  m.add('lv1', 'bus', 200, 1000, 'LV 1', { w: lvW });
  m.add('lv2', 'bus', 800, 1000, 'LV 2', { w: lvW });
  m.link('u', 'b33');
  chain(m, '1', 'b33', 'b11', 400, 0);
  chain(m, '2', 'b11', 'lv1', 200, 500);
  chain(m, '3', 'b11', 'lv2', 800, 500);
  for (let i = 0; i < loads; i++) { m.add('m1' + i, 'motor_induction', 100 + i * 80, 1100); m.link('lv1', 'm1' + i); m.add('m2' + i, 'motor_induction', 700 + i * 80, 1100); m.link('lv2', 'm2' + i); }
  return m;
};

ok('a small network fits one sheet, no connectors', () => {
  const p = SP.plan(network(), { paper: 'a1', minPt: 6 });
  assert.strictEqual(p.pages.length, 1);
  assert.strictEqual(p.connectors.length, 0);
  assert.strictEqual(p.pages[0].ids.has('m10'), true);
});

ok('too big for the minimum text: one sheet per bus group, buses packed while they fit', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8 });
  assert.ok(p.pages.length >= 2, 'splits');
  const all = new Set(p.pages.flatMap(pg => pg.buses));
  assert.deepStrictEqual([...all].sort(), ['b11', 'b33', 'lv1', 'lv2']);
  p.pages.forEach(pg => assert.ok(pg.pt >= 8 - 1e-9, `${pg.title} ${pg.pt}`));
  const sheetOf = (b) => p.pages.find(pg => pg.buses.includes(b)).index;
  assert.strictEqual(sheetOf('b33'), sheetOf('b11'), 'connected buses share the first sheet');
});

ok('every cut feeder carries the same tag on both sheets, FROM on the receiving side', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8 });
  assert.ok(p.connectors.length >= 1);
  for (const c of p.connectors) {
    assert.ok(c.from && c.to, c.id + ' has both ends');
    const tags = p.pages.flatMap(pg => pg.tags.filter(t => t.id === c.id).map(t => ({ pg, t })));
    assert.strictEqual(tags.length, 2);
    const to = tags.find(x => x.t.dir === 'TO'), from = tags.find(x => x.t.dir === 'FROM');
    assert.ok(to && from && to.pg !== from.pg);
    assert.strictEqual(to.t.sheet, from.pg.no, 'TO names the receiving sheet');
    assert.strictEqual(from.t.sheet, to.pg.no, 'FROM names the sending sheet');
  }
});

ok('breaker and cable IDs ride on the connector', () => {
  const m = network();
  // a cable between the 11 kV bus and the transformer chain 2
  m.add('cab', 'cable', 200, 585, 'C-301');
  const w = m.wires.find(x => x.a === 'cb_a2' && x.b === 'tx2');
  m.wires.splice(m.wires.indexOf(w), 1);
  m.link('cb_a2', 'cab'); m.link('cab', 'tx2');
  const p = SP.plan(m, { paper: 'a3', minPt: 8 });
  const c = p.connectors.find(x => x.breaker === 'Q-2');
  assert.ok(c, JSON.stringify(p.connectors));
  assert.strictEqual(c.cable, 'C-301');
});

ok('the transformer is drawn once, on the receiving sheet; the sending tag names it', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8, maxBuses: 1 });
  const lvPage = p.pages.find(pg => pg.buses.includes('lv1'));
  const hv = p.pages.find(pg => pg.buses.includes('b11'));
  assert.ok(lvPage.ids.has('tx2'), 'real on the receiving sheet');
  assert.ok(!hv.ids.has('tx2'), 'not on the sending sheet');
  const to = hv.tags.find(t => t.dir === 'TO' && t.farPage === lvPage);
  assert.ok(to && /LV 1/.test(to.lines.join(' ')), JSON.stringify(to && to.lines));
});

ok('regions are centred on the drawing and match the page aspect', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8, scale: 'fit' });
  for (const pg of p.pages) {
    const cx = (pg.bbox.x0 + pg.bbox.x1) / 2, cy = (pg.bbox.y0 + pg.bbox.y1) / 2;
    assert.ok(Math.abs(pg.region.x + pg.region.w / 2 - cx) < 1e-6);
    assert.ok(Math.abs(pg.region.y + pg.region.h / 2 - cy) < 1e-6);
    assert.ok(Math.abs(pg.region.w / pg.region.h - p.availMM[0] / p.availMM[1]) < 1e-6);
  }
});

ok('a bus too wide for a sheet splits into two pages joined by a busbar connector', () => {
  const m = mk();
  m.add('src', 'utility', 600, -80, 'Src');
  m.add('big', 'bus', 600, 0, 'BIG', { w: 1800 });
  m.link('src', 'big');
  for (let i = 0; i < 12; i++) { m.add('l' + i, 'motor_induction', 20 + i * 150, 120); m.link('big', 'l' + i); }
  const probe = SP.plan(m, { paper: 'a4', minPt: 8, oversize: 'keep' });
  assert.strictEqual(probe.oversized.length, 1);
  const p = SP.plan(m, { paper: 'a4', minPt: 8 });
  assert.ok(p.pages.length >= 2);
  p.pages.forEach(pg => assert.ok(pg.pt >= 8 - 1e-9));
  const conts = p.pages.flatMap(pg => pg.tags.filter(t => t.cont));
  assert.ok(conts.length >= 2);
  const id = conts[0].id;
  assert.deepStrictEqual(conts.filter(t => t.id === id).map(t => t.dir).sort(), ['FROM', 'TO']);
  const covered = new Set(p.pages.flatMap(pg => [...pg.ids]));
  assert.ok(m.comps.every(c => covered.has(c.id)), 'nothing is lost');
});

ok('a larger paper size is found when asked for', () => {
  const m = mk();
  m.add('big', 'bus', 600, 0, 'BIG', { w: 1800 });
  for (let i = 0; i < 12; i++) { m.add('l' + i, 'motor_induction', 20 + i * 150, 120); m.link('big', 'l' + i); }
  const paper = SP.fitPaper(m, { paper: 'a4', minPt: 8, landscape: true, keyPlan: true });
  assert.ok(['a3', 'a2', 'a1'].includes(paper), paper);
  assert.strictEqual(SP.plan(m, { paper, minPt: 8, oversize: 'keep' }).oversized.length, 0);
});

ok('sheets are numbered after the key plan', () => {
  const a = SP.plan(network(), { paper: 'a3', minPt: 8, keyPlan: true });
  const b = SP.plan(network(), { paper: 'a3', minPt: 8, keyPlan: false });
  assert.strictEqual(a.pages[0].no, 2);
  assert.strictEqual(b.pages[0].no, 1);
});

// 11 kV board feeding four load buses through breaker + cable (the substation template's shape)
const board = (n = 4, gap = 140) => {
  const m = mk();
  m.add('u', 'utility', 400, -100, 'Grid');
  m.add('b11', 'bus', 400, 0, '11kV Bus', { w: 600 });
  m.link('u', 'b11');
  for (let i = 0; i < n; i++) {
    const x = 120 + i * gap;
    m.add('cb' + i, 'cb', x, 60, 'CB-F' + (i + 1));
    m.add('c' + i, 'cable', x, 140, 'Feeder ' + (i + 1));
    m.add('lb' + i, 'bus', x, 220, 'Load Bus ' + (i + 1), { w: 90 });
    m.add('ld' + i, 'static_load', x, 300, 'Load ' + (i + 1));
    m.link('b11', 'cb' + i); m.link('cb' + i, 'c' + i); m.link('c' + i, 'lb' + i); m.link('lb' + i, 'ld' + i);
  }
  return m;
};

ok('sibling buses share a sheet (not one page each)', () => {
  const p = SP.plan(board(), { paper: 'a4', minPt: 10, maxBuses: 4 });
  const loadSheets = new Set(['lb0', 'lb1', 'lb2', 'lb3'].map(b => p.pages.find(pg => pg.buses.includes(b)).index));
  assert.ok(loadSheets.size < 4, `load buses on ${loadSheets.size} sheets`);
});

ok('a sheet that fits is never split (the fit test counts the real tags)', () => {
  const p = SP.plan(board(), { paper: 'a3', minPt: 8 });
  p.pages.forEach(pg => assert.strictEqual(pg.part, undefined, pg.title));
  assert.strictEqual(p.oversized.length, 0);
});

ok('a wide bus is cut across, so its feeders stay with it', () => {
  const m = mk();
  m.add('src', 'utility', 600, -80, 'Src');
  m.add('big', 'bus', 600, 0, 'BIG', { w: 1800 });
  m.link('src', 'big');
  for (let i = 0; i < 12; i++) { m.add('l' + i, 'motor_induction', 20 + i * 150, 400); m.link('big', 'l' + i); }
  const p = SP.plan(m, { paper: 'a4', minPt: 8 });
  const parts = p.pages.filter(pg => pg.part);
  assert.ok(parts.length >= 2);
  parts.forEach(pg => {
    assert.ok(isFinite(pg.clip.x0) || isFinite(pg.clip.x1), 'cut along x');
    assert.ok(!isFinite(pg.clip.y0) && !isFinite(pg.clip.y1), 'never along y');
    assert.ok(pg.ids.has('big'));
    assert.ok([...pg.ids].some(id => id[0] === 'l'), 'feeders on every part');
  });
});

ok('one scale for the whole set; "fit" sizes each sheet', () => {
  const u = SP.plan(network(), { paper: 'a3', minPt: 6, maxBuses: 1 });
  assert.ok(u.pages.length > 1);
  u.pages.forEach(pg => assert.ok(Math.abs(pg.k - u.pages[0].k) < 1e-12));
  const f = SP.plan(network(), { paper: 'a3', minPt: 6, maxBuses: 1, scale: 'fit' });
  assert.ok(new Set(f.pages.map(pg => pg.k.toFixed(6))).size > 1);
});

ok('connectors name the grid zone of the other end', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8, maxBuses: 1 });
  for (const c of p.connectors) {
    assert.ok(/^[A-Z]\d+$/.test(c.from.zone) && /^[A-Z]\d+$/.test(c.to.zone), JSON.stringify(c));
    const to = p.pages.flatMap(pg => pg.tags).find(t => t.id === c.id && t.dir === 'TO');
    assert.ok(to.lines[0].endsWith(c.to.zone), to.lines[0] + ' ' + c.to.zone);
  }
});

ok('a drawing set lays out the sheets as arranged and reports buses on no sheet', () => {
  const p = SP.plan(board(), { paper: 'a3', sheets: [
    { id: 's1', kind: 'buses', buses: ['b11'] },
    { id: 's2', kind: 'buses', buses: ['lb0', 'lb1', 'lb2'] },
  ] });
  assert.deepStrictEqual(p.pages.map(pg => pg.id), ['s1', 's2']);
  assert.deepStrictEqual(p.unassigned, ['lb3']);
  const t = p.pages[0].tags.find(x => x.wire && /Load Bus 4/.test(x.lines.join(' ')));
  assert.ok(t && /not on a sheet/.test(t.lines[0]));
});

ok('a proposal keeps fixed groups as they are', () => {
  const p = SP.plan(board(), { paper: 'a1', minPt: 6, fixed: [{ id: 'mine', buses: ['lb0', 'lb3'] }] });
  const mine = p.pages.find(pg => pg.id === 'mine');
  assert.deepStrictEqual(mine.buses.sort(), ['lb0', 'lb3']);
  assert.ok(p.pages.every(pg => pg === mine || (!pg.buses.includes('lb0') && !pg.buses.includes('lb3'))));
});

ok('a selection view shows only its parts; wires leaving it end in grey tags', () => {
  const p = SP.plan(board(), { paper: 'a3', keyPlan: false, sheets: [
    { id: 'v', kind: 'view', title: 'Feeder 1', view: { kind: 'parts', parts: ['cb0', 'c0', 'lb0', 'ld0'] } },
  ] });
  const pg = p.pages[0];
  assert.deepStrictEqual([...pg.ids].sort(), ['c0', 'cb0', 'lb0', 'ld0']);
  assert.ok(pg.tags.length === 1 && pg.tags[0].kind === 'grey');
  assert.ok(/11kV Bus/.test(pg.tags[0].lines.join(' ')));
  const edge = SP.plan(board(), { paper: 'a3', keyPlan: false, cut: 'edge', sheets: [{ id: 'v', kind: 'view', view: { kind: 'parts', parts: ['cb0', 'c0'] } }] });
  assert.strictEqual(edge.pages[0].tags.length, 0);
});

ok('a window view: whole parts centred inside (tags), or a viewport cut at the frame (edge)', () => {
  const sheets = [{ id: 'w', kind: 'view', view: { kind: 'window', window: { x: 60, y: 30, w: 200, h: 180 } } }];
  const t = SP.plan(board(), { paper: 'a3', keyPlan: false, sheets }).pages[0];
  assert.ok(t.ids.has('cb0') && t.ids.has('c1') && !t.ids.has('lb0') && !t.ids.has('ld3'));
  assert.strictEqual(t.clip, null);
  assert.ok(t.tags.some(x => x.kind === 'grey'));
  const e = SP.plan(board(), { paper: 'a3', keyPlan: false, cut: 'edge', sheets }).pages[0];
  assert.ok(e.ids.has('lb0'), 'overlapping parts are in a viewport');
  assert.deepStrictEqual(e.clip, { x0: 60, y0: 30, x1: 260, y1: 210 });
  assert.strictEqual(e.tags.length, 0);
});

ok('a long connector index continues on more key plan pages', () => {
  const L = SP.layout({ paper: 'a4', landscape: true, titleBlock: 'standard' });
  assert.strictEqual(SP.keyPageCount(L, 3, 5), 1);
  assert.ok(SP.keyPageCount(L, 10, 120) > 1);
});

ok('captions wrap instead of being cut off', () => {
  const lines = SP.wrap('Fuse-Zone A Incomer · Cable Zone A Main Feeder · LV Zone A');
  assert.ok(lines.length >= 2);
  assert.ok(lines.join(' ').includes('Cable Zone A Main Feeder'));
  assert.ok(!lines.join('').includes('…'));
});

console.log(`${n} passed`);
