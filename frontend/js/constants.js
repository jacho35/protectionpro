/* ProtectionPro — Constants & Configuration */

const GRID_SIZE = 20;
const SNAP_SIZE = 20;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.1;
const DEFAULT_BASE_MVA = 100;
const DEFAULT_FREQUENCY = 50;

const API_BASE = 'http://localhost:8000/api';

// Interaction modes
const MODE = {
  SELECT: 'select',
  WIRE: 'wire',
  PLACE: 'place',
  PAN: 'pan',
};

// Component categories for the sidebar palette
const COMPONENT_CATEGORIES = [
  {
    id: 'sources',
    name: 'Sources',
    items: ['utility', 'generator'],
  },
  {
    id: 'distribution',
    name: 'Distribution',
    items: ['bus', 'transformer', 'cable'],
  },
  {
    id: 'protection',
    name: 'Protection Devices',
    items: ['cb', 'fuse', 'relay', 'switch'],
  },
  {
    id: 'instruments',
    name: 'Instrument Transformers',
    items: ['ct', 'pt'],
  },
  {
    id: 'loads',
    name: 'Loads',
    items: ['motor_induction', 'motor_synchronous', 'static_load'],
  },
  {
    id: 'other',
    name: 'Other',
    items: ['capacitor_bank', 'surge_arrester'],
  },
];

// Component type definitions with default properties
const COMPONENT_DEFS = {
  // --- Sources ---
  utility: {
    name: 'Utility Source',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'Utility',
      voltage_kv: 33,
      fault_mva: 500,
      x_r_ratio: 15,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'fault_mva', label: 'Fault Level', type: 'number', unit: 'MVA' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
    ],
  },
  generator: {
    name: 'Generator',
    category: 'sources',
    ports: [{ id: 'out', side: 'bottom', offset: 0 }],
    width: 60,
    height: 50,
    defaults: {
      name: 'Gen',
      rated_mva: 10,
      voltage_kv: 11,
      xd_pp: 0.15,
      xd_p: 0.25,
      xd: 1.2,
      x_r_ratio: 40,
      power_factor: 0.85,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.' },
      { key: 'xd', label: 'Xd', type: 'number', unit: 'p.u.' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
    ],
  },

  // --- Distribution ---
  bus: {
    name: 'Bus',
    category: 'distribution',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
      { id: 'left', side: 'left', offset: 0 },
      { id: 'right', side: 'right', offset: 0 },
    ],
    width: 120,
    height: 10,
    defaults: {
      name: 'Bus',
      voltage_kv: 11,
      bus_type: 'PQ',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'bus_type', label: 'Bus Type', type: 'select', options: ['PQ', 'PV', 'Swing'] },
    ],
  },
  transformer: {
    name: 'Transformer',
    category: 'distribution',
    ports: [
      { id: 'primary', side: 'top', offset: 0 },
      { id: 'secondary', side: 'bottom', offset: 0 },
    ],
    width: 60,
    height: 70,
    defaults: {
      name: 'Xfmr',
      rated_mva: 10,
      voltage_hv_kv: 33,
      voltage_lv_kv: 11,
      z_percent: 8,
      x_r_ratio: 10,
      tap_percent: 0,
      vector_group: 'Dyn11',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_mva', label: 'Rating', type: 'number', unit: 'MVA' },
      { key: 'voltage_hv_kv', label: 'HV Voltage', type: 'number', unit: 'kV' },
      { key: 'voltage_lv_kv', label: 'LV Voltage', type: 'number', unit: 'kV' },
      { key: 'z_percent', label: 'Z%', type: 'number', unit: '%' },
      { key: 'x_r_ratio', label: 'X/R Ratio', type: 'number' },
      { key: 'tap_percent', label: 'Tap Position', type: 'number', unit: '%' },
      { key: 'vector_group', label: 'Vector Group', type: 'select', options: ['Dyn11', 'Dyn1', 'YNd11', 'YNd1', 'Yyn0', 'Dd0'] },
    ],
  },
  cable: {
    name: 'Cable / Feeder',
    category: 'distribution',
    ports: [
      { id: 'from', side: 'top', offset: 0 },
      { id: 'to', side: 'bottom', offset: 0 },
    ],
    width: 20,
    height: 60,
    defaults: {
      name: 'Cable',
      length_km: 1,
      r_per_km: 0.1,
      x_per_km: 0.08,
      rated_amps: 400,
      voltage_kv: 11,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'length_km', label: 'Length', type: 'number', unit: 'km' },
      { key: 'r_per_km', label: 'R', type: 'number', unit: 'Ω/km' },
      { key: 'x_per_km', label: 'X', type: 'number', unit: 'Ω/km' },
      { key: 'rated_amps', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
    ],
  },

  // --- Protection Devices ---
  cb: {
    name: 'Circuit Breaker',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'CB',
      rated_voltage_kv: 11,
      rated_current_a: 630,
      breaking_capacity_ka: 25,
      state: 'closed',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
    ],
  },
  fuse: {
    name: 'Fuse',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 20,
    height: 40,
    defaults: {
      name: 'Fuse',
      rated_voltage_kv: 11,
      rated_current_a: 100,
      breaking_capacity_ka: 50,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'breaking_capacity_ka', label: 'Breaking Cap.', type: 'number', unit: 'kA' },
    ],
  },
  relay: {
    name: 'Relay',
    category: 'protection',
    ports: [],
    width: 36,
    height: 36,
    defaults: {
      name: 'Relay',
      relay_type: '50/51',
      pickup_a: 100,
      time_dial: 1.0,
      curve: 'IEC Standard Inverse',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'relay_type', label: 'Type', type: 'select', options: ['50/51', '50N/51N', '87', '21'] },
      { key: 'pickup_a', label: 'Pickup', type: 'number', unit: 'A' },
      { key: 'time_dial', label: 'Time Dial', type: 'number' },
      { key: 'curve', label: 'Curve', type: 'select', options: ['IEC Standard Inverse', 'IEC Very Inverse', 'IEC Extremely Inverse', 'IEC Long Time Inverse', 'IEEE Moderately Inverse', 'IEEE Very Inverse', 'IEEE Extremely Inverse'] },
    ],
  },
  switch: {
    name: 'Switch',
    category: 'protection',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 40,
    defaults: {
      name: 'Switch',
      rated_voltage_kv: 11,
      rated_current_a: 630,
      state: 'closed',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'rated_current_a', label: 'Rated Current', type: 'number', unit: 'A' },
      { key: 'state', label: 'State', type: 'select', options: ['closed', 'open'] },
    ],
  },

  // --- Instrument Transformers ---
  ct: {
    name: 'Current Transformer',
    category: 'instruments',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 30,
    defaults: {
      name: 'CT',
      ratio: '400/5',
      accuracy_class: '5P20',
      burden_va: 15,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'ratio', label: 'Ratio', type: 'text' },
      { key: 'accuracy_class', label: 'Accuracy', type: 'text' },
      { key: 'burden_va', label: 'Burden', type: 'number', unit: 'VA' },
    ],
  },
  pt: {
    name: 'Potential Transformer',
    category: 'instruments',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 30,
    defaults: {
      name: 'PT',
      ratio: '11000/110',
      accuracy_class: '0.5',
      burden_va: 30,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'ratio', label: 'Ratio', type: 'text' },
      { key: 'accuracy_class', label: 'Accuracy', type: 'text' },
      { key: 'burden_va', label: 'Burden', type: 'number', unit: 'VA' },
    ],
  },

  // --- Loads ---
  motor_induction: {
    name: 'Induction Motor',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 50,
    defaults: {
      name: 'IM',
      rated_kw: 200,
      voltage_kv: 0.4,
      efficiency: 0.93,
      power_factor: 0.85,
      locked_rotor_current: 6,
      x_pp: 0.17,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kw', label: 'Rating', type: 'number', unit: 'kW' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'efficiency', label: 'Efficiency', type: 'number' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'locked_rotor_current', label: 'LRC (x FLC)', type: 'number' },
      { key: 'x_pp', label: "X''", type: 'number', unit: 'p.u.' },
    ],
  },
  motor_synchronous: {
    name: 'Synchronous Motor',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 50,
    defaults: {
      name: 'SM',
      rated_kva: 500,
      voltage_kv: 3.3,
      power_factor: 0.9,
      xd_pp: 0.15,
      xd_p: 0.25,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'xd_pp', label: "Xd''", type: 'number', unit: 'p.u.' },
      { key: 'xd_p', label: "Xd'", type: 'number', unit: 'p.u.' },
    ],
  },
  static_load: {
    name: 'Static Load',
    category: 'loads',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 50,
    height: 45,
    defaults: {
      name: 'Load',
      rated_kva: 100,
      voltage_kv: 0.4,
      power_factor: 0.85,
      load_type: 'constant_power',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kva', label: 'Rating', type: 'number', unit: 'kVA' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'power_factor', label: 'Power Factor', type: 'number' },
      { key: 'load_type', label: 'Type', type: 'select', options: ['constant_power', 'constant_current', 'constant_impedance'] },
    ],
  },

  // --- Other ---
  capacitor_bank: {
    name: 'Capacitor Bank',
    category: 'other',
    ports: [{ id: 'in', side: 'top', offset: 0 }],
    width: 40,
    height: 35,
    defaults: {
      name: 'Cap',
      rated_kvar: 100,
      voltage_kv: 11,
      steps: 1,
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_kvar', label: 'Rating', type: 'number', unit: 'kVAr' },
      { key: 'voltage_kv', label: 'Voltage', type: 'number', unit: 'kV' },
      { key: 'steps', label: 'Steps', type: 'number' },
    ],
  },
  surge_arrester: {
    name: 'Surge Arrester',
    category: 'other',
    ports: [
      { id: 'top', side: 'top', offset: 0 },
      { id: 'bottom', side: 'bottom', offset: 0 },
    ],
    width: 30,
    height: 50,
    defaults: {
      name: 'SA',
      rated_voltage_kv: 11,
      mcov_kv: 8.4,
      class: 'Station',
    },
    fields: [
      { key: 'name', label: 'Name', type: 'text' },
      { key: 'rated_voltage_kv', label: 'Rated Voltage', type: 'number', unit: 'kV' },
      { key: 'mcov_kv', label: 'MCOV', type: 'number', unit: 'kV' },
      { key: 'class', label: 'Class', type: 'select', options: ['Station', 'Intermediate', 'Distribution'] },
    ],
  },
};
