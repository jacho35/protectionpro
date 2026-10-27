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

ok('the transformer is drawn on both sheets: whole on the receiving one, a ghost on the sending one', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8 });
  const lvPage = p.pages.find(pg => pg.buses.includes('lv1') && !pg.buses.includes('b11'));
  assert.ok(lvPage, 'lv1 has its own sheet');
  assert.ok(lvPage.ids.has('tx2'), 'real on the receiving sheet');
  const hv = p.pages.find(pg => pg.buses.includes('b11'));
  assert.ok(hv.ghosts.has('tx2') && !hv.ids.has('tx2'), 'ghost on the sending sheet');
  assert.ok(hv.ghostLines.length >= 1);
});

ok('regions are centred on the drawing and match the page aspect', () => {
  const p = SP.plan(network(), { paper: 'a3', minPt: 8 });
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
  const a = SP.plan(network(), { paper: 'a4', minPt: 8, keyPlan: true });
  const b = SP.plan(network(), { paper: 'a4', minPt: 8, keyPlan: false });
  assert.strictEqual(a.pages[0].no, 2);
  assert.strictEqual(b.pages[0].no, 1);
});

console.log(`${n} passed`);
