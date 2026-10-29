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
 * `group` picks the screen refresh below. `exclude` lists entity keys that are NOT synced with
 * the entity itself (a floor's drawing `data` has its own collections); `fresh(v)` gives a new
 * local entity its excluded keys; `structural` collections create the keys of others, so the
 * engine looks the descriptors up again after one of their ops.
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
      ...this.planCollections(),
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

      { key: 'sld.drawingSets', kind: 'list', group: 'sld', get: () => AppState.drawingSets },
      { key: 'sld.views', kind: 'list', group: 'sld', get: () => AppState.sldViews },
      { key: 'sld.shapes', kind: 'list', group: 'sld', get: () => AppState.sldShapes },
    ];
  },

  // Plan markup: the floor list (metadata only), the shared layers / styles / settings, and
  // each floor's own collections. The active floor's arrays are mirrored on planMarkup.<key>
  // (AppState._stashActiveFloor), so read and edit THAT copy for the active floor.
  planCollections() {
    const pm = () => AppState.planMarkup;
    const floor = id => { const p = pm(); return p && Array.isArray(p.floors) ? p.floors.find(f => f.id === id) : undefined; };
    const p0 = pm();
    if (!p0 || !Array.isArray(p0.floors)) return [];
    const out = [
      { key: 'plan.floors', kind: 'list', group: 'plan', structural: true, exclude: ['data'],
        fresh: () => ({ data: AppState._newPlanFloorData() }), get: () => pm() && pm().floors },
      { key: 'plan.layers', kind: 'list', group: 'plan', get: () => pm() && pm().layers },
      { key: 'plan.styles', kind: 'value', group: 'plan', get: () => pm() && pm().styles,
        set: v => { if (pm() && v && typeof v === 'object') pm().styles = v; } },
      { key: 'plan.settings', kind: 'value', group: 'plan', get: () => pm() && pm().settings,
        set: v => { if (pm() && v && typeof v === 'object') pm().settings = v; } },
      { key: 'plan.nameCounters', kind: 'value', group: 'plan', get: () => pm() && pm().nameCounters,
        set: v => { if (pm() && v && typeof v === 'object') pm().nameCounters = v; } },
    ];
    const live = (id, k) => {
      const p = pm(), fl = floor(id);
      if (!fl) return undefined;
      if (p.activeFloorId === id) return p[k];
      fl.data = fl.data || AppState._newPlanFloorData();
      return fl.data[k];
    };
    for (const fl of p0.floors) {
      const id = fl.id;
      for (const k of AppState._PLAN_FLOOR_KEYS) {
        const key = `plan.${id}.${k}`;
        if (k === 'scale' || k === 'cropBox') {
          out.push({ key, kind: 'value', group: 'plan', get: () => live(id, k),
            set: v => {
              const p = pm(), f = floor(id);
              if (!f) return;
              f.data = f.data || AppState._newPlanFloorData();
              f.data[k] = v;
              if (p.activeFloorId === id) p[k] = v;
            } });
        } else {
          out.push({ key, kind: 'list', group: 'plan', get: () => live(id, k),
            ensure: () => {
              const p = pm(), f = floor(id);
              if (!f) return undefined;
              f.data = f.data || AppState._newPlanFloorData();
              if (!Array.isArray(f.data[k])) f.data[k] = [];
              if (p.activeFloorId === id) p[k] = f.data[k];
              return f.data[k];
            } });
        }
      }
    }
    return out;
  },

  // After remote ops: keep the local view valid (the active floor may have been deleted).
  afterApply(groups) {
    if (!groups.has('plan')) return;
    const p = AppState.planMarkup;
    if (p && Array.isArray(p.floors) && p.floors.length && !p.floors.some(f => f.id === p.activeFloorId)) {
      p.activeFloorId = p.floors[0].id;
      AppState._hydrateActiveFloor();
    }
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.selectedIds && PlanMarkup.findEntityById) {
      for (const id of [...PlanMarkup.selectedIds]) if (!PlanMarkup.findEntityById(id)) PlanMarkup.selectedIds.delete(id);
    }
  },

  // Id counters: [holder, name]. Holders are replaced when a project loads or an undo
  // restores, so Collab re-installs on every tick.
  counters() {
    const out = [], r = this._retic(), sl = this._sl(), rp = this._rp();
    if (r) for (const n of ['_kioskSeq', '_erfSeq', '_msSeq']) out.push([r, n]);
    if (sl) for (const n of ['_circSeq', '_poleSeq', '_rdSeq', '_phSeq']) out.push([sl, n]);
    if (rp) out.push([rp, '_seq']);
    if (AppState.planMarkup) out.push([AppState.planMarkup, '_seq']);
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
    if (groups.has('plan')) {
      if (typeof PlanImages !== 'undefined' && PlanImages.syncCache) PlanImages.syncCache();
      if (typeof PlanDxfImport !== 'undefined' && PlanDxfImport.syncFloor) PlanDxfImport.syncFloor();
      if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active) {
        if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
        PlanMarkup.updateScaleReadout();
        PlanMarkup.refreshFloorBar();
        if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
      }
      if (typeof LightingWS !== 'undefined' && LightingWS._active) LightingWS.refresh();
    }
    if (groups.has('sl') && typeof StreetLight !== 'undefined' && StreetLight._active) StreetLight.render();
    if (groups.has('rp') && typeof RoadPlan !== 'undefined' && RoadPlan._active) RoadPlan.render();
    if (groups.has('sld') && typeof DrawingSet !== 'undefined') DrawingSet.refresh();
    if (groups.has('sld') && typeof SldShapes !== 'undefined') SldShapes.refresh();
  },
};
