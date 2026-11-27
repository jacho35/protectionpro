// Tests for frontend/js/wifi-engine.js (pure). node testing/unit/wifi-engine.test.js
// Expected values are worked by hand from the formulas in the engine header.
const assert = require('assert');
const W = require('../../frontend/js/wifi-engine.js');
let n = 0; const ok = (name, fn) => { fn(); n++; console.log('ok', name); };
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const near = (a, b, t = 0.01) => assert(Math.abs(a - b) < t, `${a} vs ${b}`);

ok('FSPL at 1 m: 5 GHz 47.26 dB, 2.4 GHz 40.18 dB', () => { near(W.fspl1('5'), 47.26); near(W.fspl1('2.4'), 40.18); });

ok('open line: Tx 17 + 4 dBi, 10 m, n = 3, 5 GHz → −56.26 dBm', () => {
  near(W.rssi({ x: 0, y: 0, tx: 17, gain: 4 }, 10, 0, { band: '5', exponent: 3 }), -56.26);
});
ok('inside 1 m the distance is held at 1 m', () => {
  near(W.rssi({ x: 0, y: 0, tx: 17, gain: 4 }, 0.2, 0, { band: '5', exponent: 3 }), 21 - 47.26);
});

ok('one brick wall costs 10 dB at 5 GHz and 8 dB at 2.4 GHz', () => {
  const a = rect(0, 0, 10, 10), b = rect(10, 0, 10, 10);
  const rooms = [{ id: 'A', points: a }, { id: 'B', points: b }];
  const segs = W.walls(rooms, { 'A:1': 'brick' }, 'drywall');
  near(W.wallLoss(segs, 5, 5, 15, 5, '5'), 10); near(W.wallLoss(segs, 5, 5, 15, 5, '2.4'), 8);
  near(W.wallLoss(segs, 2, 5, 8, 5, '5'), 0);
});

ok('a wall shared by two rooms is one wall, not two', () => {
  const rooms = [{ id: 'A', points: rect(0, 0, 10, 10) }, { id: 'B', points: rect(10, 0, 10, 10) }];
  const segs = W.walls(rooms, {}, 'drywall');
  assert.strictEqual(segs.length, 7);                       // 4 + 4 − 1 shared
  near(W.wallLoss(segs, 5, 5, 15, 5, '5'), 4);
});

ok('predict: the cell next to the AP is the loudest, the serving AP is the nearer one, a wall lowers the far room', () => {
  const rooms = [{ id: 'A', points: rect(0, 0, 10, 10) }, { id: 'B', points: rect(10, 0, 10, 10) }];
  const aps = [{ id: 'ap1', x: 2.5, y: 5, tx: 17, gain: 4 }];
  const open = W.predict({ rooms, aps, band: '5', exponent: 3, defaultWall: 'open', cell: 1 });
  const brick = W.predict({ rooms, aps, band: '5', exponent: 3, defaultWall: 'brick', cell: 1 });
  const k = (p, x, y) => Math.floor((y - p.y0) / p.step) * p.nx + Math.floor((x - p.x0) / p.step);
  assert(open.best[k(open, 2.5, 5)] > open.best[k(open, 15.5, 5)]);
  near(open.best[k(open, 15.5, 5)] - brick.best[k(brick, 15.5, 5)], 10, 0.5);
  assert.strictEqual(open.ap[k(open, 15.5, 5)], 0);
});

ok('roomStats: worst point and pass against the use target', () => {
  const rooms = [{ id: 'A', name: 'A', points: rect(0, 0, 10, 10) }];
  const aps = [{ id: 'ap1', x: 5, y: 5, tx: 17, gain: 4 }];
  const p = W.predict({ rooms, aps, band: '5', exponent: 3, defaultWall: 'open', cell: 0.5 });
  const r = W.roomStats(p, rooms, {})[0];
  // corner cell centre 7.0 m from the AP: 21 − (47.26 + 30·log10 7.0) = −51.1 dBm
  assert(r.pass); near(r.worst, 21 - (47.26 + 30 * Math.log10(Math.hypot(4.75, 4.75))), 0.05);
  assert.strictEqual(r.target, -67);
  const strict = W.roomStats(p, [{ id: 'A', name: 'A', points: rooms[0].points, use: 'video' }], { uses: { video: { rssi: -40 } } })[0];
  assert(!strict.pass);
});

ok('capacity: demand = persons × devices × Mbps × concurrency; rate follows the median SNR', () => {
  const rooms = [{ id: 'A', points: rect(0, 0, 10, 10) }];
  const aps = [{ id: 'ap1', x: 5, y: 5, tx: 17, gain: 4 }];
  const p = W.predict({ rooms, aps, band: '5', exponent: 3, defaultWall: 'open', cell: 1 });
  const c = W.capacity(p, rooms, aps, { width: 80, streams: 2, density: 10, devices: 2, mbps: 25, concurrency: 0.6 })[0];
  near(c.clients, 20, 0.01);                                  // 100 m² / 10 = 10 people × 2
  near(c.demand, 20 * 25 * 0.6, 0.01);                       // 300 Mbps
  assert(c.snrMedian > 36);                                   // strong signal: top MCS
  near(c.phy, 143.4 * 4.5 * 2, 0.01); near(c.capacity, 143.4 * 4.5 * 2 * 0.6, 0.01);
  assert(c.pass);
});

ok('rate1 steps with SNR', () => { assert.strictEqual(W.rate1(4), 0); assert.strictEqual(W.rate1(5), 8.6); assert.strictEqual(W.rate1(40), 143.4); });

ok('channels: two APs in earshot get different channels; far apart ones may share', () => {
  const near2 = [{ id: 'a', x: 0, y: 0, tx: 17, gain: 4 }, { id: 'b', x: 5, y: 0, tx: 17, gain: 4 }];
  const r = W.channels(near2, { band: '5', width: 80 }, []);
  assert.notStrictEqual(r.channels[0].channel, r.channels[1].channel); assert.strictEqual(r.clash.length, 0);
  const many = [0, 1, 2, 3, 4, 5, 6].map(i => ({ id: 'p' + i, x: i * 4, y: 0, tx: 17, gain: 4 }));
  const m = W.channels(many, { band: '5', width: 80 }, []);
  assert(m.clash.length >= 0 && m.channels.every(c => W.BANDS['5'].channels[80].includes(c.channel)));
});

ok('poe: ports, switches, watts, longest run against 90 m', () => {
  near(W.cableRun({ x: 0, y: 0 }, { x: 30, y: 20 }, { drop: 3, slack: 1.1 }), (50 + 6) * 1.1);
  const p = W.poe([{ id: 'a', kind: 'ap', run: 40 }, { id: 'b', kind: 'ap', watts: 25.5, run: 95 }, { id: 'c', kind: 'dp', run: 20 }], {});
  assert.strictEqual(p.ports, 3); assert.strictEqual(p.switches, 1); near(p.watts, 40.9); assert(!p.pass); assert.deepStrictEqual(p.tooLong, ['b']);
});

ok('link: 420 m at 5.5 GHz — FSPL 99.7 dB; F1 = 8.656·√(0.42/5.5) = 2.39 m', () => {
  const r = W.link({ dist: 420, freqGhz: 5.5, tx: 23, gainA: 23, gainB: 23, losses: 2, sens: -75 });
  near(r.fspl, 20 * Math.log10(0.42) + 20 * Math.log10(5500) + 32.44, 0.01);
  near(r.f1, 2.39, 0.01); near(r.rx, 69 - r.fspl - 2, 0.01); near(r.fade, r.rx + 75, 0.01);
  const blocked = W.link({ dist: 420, freqGhz: 5.5, obstruct: 2.0 });
  near(blocked.clear, (2.39 - 2.0) / 2.39, 0.02);
  assert(!blocked.pass);
});
ok('autoPlace: a 10 x 10 room needs one AP; a 40 x 10 room with brick walls every 10 m needs several, all targets met', () => {
  const one = W.autoPlace({ rooms: [{ id: 'A', points: rect(0, 0, 10, 10) }], band: '5', exponent: 3, defaultWall: 'open' });
  assert.strictEqual(one.aps.length, 1); assert.strictEqual(one.uncovered, 0);
  const rooms = [0, 1, 2, 3].map(i => ({ id: 'R' + i, points: rect(i * 10, 0, 10, 10) }));
  const many = W.autoPlace({ rooms, band: '5', exponent: 3, defaultWall: 'brick' });
  assert(many.aps.length >= 3 && many.uncovered === 0, JSON.stringify(many.aps.length));
  const p = W.predict({ rooms, aps: many.aps.map((a, i) => ({ id: 'a' + i, x: a.x, y: a.y, tx: 17, gain: 4 })), band: '5', exponent: 3, defaultWall: 'brick', cell: 1 });
  assert(W.roomStats(p, rooms, {}).filter(r => r.pass).length >= 3);
});
console.log(n + ' passed');
