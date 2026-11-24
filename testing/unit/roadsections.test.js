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

ok('standard sizes: every section follows them until it differs; the engine shape carries the resolved sizes', () => {
  const sl = fresh(); const a = RS.add('A'), b = RS.add('B');
  assert.deepStrictEqual(RS.std().trench['LV/SL'], { w: 0.5, d: 0.7 }); assert.strictEqual(sl.settings.roadStd, RS.std());
  RS.setStd('kiosk', 'len', 1.8); RS.setStd('trench', 'LV/SL.d', 0.85); RS.setStd('trench', 'MV.w', 99);
  assert.strictEqual(RS.std().trench.MV.w, 3);                                                   // clamped
  RS.setOwn(a, 'off', true); a.items.kiosk.off = 2.2;
  let L = RS.layoutShape(a);
  assert.strictEqual(L.items.kiosk.len, 1.8); assert.strictEqual(L.items.kiosk.off, 2.2); assert.strictEqual(L.trench['LV/SL'].d, 0.85);
  assert.strictEqual(RS.setSize(a, 'kiosk', 'len', 2), true); assert.strictEqual(RS.layoutShape(a).items.kiosk.len, 1.8);   // not its own: the standard still wins
  RS.setOwn(a, 'kiosk', true);                                                                   // differs: starts from the standard
  assert.strictEqual(a.items.kiosk.len, 1.8); RS.setSize(a, 'kiosk', 'len', 2.4);
  assert.strictEqual(RS.layoutShape(a).items.kiosk.len, 2.4); assert.strictEqual(RS.layoutShape(b).items.kiosk.len, 1.8);
  RS.setStd('kiosk', 'len', 1.5); assert.strictEqual(RS.layoutShape(a).items.kiosk.len, 2.4); assert.strictEqual(RS.layoutShape(b).items.kiosk.len, 1.5);
  assert.deepStrictEqual(RS.differing('kiosk').map(s => s.id), [a.id]);
  RS.setOwn(a, 'kiosk', false); assert.strictEqual(RS.layoutShape(a).items.kiosk.len, 1.5); RS.setOwn(a, 'off', false); assert.strictEqual(a.own, undefined);
});

ok('copy from another section, make a section\'s own the standard', () => {
  fresh(); const a = RS.add('A'), b = RS.add('B'), c = RS.add('C');
  RS.setOwn(a, 'trench', true); RS.setSize(a, 'trench', 'FI.d', 0.45); RS.setSize(a, 'trench', 'FI.w', 0.25);
  assert.ok(RS.copyFrom(b, a, 'trench'));
  assert.ok(RS.own(b, 'trench')); assert.deepStrictEqual(RS.sizes(b, 'trench').FI, { w: 0.25, d: 0.45 });
  RS.setSize(a, 'trench', 'FI.d', 0.5); assert.strictEqual(RS.sizes(b, 'trench').FI.d, 0.45);   // a copy, not a link
  assert.strictEqual(RS.copyFrom(b, b, 'trench'), false);
  assert.ok(RS.toStd(a, 'trench'));
  assert.strictEqual(RS.std().trench.FI.d, 0.5); assert.strictEqual(RS.own(a, 'trench'), false);
  assert.strictEqual(RS.sizes(c, 'trench').FI.d, 0.5); assert.strictEqual(RS.sizes(b, 'trench').FI.d, 0.45);
});

ok('trenchSize: its own override, else the road section that differs, else the standard', () => {
  const roads = [{ id: 's1', type: 'street', props: {}, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }];
  fresh(roads); const a = RS.add('A'), b = RS.add('B');
  RS.setStd('trench', 'LV/SL.w', 0.55);
  assert.deepStrictEqual([RS.trenchSize({ excType: 'LV/SL' }).w, RS.trenchSize({ excType: 'LV/SL' }).from], [0.55, 'project standard']);
  RS.assign(roads, b.id); RS.setOwn(b, 'trench', true); RS.setSize(b, 'trench', 'LV/SL.w', 0.65);
  assert.strictEqual(RS.trenchSize({ excType: 'LV/SL', roadId: 's1' }).w, 0.65);
  assert.strictEqual(RS.trenchSize({ excType: 'LV/SL', section: b.id }).w, 0.65);
  assert.strictEqual(RS.trenchSize({ excType: 'LV/SL', section: a.id }).w, 0.55);
  assert.strictEqual(RS.trenchSize({ excType: 'LV/SL', roadId: 's1', widthOverride: 0.4, depthOverride: 1.2 }).w, 0.4);
  assert.strictEqual(RS.trenchSize({ excType: 'LV/SL', roadId: 's1', widthOverride: 0.4, depthOverride: 1.2 }).d, 1.2);
  // the road a hand-drawn trench runs along (1 px = 1 m here): within 25 m of its middle
  assert.strictEqual(RS.roadNear([{ x: 10, y: 8 }, { x: 60, y: 8 }], 1, roads), 's1');
  assert.strictEqual(RS.roadNear([{ x: 10, y: 40 }, { x: 60, y: 40 }], 1, roads), null);
});

ok('migrateStd: an older project keeps the sizes it used; other sections that differ keep theirs as their own', () => {
  const sl = fresh();
  const a = RS.add('A'), b = RS.add('B');
  Object.assign(a.items.lv, { depth: 0.8, w: 0.4 }); Object.assign(a.items.svc, { depth: 0.6 }); Object.assign(a.items.mv, { depth: 1.2 }); Object.assign(a.items.fi, { depth: 0.55 });
  Object.assign(b.items.lv, { depth: 0.9 }); Object.assign(b.items.svc, { depth: 0.6 }); Object.assign(b.items.mv, { depth: 1.2 }); Object.assign(b.items.fi, { depth: 0.55 });
  b.items.kiosk.len = 2.0;
  assert.ok(RS.migrateStd({ sections: { on: true } }, true));
  const S = sl.settings.roadStd;
  assert.deepStrictEqual([S.trench.MV.d, S.trench['LV/SL'].d, S.trench.FI.d, S.trench['MV/LV/SL'].d], [1.2, 0.8, 0.55, 1.2]);   // the default section's
  assert.strictEqual(S.trench['LV/SL'].w, 0.5); assert.strictEqual(S.kiosk.len, 1.4);
  assert.ok(RS.own(b, 'kiosk') && RS.own(b, 'trench')); assert.strictEqual(RS.sizes(b, 'trench')['LV/SL'].d, 0.9); assert.strictEqual(RS.sizes(b, 'kiosk').len, 2);
  assert.ok(!RS.own(a, 'kiosk')); assert.strictEqual(a.items.lv.depth, undefined);
  assert.strictEqual(RS.migrateStd({ sections: { on: true } }, true), false);                   // once
  // Auto layout's own depths where sections were off; the old trench types for a project with drawn trenches only; else the defaults
  fresh(); RS.add('A'); RS.migrateStd({ trench: { depth: { mv: 1.0, lv: 0.75, fi: 0.5, comb: null } } }, true);
  assert.deepStrictEqual([RS.std().trench.MV.d, RS.std().trench['LV/SL'].d, RS.std().trench.FI.d, RS.std().trench['MV/LV/SL'].d], [1, 0.75, 0.5, 1]);
  fresh(); RS.migrateStd(null, true); assert.deepStrictEqual([RS.std().trench.MV.d, RS.std().trench['LV/SL'].d], [1, 0.8]);
  fresh(); RS.migrateStd(null, false); assert.deepStrictEqual([RS.std().trench.MV.d, RS.std().trench['LV/SL'].d], [1.1, 0.7]);
});

ok('reserve: picked, the verges take up the change, the carriageway never moves', () => {
  fresh(); const a = RS.add('A');                                                                  // 5 + 7 + 5
  assert.strictEqual(RS.reserve(a), 17); assert.ok(RS.fits(a));                                  // none picked: the strips' sum
  assert.ok(RS.setReserve(a, 16)); assert.deepStrictEqual(a.strips.map(s => s.width), [4.5, 7, 4.5]); assert.strictEqual(RS.reserve(a), 16);
  assert.ok(RS.setReserve(a, 20, 'a')); assert.deepStrictEqual(a.strips.map(s => s.width), [4.5, 7, 8.5]);    // verge A keeps its width
  assert.ok(RS.setReserve(a, 18, 'b')); assert.deepStrictEqual(a.strips.map(s => s.width), [2.5, 7, 8.5]);
  assert.strictEqual(RS.setReserve(a, 6), false); assert.deepStrictEqual(a.strips.map(s => s.width), [2.5, 7, 8.5]);   // narrower than the carriageway: nothing changes
  a.strips[1].width = 6.4; assert.ok(!RS.fits(a));                                                // a strip edited: flagged
  assert.ok(RS.fitStrips(a)); assert.ok(RS.fits(a)); assert.strictEqual(a.strips[1].width, 6.4);
  a.strips[0].width = 3; assert.ok(!RS.fits(a)); RS.matchReserve(a); assert.strictEqual(RS.reserve(a), RS.total(a)); assert.ok(RS.fits(a));
  // the verge strip next to the boundary takes it first, then the other strips outside the carriageway
  const b = RS.make('B', [{ type: 'footpath', width: 2 }, { type: 'verge', width: 1 }, { type: 'carriageway', width: 7 }, { type: 'footpath', width: 2 }]);
  assert.ok(RS.setReserve(b, 10)); assert.deepStrictEqual(b.strips.map(s => s.width), [2, 0, 7, 1]);
  const c = RS.make('C', [{ type: 'carriageway', width: 7 }]);                                     // nothing beside the road: new verges
  assert.ok(RS.setReserve(c, 13)); assert.deepStrictEqual(c.strips.map(s => [s.type, s.width]), [['verge', 3], ['carriageway', 7], ['verge', 3]]);
});

ok('a road\'s reserve: its own width, else its section\'s picked one; mismatches name the nearest section', () => {
  const roads = [{ id: 'r1', type: 'street', props: {} }, { id: 'r2', type: 'street', props: { width: 20.2 } }, { id: 'r3', type: 'street', props: { width: 16.1 } }];
  fresh(roads); const a = RS.add('Local'), b = RS.add('Collector');
  assert.deepStrictEqual(RS.reserveOf(roads[0].props), { w: null, src: null });                   // nothing picked anywhere
  RS.setReserve(a, 16); RS.setReserve(b, 20);
  assert.strictEqual(RS.reserveOf(roads[0].props).w, 16); assert.strictEqual(RS.reserveOf(roads[0].props).src, 'section');
  assert.strictEqual(RS.reserveOf(roads[1].props).w, 20.2);
  const mm = RS.widthMismatches();
  assert.deepStrictEqual(mm.map(m => [m.route.id, m.near && m.near.id]), [['r2', b.id]]);         // 16.1 is within 0.25 m of 16
  RS.assign([roads[1]], b.id); assert.strictEqual(RS.widthMismatches().length, 0);
});


ok('standard offsets: every section follows them until it differs; a drag on its own offsets moves only that section', () => {
  const sl = fresh(); const a = RS.add('A'), b = RS.add('B');
  assert.deepStrictEqual(RS.std().off, { svc: 0.4, lv: 0.9, fi: 1.7, mv: 1.6, kiosk: 1.5, mh: 2.6 });
  RS.setStd('off', 'lv', 1.1); RS.setStd('off', 'fi', 99);
  assert.strictEqual(RS.std().off.fi, 10);                                                       // clamped
  assert.strictEqual(RS.layoutShape(a).items.lv.off, 1.1); assert.strictEqual(RS.layoutShape(b).items.lv.off, 1.1);
  a.items.lv.off = 3; assert.strictEqual(RS.layoutShape(a).items.lv.off, 1.1);                   // not its own: the standard wins
  RS.setOwn(a, 'off', true); assert.strictEqual(a.items.lv.off, 1.1);                            // starts from the standard
  RS.setSize(a, 'off', 'lv', 1.4);
  assert.strictEqual(RS.layoutShape(a).items.lv.off, 1.4); assert.strictEqual(RS.layoutShape(b).items.lv.off, 1.1);
  RS.copyFrom(b, a, 'off'); assert.strictEqual(RS.own(b, 'off'), true); assert.strictEqual(RS.layoutShape(b).items.lv.off, 1.4);
  RS.toStd(a, 'off'); assert.strictEqual(RS.std().off.lv, 1.4); assert.strictEqual(RS.own(a, 'off'), false);
  assert.deepStrictEqual(RS.differing('off').map(x => x.id), [b.id]);
});

ok('a standard made before the offsets: they come from the default section, a section that differs keeps its own', () => {
  const sl = fresh(); const a = RS.add('A'), b = RS.add('B'), c = RS.add('C');
  a.items.lv.off = 1.2; b.items.lv.off = 1.2; c.items.fi.off = 2.5;
  sl.settings.roadStd = { kiosk: {}, mh: {}, trench: {} };                                        // as 2.716 saved it
  assert.strictEqual(RS.migrateStd({}, false), true);
  assert.strictEqual(RS.std().off.lv, 1.2); assert.strictEqual(RS.std().off.fi, 1.7);
  assert.strictEqual(RS.own(a, 'off'), false); assert.strictEqual(RS.own(b, 'off'), false); assert.strictEqual(RS.own(c, 'off'), true);
  assert.strictEqual(RS.layoutShape(c).items.lv.off, 0.9); assert.strictEqual(RS.layoutShape(c).items.fi.off, 2.5);   // unchanged
  assert.strictEqual(RS.migrateStd({}, false), false);
});
console.log(n + ' passed');
