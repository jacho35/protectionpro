/* ProtectionPro — Plan Markup DXF import (client).
 *
 * The DXF is parsed on the backend with ezdxf. Two outcomes:
 *   • roundtrip — the file is one of ours (has PP_META + PP_* blocks): the
 *     backend hands back native devices/routes/rooms/…; we rebuild them as
 *     editable plan entities on the active floor (relinking each device's
 *     circuit to its board by name).
 *   • underlay — a third-party DXF: the backend flattens it (blocks exploded)
 *     to a normalised entity list which we draw as a grey trace-over backdrop
 *     (session-only, not persisted).
 */

const PlanDxfImport = {
  _overlay: null,   // {entities, bbox, offX, offY, scale, name}

  async importFile(file) {
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'plan.dxf');
      const resp = await fetch(`${API_BASE}/plan/dxf-import`, { method: 'POST', body: fd });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      const data = await resp.json();
      if (data.mode === 'roundtrip') this._reconstruct(data);
      else this._setUnderlay(data.entities || [], file.name);
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
    let nDev = 0, nRoute = 0;
    for (const d of (data.devices || [])) {
      const el = {
        id: AppState.planGenId('pmel'), type: d.type, x: d.x, y: d.y,
        rotation: d.rotation || 0, name: d.name || '', reticId: null,
        props: this._propsFor(d),
      };
      pm.elements.push(el); nDev++;
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
    for (const r of (data.routes || [])) {
      const type = (r.layer && r.layer.indexOf('RT_') === 0) ? r.layer.slice(3).toLowerCase() : 'circuit';
      pm.routes.push({
        id: AppState.planGenId('pmrt'), type: PLAN_DEFS.route(type) ? type : 'circuit',
        fromId: null, toId: null,
        points: r.pts.map(p => ({ x: p[0], y: p[1] })),
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
    if (a.LOAD_VA) props.load_va = a.LOAD_VA;
    if (a.CABLE) props.cableType = a.CABLE;
    if (a.DBOARD) props._dboard = a.DBOARD;   // transient; relinked to circuitDbId
    return props;
  },

  // ── Underlay: normalised entity list (lowercase) from the backend ──
  _setUnderlay(entities, fname) {
    if (!entities.length) { UI.alert('No supported entities found in that DXF.'); return; }
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    const acc = (x, y) => { if (x < bx0) bx0 = x; if (y < by0) by0 = y; if (x > bx1) bx1 = x; if (y > by1) by1 = y; };
    for (const e of entities) {
      if (e.type === 'line') { acc(e.x1, e.y1); acc(e.x2, e.y2); }
      else if (e.type === 'circle' || e.type === 'arc') { acc(e.cx - e.r, e.cy - e.r); acc(e.cx + e.r, e.cy + e.r); }
      else if (e.type === 'lwpolyline') (e.pts || []).forEach(p => acc(p[0], p[1]));
      else if (e.type === 'text') acc(e.x, e.y);
    }
    if (bx0 === Infinity) { UI.alert('No drawable geometry in that DXF.'); return; }
    const w = Math.max(1, bx1 - bx0), h = Math.max(1, by1 - by0);
    this._overlay = { entities, bbox: { minX: bx0, minY: by0, maxX: bx1, maxY: by1 }, scale: 1000 / Math.max(w, h), offX: 0, offY: 0, name: fname || 'DXF' };
    if (typeof PlanEngine !== 'undefined') { PlanEngine.requestDraw({ bg: true }); PlanEngine.zoomFit(); }
    UI.toast(`Imported ${entities.length} DXF entities (session reference).`, 'success');
  },

  clear() { this._overlay = null; if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true }); },

  _tx(o, x, y) { return { x: o.offX + (x - o.bbox.minX) * o.scale, y: o.offY + (o.bbox.maxY - y) * o.scale }; },

  extentWorld() {
    const o = this._overlay; if (!o) return null;
    const a = this._tx(o, o.bbox.minX, o.bbox.maxY), b = this._tx(o, o.bbox.maxX, o.bbox.minY);
    return { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) };
  },

  draw(ctx, zoom) {
    const o = this._overlay; if (!o) return;
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
