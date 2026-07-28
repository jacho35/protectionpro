/* ProtectionPro — Plan Markup DXF import (client).
 *
 * The DXF is parsed on the backend with ezdxf. Two outcomes:
 *   • roundtrip — the file is one of ours (has PP_META + PP_* blocks): the
 *     backend hands back native devices/routes/rooms/…; we rebuild them as
 *     editable plan entities on the active floor (relinking each device's
 *     circuit to its board by name).
 *   • underlay — a third-party DXF: the backend flattens it (blocks exploded)
 *     to a normalised entity list which we draw as a grey trace-over backdrop.
 *
 * An underlay belongs to one floor and outlives the session: the normalised
 * entity list is uploaded to the plan-image store (kind "dxf") exactly like a
 * background raster, and the floor keeps only the descriptor. Storing the
 * normalised list rather than the source DXF means reloading is a single GET
 * with no second ezdxf parse, and the project JSON — snapshotted into a
 * Revision row on every save — stays small.
 */

const PlanDxfImport = {
  _overlay: null,       // active floor's live underlay: {entities,bbox,offX,offY,scale,name}
  _entities: new Map(), // imageId → normalised entity list (decoded, shared across floors)
  _pending: new Set(),  // imageId currently fetching

  async importFile(file) {
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'plan.dxf');
      const resp = await fetch(`${API_BASE}/plan/dxf-import`, { method: 'POST', body: fd, headers: API.authHeaders() });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      const data = await resp.json();
      if (data.mode === 'roundtrip') this._reconstruct(data);
      else await this._setUnderlay(data.entities || [], file.name);
    } catch (e) {
      UI.alert('DXF import failed: ' + (e && e.message ? e.message : e));
    }
  },

  // ── Round-trip: rebuild native plan entities on the active floor ──
  _reconstruct(data) {
    const pm = AppState.planMarkup;
    pm.settings.domain = 'building';
    if ((!pm.scale || !pm.scale.factor) && data.factor) pm.scale = { factor: data.factor };

    const idByName = {};   // board name → new element id (for circuit relink)
    const importedEls = [];
    let nDev = 0, nRoute = 0;
    for (const d of (data.devices || [])) {
      const el = {
        id: AppState.planGenId('pmel'), type: d.type, x: d.x, y: d.y,
        rotation: d.rotation || 0, name: d.name || '', reticId: null,
        props: this._propsFor(d),
      };
      pm.elements.push(el); importedEls.push(el); nDev++;
      if (d.type === 'bd_db' && el.name) idByName[el.name.trim().toLowerCase()] = el.id;
    }
    // Relink each device's circuit to its board by the DBOARD attribute name.
    for (const el of pm.elements) {
      const board = el.props && el.props._dboard;
      if (board) {
        const id = idByName[String(board).trim().toLowerCase()];
        if (id) el.props.circuitDbId = id;
        delete el.props._dboard;
      }
    }
    // EE-12: routes round-trip as pure geometry (no fromId/toId, no snappedTo),
    // which silently kills tag propagation and routed-length sync. Re-snap each
    // endpoint/vertex to the nearest imported device — the coordinates are our
    // own exact export, so a tight tolerance re-establishes the topology
    // without grabbing genuinely free-space vertices.
    const TOL2 = 6 * 6;
    const nearestEl = (x, y) => {
      let best = null, bd = TOL2;
      for (const e of importedEls) { const dd = (e.x - x) ** 2 + (e.y - y) ** 2; if (dd <= bd) { bd = dd; best = e; } }
      return best;
    };
    for (const r of (data.routes || [])) {
      const type = (r.layer && r.layer.indexOf('RT_') === 0) ? r.layer.slice(3).toLowerCase() : 'circuit';
      const pts = r.pts.map(p => {
        const o = { x: p[0], y: p[1] };
        const near = nearestEl(o.x, o.y);
        if (near) o.snappedTo = near.id;
        return o;
      });
      pm.routes.push({
        id: AppState.planGenId('pmrt'), type: PLAN_DEFS.route(type) ? type : 'circuit',
        fromId: (pts[0] && pts[0].snappedTo) || null,
        toId: (pts[pts.length - 1] && pts[pts.length - 1].snappedTo) || null,
        points: pts,
        cableType: '', curved: !!r.curved, props: {},
      });
      nRoute++;
    }
    for (const t of (data.trenches || [])) pm.trenches.push({ id: AppState.planGenId('pmtr'), name: '', excType: Object.keys(PLAN_DEFS.trenchTypes || { trench: 1 })[0], points: t.pts.map(p => ({ x: p[0], y: p[1] })) });
    for (const rm of (data.rooms || [])) pm.rooms.push({ id: AppState.planGenId('pmrm'), name: rm.label || '', points: rm.pts.map(p => ({ x: p[0], y: p[1] })), color: '#0ea5e9' });
    for (const m of (data.measurements || [])) pm.measurements.push({ id: AppState.planGenId('pmms'), points: m.pts.map(p => ({ x: p[0], y: p[1] })) });
    for (const tx of (data.texts || [])) pm.texts.push({ id: AppState.planGenId('pmtx'), x: tx.x, y: tx.y, text: tx.text || '', fontSize: 14, color: '#111827' });

    if (typeof PlanCircuits !== 'undefined' && PlanCircuits.syncLoads) PlanCircuits.syncLoads();
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshFloorBar && PlanMarkup.refreshFloorBar(); }
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); PlanEngine.requestDraw({ all: true }); }
    UI.alert(`Imported ${nDev} device(s) and ${nRoute} route(s) from the DXF${data.floorName ? ' (floor "' + data.floorName + '")' : ''}.`);
  },

  // Restore variant + electrical props from the device's block name + attrs.
  _propsFor(d) {
    const props = {};
    const type = d.type, v = (d.block && d.block.indexOf('PP_' + type + '_') === 0) ? d.block.slice(('PP_' + type + '_').length) : '';
    if (type === 'bd_light') props.kind = v || 'ceiling';
    else if (type === 'bd_socket') { const m = /^(double_usb|double|single)(wp)?$/.exec(v); if (m) { props.outlets = m[1]; if (m[2]) props.weatherproof = true; } }
    else if (type === 'bd_switch') { const m = /^(.+)g(\d)$/.exec(v); if (m) { props.kind = m[1]; props.gangs = m[2]; } }
    else if (type === 'bd_switchboard') { const m = /^s(\d+)$/.exec(v); if (m) props.sections = +m[1]; }
    const a = d.attrs || {};
    if (a.CIRCUIT) props.circuitNo = a.CIRCUIT;
    if (a.PHASE) props.poles = (a.PHASE === '3P') ? '3P' : '1P';
    // EE-12: the export writes every device's EFFECTIVE VA to LOAD_VA. Storing
    // it verbatim pins a 20 W light at 20 VA forever; only keep it as an
    // explicit override when it actually differs from the recomputed auto VA.
    if (a.LOAD_VA) {
      const lv = Number(a.LOAD_VA);
      const auto = (typeof PlanCircuits !== 'undefined' && PlanCircuits.deviceVA)
        ? PlanCircuits.deviceVA({ type, props: { ...props } }) : NaN;
      if (!(Number.isFinite(lv) && lv === auto)) props.load_va = a.LOAD_VA;
    }
    if (a.CABLE) props.cableType = a.CABLE;
    if (a.DBOARD) props._dboard = a.DBOARD;   // transient; relinked to circuitDbId
    return props;
  },

  // ── Underlay: normalised entity list (lowercase) from the backend ──
  _bboxOf(entities) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const acc = (x, y) => { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; };
    for (const e of entities) {
      if (e.type === 'line') { acc(e.x1, e.y1); acc(e.x2, e.y2); }
      else if (e.type === 'circle' || e.type === 'arc') { acc(e.cx - e.r, e.cy - e.r); acc(e.cx + e.r, e.cy + e.r); }
      else if (e.type === 'lwpolyline') (e.pts || []).forEach(p => acc(p[0], p[1]));
      else if (e.type === 'text') acc(e.x, e.y);
    }
    return (bx0 === Infinity) ? null : { minX: bx0, minY: by0, maxX: bx1, maxY: by1 };
  },

  async _setUnderlay(entities, fname) {
    if (!entities.length) { UI.alert('No supported entities found in that DXF.'); return; }
    const bbox = this._bboxOf(entities);
    if (!bbox) { UI.alert('No drawable geometry in that DXF.'); return; }
    const w = Math.max(1, bbox.maxX - bbox.minX), h = Math.max(1, bbox.maxY - bbox.minY);
    const desc = {
      imageId: null, name: fname || 'DXF', count: entities.length,
      bbox, scale: 1000 / Math.max(w, h), offX: 0, offY: 0,
    };
    const fl = AppState.planActiveFloor();
    const prev = fl && fl.data.dxfUnderlay;

    // Persist the normalised list. A failed upload still leaves a usable
    // session underlay — losing the trace-over on reload beats losing the
    // import outright — but say so, since the user will expect it to stick.
    let stored = true;
    try {
      const meta = await this._uploadEntities(entities, desc.name);
      desc.imageId = meta.id;
      this._entities.set(meta.id, entities);
    } catch (e) {
      stored = false;
    }
    // A floor holds one underlay; release the previous row only once the
    // replacement is safely stored (and never the row we just wrote).
    if (prev && prev.imageId != null && prev.imageId !== desc.imageId) this._deleteStored(prev.imageId);
    if (fl) { fl.data.dxfUnderlay = desc; AppState.planMarkup.dxfUnderlay = desc; }
    this._overlay = { entities, bbox: desc.bbox, scale: desc.scale, offX: 0, offY: 0, name: desc.name };
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    if (typeof PlanEngine !== 'undefined') { PlanEngine.requestDraw({ bg: true }); PlanEngine.zoomFit(); }
    UI.toast(stored
      ? `Imported ${entities.length} DXF entities as a trace-over reference.`
      : `Imported ${entities.length} DXF entities (this session only — the reference could not be saved).`,
      stored ? 'success' : 'warning');
  },

  // Point the live overlay at the active floor's underlay, fetching the stored
  // entity list if it isn't decoded yet. Called wherever the active floor can
  // change (workspace activate, floor switch, project load, undo restore).
  syncFloor() {
    const fl = AppState.planActiveFloor();
    const desc = fl && fl.data && fl.data.dxfUnderlay;
    if (!desc) { if (this._overlay) { this._overlay = null; this._redraw(); } return; }
    if (desc.imageId == null) return;   // unsaved session underlay: _overlay already set
    const ents = this._entities.get(desc.imageId);
    if (ents) { this._apply(desc, ents); return; }
    this._fetchEntities(desc);
  },

  _apply(desc, entities) {
    this._overlay = {
      entities, name: desc.name || 'DXF',
      bbox: desc.bbox || this._bboxOf(entities),
      scale: desc.scale || 1, offX: desc.offX || 0, offY: desc.offY || 0,
      hidden: !!desc.hidden,
    };
    this._redraw();
  },

  _redraw() { if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true }); },

  _fetchEntities(desc) {
    const id = desc.imageId;
    if (this._pending.has(id)) return;
    this._pending.add(id);
    fetch(`${API_BASE}/plan-images/${id}`, { headers: API.authHeaders() })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(list => {
        this._pending.delete(id);
        if (!Array.isArray(list)) return;
        this._entities.set(id, list);
        // The floor may have changed while the fetch was in flight.
        const cur = AppState.planActiveFloor();
        if (cur && cur.data.dxfUnderlay && cur.data.dxfUnderlay.imageId === id) this._apply(cur.data.dxfUnderlay, list);
      })
      .catch(() => { this._pending.delete(id); });
  },

  async _uploadEntities(entities, name) {
    const blob = new Blob([JSON.stringify(entities)], { type: 'application/json' });
    const fd = new FormData();
    fd.append('file', new File([blob], (name || 'underlay') + '.json', { type: 'application/json' }));
    fd.append('kind', 'dxf');
    fd.append('name', name || '');
    if (AppState.projectId) fd.append('project_id', String(AppState.projectId));
    const resp = await fetch(`${API_BASE}/plan-images`, { method: 'POST', body: fd, headers: API.authHeaders() });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
      throw new Error(detail);
    }
    return resp.json();
  },

  // Best-effort release; the orphan cleanup sweep is the backstop.
  _deleteStored(imageId) {
    this._entities.delete(imageId);
    fetch(`${API_BASE}/plan-images/${imageId}`, { method: 'DELETE', headers: API.authHeaders() }).catch(() => {});
  },

  // Every stored underlay id in the project — for the on-save orphan claim.
  storedIds() {
    const out = [];
    for (const fl of AppState.planFloors()) {
      const d = fl.data && fl.data.dxfUnderlay;
      if (d && d.imageId != null) out.push(d.imageId);
    }
    return out;
  },

  // Drop the active floor's underlay (and its stored row).
  clear() {
    const fl = AppState.planActiveFloor();
    const desc = fl && fl.data.dxfUnderlay;
    if (desc && desc.imageId != null) this._deleteStored(desc.imageId);
    if (fl) fl.data.dxfUnderlay = null;
    AppState.planMarkup.dxfUnderlay = null;
    this._overlay = null;
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    this._redraw();
  },

  _tx(o, x, y) { return { x: o.offX + (x - o.bbox.minX) * o.scale, y: o.offY + (o.bbox.maxY - y) * o.scale }; },

  extentWorld() {
    const o = this._overlay; if (!o || o.hidden) return null;
    const a = this._tx(o, o.bbox.minX, o.bbox.maxY), b = this._tx(o, o.bbox.maxX, o.bbox.minY);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  },

  draw(ctx, zoom) {
    const o = this._overlay; if (!o || o.hidden) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(100,116,139,0.7)';
    ctx.fillStyle = 'rgba(100,116,139,0.7)';
    ctx.lineWidth = 0.8 / zoom;
    for (const e of o.entities) {
      if (e.type === 'line') {
        const a = this._tx(o, e.x1, e.y1), b = this._tx(o, e.x2, e.y2);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      } else if (e.type === 'circle') {
        const c = this._tx(o, e.cx, e.cy);
        ctx.beginPath(); ctx.arc(c.x, c.y, e.r * o.scale, 0, Math.PI * 2); ctx.stroke();
      } else if (e.type === 'arc') {
        const c = this._tx(o, e.cx, e.cy);
        const a0 = -(e.a1 || 0) * Math.PI / 180, a1 = -(e.a0 || 0) * Math.PI / 180;
        ctx.beginPath(); ctx.arc(c.x, c.y, e.r * o.scale, a0, a1); ctx.stroke();
      } else if (e.type === 'lwpolyline' && e.pts && e.pts.length) {
        ctx.beginPath();
        e.pts.forEach((p, i) => { const q = this._tx(o, p[0], p[1]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
        if (e.closed) ctx.closePath();
        ctx.stroke();
      } else if (e.type === 'text' && e.text) {
        const p = this._tx(o, e.x, e.y);
        const fpx = Math.max(6, (e.h || 2) * o.scale);
        ctx.font = `${fpx}px system-ui, sans-serif`;
        ctx.fillText(String(e.text), p.x, p.y);
      }
    }
    ctx.restore();
  },
};
