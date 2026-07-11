/* ProtectionPro — Plan Markup entity registry.
 *
 * One declarative registry drives the whole markup workspace: the palette,
 * the properties panel, canvas rendering, the push-to-schedules sync and the
 * CSV/DXF exports all read from here. Two domains share one engine — 'retic'
 * (outdoor reticulation, the phase-1 set) and 'building' (floor-plan
 * distribution, a starter set now / full port later). Adding entity types
 * later means adding rows here, not touching the engine.
 *
 * Colours, scales, widths and default styles below are taken from the source
 * apps (Retic Builder Pro's sitePlan styles block; Distribution Designer's
 * FP tables) so a faithful port keeps their visual conventions.
 */

const PLAN_DOMAINS = [
  { id: 'retic', name: 'Reticulation (Site)' },
  { id: 'building', name: 'Building Distribution' },
];

const PLAN_DEFS = {
  // Point elements. `fields[]` follow the Properties.renderField conventions
  // ({key,label,type,unit,options,...}); `cable_select` is a plan-specific
  // field type (a select of STANDARD_CABLES names filtered by voltage).
  elements: {
    // ── retic domain ──
    minisub: {
      name: 'Minisub / TX', domain: 'retic', group: 'Plant', color: '#3b82f6', scale: 1,
      symbol: 'square', dxf: { shape: 'square', sizeM: 2.5 }, rotatable: true,
      schedule: 'minisub', namePrefix: 'TX',
      defaults: {},
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: 0, max: 355, step: 5 },
      ],
    },
    kiosk: {
      name: 'Kiosk', domain: 'retic', group: 'Plant', color: '#22c55e', scale: 1,
      symbol: 'square', dxf: { shape: 'square', sizeM: 1.2 }, rotatable: true,
      schedule: 'kiosk', namePrefix: 'K',
      defaults: {},
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'rotation', label: 'Rotation', type: 'number', unit: '°', min: 0, max: 355, step: 5 },
      ],
    },
    rmu: {
      name: 'RMU', domain: 'retic', group: 'Plant', color: '#ef4444', scale: 1,
      symbol: 'square', dxf: { shape: 'square', sizeM: 1.8 }, rotatable: true,
      schedule: null, namePrefix: 'RMU',
      defaults: {},
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
    },
    pole: {
      name: 'Streetlight Pole', domain: 'retic', group: 'Street Lighting', color: '#f59e0b', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.4 }, rotatable: false,
      schedule: 'pole', namePrefix: 'P',
      defaults: {},
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
    },
    erf: {
      name: 'Erf (Stand)', domain: 'retic', group: 'Consumers', color: '#6b7280', scale: 1,
      symbol: 'x', dxf: { shape: 'circle', sizeM: 0.8 }, rotatable: false,
      schedule: 'erf', namePrefix: 'ERF',
      defaults: {},
      fields: [{ key: 'name', label: 'Erf Number', type: 'text' }],
    },
    manhole: {
      name: 'Manhole', domain: 'retic', group: 'Fibre', color: '#a855f7', scale: 1,
      symbol: 'square', dxf: { shape: 'square', sizeM: 1.0 }, rotatable: false,
      schedule: null, namePrefix: 'MH',
      defaults: {},
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
    },
    // ── building domain (starter set; full FP_ELS port is a later phase) ──
    bd_db: {
      name: 'Distribution Board', domain: 'building', group: 'Power', color: '#8b5cf6', scale: 1,
      symbol: 'square', dxf: { shape: 'square', sizeM: 0.6 }, rotatable: true,
      schedule: null, namePrefix: 'DB',
      defaults: {},
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
    },
    bd_light: {
      name: 'Light Fitting', domain: 'building', group: 'Lighting', color: '#d29922', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: false,
      schedule: null, namePrefix: 'L',
      defaults: { watts: 20 },
      fields: [
        { key: 'name', label: 'Ref', type: 'text' },
        { key: 'watts', label: 'Load', type: 'number', unit: 'W' },
      ],
    },
    bd_socket: {
      name: 'Socket Outlet', domain: 'building', group: 'Small Power', color: '#3b82f6', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.25 }, rotatable: false,
      schedule: null, namePrefix: 'S',
      defaults: {},
      fields: [{ key: 'name', label: 'Ref', type: 'text' }],
    },
    bd_switch: {
      name: 'Switch', domain: 'building', group: 'Switches', color: '#10b981', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.2 }, rotatable: false,
      schedule: null, namePrefix: 'SW',
      defaults: {},
      fields: [{ key: 'name', label: 'Ref', type: 'text' }],
    },
  },

  // Linear routes (polyline; endpoints may snap to elements).
  routes: {
    mv: {
      name: 'MV Cable', domain: 'retic', color: '#ef4444', width: 2, lineStyle: 'solid',
      cableVoltage: 'mv', dxfLayer: 'MV_RETICULATION', schedule: null, requiresEndpoints: false,
      defaults: { cableType: '' },
      fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', voltage: 'mv' }],
    },
    lv: {
      name: 'LV Feeder', domain: 'retic', color: '#3b82f6', width: 2, lineStyle: 'solid',
      cableVoltage: 'lv', dxfLayer: 'LV_RETICULATION', schedule: 'feeder', requiresEndpoints: true,
      defaults: { cableType: '' },
      fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', voltage: 'lv' }],
    },
    service: {
      name: 'Service Cable', domain: 'retic', color: '#22c55e', width: 1.5, lineStyle: 'solid',
      cableVoltage: 'lv', dxfLayer: 'SERVICE_CABLES', schedule: 'service', requiresEndpoints: true,
      defaults: { cableType: '' },
      fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', voltage: 'lv' }],
    },
    sl: {
      name: 'Street Lighting', domain: 'retic', color: '#f59e0b', width: 1.5, lineStyle: 'solid',
      cableVoltage: 'lv', dxfLayer: 'STREET_LIGHTING', schedule: 'sl', requiresEndpoints: false,
      defaults: { cableType: '' },
      fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', voltage: 'lv' }],
    },
    fibreBB: {
      name: 'Fibre Backbone', domain: 'retic', color: '#a855f7', width: 1.5, lineStyle: 'dashed',
      cableVoltage: null, dxfLayer: 'FIBRE', schedule: null, requiresEndpoints: false,
      defaults: { cableType: '' }, fields: [],
    },
    fibreErf: {
      name: 'Fibre Drop', domain: 'retic', color: '#c084fc', width: 1, lineStyle: 'solid',
      cableVoltage: null, dxfLayer: 'FIBRE', schedule: null, requiresEndpoints: false,
      defaults: { cableType: '' }, fields: [],
    },
  },

  // Trench excavation bands (open polyline drawn as a band of real width).
  trenchTypes: {
    'MV': { name: 'MV Trench', color: 'rgba(220,38,38,0.5)', width: 0.6, depth: 1.0 },
    'LV/SL': { name: 'LV/SL Trench', color: 'rgba(37,99,235,0.38)', width: 0.5, depth: 0.8 },
    'MV/LV/SL': { name: 'Combined Trench', color: 'rgba(124,58,237,0.38)', width: 0.9, depth: 1.0 },
    'FI': { name: 'Fibre Trench', color: 'rgba(245,146,0,0.38)', width: 0.3, depth: 0.6 },
  },

  crossings: { sizes: ['110', '160'], defaultSize: '110', color: '#f97316' },

  annotations: {
    text: {
      defaults: { text: 'Note', fontSize: 14, color: '#111827' },
      fields: [
        { key: 'text', label: 'Text', type: 'text' },
        { key: 'fontSize', label: 'Size', type: 'number', unit: 'px' },
        { key: 'color', label: 'Colour', type: 'text' },
      ],
    },
    measurement: { color: '#0ea5e9' },
  },

  // ─── Lookup / helper API (consumed by the engine, palette, props, exports) ───

  element(type) { return this.elements[type] || null; },
  route(type) { return this.routes[type] || null; },

  // Default props object for a freshly placed element/route of `type`.
  defaults(type) {
    const d = (this.elements[type] || this.routes[type] || {}).defaults;
    return d ? { ...d } : {};
  },

  // Resolved fill colour for an element type, honoring project style overrides.
  elementColor(type, styles) {
    const ov = styles && styles.elementColors && styles.elementColors[type];
    return ov || (this.elements[type] && this.elements[type].color) || '#6b7280';
  },
  routeColor(type, styles) {
    const ov = styles && styles.routeColors && styles.routeColors[type];
    return ov || (this.routes[type] && this.routes[type].color) || '#3b82f6';
  },

  // Palette groups for a domain: [{label, items:[{type, kind, name, color}]}].
  paletteGroups(domain) {
    const groups = new Map();
    const push = (label, item) => {
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(item);
    };
    for (const [type, def] of Object.entries(this.elements)) {
      if (def.domain !== domain) continue;
      push(def.group || 'Other', { type, kind: 'element', name: def.name, color: def.color });
    }
    for (const [type, def] of Object.entries(this.routes)) {
      if (def.domain !== domain) continue;
      push('Routes', { type, kind: 'route', name: def.name, color: def.color });
    }
    if (domain === 'retic') {
      for (const [type, def] of Object.entries(this.trenchTypes)) {
        push('Trenches', { type, kind: 'trench', name: def.name, color: def.color });
      }
      push('Other', { type: 'crossing', kind: 'crossing', name: 'Road Crossing', color: this.crossings.color });
    }
    push('Annotate', { type: 'text', kind: 'text', name: 'Text', color: '#111827' });
    push('Annotate', { type: 'measurement', kind: 'measurement', name: 'Measure', color: this.annotations.measurement.color });
    return [...groups.entries()].map(([label, items]) => ({ label, items }));
  },

  // Canvas symbol renderer for a point element, in WORLD units (metres if
  // calibrated). The engine sets up the transform + stroke scale; this just
  // paints the glyph centred at (0,0). `opts`: {sizePx, color, selected}.
  // sizePx is the fallback size to use when the plan is not calibrated
  // (no metres-per-pixel), so glyphs stay visible.
  drawElement(ctx, def, opts) {
    const color = opts.color || (def && def.color) || '#6b7280';
    const shape = (def && def.symbol) || 'circle';
    const r = opts.sizePx;
    ctx.lineWidth = opts.strokeW;
    ctx.strokeStyle = color;
    ctx.fillStyle = opts.selected ? color : (color + '33'); // 20% alpha fill
    if (shape === 'square') {
      ctx.beginPath();
      ctx.rect(-r, -r, r * 2, r * 2);
      ctx.fill(); ctx.stroke();
    } else if (shape === 'x') {
      ctx.beginPath();
      ctx.moveTo(-r, -r); ctx.lineTo(r, r);
      ctx.moveTo(-r, r); ctx.lineTo(r, -r);
      ctx.stroke();
    } else { // circle
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  },
};

// Discipline layers (from Retic Builder's sitePlan.drawings defaults). These
// filter what is emphasized per sheet; entities are matched by TYPE, so an
// entity can appear (dimmed) on non-primary layers.
const PLAN_DEFAULT_LAYERS = [
  {
    id: 'mv', name: 'MV Reticulation', discipline: 'mv', color: '#ef4444',
    visibleElementTypes: ['minisub', 'rmu'], routeTypes: ['mv'],
    trenchTypes: ['MV', 'MV/LV/SL'], showCrossings: true, drawingNo: '', revision: '',
  },
  {
    id: 'lv', name: 'LV Reticulation', discipline: 'lv', color: '#3b82f6',
    visibleElementTypes: ['minisub', 'kiosk', 'erf'], routeTypes: ['lv', 'service'],
    trenchTypes: ['LV/SL', 'MV/LV/SL'], showCrossings: true, drawingNo: '', revision: '',
  },
  {
    id: 'trenching', name: 'Trenching Layout', discipline: 'trenching', color: '#7c3aed',
    visibleElementTypes: ['minisub', 'kiosk', 'manhole', 'rmu'], routeTypes: [],
    trenchTypes: ['MV', 'LV/SL', 'MV/LV/SL', 'FI'], showCrossings: true, drawingNo: '', revision: '',
  },
  {
    id: 'fibre', name: 'Fibre Layout', discipline: 'fibre', color: '#f59e0b',
    visibleElementTypes: ['manhole', 'erf'], routeTypes: ['fibreBB', 'fibreErf'],
    trenchTypes: ['FI'], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'sl', name: 'Street Lighting', discipline: 'sl', color: '#22c55e',
    visibleElementTypes: ['pole', 'kiosk'], routeTypes: ['sl'],
    trenchTypes: ['LV/SL'], showCrossings: false, drawingNo: '', revision: '',
  },
];

// Seed styles (Retic Builder's sitePlan.styles). A project overrides sparsely
// via planMarkup.styles; precedence is `styles.X ?? PLAN_DEFS default`.
const PLAN_DEFAULT_STYLES = {
  elementColors: {
    kiosk: '#22c55e', minisub: '#3b82f6', manhole: '#a855f7',
    pole: '#f59e0b', rmu: '#ef4444', erf: '#6b7280',
  },
  elementScales: { kiosk: 1, minisub: 1, manhole: 1, pole: 1, rmu: 1, erf: 1 },
  routeColors: {
    mv: '#ef4444', lv: '#3b82f6', service: '#22c55e',
    fibreBB: '#a855f7', fibreErf: '#c084fc', sl: '#f59e0b',
  },
  defaultCableTypes: { mv: '', lv: '', service: '', sl: '' },
  routeLineStyles: {
    mv: 'solid', lv: 'solid', service: 'solid',
    fibreBB: 'dashed', fibreErf: 'solid', sl: 'solid',
  },
  routeLabelPosition: 'along',
};
