/* ProtectionPro — Plan Markup DXF export (client).
 *
 * The DXF itself is built on the backend with ezdxf (AC1015 / R2000) so it is
 * guaranteed spec-valid — real BLOCK/INSERT with ATTRIB attributes, true
 * SPLINE curves and LWPOLYLINE straights. This module just gathers the active
 * floor into a payload — the symbol geometry comes straight from the on-screen
 * PLAN_SYMBOLS recipes so the exported blocks match the drawing exactly — POSTs
 * it, and downloads the returned file.
 */

const PlanDXF = {
  _factor() { const s = AppState.planMarkup.scale; return (s && s.factor) ? s.factor : null; },

  // Stable block name per symbol variant (parametric families differ by props).
  _variantKey(el) {
    const p = el.props || {};
    switch (el.type) {
      case 'bd_light': return p.kind || 'ceiling';
      case 'bd_socket': return 'g' + (p.gangs || '1') + (p.weatherproof ? 'wp' : '');
      case 'bd_switch': return (p.kind || 'standard') + 'g' + (p.gangs || '1');
      case 'bd_switchboard': return 's' + (p.sections || (p.props && p.props.sections) || 1);
      default: return '';
    }
  },
  _blockName(el) { const v = this._variantKey(el); return 'PP_' + el.type + (v ? '_' + v : ''); },

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

    // Symbol blocks (one per variant) + device instances with attributes.
    const blocks = {}, elements = [];
    for (const el of pm.elements) {
      const def = PLAN_DEFS.element(el.type) || {};
      const name = this._blockName(el);
      if (!blocks[name]) {
        let prims = (typeof PlanSymbols !== 'undefined' && PlanSymbols.prims) ? PlanSymbols.prims(el.type, el.props) : null;
        if (!prims || !prims.length) prims = [{ k: 'r', x: 8, y: 8, w: 24, h: 24, s: 'col' }];
        const sizeWorld = (typeof PlanSymbols !== 'undefined' && PlanSymbols.size) ? PlanSymbols.size(el.type, el.props) : (def.dxf ? def.dxf.sizeM * 20 : 24);
        blocks[name] = { sizeWorld, prims };
      }
      const grp = (def.group || 'MISC').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const lname = layer('EL_' + grp, def.color);
      const load = (typeof PlanCircuits !== 'undefined' && PlanCircuits.isCircuitDevice && PlanCircuits.isCircuitDevice(el.type))
        ? PlanCircuits.deviceVA(el) : '';
      const p = el.props || {};
      elements.push({
        block: name, type: el.type, x: el.x, y: el.y, rotation: el.rotation || 0, layer: lname,
        attrs: {
          NAME: el.name || '', TYPE: el.type,
          DBOARD: p.circuitDbId ? boardName(p.circuitDbId) : '',
          CIRCUIT: (p.circuitNo != null ? p.circuitNo : ''),
          PHASE: PlanCircuits && PlanCircuits.isCircuitDevice && PlanCircuits.isCircuitDevice(el.type) ? (p.poles === '3P' ? '3P' : '1P') : '',
          LOAD_VA: load === '' ? '' : String(load),
          CABLE: p.cableType || '',
        },
      });
    }

    // Routes (curved flag preserved) + cable/length label.
    const routes = [];
    for (const r of pm.routes) {
      if (!r.points || r.points.length < 2) continue;
      const rdef = PLAN_DEFS.route(r.type) || {};
      const lname = layer('RT_' + String(r.type).toUpperCase(), rdef.color || '#3b82f6');
      const lenM = this._routeLenM(r, factor);
      routes.push({
        layer: lname, curved: !!r.curved, cable: r.cableType || '',
        label: `${r.cableType ? r.cableType + ' ' : ''}${lenM.toFixed(2)} m`,
        pts: r.points.map(p => [p.x, p.y]),
      });
    }

    const trenches = (pm.trenches || []).filter(t => t.points && t.points.length >= 2)
      .map(t => ({ pts: t.points.map(p => [p.x, p.y]) }));
    const rooms = (pm.rooms || []).filter(rm => rm.points && rm.points.length >= 3)
      .map(rm => ({ label: rm.name || '', pts: rm.points.map(p => [p.x, p.y]) }));
    const measurements = (pm.measurements || []).filter(m => m.points && m.points.length >= 2)
      .map(m => ({ pts: m.points.map(p => [p.x, p.y]) }));
    const crossings = (pm.crossings || []).filter(c => c.p1 && c.p2)
      .map(c => ({ p1: [c.p1.x, c.p1.y], p2: [c.p2.x, c.p2.y] }));
    const texts = (pm.texts || []).map(t => ({ x: t.x, y: t.y, h: t.fontSize || 14, text: t.text || '' }));

    const af = (typeof AppState.planActiveFloor === 'function') && AppState.planActiveFloor();
    const payload = {
      factor, floorName: (af && af.name) || '',
      fileName: ((AppState.projectName || 'plan').replace(/[^\w-]+/g, '_')) + (af && af.name ? '_' + af.name.replace(/[^\w-]+/g, '_') : ''),
      layers: Object.entries(layers).map(([name, color]) => ({ name, color })),
      blocks, elements, routes, trenches, rooms, measurements, crossings, texts,
    };

    try {
      const resp = await fetch(`${API_BASE}/plan/dxf-export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
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
    }
  },
};
