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

/* Building final-circuit / sub-main cable library — the specialised set from
 * Distribution Designer Pro (House Wiring T+E & singles, H07V-R singles,
 * Surfix, SWA multicore for feeders, DALI/0-10V control). These are distinct
 * from the reticulation STANDARD_CABLES (SWA distribution keyed by kV): one
 * library per cable class, so building distribution routes offer the right
 * specialised types. `rating` is the ampacity (A); r/x are Ω/km. */
const BUILDING_CABLES = [
  // House Wiring — twin & earth
  { name: '1.5mm² T+E Cu PVC', category: 'House Wiring', size: 1.5, cores: 2, rating: 16, r: 14.6, x: 0.1 },
  { name: '2.5mm² T+E Cu PVC', category: 'House Wiring', size: 2.5, cores: 2, rating: 22, r: 8.7, x: 0.095 },
  { name: '4mm² T+E Cu PVC', category: 'House Wiring', size: 4, cores: 2, rating: 30, r: 5.5, x: 0.093 },
  { name: '6mm² T+E Cu PVC', category: 'House Wiring', size: 6, cores: 2, rating: 38, r: 3.6, x: 0.09 },
  { name: '10mm² T+E Cu PVC', category: 'House Wiring', size: 10, cores: 2, rating: 52, r: 2.2, x: 0.084 },
  { name: '16mm² T+E Cu PVC', category: 'House Wiring', size: 16, cores: 2, rating: 69, r: 1.4, x: 0.08 },
  // Wiring — H07V-R single cores (in conduit)
  { name: '1.5mm² H07V-R Cu', category: 'Wiring', size: 1.5, cores: 1, rating: 17, r: 14.6, x: 0 },
  { name: '2.5mm² H07V-R Cu', category: 'Wiring', size: 2.5, cores: 1, rating: 24, r: 8.7, x: 0 },
  { name: '4mm² H07V-R Cu', category: 'Wiring', size: 4, cores: 1, rating: 32, r: 5.5, x: 0 },
  { name: '6mm² H07V-R Cu', category: 'Wiring', size: 6, cores: 1, rating: 41, r: 3.6, x: 0 },
  { name: '10mm² H07V-R Cu', category: 'Wiring', size: 10, cores: 1, rating: 57, r: 2.2, x: 0 },
  { name: '16mm² H07V-R Cu', category: 'Wiring', size: 16, cores: 1, rating: 76, r: 1.4, x: 0 },
  { name: '25mm² H07V-R Cu', category: 'Wiring', size: 25, cores: 1, rating: 101, r: 0.87, x: 0 },
  { name: '35mm² H07V-R Cu', category: 'Wiring', size: 35, cores: 1, rating: 125, r: 0.63, x: 0 },
  { name: '50mm² H07V-R Cu', category: 'Wiring', size: 50, cores: 1, rating: 151, r: 0.46, x: 0 },
  { name: '70mm² H07V-R Cu', category: 'Wiring', size: 70, cores: 1, rating: 192, r: 0.32, x: 0 },
  { name: '95mm² H07V-R Cu', category: 'Wiring', size: 95, cores: 1, rating: 232, r: 0.24, x: 0 },
  // Surfix — flat surface twin/three + earth
  { name: '1.5mm² Surfix 2C+E', category: 'Surfix', size: 1.5, cores: 2, rating: 20, r: 14.6, x: 0.1 },
  { name: '2.5mm² Surfix 2C+E', category: 'Surfix', size: 2.5, cores: 2, rating: 27, r: 8.7, x: 0.095 },
  { name: '4mm² Surfix 2C+E', category: 'Surfix', size: 4, cores: 2, rating: 36, r: 5.5, x: 0.093 },
  { name: '6mm² Surfix 2C+E', category: 'Surfix', size: 6, cores: 2, rating: 46, r: 3.6, x: 0.09 },
  { name: '1.5mm² Surfix 3C+E', category: 'Surfix', size: 1.5, cores: 3, rating: 16, r: 14.6, x: 0.1 },
  { name: '2.5mm² Surfix 3C+E', category: 'Surfix', size: 2.5, cores: 3, rating: 22, r: 8.7, x: 0.095 },
  { name: '4mm² Surfix 3C+E', category: 'Surfix', size: 4, cores: 3, rating: 30, r: 5.5, x: 0.093 },
  // SWA multicore — sub-mains / 3-phase final circuits
  { name: '2.5mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 2.5, cores: 4, rating: 32, r: 8.7, x: 0.095 },
  { name: '4mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 4, cores: 4, rating: 42, r: 5.5, x: 0.093 },
  { name: '6mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 6, cores: 4, rating: 53, r: 3.6, x: 0.09 },
  { name: '10mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 10, cores: 4, rating: 70, r: 2.2, x: 0.084 },
  { name: '16mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 16, cores: 4, rating: 91, r: 1.4, x: 0.08 },
  { name: '25mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 25, cores: 4, rating: 119, r: 0.87, x: 0.084 },
  { name: '35mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 35, cores: 4, rating: 143, r: 0.64, x: 0.084 },
  { name: '50mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 50, cores: 4, rating: 169, r: 0.46, x: 0.081 },
  { name: '70mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 70, cores: 4, rating: 210, r: 0.32, x: 0.081 },
  { name: '95mm² x4C Cu PVC/SWA', category: 'SWA Multicore', size: 95, cores: 4, rating: 251, r: 0.24, x: 0.078 },
  // Control
  { name: '0.5mm² x2C DALI', category: 'Control', size: 0.5, cores: 2, rating: 0, r: 39, x: 0 },
  { name: '1mm² x2C DALI', category: 'Control', size: 1, cores: 2, rating: 0, r: 19.5, x: 0 },
  { name: '1.5mm² x2C DALI', category: 'Control', size: 1.5, cores: 2, rating: 0, r: 14.5, x: 0 },
  { name: '1.0mm² x2C 0-10V Signal', category: 'Control', size: 1, cores: 2, rating: 0, r: 21.8, x: 0 },
  { name: '1.5mm² x2C Screened BMS', category: 'Control', size: 1.5, cores: 2, rating: 0, r: 14.5, x: 0 },
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
    // ── building domain (floor-plan distribution) ──
    // Power / distribution
    bd_utility: { name: 'Utility Intake', domain: 'building', group: 'Power', color: '#ef4444', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.8 }, rotatable: true, schedule: null, namePrefix: 'UT', defaults: {}, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    bd_transformer: { name: 'Transformer', domain: 'building', group: 'Power', color: '#f59e0b', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 1.2 }, rotatable: true, schedule: null, namePrefix: 'TX', defaults: {}, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    bd_generator: { name: 'Generator', domain: 'building', group: 'Power', color: '#22c55e', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 1.0 }, rotatable: true, schedule: null, namePrefix: 'GEN', defaults: {}, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    bd_db: { name: 'Distribution Board', domain: 'building', group: 'Power', color: '#8b5cf6', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.7 }, rotatable: true, schedule: null, namePrefix: 'DB', defaults: {}, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    bd_riser: { name: 'Riser', domain: 'building', group: 'Power', color: '#6366f1', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.4 }, rotatable: false, schedule: null, namePrefix: 'RS', defaults: {}, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
    bd_jb: { name: 'Junction Box', domain: 'building', group: 'Power', color: '#94a3b8', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.2 }, rotatable: false, schedule: null, namePrefix: 'JB', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    // Lighting — one dynamic-block family; `kind` renders the permutation.
    bd_light: {
      name: 'Light Fitting', domain: 'building', group: 'Lighting', color: '#d29922', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: true, schedule: null, namePrefix: 'L',
      defaults: { kind: 'ceiling', watts: 20 },
      fields: [
        { key: 'name', label: 'Ref', type: 'text' },
        { key: 'kind', label: 'Type', type: 'select', options: [
          { value: 'ceiling', label: 'Ceiling / Surface' }, { value: 'downlight', label: 'Downlight' },
          { value: 'batten', label: 'Batten / Linear' }, { value: 'floodlight', label: 'Floodlight' },
          { value: 'wall', label: 'Wall / Bulkhead' }, { value: 'highbay', label: 'High-bay' },
          { value: 'emergency', label: 'Emergency' }, { value: 'exit', label: 'Exit Sign' },
        ] },
        { key: 'watts', label: 'Load', type: 'number', unit: 'W' },
      ],
    },
    // Small power
    bd_socket: {
      name: 'Socket Outlet', domain: 'building', group: 'Small Power', color: '#3b82f6', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.25 }, rotatable: false, schedule: null, namePrefix: 'S',
      defaults: { gangs: '1', weatherproof: false },
      fields: [
        { key: 'name', label: 'Ref', type: 'text' },
        { key: 'gangs', label: 'Gangs', type: 'select', options: [
          { value: '1', label: '1 gang' }, { value: '2', label: '2 gang' }, { value: '3', label: '3 gang' }] },
        { key: 'weatherproof', label: 'Weatherproof', type: 'checkbox' },
      ],
    },
    bd_isolator: { name: 'Isolator', domain: 'building', group: 'Small Power', color: '#0ea5e9', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.25 }, rotatable: false, schedule: null, namePrefix: 'IS', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_fcu: { name: 'Fused Spur (FCU)', domain: 'building', group: 'Small Power', color: '#06b6d4', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.2 }, rotatable: false, schedule: null, namePrefix: 'FCU', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    // Switches — one dynamic-block family; `gangs` + `kind` render the permutation.
    bd_switch: {
      name: 'Switch', domain: 'building', group: 'Switches', color: '#10b981', scale: 1,
      symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.2 }, rotatable: false, schedule: null, namePrefix: 'SW',
      defaults: { gangs: '1', kind: 'standard' },
      fields: [
        { key: 'name', label: 'Ref', type: 'text' },
        { key: 'gangs', label: 'Gangs', type: 'select', options: [
          { value: '1', label: '1 gang' }, { value: '2', label: '2 gang' }, { value: '3', label: '3 gang' }] },
        { key: 'kind', label: 'Type', type: 'select', options: [
          { value: 'standard', label: 'Standard' }, { value: '2way', label: '2-way' },
          { value: 'intermediate', label: 'Intermediate' }, { value: 'dimmer', label: 'Dimmer' },
          { value: 'pir', label: 'PIR / Occupancy' }, { value: 'key', label: 'Key switch' },
          { value: 'timer', label: 'Timer' }, { value: 'photocell', label: 'Photocell' },
        ] },
      ],
    },
    // ELV / fire / security
    bd_smoke: { name: 'Smoke Detector', domain: 'building', group: 'ELV & Fire', color: '#dc2626', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: false, schedule: null, namePrefix: 'SD', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_heat: { name: 'Heat Detector', domain: 'building', group: 'ELV & Fire', color: '#b91c1c', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: false, schedule: null, namePrefix: 'HD', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_call: { name: 'Call Point', domain: 'building', group: 'ELV & Fire', color: '#991b1b', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.2 }, rotatable: false, schedule: null, namePrefix: 'CP', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_cctv: { name: 'CCTV Camera', domain: 'building', group: 'ELV & Fire', color: '#7c3aed', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: true, schedule: null, namePrefix: 'CAM', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_datapoint: { name: 'Data Outlet', domain: 'building', group: 'ELV & Fire', color: '#0891b2', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.2 }, rotatable: false, schedule: null, namePrefix: 'DP', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_wap: { name: 'Wireless AP', domain: 'building', group: 'ELV & Fire', color: '#0e7490', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.3 }, rotatable: false, schedule: null, namePrefix: 'AP', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    // Control
    bd_sensor: { name: 'Occupancy Sensor', domain: 'building', group: 'Control', color: '#e11d48', scale: 1, symbol: 'circle', dxf: { shape: 'circle', sizeM: 0.25 }, rotatable: false, schedule: null, namePrefix: 'PIR', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
    bd_dali: { name: 'DALI Controller', domain: 'building', group: 'Control', color: '#db2777', scale: 1, symbol: 'square', dxf: { shape: 'square', sizeM: 0.3 }, rotatable: true, schedule: null, namePrefix: 'DAL', defaults: {}, fields: [{ key: 'name', label: 'Ref', type: 'text' }] },
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
    // ── building domain routes ── (cables from the specialised BUILDING_CABLES
    //    library, filtered by category per route type)
    feeder: { name: 'Feeder', domain: 'building', color: '#ef4444', width: 2.5, lineStyle: 'solid', cableVoltage: 'lv', dxfLayer: 'POWER', schedule: null, requiresEndpoints: true, defaults: { cableType: '' }, fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', library: 'building', category: ['SWA Multicore', 'Wiring'] }] },
    circuit: { name: 'Final Circuit', domain: 'building', color: '#3b82f6', width: 1.5, lineStyle: 'solid', cableVoltage: 'lv', dxfLayer: 'FINAL_CIRCUITS', schedule: null, requiresEndpoints: false, defaults: { cableType: '' }, fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', library: 'building', category: ['House Wiring', 'Wiring', 'Surfix', 'SWA Multicore'] }] },
    lighting_ckt: { name: 'Lighting Circuit', domain: 'building', color: '#eab308', width: 1.5, lineStyle: 'solid', cableVoltage: 'lv', dxfLayer: 'LIGHTING', schedule: null, requiresEndpoints: false, defaults: { cableType: '' }, fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', library: 'building', category: ['House Wiring', 'Surfix', 'Wiring'] }] },
    conduit: { name: 'Conduit', domain: 'building', color: '#64748b', width: 2, lineStyle: 'solid', cableVoltage: null, dxfLayer: 'CONTAINMENT', schedule: null, requiresEndpoints: false, defaults: {}, fields: [] },
    cable_tray: { name: 'Cable Tray', domain: 'building', color: '#475569', width: 3, lineStyle: 'solid', cableVoltage: null, dxfLayer: 'CONTAINMENT', schedule: null, requiresEndpoints: false, defaults: {}, fields: [] },
    data_cable: { name: 'Data Cable', domain: 'building', color: '#0891b2', width: 1, lineStyle: 'dashed', cableVoltage: null, dxfLayer: 'DATA', schedule: null, requiresEndpoints: false, defaults: {}, fields: [] },
    fire_cable: { name: 'Fire Cable', domain: 'building', color: '#dc2626', width: 1.5, lineStyle: 'dashed', cableVoltage: null, dxfLayer: 'FIRE', schedule: null, requiresEndpoints: false, defaults: {}, fields: [] },
    dali_bus: { name: 'DALI Bus', domain: 'building', color: '#db2777', width: 1, lineStyle: 'dashed', cableVoltage: null, dxfLayer: 'CONTROL', schedule: null, requiresEndpoints: false, defaults: { cableType: '' }, fields: [{ key: 'cableType', label: 'Cable Type', type: 'cable_select', library: 'building', category: ['Control'] }] },
  },

  // Trench excavation bands (open polyline drawn as a band of real width).
  trenchTypes: {
    'MV': { name: 'MV Trench', color: 'rgba(220,38,38,0.5)', width: 0.6, depth: 1.0 },
    'LV/SL': { name: 'LV/SL Trench', color: 'rgba(37,99,235,0.38)', width: 0.5, depth: 0.8 },
    'MV/LV/SL': { name: 'Combined Trench', color: 'rgba(124,58,237,0.38)', width: 0.9, depth: 1.0 },
    'FI': { name: 'Fibre Trench', color: 'rgba(245,146,0,0.38)', width: 0.3, depth: 0.6 },
  },

  crossings: { sizes: ['110', '160'], defaultSize: '110', color: '#f97316' },

  // Closed-polygon zones (rooms / areas). Used for area take-off and the lux
  // model. Available in both domains.
  room: {
    fill: 'rgba(56,189,248,0.14)', stroke: '#0ea5e9',
    defaults: { name: 'Room' },
    fields: [{ key: 'name', label: 'Name', type: 'text' }],
  },

  // SLD component types that can be adopted into the building plan (placed
  // "From SLD"), mapped to the building symbol they render as.
  sldLinkTypes: {
    distribution_board: 'bd_db',
    transformer: 'bd_transformer',
    generator: 'bd_generator',
    utility: 'bd_utility',
    bus: 'bd_db',
  },

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
    push('Zones', { type: 'room', kind: 'room', name: 'Room / Area', color: this.room.stroke });
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
  // Building-distribution discipline layers (used when the Building domain is active)
  {
    id: 'b_power', name: 'Power Distribution', discipline: 'building', color: '#ef4444',
    visibleElementTypes: ['bd_utility', 'bd_transformer', 'bd_generator', 'bd_db', 'bd_riser', 'bd_jb'],
    routeTypes: ['feeder'], trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'b_circuits', name: 'Final Circuits', discipline: 'building', color: '#3b82f6',
    visibleElementTypes: ['bd_db', 'bd_socket', 'bd_isolator', 'bd_fcu'],
    routeTypes: ['circuit'], trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'b_lighting', name: 'Lighting', discipline: 'building', color: '#eab308',
    visibleElementTypes: ['bd_light', 'bd_switch'],
    routeTypes: ['lighting_ckt'], trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'b_containment', name: 'Cable Containment', discipline: 'building', color: '#475569',
    visibleElementTypes: ['bd_riser', 'bd_jb'], routeTypes: ['conduit', 'cable_tray'],
    trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'b_elv', name: 'ELV & Fire', discipline: 'building', color: '#7c3aed',
    visibleElementTypes: ['bd_smoke', 'bd_heat', 'bd_call', 'bd_cctv', 'bd_datapoint', 'bd_wap'],
    routeTypes: ['data_cable', 'fire_cable'], trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
  },
  {
    id: 'b_control', name: 'Control', discipline: 'building', color: '#db2777',
    visibleElementTypes: ['bd_sensor', 'bd_dali'], routeTypes: ['dali_bus'],
    trenchTypes: [], showCrossings: false, drawingNo: '', revision: '',
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
