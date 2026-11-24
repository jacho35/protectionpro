// Tests for frontend/js/roadsections.js (pure, no browser).
//   node testing/unit/roadsections.test.js
const assert = require('assert');
global.PlanSections = require('../../frontend/js/plan-sections.js');
const RS = require('../../frontend/js/roadsections.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };

const fresh = (roads) => { const sl = { settings: {}, roadDesigns: [], roadPlan: { roads: [] } }; RS._use(sl, () => roads || []); return sl; };

ok('a new section: verge / carriageway / verge with every service at its default; the first one becomes the default', () => {
  fresh();
  const s = RS.add('Local road');
  assert.deepStrictEqual(s.strips.map(x => [x.type, x.width]), [['verge', 5], ['carriageway', 7], ['verge', 5]]);
  assert.strictEqual(s.items.kiosk.off, 1.5); assert.strictEqual(RS.defId(), s.id);
  const t = RS.add('Other'); assert.strictEqual(RS.defId(), s.id); assert.notStrictEqual(t.id, s.id);
  assert.strictEqual(new Set(s.strips.map(x => x.id)).size, 3);
});

ok('span: verge A / road / verge B from any strips; a median between carriageways is road', () => {
  fresh();
  const s = RS.make('Dual', [{ type: 'footpath', width: 2 }, { type: 'carriageway', width: 7.4 }, { type: 'median', width: 4 }, { type: 'carriageway', width: 7.4 }, { type: 'verge', width: 3 }]);
  assert.deepStrictEqual(RS.span(s), { a: 2, road: 18.8, b: 3, total: 23.8 });
  const v = RS.make('Path', [{ type: 'footpath', width: 3 }]);
  assert.deepStrictEqual(RS.span(v), { a: 1.5, road: 0, b: 1.5, total: 3 });
});

ok('layoutShape: the engine shape, the pole from the first lighting design using the section', () => {
  const sl = fresh(); const s = RS.add('R', [{ type: 'verge', width: 4 }, { type: 'carriageway', width: 6 }, { type: 'verge', width: 4 }]);
  let L = RS.layoutShape(s);
  assert.deepStrictEqual(L.strips, { a: 4, road: 6, b: 4 }); assert.strictEqual(L.items.lv.off, s.items.lv.off);
  assert.strictEqual(RS.pole(s), null);
  sl.roadDesigns.push({ id: 'rd_1', name: 'D', section: s.id, rows: [{ side: 'left', setback: 1, height: 10, overhang: 2 }] });
  assert.deepStrictEqual([RS.pole(s).off, RS.pole(s).h, RS.pole(s).arm], [3, 10, 2]);           // left kerb 4 m from A, 1 m behind it
  L = RS.layoutShape(s); assert.strictEqual(L.items.pole.off, 3);
  sl.roadDesigns[0].rows[0].side = 'right'; assert.strictEqual(RS.pole(s).off, 11);             // right kerb 10 m + 1 m
});

ok('a design with a section works on its strips (the same array); without one on its own', () => {
  const sl = fresh(); const s = RS.add('R');
  const d = { id: 'rd_1', section: s.id, sections: [] }; sl.roadDesigns.push(d);
  assert.strictEqual(RS.stripsOf(d), s.strips);
  const own = { id: 'rd_2', sections: [{ type: 'carriageway', width: 6 }] };
  assert.strictEqual(RS.stripsOf(own), own.sections);
});

ok('carriage: a road\'s own width wins, else its own section\'s, else none', () => {
  fresh(); const s = RS.add('R', [{ type: 'verge', width: 3 }, { type: 'carriageway', width: 6 }, { type: 'verge', width: 5 }]);
  assert.deepStrictEqual([RS.carriage({ carriageW: 7, cwOffset: 1 }).cw, RS.carriage({ carriageW: 7, cwOffset: 1 }).src], [7, 'own']);
  const c = RS.carriage({ section: s.id }); assert.strictEqual(c.cw, 6); assert.strictEqual(c.off, 1); assert.strictEqual(c.src, 'section');   // centre 1 m left of the reserve's
  assert.strictEqual(RS.carriage({}).cw, 0);                                                     // no pick: the layout's assumed width, as before
});

ok('roads: the default holds the roads with no pick; forLayout makes a line over each road with its own pick', () => {
  const roads = [{ id: 'r1', type: 'street', props: {} }, { id: 'r2', type: 'street', props: {} }];
  fresh(roads); const a = RS.add('A'), b = RS.add('B');
  RS.assign([roads[1]], b.id);
  assert.deepStrictEqual(RS.roadsUsing(a.id).map(r => r.id), ['r1']);
  assert.deepStrictEqual(RS.roadsUsing(b.id).map(r => r.id), ['r2']);
  const F = RS.forLayout(true);
  assert.strictEqual(F.def, a.id); assert.strictEqual(F.list.length, 2);
  assert.deepStrictEqual(F.lines.map(l => [l.streetId, l.sec]), [['r2', b.id]]);
  assert.strictEqual(PlanSections.at(F, 'r2', 50).id, b.id); assert.strictEqual(PlanSections.at(F, 'r1', 50).id, a.id);
  roads[1].props.carriageW = 5; assert.strictEqual(RS.mismatches().length, 1);                   // its own 5 m, the section's 7 m
});

ok('remove: roads go back to the default, designs keep the strips as their own; the last one stays', () => {
  const roads = [{ id: 'r1', type: 'street', props: {} }];
  const sl = fresh(roads); const a = RS.add('A'), b = RS.add('B', [{ type: 'carriageway', width: 9 }]);
  RS.assign(roads, b.id); const d = { id: 'rd_1', section: b.id, sections: [] }; sl.roadDesigns.push(d);
  assert.ok(RS.remove(b.id));
  assert.strictEqual(roads[0].props.section, undefined); assert.strictEqual(d.section, undefined); assert.strictEqual(d.sections[0].width, 9);
  assert.strictEqual(RS.remove(a.id), false);
});

ok('migrate: Auto layout sections and lines, and lighting designs\' own strips, become road sections once', () => {
  const roads = [{ id: 's1', type: 'street', props: {} }, { id: 's2', type: 'street', props: {} }];
  const sl = fresh(roads);
  const lay = { sections: { on: true, def: 'sec_2', list: [{ id: 'sec_1', name: 'Wide', strips: { a: 6, road: 8, b: 6 } }, { id: 'sec_2', name: 'Narrow', strips: { a: 3, road: 6, b: 3 } }],
    lines: [{ streetId: 's1', s0: 0, s1: 20, sec: 'sec_2' }, { streetId: 's1', s0: 20, s1: 90, sec: 'sec_1' }] } };
  const strips = [{ type: 'footpath', width: 2 }, { type: 'carriageway', width: 7.4, cls: 'B2' }, { type: 'footpath', width: 2 }];
  const designs = [{ id: 'rd_1', name: 'D1', sections: strips.map(x => Object.assign({}, x)) }, { id: 'rd_2', name: 'D2', sections: strips.map(x => Object.assign({}, x)) }];
  sl.roadDesigns = designs;
  assert.ok(RS.migrate(lay, designs));
  assert.deepStrictEqual(lay.sections, { on: true });
  assert.strictEqual(RS.list().length, 3);                                                       // Wide, Narrow, one shared by D1 + D2
  assert.strictEqual(RS.get(RS.defId()).name, 'Narrow');
  assert.strictEqual(RS.get(roads[0].props.section).name, 'Wide');                               // the line covering most of s1
  assert.strictEqual(roads[1].props.section, undefined);
  assert.strictEqual(designs[0].section, designs[1].section); assert.deepStrictEqual(designs[0].sections, []);
  assert.strictEqual(RS.stripsOf(designs[0])[1].cls, 'B2');
  assert.strictEqual(RS.migrate(lay, designs), false);                                           // nothing left to convert
});

console.log(n + ' passed');
