/* ProtectionPro — Plan Markup DXF export (client).
 *
 * The DXF itself is built on the backend with ezdxf (AC1015 / R2000) so it is
 * guaranteed spec-valid — real BLOCK/INSERT with ATTRIB attributes, true
 * SPLINE curves and LWPOLYLINE straights. This module just gathers the active
 * floor into a payload — the symbol geometry comes straight from the on-screen
 * PLAN_SYMBOLS recipes so the exported blocks match the drawing exactly — POSTs
 * it, and downloads the returned file.
 */

// Core ATTRIB/XDATA tags carried on every device blockref — the AutoCAD LISP
// toolkit's own vocabulary (REF/TYPE/DBFED/CIRCUIT/PHASE/CABLE all match its
// block attribute names directly; LOAD_VA is ours — the LISP side keys its
// equivalent per block as WATTS/LOAD_W/LOAD_KW/LOAD_EST, so there's no single
// tag name to adopt). Must match backend `ATTR_TAGS` (plan_dxf.py) exactly.
const PLAN_DXF_CORE_ATTRS = ['REF', 'TYPE', 'DBFED', 'CIRCUIT', 'PHASE', 'LOAD_VA', 'CABLE'];

const PlanDXF = {
  _factor() { const s = AppState.planMarkup.scale; return (s && s.factor) ? s.factor : null; },

  // Stable block name per symbol variant (parametric families differ by props).
  _variantKey(el) {
    const p = el.props || {};
    switch (el.type) {
      case 'bd_light': return p.kind || 'ceiling';
      case 'bd_socket': return (p.outlets || 'single') + (p.weatherproof ? 'wp' : '');
      case 'bd_switch': return (p.kind || 'standard') + 'g' + (p.gangs || '1');
      case 'bd_switchboard': return 's' + (p.sections || (p.props && p.props.sections) || 1);
      default: return '';
    }
  },
  // A type with a `dxfBlock` uses the LISP toolkit's own fixed block name
  // (one shared symbol for every variant, matching how the LISP toolkit
  // itself has no visual permutation for e.g. LUMINAIRE) — the variant
  // (kind/outlets/gangs) instead round-trips via the PP_VARIANT tag. A type
  // with no LISP counterpart keeps the old PP_<type>_<variant> scheme, one
  // block definition per variant, so its glyph stays variant-accurate.
  _blockName(el) {
    const def = PLAN_DEFS.element(el.type) || {};
    if (def.dxfBlock) return def.dxfBlock;
    const v = this._variantKey(el);
    return 'PP_' + el.type + (v ? '_' + v : '');
  },
  // Extra ATTRIB tags a block needs beyond the core set: LISP-named tags for
  // any declared field with a PLAN_DXF_FIELD_TAGS entry, plus PP_VARIANT for
  // the parametric families (own round-trip fidelity only).
  _extraAttrTags(type) {
    const def = PLAN_DEFS.element(type);
    if (!def || !def.dxfBlock) return [];
    const tags = [];
    for (const f of (def.fields || [])) {
      const t = PLAN_DXF_FIELD_TAGS[f.key];
      if (t && !tags.includes(t)) tags.push(t);
    }
    if (['bd_light', 'bd_socket', 'bd_switch', 'bd_switchboard'].includes(type)) tags.push('PP_VARIANT');
    return tags;
  },

  _routeLenM(r, f) {
    let px = 0;
    for (let i = 1; i < r.points.length; i++) px += Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].y - r.points[i - 1].y);
    return f ? px * f : 0;
  },

  async export() {
    const pm = AppState.planMarkup;
    const factor = this._factor();
    if (!factor) { UI.alert('Plan is not calibrated — use the Calibrate tool before exporting DXF.'); return; }
    const elById = {}; for (const e of pm.elements) elById[e.id] = e;
    const boardName = (id) => { const b = elById[id]; return b ? (b.name || '') : ''; };
    const layers = {};
    const layer = (name, color) => { if (name && !layers[name]) layers[name] = color || '#333333'; return name; };

    // Symbol blocks (one per variant, or one per type when it has a fixed
    // LISP block name) + device instances with attributes.
    const blocks = {}, elements = [];
    for (const el of pm.elements) {
      const def = PLAN_DEFS.element(el.type) || {};
      const name = this._blockName(el);
      if (!blocks[name]) {
        // A LISP-named block is one shared symbol for every variant — glyph
        // from the type's OWN defaults, not whichever instance is placed
        // first, so the block definition is deterministic.
        const glyphProps = def.dxfBlock ? PLAN_DEFS.defaults(el.type) : el.props;
        let prims = (typeof PlanSymbols !== 'undefined' && PlanSymbols.prims) ? PlanSymbols.prims(el.type, glyphProps) : null;
        if (!prims || !prims.length) prims = [{ k: 'r', x: 8, y: 8, w: 24, h: 24, s: 'col' }];
        const sizeWorld = (typeof PlanSymbols !== 'undefined' && PlanSymbols.size) ? PlanSymbols.size(el.type, glyphProps) : (def.dxf ? def.dxf.sizeM * 20 : 24);
        const attrTags = PLAN_DXF_CORE_ATTRS.concat(this._extraAttrTags(el.type));
        blocks[name] = { sizeWorld, prims, attrTags };
      }
      const lname = layer(def.dxfLayer || ('EL_' + (def.group || 'MISC').toUpperCase().replace(/[^A-Z0-9]+/g, '_')), def.color);
      const isCircuit = typeof PlanCircuits !== 'undefined' && PlanCircuits.isCircuitDevice && PlanCircuits.isCircuitDevice(el.type);
      const load = isCircuit ? PlanCircuits.deviceVA(el) : '';
      const p = el.props || {};
      const attrs = {
        REF: el.name || '', TYPE: el.type,
        DBFED: p.circuitDbId ? boardName(p.circuitDbId) : '',
        CIRCUIT: (p.circuitNo != null ? p.circuitNo : ''),
        PHASE: isCircuit ? (p.poles === '3P' ? '3P' : '1P') : '',
        LOAD_VA: load === '' ? '' : String(load),
        CABLE: p.cableType || '',
      };
      for (const f of (def.fields || [])) {
        const tag = PLAN_DXF_FIELD_TAGS[f.key];
        if (tag && p[f.key] != null && p[f.key] !== '') attrs[tag] = String(p[f.key]);
      }
      if (def.dxfBlock && ['bd_light', 'bd_socket', 'bd_switch', 'bd_switchboard'].includes(el.type)) {
        attrs.PP_VARIANT = this._variantKey(el);
      }
      elements.push({ block: name, type: el.type, x: el.x, y: el.y, rotation: el.rotation || 0, layer: lname, attrs });
    }

    // Routes (curved flag preserved) + cable/length label.
    const routes = [];
    for (const r of pm.routes) {
      if (!r.points || r.points.length < 2) continue;
      const rdef = PLAN_DEFS.route(r.type) || {};
      const lname = layer(rdef.dxfLayer || ('RT_' + String(r.type).toUpperCase()), rdef.color || '#3b82f6');
      const lenM = this._routeLenM(r, factor);
      // type/cable/end names travel as XDATA so a re-import rebuilds the
      // route exactly (the layer alone can't carry a mixed-case type key).
      routes.push({
        layer: lname, type: r.type, curved: !!r.curved, cable: r.cableType || '',
        fromName: r.fromId ? boardName(r.fromId) : '', toName: r.toId ? boardName(r.toId) : '',
        label: `${r.cableType ? r.cableType + ' ' : ''}${lenM.toFixed(2)} m`,
        pts: r.points.map(p => [p.x, p.y]),
      });
    }

    const trenches = (pm.trenches || []).filter(t => t.points && t.points.length >= 2)
      .map(t => ({ pts: t.points.map(p => [p.x, p.y]), excType: t.excType || '', name: t.name || '' }));
    const rooms = (pm.rooms || []).filter(rm => rm.points && rm.points.length >= 3)
      .map(rm => ({ label: rm.name || '', pts: rm.points.map(p => [p.x, p.y]) }));
    const measurements = (pm.measurements || []).filter(m => m.points && m.points.length >= 2)
      .map(m => ({ pts: m.points.map(p => [p.x, p.y]) }));
    const crossings = (pm.crossings || []).filter(c => c.p1 && c.p2)
      .map(c => ({ p1: [c.p1.x, c.p1.y], p2: [c.p2.x, c.p2.y], size: c.size || '', name: c.name || '' }));
    const texts = (pm.texts || []).map(t => ({ x: t.x, y: t.y, h: t.fontSize || 14, text: t.text || '' }));

    const af = (typeof AppState.planActiveFloor === 'function') && AppState.planActiveFloor();
    const payload = {
      factor, floorName: (af && af.name) || '', domain: pm.settings.domain || '',
      fileName: ((AppState.projectName || 'plan').replace(/[^\w-]+/g, '_')) + (af && af.name ? '_' + af.name.replace(/[^\w-]+/g, '_') : ''),
      layers: Object.entries(layers).map(([name, color]) => ({ name, color })),
      blocks, elements, routes, trenches, rooms, measurements, crossings, texts,
    };

    // UX-10: disable the trigger + show a busy overlay for the backend round-trip.
    const btn = document.querySelector('#plan-toolbar [data-action="dxf"]');
    if (btn) btn.disabled = true;
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(true, 'Exporting DXF…');
    try {
      const resp = await fetch(`${API_BASE}/plan/dxf-export`, {
        method: 'POST', headers: API.authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
        throw new Error(detail);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = payload.fileName + '.dxf';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      UI.alert('DXF export failed: ' + (e && e.message ? e.message : e));
    } finally {
      if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(false);
      if (btn) btn.disabled = false;
    }
  },
};
