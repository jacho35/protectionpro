/* ProtectionPro — Distribution Designer Pro (.json) project importer.
 *
 * Reads a project saved by Distribution Designer Pro v9.x and rebuilds its
 * buildings×floors as ProtectionPro Plan Markup floors. Geometry maps cleanly
 * (both store floor-plan coordinates in image pixels + a metres-per-pixel scale
 * factor); the only real transforms are:
 *   • ORIGIN SHIFT — DD draws the plan image centred on the origin (coords are
 *     ±imgW/2), ProtectionPro draws it top-left at (0,0), so add imgW/2, imgH/2.
 *   • TYPE REMAP — DD's ~150 FP_ELS / FP_ROUTE_TYPES ids → our bd_* / route
 *     types. Unmapped types fall back to the nearest symbol; the original DD
 *     type is always stashed in props._ddType so nothing is silently lost.
 *   • IMAGE UPLOAD — DD embeds page rasters as base64; we POST them to
 *     /api/plan-images to mint the integer imageId our model references. If the
 *     backend is unreachable the image is skipped and the geometry still imports.
 *
 * DD's electrical schedule (building.dbs circuits/ratings) and custom symbols
 * have no home in planMarkup and are not imported (geometry + markup only).
 */

const PlanDdImport = {
  // ── Element type map: DD FP_ELS id → our bd_* type ──
  // Clean 1:1; everything else falls back by group (see _mapElType).
  _EL_EXPLICIT: {
    utility: 'bd_utility', transformer: 'bd_transformer', generator: 'bd_generator',
    mdb: 'bd_db', sdb: 'bd_db', db_wall: 'bd_db', riser: 'bd_riser',
    jb: 'bd_jb', splice_jb: 'bd_jb',
    isolator: 'bd_isolator', fcu: 'bd_fcu', data_pt: 'bd_datapoint',
    cctv_cam: 'bd_cctv', cctv_nvr: 'bd_cctv',
    smoke_det: 'bd_smoke', heat_det: 'bd_heat', mcp: 'bd_call',
    exit_sign: 'bd_light', emlight: 'bd_light',
  },

  _ROUTE_EXPLICIT: {
    main: 'feeder', sub: 'feeder', riser_feed: 'feeder', circuit: 'circuit',
    pvc_conduit: 'conduit', steel_conduit: 'conduit',
    cable_rack: 'cable_tray', perf_tray: 'cable_tray', basket_tray: 'cable_tray', ladder_rack: 'cable_tray',
    fire_cable: 'fire_cable', data_cable: 'data_cable', dali_bus: 'dali_bus',
  },

  isDdProject(o) { return !!(o && o.proj && Array.isArray(o.proj.buildings)); },

  // ── Entry point (wired to the Plan toolbar Import for .json files) ──
  async importFile(file) {
    let S;
    try { S = JSON.parse(await file.text()); }
    catch (e) { UI.alert('Could not read that file as JSON.'); return; }
    if (!this.isDdProject(S)) {
      UI.alert('This JSON is not a Distribution Designer project (no proj.buildings). ' +
        'To open a ProtectionPro project, use File ▸ Open instead.');
      return;
    }
    try {
      const sum = await this._import(S);
      if (typeof PlanMarkup !== 'undefined') {
        PlanMarkup.snapshot(); PlanMarkup.markDirty();
        PlanMarkup.refreshFloorBar();
      }
      if (typeof PlanImages !== 'undefined') PlanImages.syncCache();
      if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
      if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); PlanEngine.requestDraw({ all: true }); }
      const notes = [];
      if (sum.fallbacks) notes.push(`${sum.fallbacks} element(s) mapped to a nearest symbol (original type kept in props._ddType)`);
      if (sum.imagesFailed) notes.push(`${sum.imagesFailed} background image(s) could not be uploaded (geometry imported; overlay missing)`);
      if (sum.schedulesDropped) notes.push(`${sum.schedulesDropped} board schedule(s) were NOT imported — DD's circuit ratings have no home in the plan; re-derive them with "Sync Circuits" after syncing boards to the SLD`);
      UI.alert(
        `Imported from Distribution Designer:\n` +
        `• ${sum.floors} floor(s), ${sum.elements} device(s), ${sum.routes} route(s), ${sum.images} plan image(s)` +
        (sum.circuits ? `\n• ${sum.circuits} device(s) relinked to their distribution-board circuit` : '') +
        (notes.length ? `\n\n${notes.join('\n')}` : ''));
    } catch (e) {
      UI.alert('Import failed: ' + (e && e.message ? e.message : e));
    }
  },

  async _import(S) {
    const imgs = S._embeddedImages || {};
    const pm = AppState.planMarkup;
    pm.settings.domain = 'building';   // DD is a building-distribution tool
    const idMap = new Map();           // DD element id → new plan element id
    const newFloors = [];
    const sum = { floors: 0, elements: 0, routes: 0, images: 0, fallbacks: 0, imagesFailed: 0, circuits: 0, schedulesDropped: 0 };
    const multiBuilding = S.proj.buildings.length > 1;

    for (const b of S.proj.buildings) {
      // EE-11: DD's electrical board schedules (building.dbs) have no home in
      // planMarkup — count them so the completion dialog admits the drop.
      if (b.dbs) sum.schedulesDropped += Array.isArray(b.dbs) ? b.dbs.length : Object.keys(b.dbs).length;
      const bh = (typeof b.floorHeight === 'number') ? b.floorHeight : (pm.settings.floorHeight || 3.5);
      if (typeof b.riserFactor === 'number') pm.settings.riserFactor = b.riserFactor;   // per-building; last wins
      for (const fl of (b.floors || [])) {
        if (fl.isSitePlan) continue;   // outdoor site plan — this is a building import
        const fp = fl.fp || {};
        // Primary image + dims drive the origin shift (DD centres the image).
        const planList = (Array.isArray(fp.plans) && fp.plans.length)
          ? fp.plans
          : (fp.imgKey ? [{ imgKey: fp.imgKey, imgW: fp.imgW, imgH: fp.imgH, name: fl.name, opacity: 1, visible: true, offX: 0, offY: 0 }] : []);
        const prim = planList[0] || {};
        const imgW = prim.imgW || fp.imgW || 0;
        const imgH = prim.imgH || fp.imgH || 0;
        const shift = (x, y) => ({ x: (x || 0) + imgW / 2, y: (y || 0) + imgH / 2 });

        const floor = AppState._newPlanFloor(
          (multiBuilding ? `${b.name || 'Building'} — ` : '') + (fl.name || 'Floor'),
          (fl.level == null ? newFloors.length : fl.level),
          (typeof fl.height === 'number' ? fl.height : bh));
        const D = floor.data;

        // Background plans → upload rasters, keep integer ids.
        for (const pl of planList) {
          const dataUrl = imgs[pl.imgKey];
          if (!dataUrl) { if (pl.imgKey) sum.imagesFailed++; continue; }
          try {
            const { blob, mime } = this._dataUrlToBlob(dataUrl);
            const meta = await PlanImages._upload(blob, mime, pl.name || fl.name || 'Plan', pl.imgW || imgW, pl.imgH || imgH, 'raster');
            D.plans.push({
              id: AppState.planGenId('pmimg'), name: pl.name || fl.name || 'Plan',
              imageId: meta.id, sourcePdfId: null, pdfPage: null, pdfPages: null,
              imgW: pl.imgW || imgW, imgH: pl.imgH || imgH,
              opacity: (typeof pl.opacity === 'number') ? pl.opacity : 1,
              visible: pl.visible !== false, offX: pl.offX || 0, offY: pl.offY || 0,
              rotation: 0, scaleAdj: 1,
            });
            sum.images++;
          } catch (e) { sum.imagesFailed++; }
        }

        // Scale (identical semantics; shift the calibration points too).
        if (fp.scale && fp.scale.factor) {
          D.scale = { factor: fp.scale.factor, realDist: fp.scale.realDist, pxDist: fp.scale.pxDist };
          if (fp.scale.p1) D.scale.p1 = shift(fp.scale.p1.x, fp.scale.p1.y);
          if (fp.scale.p2) D.scale.p2 = shift(fp.scale.p2.x, fp.scale.p2.y);
        }
        if (fp.cropBox) D.cropBox = { ...fp.cropBox };

        // Elements (build the DD→new id map for route endpoints).
        for (const el of (fp.els || [])) {
          const m = this._mapElType(el.type);
          if (m.fb) sum.fallbacks++;
          const nid = AppState.planGenId('pmel');
          idMap.set(el.id, nid);
          const pos = shift(el.x, el.y);
          D.elements.push({
            id: nid, type: m.type, x: pos.x, y: pos.y, rotation: el.rotation || 0,
            name: el.name || '', reticId: null, props: this._mapElProps(el, m.type),
          });
          sum.elements++;
        }

        // Routes (remap endpoints via idMap; derive fromId/toId from endpoints).
        for (const rt of (fp.routes || [])) {
          const pts = (rt.pts || []).map(p => {
            const q = shift(p.x, p.y);
            const o = { x: q.x, y: q.y };
            if (p.snapped && idMap.has(p.snapped)) o.snappedTo = idMap.get(p.snapped);
            return o;
          });
          if (pts.length < 2) continue;
          const rtype = this._mapRouteType(rt.type);
          const props = { _ddType: rt.type };
          if (rt.size) props.size = rt.size;
          if (rt.mounting) props.mounting = rt.mounting;
          D.routes.push({
            id: AppState.planGenId('pmrt'), type: rtype,
            fromId: pts[0].snappedTo || null, toId: pts[pts.length - 1].snappedTo || null,
            points: pts, cableType: rt.cable || '', curved: !!rt.curved, props,
          });
          sum.routes++;
        }

        // Text notes / rooms / measurements (coord shift only).
        for (const tn of (fp.textNotes || [])) {
          const q = shift(tn.x, tn.y);
          D.texts.push({ id: AppState.planGenId('pmtx'), x: q.x, y: q.y, text: tn.text || tn.label || '', fontSize: tn.fontSize || 14, color: tn.color || '#111827' });
        }
        for (const rm of (fp.rooms || [])) {
          const src = rm.points || rm.pts;
          if (!Array.isArray(src) || src.length < 3) continue;
          D.rooms.push({ id: AppState.planGenId('pmrm'), name: rm.name || '', points: src.map(p => shift(p.x, p.y)), color: rm.color || '#0ea5e9' });
        }
        for (const ms of (fp.measurements || [])) {
          const src = ms.points || ms.pts;
          if (!Array.isArray(src) || src.length < 2) continue;
          D.measurements.push({ id: AppState.planGenId('pmms'), points: src.map(p => shift(p.x, p.y)) });
        }

        newFloors.push(floor);
        sum.floors++;
      }
    }

    if (!newFloors.length) throw new Error('No building floors found in this project (only a site plan?).');

    // EE-11: relink each device's DD circuit assignment to the imported board
    // (ids are only fully known now). circuitDbId + circuitNo drive syncLoads.
    for (const floor of newFloors) {
      for (const e of (floor.data.elements || [])) {
        const p = e.props;
        if (!p || p._ddDb == null) { if (p) { delete p._ddDb; delete p._ddCircuit; } continue; }
        const bid = idMap.get(p._ddDb);
        if (bid) {
          p.circuitDbId = bid;
          if (p._ddCircuit != null) p.circuitNo = String(p._ddCircuit);
          sum.circuits++;
        }
        delete p._ddDb; delete p._ddCircuit;
      }
    }

    // Append the imported floors. If the project is still the untouched default
    // (one empty Ground floor), replace it rather than leaving a blank sheet.
    AppState._stashActiveFloor();
    const soleEmpty = pm.floors.length === 1 && this._floorEmpty(pm.floors[0]);
    pm.floors = soleEmpty ? newFloors : pm.floors.concat(newFloors);
    pm.activeFloorId = newFloors[0].id;
    AppState._hydrateActiveFloor();
    return sum;
  },

  _floorEmpty(fl) {
    const d = (fl && fl.data) || {};
    return !((d.elements || []).length) && !((d.routes || []).length) && !((d.plans || []).length) &&
      !((d.trenches || []).length) && !((d.rooms || []).length) && !((d.texts || []).length) &&
      !((d.measurements || []).length) && !d.scale;
  },

  // ── Type mapping ──
  // Returns {type, fb} — fb true when it's a group fallback (not a clean 1:1).
  _mapElType(id) {
    id = String(id || '');
    if (this._EL_EXPLICIT[id]) return { type: this._EL_EXPLICIT[id], fb: false };
    if (id.startsWith('lt_')) return { type: 'bd_light', fb: true };
    if (id.startsWith('sock_') || id === 'floor_box') return { type: 'bd_socket', fb: true };
    if (id.startsWith('sw_')) return { type: 'bd_switch', fb: true };
    if (id.startsWith('smart_')) return { type: (/pir|daylight/.test(id) ? 'bd_sensor' : 'bd_dali'), fb: true };
    if (id.startsWith('dali_') || id.startsWith('ctrl_')) return { type: 'bd_dali', fb: true };
    if (id.startsWith('acc_')) return { type: 'bd_datapoint', fb: true };
    if (id.startsWith('fire_')) return { type: 'bd_call', fb: true };
    if (id === 'solar') return { type: 'bd_generator', fb: true };
    // earthing, metering, load, cable_drop, bld_entry, custom, … → neutral marker
    return { type: 'bd_jb', fb: true };
  },

  _mapRouteType(id) {
    id = String(id || '');
    if (this._ROUTE_EXPLICIT[id]) return this._ROUTE_EXPLICIT[id];
    if (id.startsWith('acc_')) return 'data_cable';
    if (id.startsWith('ctrl_')) return 'dali_bus';
    if (id.startsWith('earth_')) return 'circuit';
    return 'circuit';
  },

  // Carry across the props our target type understands; always stash the DD
  // type (and any load) so re-export / later mapping loses nothing.
  _mapElProps(el, targetType) {
    const props = { _ddType: el.type };
    if (targetType === 'bd_light') {
      props.kind = this._lightKind(el.type);
      if (typeof el.watts === 'number') props.watts = el.watts;
    } else if (targetType === 'bd_socket') {
      // EE-11: the socket editor keys on `outlets`, not `gangs` — a double
      // socket imported as gangs:'2' displayed "Single" and undercounted VA.
      props.outlets = this._socketGangs(el.type) === '2' ? 'double' : 'single';
    } else if (targetType === 'bd_switch') {
      const s = this._switchProps(el.type);
      props.gangs = s.gangs; props.kind = s.kind;
    }
    // EE-11: promote a DD wattage to the effective load_va for non-lighting
    // load devices (lights carry it as watts); otherwise stash it, never drop.
    if (typeof el.watts === 'number') {
      if (targetType !== 'bd_light' && (targetType === 'bd_socket' || targetType === 'bd_fcu')) {
        props.load_va = el.watts;
      } else if (props.watts == null) {
        props._ddWatts = el.watts;
      }
    }
    // EE-11: carry DD circuit assignments so they can be relinked to the
    // imported board once every element id is known (resolved in _import).
    const ddDb = el.dbId ?? el.db ?? el.board ?? el.boardId ?? el.dbRef ?? el.circuitDb ?? null;
    const ddCkt = el.circuit ?? el.circuitNo ?? el.ckt ?? el.way ?? el.wayNo ?? el.circuitNumber ?? null;
    if (ddDb != null && ddDb !== '') props._ddDb = ddDb;
    if (ddCkt != null && ddCkt !== '') props._ddCircuit = ddCkt;
    return props;
  },

  _lightKind(id) {
    id = String(id || '');
    if (id === 'exit_sign') return 'exit';
    if (id === 'emlight') return 'emergency';
    if (id.includes('down')) return 'downlight';
    if (id.includes('flood')) return 'floodlight';
    if (id.includes('hibay')) return 'highbay';
    if (id.includes('wall')) return 'wall';
    if (/strip|fluoro|batten|flex/.test(id)) return 'batten';
    return 'ceiling';
  },

  _socketGangs(id) {
    id = String(id || '');
    return /(^sock_d|^sock_td|^sock_ts|^sock_tded)/.test(id) ? '2' : '1';
  },

  _switchProps(id) {
    id = String(id || '');
    const gangs = id.includes('3g') ? '3' : id.includes('2g') ? '2' : '1';
    let kind = 'standard';
    if (id.includes('2w')) kind = '2way';
    else if (id.includes('int')) kind = 'intermediate';
    else if (id.includes('dim')) kind = 'dimmer';
    else if (id.includes('pir')) kind = 'pir';
    else if (id.includes('key')) kind = 'key';
    else if (id.includes('timer')) kind = 'timer';
    else if (id.includes('photocell')) kind = 'photocell';
    return { gangs, kind };
  },

  // data:<mime>;base64,<data> → { blob, mime }
  _dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
    const mime = (m && m[1]) || 'image/png';
    const isB64 = !!(m && m[2]);
    const data = m ? m[3] : '';
    let bytes;
    if (isB64) {
      const bin = atob(data);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(data));
    }
    return { blob: new Blob([bytes], { type: mime }), mime };
  },
};
