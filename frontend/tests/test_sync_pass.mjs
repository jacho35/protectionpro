/* ProtectionPro — the sync pass (UX plan PR 5).
 *
 * Runs the real constants.js / state.js / sync.js (vm sandbox, no browser):
 *  · routines run in their fixed order, whatever order they registered in;
 *  · a second pass changes nothing (idempotence);
 *  · an adopt pass (an old project opening) keeps differing values as
 *    overrides and does not mark the project changed; a later pass keeps the
 *    typed value until Reset;
 *  · an edit schedules one pass after the debounce; a held pointer (a drag)
 *    holds it until release; the pass's own writes start no second pass;
 *  · a remote co-editor's change (Sync.quietly) starts no pass;
 *  · "Keep workspaces in sync" off → no pass;
 *  · no undo snapshots while the pass writes;
 *  · a routine that throws becomes an Issues entry and the others still run;
 *  · old project → adopt pass pending on open; a project saved now → not;
 *  · the Reticulation, street-lighting, Building, Demand → single line and single-line feeder routines are registered.
 *
 * Run:  node frontend/tests/test_sync_pass.mjs   (exit code 1 on failure)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const js = join(dirname(fileURLToPath(import.meta.url)), '..', 'js');
const listeners = {};
let snapshots = 0;
const ctx = {
  console, Math, JSON, window: {},
  document: {
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    getElementById: () => null,
  },
  localStorage: { getItem: () => null, setItem() {} },
  queueMicrotask, setTimeout, clearTimeout, performance,
  Annotations: { offsets: new Map(), hiddenResultBoxes: new Set() },
  UndoManager: { _paused: false, snapshot() { if (!this._paused) snapshots++; } },
};
ctx.window.addEventListener = () => {};
vm.createContext(ctx);
for (const f of ['constants.js', 'cases.js', 'state.js', 'sync.js']) vm.runInContext(readFileSync(join(js, f), 'utf8'), ctx, { filename: f });
const A = vm.runInContext('AppState', ctx);
const Sync = vm.runInContext('Sync', ctx);
Sync.init();
Sync.DEBOUNCE_MS = 5;
const wait = (ms = 25) => new Promise(r => setTimeout(r, ms));
const fire = (t) => (listeners[t] || []).forEach(fn => fn());
const builtIn = Sync.routines.slice();

// Values from the vm come from another realm: compare their JSON.
const deq = (a, b) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null)));
let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// A pair of "workspaces": the source owns `len`, the target shows it.
const src = { len: 38 }, dst = { len: 38 };
const copyLen = {
  id: 'copy-len', order: 20, label: 'source → target',
  run(c) {
    const v = c.value('len:dst', src.len, dst.len);
    if (v === dst.len) return false;
    dst.len = v; c.touch('retic'); return true;
  },
};
function only(...rs) { Sync.routines = []; rs.forEach(r => Sync.register(r)); }

await ok('routines run in their fixed order', () => {
  const seen = [];
  only({ id: 'c', order: 50, run() { seen.push('c'); } }, { id: 'a', order: 10, run() { seen.push('a'); } }, { id: 'b', order: 30, run() { seen.push('b'); } });
  Sync.run();
  deq(seen, ['a', 'b', 'c']);
});

await ok('a second pass changes nothing', () => {
  only(copyLen); A.syncOverrides = {};
  src.len = 62;
  deq(Sync.run().changed, ['copy-len']);
  assert.strictEqual(dst.len, 62);
  deq(Sync.run().changed, []);
});

await ok('adopt pass on open keeps a differing value as an override, unchanged and not dirty', () => {
  only(copyLen); A.syncOverrides = {};
  src.len = 38; dst.len = 45;                 // typed in the other workspace
  A.dirty = false;
  const r = Sync.run({ adopt: true });
  assert.strictEqual(dst.len, 45);
  deq(A.syncOverrides['len:dst'], { v: 45, src: 38 });
  assert.strictEqual(A.dirty, false);
  assert.strictEqual(r.adopt, true);
  src.len = 40; Sync.run();                    // the source moves on …
  assert.strictEqual(dst.len, 45);             // … the typed value stays
  Sync.resetOverride('len:dst');
  Sync.run();
  assert.strictEqual(dst.len, 40);             // Reset: follows its source again
  assert.strictEqual(Sync.override('len:dst'), null);
});

await ok('an edit schedules one pass; the pass\'s own writes start no other', async () => {
  let runs = 0;
  only({ id: 'w', order: 1, run() { runs++; A.dirty = true; return runs === 1; } });
  A.dirty = true;
  await wait();
  assert.strictEqual(runs, 1);
  await wait();
  assert.strictEqual(runs, 1);
});

await ok('a held pointer (a drag) holds the pass until release', async () => {
  let runs = 0;
  only({ id: 'p', order: 1, run() { runs++; } });
  fire('pointerdown');
  A.dirty = true;
  await wait();
  assert.strictEqual(runs, 0);
  fire('pointerup');
  await wait();
  assert.strictEqual(runs, 1);
});

await ok('a remote co-editor\'s change starts no pass', async () => {
  let runs = 0;
  only({ id: 'r', order: 1, run() { runs++; } });
  Sync.quietly(() => { A.dirty = true; });
  await wait();
  assert.strictEqual(runs, 0);
});

await ok('"Keep workspaces in sync" off: no pass', async () => {
  let runs = 0;
  only({ id: 'o', order: 1, run() { runs++; } });
  A.keepInSync = false;
  A.dirty = true;
  await wait();
  assert.strictEqual(runs, 0);
  assert.strictEqual(Sync.run(), null);
  A.keepInSync = true;
});

await ok('no undo snapshots while the pass writes', () => {
  snapshots = 0;
  only({ id: 's', order: 1, run() { ctx.UndoManager.snapshot(); return true; } });
  Sync.run();
  assert.strictEqual(snapshots, 0);
  ctx.UndoManager.snapshot();
  assert.strictEqual(snapshots, 1);            // recording again afterwards
});

await ok('a routine that throws becomes an Issues entry; the rest still run', () => {
  const err = console.error; console.error = () => {};
  let after = false;
  only({ id: 'bad', order: 1, label: 'Broken link', run() { throw new Error('boom'); } }, { id: 'next', order: 2, run() { after = true; } });
  Sync.run();
  console.error = err;
  assert.ok(after);
  assert.strictEqual(Sync.issues.length, 1);
  assert.match(Sync.issues[0].text, /Broken link could not update: boom/);
});

await ok('routines report questions as Issues entries, replaced each pass', () => {
  let ask = true;
  only({ id: 'q', order: 1, run(c) { if (ask) c.issue('plan-uncalibrated', 'Site plan not calibrated'); } });
  Sync.run();
  deq(Sync.issues.map(i => i.key), ['plan-uncalibrated']);
  ask = false; Sync.run();
  deq(Sync.issues, []);
});

await ok('an old project opens with an adopt pass pending; one saved now does not', () => {
  const old = JSON.parse(JSON.stringify(A.toJSON()));
  delete old.keepInSync;
  A.fromJSON(old);
  assert.strictEqual(A._syncAdoptPending, true);
  assert.strictEqual(A.keepInSync, true);
  A.fromJSON(JSON.parse(JSON.stringify(A.toJSON())));
  assert.strictEqual(A._syncAdoptPending, false);
  const off = JSON.parse(JSON.stringify(A.toJSON())); off.keepInSync = false;
  A.fromJSON(off);
  assert.strictEqual(A.keepInSync, false);
  A.keepInSync = true;
  A.syncOverrides = { 'len:dst': { v: 1, src: 2 } };
  const back = JSON.parse(JSON.stringify(A.toJSON()));
  deq(back.syncOverrides, { 'len:dst': { v: 1, src: 2 } });
  A.fromJSON(back);
  deq(A.syncOverrides, { 'len:dst': { v: 1, src: 2 } });
});

await ok('the Reticulation, street-lighting, Building, Demand → single line and single-line feeder routines are registered, in order', () => {
  deq(builtIn.map(r => r.id), ['retic', 'streetlight', 'building', 'demand-sld', 'sld-feeder-ways']);
});

await wait();
console.log(`\n${n} passed`);
