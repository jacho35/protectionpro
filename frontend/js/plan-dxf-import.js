/* ProtectionPro — Plan Markup DXF import (client).
 *
 * The DXF is parsed on the backend with ezdxf. Two outcomes:
 *   • roundtrip — the file is one of ours (has PP_META + PP_* blocks): the
 *     backend hands back native devices/routes/trenches/rooms/…; we rebuild
 *     them as editable plan entities on the active floor, in whichever plan
 *     domain (Site plan / Floor plans) the file was exported from.
 *   • underlay — any other DXF: the backend returns it structured — layers
 *     (colour, on/frozen), block definitions, every placed block with its
 *     ATTRIB values, and model-space geometry with all curve types resolved
 *     (bulged polylines, splines, ellipses, hatches, dimensions…) — which we
 *     draw as a reference drawing and can convert to plan items
 *     (PlanDxfManager: blocks → devices, layers → routes/trenches/rooms/erven).
 *
 * A floor holds any number of DXFs (architectural + services, survey +
 * services…). Each is a descriptor in `planMarkup.dxfs` (per floor); the
 * parsed drawing is uploaded to the plan-image store (kind "dxf") so the
 * project JSON — snapshotted into a Revision on every save — stays small.
 *
 * Placement: DXF coordinates are stored relative to `origin` (extents'
 * lower-left) so survey coordinates keep canvas precision. A relative DXF
 * point (X, Y) lands at   world = off + scaleAdj·R(rotation)·(X·k, −Y·k)
 * where k is plan pixels per drawing unit. With known units a DXF lands at
 * true scale: k = unitM / (metres per pixel); an uncalibrated floor takes
 * its scale from the first DXF. DXFs sharing a coordinate system (same
 * project, different disciplines) are co-registered automatically.
 */

const PlanDxfImport = {
  _data: new Map(),     // imageId (or session key) → normalised drawing
  _pending: new Set(),  // imageId currently fetching
  _cache: new Map(),    // descriptor id → render/snap cache

  // ─── Descriptors on the active floor ───
  list() {
    const pm = AppState.planMarkup;
    if (!Array.isArray(pm.dxfs)) pm.dxfs = [];
    return pm.dxfs;
  },
  byId(id) { return this.list().find(d => d.id === id) || null; },
  dataOf(desc) { return desc ? (this._data.get(this._key(desc)) || null) : null; },
  _key(desc) { return desc.imageId != null ? desc.imageId : 'session:' + desc.id; },
  anyVisible() { return this.list().some(d => !d.hidden && this.dataOf(d)); },

  // ─── Import ───
  async importFile(file) {
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, 'Reading DXF…');
    let data;
    try {
      const fd = new FormData();
      fd.append('file', file, file.name || 'plan.dxf');
      const resp = await fetch(`${API_BASE}/plan/dxf-import`, { method: 'POST', body: fd, headers: API.authHeaders() });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      data = await resp.json();
    } catch (e) {
      UI.alert('DXF import failed: ' + (e && e.message ? e.message : e));
      return;
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
    }
    if (data.mode === 'roundtrip') this._reconstruct(data);
    else await this._addUnderlay(this._normalise(data), (file.name || 'DXF').replace(/\.dxf$/i, ''));
  },

  // ── Round-trip: rebuild native plan entities on the active floor ──
  _reconstruct(data) {
    const pm = AppState.planMarkup;
    const empty = !pm.elements.length && !pm.routes.length && !(pm.trenches || []).length;
    const domain = data.domain || 'building';
    if (empty) pm.settings.domain = domain;
    else if (pm.settings.domain !== domain) {
      UI.toast(`This DXF was exported from ${domain === 'retic' ? 'a Site plan' : 'Floor plans'} — importing its items anyway.`, 'warning');
    }
    if ((!pm.scale || !pm.scale.factor) && data.factor) pm.scale = { factor: data.factor };

    const idByName = {};   // board name → new element id (for circuit relink)
    const nameToEl = {};   // any device name → element (route endpoint relink)
    const importedEls = [];
    let nDev = 0, nRoute = 0;
    for (const d of (data.devices || [])) {
      if (!PLAN_DEFS.element(d.type)) continue;
      const el = {
        id: AppState.planGenId('pmel'), type: d.type, x: d.x, y: d.y,
        rotation: d.rotation || 0, name: d.name || '', reticId: null,
        props: { ...PLAN_DEFS.defaults(d.type), ...this._propsFor(d) },
      };
      pm.elements.push(el); importedEls.push(el); nDev++;
      if (d.type === 'bd_db' && el.name) idByName[el.name.trim().toLowerCase()] = el.id;
      if (el.name) nameToEl[el.name.trim().toLowerCase()] = el;
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
    // Routes carry TYPE/CABLE/FROM/TO as XDATA; older files only the layer.
    // Endpoints relink by the FROM/TO device name, else (EE-12) re-snap to the
    // nearest imported device — the coordinates are our own exact export, so a
    // tight tolerance re-establishes topology without grabbing free vertices.
    const TOL2 = 6 * 6;
    const nearestEl = (x, y) => {
      let best = null, bd = TOL2;
      for (const e of importedEls) { const dd = (e.x - x) ** 2 + (e.y - y) ** 2; if (dd <= bd) { bd = dd; best = e; } }
      return best;
    };
    for (const r of (data.routes || [])) {
      const meta = r.meta || {};
      let type = meta.TYPE || ((r.layer && r.layer.indexOf('RT_') === 0) ? r.layer.slice(3).toLowerCase() : '');
      if (!PLAN_DEFS.route(type)) type = domain === 'retic' ? 'lv' : 'circuit';
      if (!PLAN_DEFS.route(type)) type = Object.keys(PLAN_DEFS.routes)[0];
      const pts = r.pts.map(p => {
        const o = { x: p[0], y: p[1] };
        const near = nearestEl(o.x, o.y);
        if (near) o.snappedTo = near.id;
        return o;
      });
      const byName = (n) => n && nameToEl[String(n).trim().toLowerCase()];
      const from = byName(meta.FROM), to = byName(meta.TO);
      if (from && pts[0]) pts[0].snappedTo = from.id;
      if (to && pts.length) pts[pts.length - 1].snappedTo = to.id;
      pm.routes.push({
        id: AppState.planGenId('pmrt'), type,
        fromId: (pts[0] && pts[0].snappedTo) || null,
        toId: (pts[pts.length - 1] && pts[pts.length - 1].snappedTo) || null,
        points: pts,
        cableType: meta.CABLE || '', curved: !!r.curved, props: {},
      });
      nRoute++;
    }
    const excTypes = Object.keys(PLAN_DEFS.trenchTypes || { trench: 1 });
    for (const t of (data.trenches || [])) {
      const exc = t.meta && t.meta.EXC;
      pm.trenches.push({ id: AppState.planGenId('pmtr'), name: (t.meta && t.meta.NAME) || '',
        excType: excTypes.includes(exc) ? exc : excTypes[0], points: t.pts.map(p => ({ x: p[0], y: p[1] })) });
    }
    for (const c of (data.crossings || [])) {
      const sz = c.meta && c.meta.SIZE;
      pm.crossings.push({ id: AppState.planGenId('pmcr'), name: (c.meta && c.meta.NAME) || '',
        size: (PLAN_DEFS.crossings.sizes.includes(sz) ? sz : PLAN_DEFS.crossings.defaultSize),
        p1: { x: c.p1[0], y: c.p1[1] }, p2: { x: c.p2[0], y: c.p2[1] } });
    }
    for (const rm of (data.rooms || [])) pm.rooms.push({ id: AppState.planGenId('pmrm'), name: rm.label || '', points: rm.pts.map(p => ({ x: p[0], y: p[1] })), color: null });
    for (const m of (data.measurements || [])) pm.measurements.push({ id: AppState.planGenId('pmms'), points: m.pts.map(p => ({ x: p[0], y: p[1] })) });
    for (const tx of (data.texts || [])) pm.texts.push({ id: AppState.planGenId('pmtx'), x: tx.x, y: tx.y, text: tx.text || '', fontSize: 14, color: '#111827' });

    this._afterEntitiesChanged();
    if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); PlanEngine.requestDraw({ all: true }); }
    UI.alert(`Imported ${nDev} device(s) and ${nRoute} route(s) from the DXF${data.floorName ? ' (floor "' + data.floorName + '")' : ''}.`);
  },

  _afterEntitiesChanged() {
    if (typeof PlanCircuits !== 'undefined' && PlanCircuits.syncLoads) PlanCircuits.syncLoads();
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshFloorBar && PlanMarkup.refreshFloorBar(); PlanMarkup.updatePushButton && PlanMarkup.updatePushButton(); }
    if (typeof PlanUI !== 'undefined') { PlanUI.renderPalette(); PlanUI.renderProps(); }
    if (typeof Workspaces !== 'undefined' && Workspaces.refresh) Workspaces.refresh();
  },

  // Restore variant + electrical props from the device's block name + attrs.
  // A LISP-named block (def.dxfBlock) carries its variant in the PP_VARIANT
  // tag instead of a block-name suffix (see plan-dxf.js); legacy files
  // (pre-rename, or no XDATA at all) fall back to the old suffix parse.
  _propsFor(d) {
    const props = {};
    const type = d.type;
    const a = d.attrs || {};
    const def = PLAN_DEFS.element(type);
    const v = a.PP_VARIANT || ((d.block && d.block.indexOf('PP_' + type + '_') === 0) ? d.block.slice(('PP_' + type + '_').length) : '');
    if (type === 'bd_light') props.kind = v || 'ceiling';
    else if (type === 'bd_socket') { const m = /^(double_usb|double|single)(wp)?$/.exec(v); if (m) { props.outlets = m[1]; if (m[2]) props.weatherproof = true; } }
    else if (type === 'bd_switch') { const m = /^(.+)g(\d)$/.exec(v); if (m) { props.kind = m[1]; props.gangs = m[2]; } }
    else if (type === 'bd_switchboard') { const m = /^s(\d+)$/.exec(v); if (m) props.sections = +m[1]; }
    if (a.CIRCUIT) props.circuitNo = a.CIRCUIT;
    if (a.PHASE) props.poles = (a.PHASE === '3P') ? '3P' : '1P';
    if (a.CABLE) props.cableType = a.CABLE;
    const dboard = a.DBFED || a.DBOARD;   // DBFED is current; DBOARD is the pre-rename tag name
    if (dboard) props._dboard = dboard;   // transient; relinked to circuitDbId
    // Per-type fields with a LISP tag (WATTS/LUMENS/ZONE/HEIGHT/SIZE/CONDUCTOR)
    // — resolved before the LOAD_VA auto-vs-override check below, since a
    // light's auto VA is derived from its OWN watts value.
    if (def && def.dxfBlock) {
      for (const f of (def.fields || [])) {
        const tag = PLAN_DXF_FIELD_TAGS[f.key];
        if (tag && a[tag] != null && a[tag] !== '') {
          props[f.key] = (f.type === 'number') ? Number(a[tag]) : a[tag];
        }
      }
    }
    // EE-12: the export writes every device's EFFECTIVE VA to LOAD_VA. Storing
    // it verbatim pins a 20 W light at 20 VA forever; only keep it as an
    // explicit override when it actually differs from the recomputed auto VA.
    if (a.LOAD_VA) {
      const lv = Number(a.LOAD_VA);
      const auto = (typeof PlanCircuits !== 'undefined' && PlanCircuits.deviceVA)
        ? PlanCircuits.deviceVA({ type, props: { ...props } }) : NaN;
      if (!(Number.isFinite(lv) && lv === auto)) props.load_va = a.LOAD_VA;
    }
    return props;
  },

  // ─── Drawing normalisation ───
  // Current format (2) passes through; a pre-multi-DXF stored list (array of
  // {type:'line'|'circle'|'arc'|'lwpolyline'|'text'} in absolute coords) is
  // lifted into the same shape so one renderer serves both.
  _normalise(data) {
    if (data && !Array.isArray(data) && data.format === 2) {
      data.blocks = data.blocks || {};
      data.inserts = data.inserts || [];
      data.entities = data.entities || [];
      data.layers = data.layers || [];
      return data;
    }
    const list = Array.isArray(data) ? data : ((data && data.entities) || []);
    const ents = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const acc = (x, y) => { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; };
    for (const e of list) {
      if (e.type === 'line') { ents.push({ t: 'l', l: '0', p: [e.x1, e.y1, e.x2, e.y2] }); acc(e.x1, e.y1); acc(e.x2, e.y2); }
      else if (e.type === 'circle') { ents.push({ t: 'c', l: '0', p: [e.cx, e.cy, e.r] }); acc(e.cx - e.r, e.cy - e.r); acc(e.cx + e.r, e.cy + e.r); }
      else if (e.type === 'arc') { ents.push({ t: 'a', l: '0', p: [e.cx, e.cy, e.r, e.a0 || 0, e.a1 || 0] }); acc(e.cx - e.r, e.cy - e.r); acc(e.cx + e.r, e.cy + e.r); }
      else if (e.type === 'lwpolyline' && e.pts) { ents.push({ t: 'p', l: '0', g: 'LWPOLYLINE', c: !!e.closed, p: e.pts.flatMap(q => { acc(q[0], q[1]); return [q[0], q[1]]; }) }); }
      else if (e.type === 'text') { ents.push({ t: 'x', l: '0', p: [e.x, e.y], h: e.h || 2, r: 0, s: String(e.text || ''), ha: 'l', va: 'a' }); acc(e.x, e.y); }
    }
    return {
      format: 2, legacy: true, units: { m: null }, origin: [0, 0],
      bbox: x0 === Infinity ? [0, 0, 1, 1] : [x0, y0, x1, y1],
      layers: [{ name: '0', color: '#64748b', aci7: false, on: true, frozen: false, n: ents.length }],
      blocks: {}, inserts: [], entities: ents, count: ents.length,
    };
  },

  // ─── Adding an underlay ───
  async _addUnderlay(data, name) {
    if (data.empty || !(data.entities.length || data.inserts.length)) {
      const sk = data.skipped && Object.keys(data.skipped).length ? ` (unsupported: ${Object.keys(data.skipped).join(', ')})` : '';
      UI.alert('No drawable geometry found in that DXF' + sk + '. Only model space is read — if the drawing sits in a layout (paper space), explode or copy it to model space first.');
      return;
    }
    const pm = AppState.planMarkup;
    let unitM = data.units && data.units.m;
    let guessed = false;
    if (!unitM) {
      unitM = await this.askUnits(data, name);
      if (!unitM) return;   // cancelled
      guessed = true;
    }
    // A layer off/frozen in the source file starts hidden here too — but a
    // CAD session's layer state is often just whatever was toggled while the
    // last person worked on it, not a deliberate "never show this" choice.
    // Silently honouring it can hide most of a drawing with zero indication
    // why, so count how much content that affects and flag it below.
    const layers = {};
    let hiddenLayers = 0, hiddenRecords = 0, totalRecords = 0;
    for (const ly of data.layers) {
      totalRecords += ly.n || 0;
      if (!ly.on || ly.frozen) {
        layers[ly.name] = { hidden: true };
        hiddenLayers++;
        hiddenRecords += ly.n || 0;
      }
    }
    const desc = {
      id: AppState.planGenId('pmdxf'), imageId: null, name, count: data.count || 0,
      unitM, unitsGuessed: guessed, origin: data.origin || [0, 0], bbox: data.bbox,
      k: 1, offX: 0, offY: 0, rotation: 0, scaleAdj: 1,
      hidden: false, opacity: 1, colorMode: 'file', layers, converted: [],
    };
    const placedHow = this._place(desc);

    // Persist the parsed drawing. A failed upload still leaves a usable
    // session underlay — losing it on reload beats losing the import — but
    // say so, since the user will expect it to stick.
    let stored = true;
    try {
      const meta = await this._upload(data, name);
      desc.imageId = meta.id;
    } catch (e) {
      stored = false;
    }
    this._data.set(this._key(desc), data);
    this.list().push(desc);
    if (typeof PlanMarkup !== 'undefined') {
      PlanMarkup.snapshot(); PlanMarkup.markDirty();
      if (PlanMarkup.updateScaleReadout) PlanMarkup.updateScaleReadout();
      if (PlanMarkup.onToolChanged && typeof PlanTools !== 'undefined' && PlanTools.active && PlanTools.active.id === 'select') PlanMarkup.onToolChanged('select', {});
    }
    if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
    if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); PlanEngine.requestDraw({ all: true }); }
    const nb = Object.keys(data.blocks).length;
    const msg = [`Imported "${name}": ${data.entities.length} entities, ${data.inserts.length} block references (${nb} blocks), ${data.layers.length} layers.`];
    if (placedHow) msg.push(placedHow);
    if (data.truncated) msg.push('The drawing is very large — only the first part was read.');
    if (!stored) msg.push('It could not be saved to the server — it will be lost on reload.');
    const hiddenFrac = totalRecords > 0 ? hiddenRecords / totalRecords : 0;
    const mostlyHidden = hiddenFrac >= 0.2 && hiddenRecords > 0;
    if (mostlyHidden) {
      msg.push(`${hiddenLayers} of ${data.layers.length} layers (${Math.round(hiddenFrac * 100)}% of the drawing) came in off/frozen and start hidden — ◫ Background Plans → Layers → "Show all" to see everything.`);
    }
    UI.toast(msg.join(' '), (!stored || data.truncated || mostlyHidden) ? 'warning' : 'success', mostlyHidden ? 9000 : 6000);
    if (data.inserts.length && typeof PlanDxfManager !== 'undefined') {
      UI.toast('Open ◫ in Background Plans to map its blocks to plan devices.', 'info', 5000);
    }
  },

  // Scale + position a freshly imported DXF. Returns a note for the toast.
  _place(desc) {
    const pm = AppState.planMarkup;
    const [bx0, by0, bx1, by1] = desc.bbox;
    let note = '';
    let f = PlanEngine.factor();
    if (f) desc.k = desc.unitM / f;
    else {
      // Uncalibrated floor: the DXF's real units calibrate it. Device symbols
      // are a fixed size in plan pixels, so pick the metres-per-pixel a traced
      // PDF usually lands at (floor plan ≈ 1:100, site plan ≈ 1:1000 at
      // ~150 dpi) — symbols then look the same size as on a raster plan.
      const mpp = pm.settings.domain === 'building' ? 0.02 : 0.15;
      desc.k = desc.unitM / mpp;
      pm.scale = { factor: mpp, source: 'dxf' };
      f = pm.scale.factor;
      note = 'The floor scale was set from the DXF units.';
    }
    // Co-register with a DXF already on this floor when both are in real units
    // and their extents are in the same neighbourhood (same project grid).
    const sib = this.list().find(d => d.unitM && d.origin && d.bbox && d.k);
    if (sib && this._sameGrid(sib, desc)) {
      const u = desc.unitM / sib.unitM;
      desc.rotation = sib.rotation || 0;
      desc.scaleAdj = (sib.scaleAdj || 1) * (sib.k / sib.unitM) / (desc.k / desc.unitM);
      const o = this.worldOf(sib, desc.origin[0] * u - sib.origin[0], desc.origin[1] * u - sib.origin[1]);
      desc.offX = o.x; desc.offY = o.y;
      return (note ? note + ' ' : '') + `Placed in the same coordinates as "${sib.name}" — use Move / Align if it doesn't line up.`;
    }
    // Otherwise centre it on the existing content (or the origin).
    let cx = 0, cy = 0;
    const box = PlanEngine._contentBBox && PlanEngine._contentBBox();
    if (box) { cx = (box.minX + box.maxX) / 2; cy = (box.minY + box.maxY) / 2; }
    desc.offX = cx - (bx0 + bx1) / 2 * desc.k;
    desc.offY = cy + (by0 + by1) / 2 * desc.k;
    return note;
  },

  // Do two DXFs sit on the same coordinate grid? Their real-world extents
  // must overlap or lie within a few drawing-widths of each other.
  _sameGrid(a, b) {
    const box = (d) => {
      const u = d.unitM;
      return [(d.origin[0] + d.bbox[0]) * u, (d.origin[1] + d.bbox[1]) * u, (d.origin[0] + d.bbox[2]) * u, (d.origin[1] + d.bbox[3]) * u];
    };
    const A = box(a), B = box(b);
    const span = Math.max(A[2] - A[0], A[3] - A[1], B[2] - B[0], B[3] - B[1]);
    const gapX = Math.max(0, Math.max(A[0], B[0]) - Math.min(A[2], B[2]));
    const gapY = Math.max(0, Math.max(A[1], B[1]) - Math.min(A[3], B[3]));
    return Math.max(gapX, gapY) <= 3 * span;
  },

  // Unitless DXF: ask what one drawing unit is. The guess leans on the plan
  // domain and the drawing's size (buildings are usually drawn in mm, site
  // plans in metres) and the file's metric/imperial flag.
  askUnits(data, name) {
    const [bx0, by0, bx1, by1] = data.bbox;
    const span = Math.max(bx1 - bx0, by1 - by0);
    const building = AppState.planMarkup.settings.domain === 'building';
    let guess = (data.units && data.units.metric === false) ? 0.0254
      : (building ? (span > 300 ? 0.001 : 1) : (span > 20000 ? 0.001 : 1));
    const opts = [['0.001', 'Millimetres'], ['0.01', 'Centimetres'], ['1', 'Metres'], ['1000', 'Kilometres'], ['0.0254', 'Inches'], ['0.3048', 'Feet']];
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal plan-floor-modal';
      ov.style.display = 'flex'; ov.style.zIndex = '3000';
      ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'DXF units');
      const fmt = (u) => { const m = span * u; return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m >= 1 ? m.toFixed(1) + ' m' : (m * 1000).toFixed(0) + ' mm'; };
      ov.innerHTML = `
        <div class="modal-content plan-floor-content" style="max-width:420px">
          <div class="modal-header"><h3>DXF units</h3></div>
          <div class="modal-body">
            <p style="margin:0 0 10px">"${escHtml(name)}" doesn't say what unit it is drawn in. One drawing unit is:</p>
            <select data-role="u" style="width:100%">${opts.map(([v, l]) => `<option value="${v}"${Math.abs(+v - guess) < 1e-12 ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <p data-role="span" style="margin:8px 0 0;color:var(--text-muted);font-size:12px"></p>
            <div class="ui-dialog-actions">
              <button class="btn-small" data-role="cancel">Cancel</button>
              <button class="btn-primary" data-role="ok">Import</button>
            </div>
          </div>
        </div>`;
      const sel = ov.querySelector('[data-role="u"]');
      const showSpan = () => { ov.querySelector('[data-role="span"]').textContent = `The drawing would be ${fmt(+sel.value)} across.`; };
      showSpan();
      sel.addEventListener('change', showSpan);
      const done = (v) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(v); };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter') { e.preventDefault(); done(+sel.value); }
      };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('click', (e) => {
        const r = e.target.dataset && e.target.dataset.role;
        if (r === 'ok') done(+sel.value);
        else if (r === 'cancel' || e.target === ov) done(null);
      });
      document.body.appendChild(ov);
      requestAnimationFrame(() => { try { sel.focus(); } catch (_) {} });
    });
  },

  // Change a DXF's units after import. When the floor's scale came from this
  // DXF alone, the floor is re-calibrated (the drawing stays put); otherwise
  // the DXF is re-scaled about its centre to stay true to the floor's scale.
  setUnits(desc, unitM) {
    const pm = AppState.planMarkup;
    const others = this.list().filter(d => d !== desc).length + ((pm.plans || []).length);
    if (pm.scale && pm.scale.source === 'dxf' && !others) {
      pm.scale = { factor: pm.scale.factor * unitM / (desc.unitM || unitM), source: 'dxf' };
      desc.unitM = unitM; desc.unitsGuessed = false;
      this.invalidate(desc);
      if (typeof PlanMarkup !== 'undefined' && PlanMarkup.updateScaleReadout) PlanMarkup.updateScaleReadout();
      return;
    }
    const [bx0, by0, bx1, by1] = desc.bbox;
    const c = this.worldOf(desc, (bx0 + bx1) / 2, (by0 + by1) / 2);
    desc.k = desc.k * unitM / (desc.unitM || unitM);
    desc.unitM = unitM; desc.unitsGuessed = false;
    const c2 = this.worldOf(desc, (bx0 + bx1) / 2, (by0 + by1) / 2);
    desc.offX += c.x - c2.x; desc.offY += c.y - c2.y;
    this.invalidate(desc);
  },

  async _upload(data, name) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const fd = new FormData();
    fd.append('file', new File([blob], (name || 'dxf') + '.json', { type: 'application/json' }));
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

  // ─── Floor sync / persistence ───
  // Make sure every DXF on the active floor is loaded. Called wherever the
  // active floor can change (workspace activate, floor switch, project load,
  // undo restore).
  syncFloor() {
    for (const desc of this.list()) if (!this.dataOf(desc) && desc.imageId != null) this._fetch(desc);
    // Drop render caches for descriptors no longer on this floor (undo can
    // swap descriptor objects, so key caches by id and re-validate).
    const ids = new Set(this.list().map(d => d.id));
    for (const id of [...this._cache.keys()]) if (!ids.has(id)) this._cache.delete(id);
    for (const d of this.list()) { const c = this._cache.get(d.id); if (c && c.convSig !== this._convSig(d)) this._cache.delete(d.id); }
    this._redraw();
  },

  _fetch(desc) {
    const id = desc.imageId;
    if (this._pending.has(id)) return;
    this._pending.add(id);
    fetch(`${API_BASE}/plan-images/${id}`, { headers: API.authHeaders() })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(json => {
        this._pending.delete(id);
        this._data.set(id, this._normalise(json));
        this._redraw();
        if (typeof PlanUI !== 'undefined') PlanUI.renderPalette();
      })
      .catch(() => { this._pending.delete(id); });
  },

  _redraw() { if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true, fg: true }); },

  // Every stored DXF id in the project — for the on-save orphan claim.
  storedIds() {
    const out = [];
    for (const fl of AppState.planFloors()) {
      for (const d of ((fl.data && fl.data.dxfs) || [])) if (d.imageId != null) out.push(d.imageId);
    }
    return out;
  },

  // Remove one DXF from the active floor. Undoable: the stored row is kept
  // (the orphan sweep is the backstop), so Ctrl+Z brings the drawing back.
  remove(id) {
    const pm = AppState.planMarkup;
    const i = this.list().findIndex(d => d.id === id);
    if (i < 0) return;
    pm.dxfs.splice(i, 1);
    this._cache.delete(id);
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    this._redraw();
  },

  invalidate(desc) { this._cache.delete(desc.id); this._redraw(); },

  // ─── Transforms ───
  worldOf(desc, X, Y) {
    return PlanEngine.planImageToWorld(desc, X * desc.k, -Y * desc.k);
  },
  localOf(desc, wx, wy) {
    const q = PlanEngine.planWorldToImage(desc, wx, wy);
    return { x: q.x / desc.k, y: -q.y / desc.k };
  },
  // Plan pixels per drawing unit, all scale factors included.
  _pxPerUnit(desc) { return desc.k * ((typeof desc.scaleAdj === 'number' && desc.scaleAdj > 0) ? desc.scaleAdj : 1); },

  // Local (drawing-unit) points of an entity record, matching the backend's
  // _rec_points — used so a fit can consider only currently-visible layers.
  _recLocalPoints(r) {
    const p = r.p || [];
    if (r.t === 'c' || r.t === 'a') return [[p[0] - p[2], p[1] - p[2]], [p[0] + p[2], p[1] + p[2]]];
    if (r.t === 'x' || r.t === 'o') return [[p[0], p[1]]];
    const pts = [];
    for (let i = 0; i < p.length - 1; i += 2) pts.push([p[i], p[i + 1]]);
    return pts;
  },

  // min/max of `values`, excluding a small isolated tail at either end —
  // the same idea as the backend's _robust_bounds (backend/analysis/
  // plan_dxf.py), reproduced here because a per-layer-visible fit collects
  // a point set the backend never sees (a still-visible layer can still
  // hold one isolated far-off record, e.g. a stray XREF insertion point).
  _robustBounds(values) {
    const MIN_N = 20, OUTER_FRAC = 0.02, OUTER_MIN = 3, OUTER_MAX = 40, ISOLATION = 10;
    const v = values.slice().sort((a, b) => a - b);
    const n = v.length;
    if (n < MIN_N) return [v[0], v[n - 1]];
    const gaps = [];
    for (let i = 1; i < n; i++) gaps.push(v[i] - v[i - 1]);
    const nz = gaps.filter((g) => g > 0).sort((a, b) => a - b);
    if (!nz.length) return [v[0], v[n - 1]];
    const typical = nz[Math.floor(nz.length / 2)];
    if (typical <= 0) return [v[0], v[n - 1]];
    const outer = Math.max(OUTER_MIN, Math.min(OUTER_MAX, Math.floor(n * OUTER_FRAC)));
    let lo = 0, hi = n - 1;
    const start = Math.max(0, n - 1 - outer);
    let bestI = -1, bestG = 0;
    for (let i = start; i < n - 1; i++) if (gaps[i] > bestG) { bestG = gaps[i]; bestI = i; }
    if (bestI >= 0 && bestG > ISOLATION * typical) hi = bestI;
    const end = Math.min(n - 1, outer);
    bestI = -1; bestG = 0;
    for (let i = 0; i < end; i++) if (gaps[i] > bestG) { bestG = gaps[i]; bestI = i; }
    if (bestI >= 0 && bestG > ISOLATION * typical) lo = bestI + 1;
    if (lo >= hi) return [v[0], v[n - 1]];
    return [v[lo], v[hi]];
  },

  extentWorld() {
    let box = null;
    const grow = (minX, minY, maxX, maxY) => {
      if (!box) box = { minX, minY, maxX, maxY };
      else { box.minX = Math.min(box.minX, minX); box.minY = Math.min(box.minY, minY); box.maxX = Math.max(box.maxX, maxX); box.maxY = Math.max(box.maxY, maxY); }
    };
    for (const d of this.list()) {
      if (d.hidden || !d.bbox) continue;
      const data = this.dataOf(d);
      const anyLayerHidden = data && d.layers && Object.values(d.layers).some((st) => st && st.hidden);
      if (!data || !anyLayerHidden) {
        // Fast path (no per-layer hiding in play): the whole DXF's
        // already-robust bbox (backend/analysis/plan_dxf.py:_robust_bounds).
        const [x0, y0, x1, y1] = d.bbox;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) {
          const w = this.worldOf(d, x, y);
          minX = Math.min(minX, w.x); minY = Math.min(minY, w.y);
          maxX = Math.max(maxX, w.x); maxY = Math.max(maxY, w.y);
        }
        grow(minX, minY, maxX, maxY);
        continue;
      }
      // Some layers are hidden (default-off/frozen in the source file, or
      // toggled off by the user) — a "fit" should aim at what's actually on
      // screen, not the whole drawing including switched-off content that
      // can otherwise leave the visible part a barely-visible speck. Collect
      // every visible point in world space, then robust-bound it the same
      // way the backend robust-bounds the full drawing, so one still-visible
      // isolated record (a stray insert on an otherwise-fine layer) can't
      // reintroduce the same blow-out this whole fix is for.
      const xs = [], ys = [];
      for (const r of data.entities) {
        if (this.layerHidden(d, r.l)) continue;
        for (const [lx, ly] of this._recLocalPoints(r)) {
          const w = this.worldOf(d, lx, ly);
          xs.push(w.x); ys.push(w.y);
        }
      }
      for (const ins of data.inserts) {
        if (this.layerHidden(d, ins.l)) continue;
        const w = this.worldOf(d, ins.p[0], ins.p[1]);
        xs.push(w.x); ys.push(w.y);
      }
      if (!xs.length) continue;
      const [minX, maxX] = this._robustBounds(xs);
      const [minY, maxY] = this._robustBounds(ys);
      grow(minX, minY, maxX, maxY);
    }
    return box;
  },

  // ─── Colours ───
  _theme() {
    let dark = false;
    try {
      const bg = PlanEngine._cssVar('--plan-stage-bg', '#f1f5f9');
      dark = this._lum(bg) < 0.4;
    } catch (_) {}
    return { dark, fg: dark ? '#e5e7eb' : '#1f2937' };
  },
  _lum(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  },
  // Keep file colours legible on the stage: white/black (ACI 7) follow the
  // theme, and near-background colours are pulled toward the foreground.
  _legible(col, th) {
    if (!col) return th.fg;
    const L = this._lum(col);
    // CAD palettes are designed for a black screen: bright ACI greens,
    // cyans and yellows wash out on a light stage, so darken them there.
    if (!th.dark && L > 0.55) return this._mix(col, '#000000', Math.min(0.55, (L - 0.4) * 1.1));
    if (th.dark && L < 0.18) return this._mix(col, '#ffffff', 0.45);
    return col;
  },
  _mix(a, b, t) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    const ch = (s) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
    return '#' + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
  },
  layerColor(desc, data, name) {
    const st = desc.layers && desc.layers[name];
    if (st && st.color) return st.color;
    const ly = this._layerMap(data).get(name);
    if (!ly) return null;
    return ly.aci7 ? null : ly.color;   // null → theme foreground
  },
  _layerMap(data) {
    if (!data._layerMap) data._layerMap = new Map(data.layers.map(l => [l.name, l]));
    return data._layerMap;
  },
  layerHidden(desc, name) { const st = desc.layers && desc.layers[name]; return !!(st && st.hidden); },

  // ─── Render cache ───
  _convSig(desc) { return (desc.converted || []).length; },

  _buildCache(desc, data) {
    const conv = new Set(desc.converted || []);
    const groups = new Map();   // "layer|k" → {layer, k, path}
    const texts = [];
    for (const r of data.entities) {
      if (r.h && conv.has(r.h)) continue;
      if (r.t === 'x') { texts.push(r); continue; }
      this._addToGroups(groups, r);
    }
    const c = {
      groups: [...groups.values()], texts,
      inserts: data.inserts.filter(i => !conv.has(i.h)),
      blocks: new Map(), convSig: this._convSig(desc), snap: null,
    };
    this._cache.set(desc.id, c);
    return c;
  },

  _addToGroups(groups, r) {
    const key = r.l + '|' + (r.k || '');
    let g = groups.get(key);
    if (!g) { g = { layer: r.l, k: r.k || null, path: new Path2D() }; groups.set(key, g); }
    const P = g.path, p = r.p;
    switch (r.t) {
      case 'l': P.moveTo(p[0], p[1]); P.lineTo(p[2], p[3]); break;
      case 'p':
        P.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) P.lineTo(p[i], p[i + 1]);
        if (r.c) P.closePath();
        break;
      case 'c': P.moveTo(p[0] + p[2], p[1]); P.arc(p[0], p[1], p[2], 0, Math.PI * 2); break;
      case 'a': {
        const a0 = p[3] * Math.PI / 180, a1 = p[4] * Math.PI / 180;
        P.moveTo(p[0] + p[2] * Math.cos(a0), p[1] + p[2] * Math.sin(a0));
        P.arc(p[0], p[1], p[2], a0, a1, false);   // local space is Y-up → CCW
        break;
      }
      case 'o': P.moveTo(p[0], p[1]); P.lineTo(p[0], p[1]); break;   // round cap → dot
      default: break;
    }
  },

  _blockCache(c, data, name) {
    let b = c.blocks.get(name);
    if (b) return b;
    const blk = data.blocks[name];
    if (!blk) return null;
    const groups = new Map(), texts = [], nested = [];
    for (const r of blk.e) {
      if (r.t === 'x') texts.push(r);
      else if (r.t === 'i') nested.push(r);
      else this._addToGroups(groups, r);
    }
    const bb = blk.bb;
    const rad = bb ? Math.max(Math.hypot(bb[0] - blk.bp[0], bb[1] - blk.bp[1]), Math.hypot(bb[2] - blk.bp[0], bb[3] - blk.bp[1]),
      Math.hypot(bb[0] - blk.bp[0], bb[3] - blk.bp[1]), Math.hypot(bb[2] - blk.bp[0], bb[1] - blk.bp[1])) : 0;
    b = { groups: [...groups.values()], texts, nested, bp: blk.bp || [0, 0], rad };
    c.blocks.set(name, b);
    return b;
  },

  // ─── Rendering (background canvas, world transform already applied) ───
  draw(ctx, zoom, viewRect, theme) {
    const th = theme || this._theme();
    for (const desc of this.list()) {
      if (desc.hidden) continue;
      const data = this.dataOf(desc);
      if (!data) continue;
      this._drawOne(ctx, zoom, desc, data, th, viewRect);
    }
  },

  _drawOne(ctx, zoom, desc, data, th, viewRect) {
    const c = this._cache.get(desc.id) || this._buildCache(desc, data);
    const ppu = this._pxPerUnit(desc);          // plan px per drawing unit
    const unitPx = zoom * ppu;                  // screen px per drawing unit
    const mono = desc.colorMode === 'mono';
    const monoCol = th.dark ? 'rgba(148,163,184,0.85)' : 'rgba(100,116,139,0.85)';
    const colorFor = (layer, k, inhLayer, inhCol) => {
      if (mono) return monoCol;
      if (k === 'B') return inhCol != null ? inhCol : th.fg;
      if (k) {
        const ov = desc.layers && desc.layers[layer] && desc.layers[layer].color;
        return ov || this._legible(k, th);
      }
      const col = this.layerColor(desc, data, layer === '0' && inhLayer ? inhLayer : layer);
      return col ? this._legible(col, th) : th.fg;
    };

    // Local view rect (drawing units) for culling block references.
    let lv = null;
    if (viewRect) {
      const pts = [[viewRect.minX, viewRect.minY], [viewRect.maxX, viewRect.minY], [viewRect.maxX, viewRect.maxY], [viewRect.minX, viewRect.maxY]]
        .map(([x, y]) => this.localOf(desc, x, y));
      lv = { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
    }

    ctx.save();
    ctx.globalAlpha = (typeof desc.opacity === 'number') ? desc.opacity : 1;
    ctx.translate(desc.offX || 0, desc.offY || 0);
    if (desc.rotation) ctx.rotate(desc.rotation * Math.PI / 180);
    ctx.scale(ppu, -ppu);                         // drawing units, Y up
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const lw = 0.9 / unitPx;

    // Model-space geometry, one stroke per layer/colour group.
    ctx.lineWidth = lw;
    for (const g of c.groups) {
      if (this.layerHidden(desc, g.layer)) continue;
      ctx.strokeStyle = colorFor(g.layer, g.k, null, null);
      ctx.stroke(g.path);
    }
    // Model-space text (skipped when too small to read).
    for (const t of c.texts) {
      if (this.layerHidden(desc, t.l)) continue;
      if (t.h * unitPx < 2.5) continue;
      ctx.fillStyle = colorFor(t.l, t.k, null, null);
      this._drawText(ctx, t);
    }
    // Block references.
    for (const ins of c.inserts) {
      if (this.layerHidden(desc, ins.l)) continue;
      const b = this._blockCache(c, data, ins.b);
      if (!b) continue;
      const sc = Math.max(Math.abs(ins.sx || 1), Math.abs(ins.sy || 1));
      const R = b.rad * sc;
      if (lv && (ins.p[0] + R < lv.x0 || ins.p[0] - R > lv.x1 || ins.p[1] + R < lv.y0 || ins.p[1] - R > lv.y1)) continue;
      if (R * unitPx >= 1) {
        const col = ins.k && ins.k !== 'B' ? (mono ? monoCol : this._legible(ins.k, th)) : colorFor(ins.l, null, null, null);
        this._drawBlock(ctx, c, data, desc, b, ins, ins.l, col, unitPx, colorFor, 0);
      }
      // Visible attribute values (already in model-space coords).
      if (ins.at) {
        for (const t of ins.at) {
          if (this.layerHidden(desc, t.l) || t.h * unitPx < 2.5) continue;
          ctx.fillStyle = colorFor(t.l, t.k, ins.l, null);
          this._drawText(ctx, t);
        }
      }
    }
    ctx.restore();
  },

  _drawBlock(ctx, c, data, desc, b, ins, inhLayer, inhCol, unitPx, colorFor, depth) {
    if (depth > 8) return;
    const sx = ins.sx || 1, sy = ins.sy || 1;
    const scale = Math.sqrt(Math.abs(sx * sy)) || 1;
    ctx.save();
    ctx.translate(ins.p[0], ins.p[1]);
    if (ins.r) ctx.rotate(ins.r * Math.PI / 180);
    ctx.scale(sx, sy);
    ctx.translate(-b.bp[0], -b.bp[1]);
    const up = unitPx * scale;
    ctx.lineWidth = 0.9 / up;
    for (const g of b.groups) {
      const lay = g.layer === '0' ? inhLayer : g.layer;
      if (g.layer !== '0' && this.layerHidden(desc, g.layer)) continue;
      ctx.strokeStyle = colorFor(lay, g.k, inhLayer, inhCol);
      ctx.stroke(g.path);
    }
    for (const t of b.texts) {
      if (t.h * up < 2.5) continue;
      if (t.l !== '0' && this.layerHidden(desc, t.l)) continue;
      ctx.fillStyle = colorFor(t.l === '0' ? inhLayer : t.l, t.k, inhLayer, inhCol);
      this._drawText(ctx, t);
    }
    for (const n of b.nested) {
      const nb = this._blockCache(c, data, n.b);
      if (!nb) continue;
      const lay = n.l === '0' ? inhLayer : n.l;
      if (n.l !== '0' && this.layerHidden(desc, n.l)) continue;
      const col = n.k === 'B' ? inhCol : colorFor(lay, n.k || null, inhLayer, inhCol);
      this._drawBlock(ctx, c, data, desc, nb, n, lay, col, up, colorFor, depth + 1);
    }
    ctx.restore();
  },

  // Text in a Y-up local space: flip back upright, 100px font scaled so the
  // cap height matches the DXF text height.
  _drawText(ctx, t) {
    const s = t.h / 72;
    ctx.save();
    ctx.translate(t.p[0], t.p[1]);
    if (t.r) ctx.rotate(t.r * Math.PI / 180);
    ctx.scale(s, -s);
    ctx.font = '100px system-ui, sans-serif';
    ctx.textAlign = t.ha === 'c' ? 'center' : t.ha === 'r' ? 'right' : 'left';
    ctx.textBaseline = t.va === 't' ? 'top' : t.va === 'm' ? 'middle' : t.va === 'b' ? 'bottom' : 'alphabetic';
    const lines = String(t.s).split('\n');
    const lh = 140;
    const y0 = t.va === 'b' || t.va === 'a' ? -(lines.length - 1) * lh : t.va === 'm' ? -(lines.length - 1) * lh / 2 : 0;
    lines.forEach((ln, i) => ctx.fillText(ln, 0, y0 + i * lh));
    ctx.restore();
  },

  // ─── Snapping ───
  // Snap candidates per DXF, in drawing units, bucketed in a coarse grid:
  // line/polyline end + mid points, polyline vertices, circle/arc centres and
  // arc ends, points, and block insertion points.
  _snapIndex(desc, data) {
    const c = this._cache.get(desc.id) || this._buildCache(desc, data);
    if (c.snap) return c.snap;
    const xs = [], ys = [], ls = [], ks = [];
    const add = (x, y, l, k) => { xs.push(x); ys.push(y); ls.push(l); ks.push(k); };
    const conv = new Set(desc.converted || []);
    for (const r of data.entities) {
      if (r.h && conv.has(r.h)) continue;
      const p = r.p;
      if (r.t === 'l') { add(p[0], p[1], r.l, 'end'); add(p[2], p[3], r.l, 'end'); add((p[0] + p[2]) / 2, (p[1] + p[3]) / 2, r.l, 'mid'); }
      else if (r.t === 'p') {
        if (r.g === 'HATCH') continue;
        const n = p.length / 2;
        if (!r.g || r.g === 'LWPOLYLINE' || r.g === 'POLYLINE' || r.g === 'SOLID') {
          for (let i = 0; i < n; i++) {
            add(p[2 * i], p[2 * i + 1], r.l, (i === 0 || i === n - 1) ? 'end' : 'vtx');
            if (i < n - 1 && n < 400) add((p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2, r.l, 'mid');
          }
        } else { add(p[0], p[1], r.l, 'end'); add(p[p.length - 2], p[p.length - 1], r.l, 'end'); }
      } else if (r.t === 'c') add(p[0], p[1], r.l, 'cen');
      else if (r.t === 'a') {
        add(p[0], p[1], r.l, 'cen');
        for (const a of [p[3], p[4]]) add(p[0] + p[2] * Math.cos(a * Math.PI / 180), p[1] + p[2] * Math.sin(a * Math.PI / 180), r.l, 'end');
      } else if (r.t === 'o') add(p[0], p[1], r.l, 'end');
    }
    for (const ins of c.inserts) add(ins.p[0], ins.p[1], ins.l, 'ins');
    const [bx0, by0, bx1, by1] = data.bbox;
    const cell = Math.max(bx1 - bx0, by1 - by0, 1e-9) / 128;
    const grid = new Map();
    for (let i = 0; i < xs.length; i++) {
      const key = Math.floor(xs[i] / cell) + ',' + Math.floor(ys[i] / cell);
      let a = grid.get(key); if (!a) { a = []; grid.set(key, a); }
      a.push(i);
    }
    c.snap = { xs, ys, ls, ks, grid, cell };
    return c.snap;
  },

  // Nearest DXF snap point to world `pt` within `radiusWorld` plan px.
  // opts.only / opts.exclude restrict the search to / away from one DXF id.
  snap(pt, radiusWorld, opts) {
    opts = opts || {};
    let best = null, bd = Infinity;
    for (const desc of this.list()) {
      if (desc.hidden) continue;
      if (opts.only && desc.id !== opts.only) continue;
      if (opts.exclude && desc.id === opts.exclude) continue;
      const data = this.dataOf(desc);
      if (!data) continue;
      const S = this._snapIndex(desc, data);
      const q = this.localOf(desc, pt.x, pt.y);
      const rl = radiusWorld / this._pxPerUnit(desc);
      const gx0 = Math.floor((q.x - rl) / S.cell), gx1 = Math.floor((q.x + rl) / S.cell);
      const gy0 = Math.floor((q.y - rl) / S.cell), gy1 = Math.floor((q.y + rl) / S.cell);
      if ((gx1 - gx0) * (gy1 - gy0) > 4096) continue;   // zoomed far out: skip
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const a = S.grid.get(gx + ',' + gy); if (!a) continue;
          for (const i of a) {
            if (this.layerHidden(desc, S.ls[i])) continue;
            // Prefer ends/centres/insertion points over midpoints at equal range.
            const d = Math.hypot(S.xs[i] - q.x, S.ys[i] - q.y) * (S.ks[i] === 'mid' ? 1.25 : 1);
            if (d > rl) continue;
            const dw = d * this._pxPerUnit(desc);   // compare across DXFs in plan px
            if (dw < bd) {
              const w = this.worldOf(desc, S.xs[i], S.ys[i]);
              bd = dw; best = { x: w.x, y: w.y, kind: S.ks[i] };
            }
          }
        }
      }
    }
    return best;
  },
};
