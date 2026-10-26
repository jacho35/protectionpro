/* ProtectionPro — CollabData: which project data Collab syncs per element, and how the
 * screens refresh after a remote change. collab.js is the engine; this file only
 * describes the data.
 *
 * A collection descriptor is { key, kind, group, get(), set?(v), immutable? }:
 *   list   an array of objects that each have a string `id` (synced one entity at a time,
 *          plus an `order` op when the sequence changes)
 *   map    an object keyed by id (photometry webs, junction classes)
 *   value  any JSON value, synced whole (settings, a background drawing)
 * `get()` returns the live array / object / value (undefined when that part of the project
 * doesn't exist yet) and remote changes are applied to it IN PLACE, so anything that
 * aliases the array keeps working. `immutable` entities are never edited after creation
 * (large photometric webs): they are compared by reference, not re-serialised every tick.
 * `group` picks the screen refresh below.
 *
 * Counters (`_kioskSeq` …) mint ids with `x._seq++`; while connected they are strided by
 * the server-assigned slot (id ≡ slot mod 16) so two editors never mint the same id.
 */

const CollabData = {
  STRIDE: 16,

  // The reticulation module: Demand (minisubs / kiosks / erven), street lighting
  // circuits and road lighting designs, the road plan and its 3D scene.
  _retic() { return AppState.reticulation; },
  _sl() { const r = AppState.reticulation; return r && r.streetLighting; },
  _rp() { const s = this._sl(); return s && s.roadPlan; },

  collections() {
    const R = () => this._retic(), SL = () => this._sl(), RP = () => this._rp();
    const scene = k => () => { const rp = RP(); return rp && rp.scene ? rp.scene[k] : undefined; };
    const ensureScene = () => {
      const rp = RP();
      if (rp && !rp.scene) rp.scene = { objects: [], surfaces: [], points: [] };
      return rp && rp.scene;
    };
    const sceneList = (key, k) => ({
      key, kind: 'list', group: 'rp',
      get: scene(k),
      ensure: () => { const sc = ensureScene(); if (sc && !Array.isArray(sc[k])) sc[k] = []; return sc && sc[k]; },
    });
    return [
      { key: 'retic.settings', kind: 'value', group: 'retic', get: () => R() && R().settings,
        set: v => { if (R() && v && typeof v === 'object') R().settings = v; } },
      { key: 'retic.minisubs', kind: 'list', group: 'retic', get: () => R() && R().minisubs },
      { key: 'retic.kiosks', kind: 'list', group: 'retic', get: () => R() && R().kiosks },

      { key: 'sl.settings', kind: 'value', group: 'sl', get: () => SL() && SL().settings,
        set: v => { if (SL() && v && typeof v === 'object') SL().settings = v; } },
      { key: 'sl.circuits', kind: 'list', group: 'sl', get: () => SL() && SL().circuits },
      { key: 'sl.roadDesigns', kind: 'list', group: 'sl', get: () => SL() && SL().roadDesigns },
      { key: 'sl.photometry', kind: 'map', group: 'sl', immutable: true, get: () => SL() && SL().photometry },

      { key: 'rp.roads', kind: 'list', group: 'rp', get: () => RP() && RP().roads },
      { key: 'rp.junctionCls', kind: 'map', group: 'rp', get: () => RP() && RP().junctionCls },
      { key: 'rp.bg', kind: 'value', group: 'rp', immutable: true, get: () => RP() && RP().bg,
        set: v => { if (RP()) RP().bg = v || null; } },
      { key: 'rp.settings', kind: 'value', group: 'rp', get: () => RP() && RP().settings,
        set: v => { if (RP() && v && typeof v === 'object') RP().settings = v; } },
      sceneList('rp.objects', 'objects'),
      sceneList('rp.surfaces', 'surfaces'),
      sceneList('rp.points', 'points'),
    ];
  },

  // Id counters: [holder, name]. Holders are replaced when a project loads or an undo
  // restores, so Collab re-installs on every tick.
  counters() {
    const out = [], r = this._retic(), sl = this._sl(), rp = this._rp();
    if (r) for (const n of ['_kioskSeq', '_erfSeq', '_msSeq']) out.push([r, n]);
    if (sl) for (const n of ['_circSeq', '_poleSeq', '_rdSeq', '_phSeq']) out.push([sl, n]);
    if (rp) out.push([rp, '_seq']);
    return out;
  },

  installCounters(slot) {
    const stride = this.STRIDE;
    for (const [holder, name] of this.counters()) {
      const d = Object.getOwnPropertyDescriptor(holder, name);
      if (!d || d.get) continue;   // missing, or already strided
      let raw = Number(d.value) || 1;
      Object.defineProperty(holder, name, {
        enumerable: true, configurable: true,
        get() { return raw + (((slot - raw % stride) + stride) % stride); },
        set(v) { raw = v; },
      });
    }
  },

  removeCounters() {
    for (const [holder, name] of this.counters()) {
      const d = Object.getOwnPropertyDescriptor(holder, name);
      if (d && d.get) Object.defineProperty(holder, name,
        { value: holder[name], writable: true, enumerable: true, configurable: true });
    }
  },

  // Redraw what a remote change touched, but only the screens that are showing.
  refresh(groups) {
    if (groups.has('retic') && typeof Retic !== 'undefined' && Retic._active) {
      Retic.render();
      clearTimeout(this._recomputeTimer);
      this._recomputeTimer = setTimeout(() => { if (Retic._active) Retic.recompute(); }, 600);
    }
    if (groups.has('sl') && typeof StreetLight !== 'undefined' && StreetLight._active) StreetLight.render();
    if (groups.has('rp') && typeof RoadPlan !== 'undefined' && RoadPlan._active) RoadPlan.render();
  },
};
