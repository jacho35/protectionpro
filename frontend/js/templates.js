/* ProtectionPro — Pre-built Network Templates */

const NetworkTemplates = {

  templates: [
    {
      id: 'substation_33_11',
      name: '33/11 kV Substation',
      description: 'Two-transformer substation with 33 kV intake, 11 kV switchboard, and four outgoing feeders with CB protection.',
      category: 'Substation',
      preview: '33kV → 2×Xfmr → 11kV Bus → 4 Feeders',
    },
    {
      id: 'industrial_plant',
      name: 'Industrial Plant',
      description: 'Utility supply through MV/LV transformer to LV switchboard feeding induction motors, static loads, and capacitor bank.',
      category: 'Industrial',
      preview: '11kV → Xfmr → 0.4kV Bus → Motors + Loads + Cap',
    },
    {
      id: 'residential_dist',
      name: 'Residential Distribution',
      description: 'MV ring with three distribution transformers supplying LV residential load centres.',
      category: 'Residential',
      preview: '33kV → 11kV Ring → 3× MV/LV Xfmr → LV Loads',
    },
    {
      id: 'generator_island',
      name: 'Generator + Island',
      description: 'Diesel generator island with synchronous generator, MV bus, step-down transformer, and mixed loads.',
      category: 'Industrial',
      preview: 'Gen → 11kV Bus → Xfmr → 0.4kV → Loads',
    },
  ],

  // ── Generate template data ──

  generate(templateId) {
    switch (templateId) {
      case 'substation_33_11': return this._substation33_11();
      case 'industrial_plant': return this._industrialPlant();
      case 'residential_dist': return this._residentialDist();
      case 'generator_island': return this._generatorIsland();
      default: return null;
    }
  },

  // ── 33/11 kV Substation ──
  _substation33_11() {
    const c = [];
    const w = [];
    const X = 400, Y0 = 60;
    const S = 160; // horizontal spacing between feeders

    // Utility source
    c.push({ id: 'utility_1', type: 'utility', x: X, y: Y0, rotation: 0,
      props: { name: 'Grid Supply', voltage_kv: 33, fault_mva: 750, x_r_ratio: 15 } });

    // 33 kV Bus
    c.push({ id: 'bus_1', type: 'bus', x: X, y: Y0 + 100, rotation: 0,
      props: { name: '33kV Bus', voltage_kv: 33, bus_type: 'Swing' } });
    w.push({ id: 'wire_1', fromComponent: 'utility_1', fromPort: 'out', toComponent: 'bus_1', toPort: 'top' });

    // Two transformers side by side
    const xfmrX = [X - 100, X + 100];
    for (let i = 0; i < 2; i++) {
      const ti = i + 1;
      // CB on HV side
      c.push({ id: `cb_${ti}`, type: 'cb', x: xfmrX[i], y: Y0 + 160, rotation: 0,
        props: { name: `CB-HV${ti}`, rated_voltage_kv: 33, rated_current_a: 400, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 400, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
      w.push({ id: `wire_${2 + i * 4}`, fromComponent: 'bus_1', fromPort: 'bottom', toComponent: `cb_${ti}`, toPort: 'top' });

      // Transformer
      c.push({ id: `transformer_${ti}`, type: 'transformer', x: xfmrX[i], y: Y0 + 260, rotation: 0,
        props: { name: `Xfmr T${ti}`, rated_mva: 10, voltage_hv_kv: 33, voltage_lv_kv: 11, z_percent: 8, x_r_ratio: 10, vector_group: 'Dyn11', winding_config: 'step_down', grounding_hv: 'ungrounded', grounding_lv: 'solidly_grounded', grounding_hv_resistance: 0, grounding_hv_reactance: 0, grounding_lv_resistance: 0, grounding_lv_reactance: 0, tap_percent: 0 } });
      w.push({ id: `wire_${3 + i * 4}`, fromComponent: `cb_${ti}`, fromPort: 'bottom', toComponent: `transformer_${ti}`, toPort: 'primary' });

      // LV CB
      c.push({ id: `cb_${ti + 2}`, type: 'cb', x: xfmrX[i], y: Y0 + 380, rotation: 0,
        props: { name: `CB-LV${ti}`, rated_voltage_kv: 11, rated_current_a: 630, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 630, thermal_pickup: 1.0, magnetic_pickup: 8, long_time_delay: 10 } });
      w.push({ id: `wire_${4 + i * 4}`, fromComponent: `transformer_${ti}`, fromPort: 'secondary', toComponent: `cb_${ti + 2}`, toPort: 'top' });
      w.push({ id: `wire_${5 + i * 4}`, fromComponent: `cb_${ti + 2}`, fromPort: 'bottom', toComponent: 'bus_2', toPort: 'top' });
    }

    // 11 kV Bus
    c.push({ id: 'bus_2', type: 'bus', x: X, y: Y0 + 460, rotation: 0,
      props: { name: '11kV Bus', voltage_kv: 11, bus_type: 'PQ' } });

    // Four outgoing feeders
    const feederNames = ['Feeder 1', 'Feeder 2', 'Feeder 3', 'Feeder 4'];
    const feederX = [X - S * 1.5, X - S * 0.5, X + S * 0.5, X + S * 1.5];
    let wId = 20;
    let cId = 10;
    for (let i = 0; i < 4; i++) {
      const fx = feederX[i];
      const baseY = Y0 + 520;

      // Feeder CB
      c.push({ id: `cb_${cId}`, type: 'cb', x: fx, y: baseY, rotation: 0,
        props: { name: `CB-F${i + 1}`, rated_voltage_kv: 11, rated_current_a: 400, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 400, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
      w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: `cb_${cId}`, toPort: 'top' });

      // Cable
      c.push({ id: `cable_${i + 1}`, type: 'cable', x: fx, y: baseY + 80, rotation: 0,
        props: { name: feederNames[i], length_km: 2 + i, r_per_km: 0.1, x_per_km: 0.08, rated_amps: 300, voltage_kv: 11 } });
      w.push({ id: `wire_${wId++}`, fromComponent: `cb_${cId}`, fromPort: 'bottom', toComponent: `cable_${i + 1}`, toPort: 'from' });

      // Load bus
      c.push({ id: `bus_${i + 3}`, type: 'bus', x: fx, y: baseY + 200, rotation: 0,
        props: { name: `Load Bus ${i + 1}`, voltage_kv: 11, bus_type: 'PQ' } });
      w.push({ id: `wire_${wId++}`, fromComponent: `cable_${i + 1}`, fromPort: 'to', toComponent: `bus_${i + 3}`, toPort: 'top' });

      // Static load
      c.push({ id: `static_load_${i + 1}`, type: 'static_load', x: fx, y: baseY + 280, rotation: 0,
        props: { name: `Load ${i + 1}`, rated_kva: 500 + i * 200, voltage_kv: 11, power_factor: 0.85, load_type: 'constant_power' } });
      w.push({ id: `wire_${wId++}`, fromComponent: `bus_${i + 3}`, fromPort: 'bottom', toComponent: `static_load_${i + 1}`, toPort: 'in' });

      cId++;
    }

    return {
      projectName: '33/11 kV Substation',
      baseMVA: 100, frequency: 50, defaultLengthUnit: 'km',
      nextId: 50,
      components: c, wires: w, scenarios: [],
    };
  },

  // ── Industrial Plant ──
  _industrialPlant() {
    const c = [];
    const w = [];
    const X = 400, Y0 = 60;
    let wId = 1;

    // Utility
    c.push({ id: 'utility_1', type: 'utility', x: X, y: Y0, rotation: 0,
      props: { name: 'Grid', voltage_kv: 11, fault_mva: 250, x_r_ratio: 12 } });

    // 11 kV Bus (incoming)
    c.push({ id: 'bus_1', type: 'bus', x: X, y: Y0 + 100, rotation: 0,
      props: { name: '11kV Intake', voltage_kv: 11, bus_type: 'Swing' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'utility_1', fromPort: 'out', toComponent: 'bus_1', toPort: 'top' });

    // Main incoming CB
    c.push({ id: 'cb_1', type: 'cb', x: X, y: Y0 + 160, rotation: 0,
      props: { name: 'Main Incomer', rated_voltage_kv: 11, rated_current_a: 630, breaking_capacity_ka: 25, state: 'closed', cb_type: 'acb', trip_rating_a: 630, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10, short_time_pickup: 6, short_time_delay: 0.2, instantaneous_pickup: 12 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_1', fromPort: 'bottom', toComponent: 'cb_1', toPort: 'top' });

    // Main transformer 11/0.4 kV
    c.push({ id: 'transformer_1', type: 'transformer', x: X, y: Y0 + 260, rotation: 0,
      props: { name: 'Main Xfmr', rated_mva: 1.5, voltage_hv_kv: 11, voltage_lv_kv: 0.4, z_percent: 6, x_r_ratio: 8, vector_group: 'Dyn11', winding_config: 'step_down', grounding_hv: 'ungrounded', grounding_lv: 'solidly_grounded', grounding_hv_resistance: 0, grounding_hv_reactance: 0, grounding_lv_resistance: 0, grounding_lv_reactance: 0, tap_percent: 0 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_1', fromPort: 'bottom', toComponent: 'transformer_1', toPort: 'primary' });

    // LV Main CB
    c.push({ id: 'cb_2', type: 'cb', x: X, y: Y0 + 380, rotation: 0,
      props: { name: 'LV Main', rated_voltage_kv: 0.4, rated_current_a: 2500, breaking_capacity_ka: 50, state: 'closed', cb_type: 'acb', trip_rating_a: 2500, thermal_pickup: 1.0, magnetic_pickup: 8, long_time_delay: 10, short_time_pickup: 6, short_time_delay: 0.1, instantaneous_pickup: 12 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'transformer_1', fromPort: 'secondary', toComponent: 'cb_2', toPort: 'top' });

    // 0.4 kV Main Bus
    c.push({ id: 'bus_2', type: 'bus', x: X, y: Y0 + 460, rotation: 0,
      props: { name: '0.4kV MCC', voltage_kv: 0.4, bus_type: 'PQ' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_2', fromPort: 'bottom', toComponent: 'bus_2', toPort: 'top' });

    // Motor 1 feeder (large)
    const m1x = X - 240;
    c.push({ id: 'cb_3', type: 'cb', x: m1x, y: Y0 + 520, rotation: 0,
      props: { name: 'CB-M1', rated_voltage_kv: 0.4, rated_current_a: 400, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 400, thermal_pickup: 0.9, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_3', toPort: 'top' });

    c.push({ id: 'cable_1', type: 'cable', x: m1x, y: Y0 + 600, rotation: 0,
      props: { name: 'Cable M1', length_km: 0.05, r_per_km: 0.1, x_per_km: 0.08, rated_amps: 350, voltage_kv: 0.4 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_3', fromPort: 'bottom', toComponent: 'cable_1', toPort: 'from' });

    c.push({ id: 'motor_induction_1', type: 'motor_induction', x: m1x, y: Y0 + 720, rotation: 0,
      props: { name: 'Compressor M1', rated_kw: 200, voltage_kv: 0.4, efficiency: 0.93, power_factor: 0.85, locked_rotor_current: 6, x_pp: 0.17, x_r_ratio: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cable_1', fromPort: 'to', toComponent: 'motor_induction_1', toPort: 'in' });

    // Motor 2 feeder (medium)
    const m2x = X - 80;
    c.push({ id: 'cb_4', type: 'cb', x: m2x, y: Y0 + 520, rotation: 0,
      props: { name: 'CB-M2', rated_voltage_kv: 0.4, rated_current_a: 200, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 200, thermal_pickup: 0.95, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_4', toPort: 'top' });

    c.push({ id: 'motor_induction_2', type: 'motor_induction', x: m2x, y: Y0 + 620, rotation: 0,
      props: { name: 'Pump M2', rated_kw: 90, voltage_kv: 0.4, efficiency: 0.91, power_factor: 0.83, locked_rotor_current: 7, x_pp: 0.18, x_r_ratio: 8 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_4', fromPort: 'bottom', toComponent: 'motor_induction_2', toPort: 'in' });

    // Lighting/general load feeder
    const lx = X + 80;
    c.push({ id: 'cb_5', type: 'cb', x: lx, y: Y0 + 520, rotation: 0,
      props: { name: 'CB-L1', rated_voltage_kv: 0.4, rated_current_a: 250, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 250, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_5', toPort: 'top' });

    c.push({ id: 'static_load_1', type: 'static_load', x: lx, y: Y0 + 620, rotation: 0,
      props: { name: 'Lighting & Gen', rated_kva: 150, voltage_kv: 0.4, power_factor: 0.9, load_type: 'constant_power' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_5', fromPort: 'bottom', toComponent: 'static_load_1', toPort: 'in' });

    // Capacitor bank feeder
    const cx = X + 240;
    c.push({ id: 'cb_6', type: 'cb', x: cx, y: Y0 + 520, rotation: 0,
      props: { name: 'CB-Cap', rated_voltage_kv: 0.4, rated_current_a: 200, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 200, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_6', toPort: 'top' });

    c.push({ id: 'capacitor_bank_1', type: 'capacitor_bank', x: cx, y: Y0 + 620, rotation: 0,
      props: { name: 'PFC Bank', rated_kvar: 100, voltage_kv: 0.4, steps: 4 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_6', fromPort: 'bottom', toComponent: 'capacitor_bank_1', toPort: 'in' });

    return {
      projectName: 'Industrial Plant',
      baseMVA: 100, frequency: 50, defaultLengthUnit: 'km',
      nextId: 50,
      components: c, wires: w, scenarios: [],
    };
  },

  // ── Residential Distribution ──
  _residentialDist() {
    const c = [];
    const w = [];
    let wId = 1;
    const X = 400, Y0 = 60;

    // Utility 33 kV
    c.push({ id: 'utility_1', type: 'utility', x: X, y: Y0, rotation: 0,
      props: { name: 'Grid 33kV', voltage_kv: 33, fault_mva: 500, x_r_ratio: 15 } });

    // 33 kV Bus
    c.push({ id: 'bus_1', type: 'bus', x: X, y: Y0 + 100, rotation: 0,
      props: { name: '33kV Bus', voltage_kv: 33, bus_type: 'Swing' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'utility_1', fromPort: 'out', toComponent: 'bus_1', toPort: 'top' });

    // Main 33/11 kV transformer
    c.push({ id: 'cb_1', type: 'cb', x: X, y: Y0 + 160, rotation: 0,
      props: { name: 'CB-HV', rated_voltage_kv: 33, rated_current_a: 200, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 200, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_1', fromPort: 'bottom', toComponent: 'cb_1', toPort: 'top' });

    c.push({ id: 'transformer_1', type: 'transformer', x: X, y: Y0 + 260, rotation: 0,
      props: { name: 'Main Xfmr', rated_mva: 5, voltage_hv_kv: 33, voltage_lv_kv: 11, z_percent: 7, x_r_ratio: 10, vector_group: 'Dyn11', winding_config: 'step_down', grounding_hv: 'ungrounded', grounding_lv: 'solidly_grounded', grounding_hv_resistance: 0, grounding_hv_reactance: 0, grounding_lv_resistance: 0, grounding_lv_reactance: 0, tap_percent: 0 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_1', fromPort: 'bottom', toComponent: 'transformer_1', toPort: 'primary' });

    // 11 kV Bus
    c.push({ id: 'bus_2', type: 'bus', x: X, y: Y0 + 380, rotation: 0,
      props: { name: '11kV Bus', voltage_kv: 11, bus_type: 'PQ' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'transformer_1', fromPort: 'secondary', toComponent: 'bus_2', toPort: 'top' });

    // Three distribution transformers
    const distNames = ['Zone A', 'Zone B', 'Zone C'];
    const distX = [X - 220, X, X + 220];
    const distMVA = [0.5, 0.315, 0.5];
    const loadKVA = [350, 200, 400];

    for (let i = 0; i < 3; i++) {
      const dx = distX[i];
      const baseY = Y0 + 440;
      const idx = i + 2; // cb_2, cb_3, cb_4

      // Fuse on MV side
      c.push({ id: `fuse_${i + 1}`, type: 'fuse', x: dx, y: baseY, rotation: 0,
        props: { name: `Fuse-${distNames[i]}`, rated_voltage_kv: 11, rated_current_a: 40, breaking_capacity_ka: 50, fuse_type: 'gG' } });
      w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: `fuse_${i + 1}`, toPort: 'top' });

      // Cable to distribution transformer
      c.push({ id: `cable_${i + 1}`, type: 'cable', x: dx, y: baseY + 80, rotation: 0,
        props: { name: `Cable ${distNames[i]}`, length_km: 0.5 + i * 0.3, r_per_km: 0.32, x_per_km: 0.08, rated_amps: 150, voltage_kv: 11 } });
      w.push({ id: `wire_${wId++}`, fromComponent: `fuse_${i + 1}`, fromPort: 'bottom', toComponent: `cable_${i + 1}`, toPort: 'from' });

      // Distribution transformer 11/0.4 kV
      c.push({ id: `transformer_${i + 2}`, type: 'transformer', x: dx, y: baseY + 200, rotation: 0,
        props: { name: `Xfmr ${distNames[i]}`, rated_mva: distMVA[i], voltage_hv_kv: 11, voltage_lv_kv: 0.4, z_percent: 4, x_r_ratio: 5, vector_group: 'Dyn11', winding_config: 'step_down', grounding_hv: 'ungrounded', grounding_lv: 'solidly_grounded', grounding_hv_resistance: 0, grounding_hv_reactance: 0, grounding_lv_resistance: 0, grounding_lv_reactance: 0, tap_percent: 0 } });
      w.push({ id: `wire_${wId++}`, fromComponent: `cable_${i + 1}`, fromPort: 'to', toComponent: `transformer_${i + 2}`, toPort: 'primary' });

      // LV CB
      c.push({ id: `cb_${idx}`, type: 'cb', x: dx, y: baseY + 320, rotation: 0,
        props: { name: `CB-LV ${distNames[i]}`, rated_voltage_kv: 0.4, rated_current_a: 630, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 630, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
      w.push({ id: `wire_${wId++}`, fromComponent: `transformer_${i + 2}`, fromPort: 'secondary', toComponent: `cb_${idx}`, toPort: 'top' });

      // LV Bus
      c.push({ id: `bus_${i + 3}`, type: 'bus', x: dx, y: baseY + 400, rotation: 0,
        props: { name: `LV ${distNames[i]}`, voltage_kv: 0.4, bus_type: 'PQ' } });
      w.push({ id: `wire_${wId++}`, fromComponent: `cb_${idx}`, fromPort: 'bottom', toComponent: `bus_${i + 3}`, toPort: 'top' });

      // Residential load
      c.push({ id: `static_load_${i + 1}`, type: 'static_load', x: dx, y: baseY + 480, rotation: 0,
        props: { name: `${distNames[i]} Load`, rated_kva: loadKVA[i], voltage_kv: 0.4, power_factor: 0.9, load_type: 'constant_power' } });
      w.push({ id: `wire_${wId++}`, fromComponent: `bus_${i + 3}`, fromPort: 'bottom', toComponent: `static_load_${i + 1}`, toPort: 'in' });
    }

    return {
      projectName: 'Residential Distribution',
      baseMVA: 100, frequency: 50, defaultLengthUnit: 'km',
      nextId: 50,
      components: c, wires: w, scenarios: [],
    };
  },

  // ── Generator Island ──
  _generatorIsland() {
    const c = [];
    const w = [];
    let wId = 1;
    const X = 400, Y0 = 60;

    // Diesel generator
    c.push({ id: 'generator_1', type: 'generator', x: X, y: Y0, rotation: 0,
      props: { name: 'DG1', rated_mva: 2.5, voltage_kv: 11, xd_pp: 0.15, xd_p: 0.25, xd: 1.2, x_r_ratio: 40, power_factor: 0.8 } });

    // Generator CB
    c.push({ id: 'cb_1', type: 'cb', x: X, y: Y0 + 100, rotation: 0,
      props: { name: 'Gen CB', rated_voltage_kv: 11, rated_current_a: 200, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 200, thermal_pickup: 1.0, magnetic_pickup: 8, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'generator_1', fromPort: 'out', toComponent: 'cb_1', toPort: 'top' });

    // 11 kV Bus
    c.push({ id: 'bus_1', type: 'bus', x: X, y: Y0 + 180, rotation: 0,
      props: { name: '11kV Genset Bus', voltage_kv: 11, bus_type: 'Swing' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_1', fromPort: 'bottom', toComponent: 'bus_1', toPort: 'top' });

    // Step-down transformer
    c.push({ id: 'cb_2', type: 'cb', x: X, y: Y0 + 240, rotation: 0,
      props: { name: 'CB-Xfmr', rated_voltage_kv: 11, rated_current_a: 200, breaking_capacity_ka: 25, state: 'closed', cb_type: 'mccb', trip_rating_a: 200, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_1', fromPort: 'bottom', toComponent: 'cb_2', toPort: 'top' });

    c.push({ id: 'transformer_1', type: 'transformer', x: X, y: Y0 + 340, rotation: 0,
      props: { name: 'Step-Down Xfmr', rated_mva: 2, voltage_hv_kv: 11, voltage_lv_kv: 0.4, z_percent: 5.5, x_r_ratio: 6, vector_group: 'Dyn11', winding_config: 'step_down', grounding_hv: 'ungrounded', grounding_lv: 'solidly_grounded', grounding_hv_resistance: 0, grounding_hv_reactance: 0, grounding_lv_resistance: 0, grounding_lv_reactance: 0, tap_percent: 0 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_2', fromPort: 'bottom', toComponent: 'transformer_1', toPort: 'primary' });

    // LV Main
    c.push({ id: 'cb_3', type: 'cb', x: X, y: Y0 + 460, rotation: 0,
      props: { name: 'LV Main', rated_voltage_kv: 0.4, rated_current_a: 3200, breaking_capacity_ka: 50, state: 'closed', cb_type: 'acb', trip_rating_a: 3200, thermal_pickup: 1.0, magnetic_pickup: 8, long_time_delay: 10, short_time_pickup: 6, short_time_delay: 0.1, instantaneous_pickup: 12 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'transformer_1', fromPort: 'secondary', toComponent: 'cb_3', toPort: 'top' });

    // 0.4 kV Bus
    c.push({ id: 'bus_2', type: 'bus', x: X, y: Y0 + 540, rotation: 0,
      props: { name: '0.4kV Bus', voltage_kv: 0.4, bus_type: 'PQ' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_3', fromPort: 'bottom', toComponent: 'bus_2', toPort: 'top' });

    // Essential load
    const ex = X - 160;
    c.push({ id: 'fuse_1', type: 'fuse', x: ex, y: Y0 + 600, rotation: 0,
      props: { name: 'Fuse-Essential', rated_voltage_kv: 0.4, rated_current_a: 200, breaking_capacity_ka: 50, fuse_type: 'gG' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'fuse_1', toPort: 'top' });

    c.push({ id: 'static_load_1', type: 'static_load', x: ex, y: Y0 + 700, rotation: 0,
      props: { name: 'Essential Load', rated_kva: 120, voltage_kv: 0.4, power_factor: 0.85, load_type: 'constant_power' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'fuse_1', fromPort: 'bottom', toComponent: 'static_load_1', toPort: 'in' });

    // Motor load
    c.push({ id: 'cb_4', type: 'cb', x: X, y: Y0 + 600, rotation: 0,
      props: { name: 'CB-Motor', rated_voltage_kv: 0.4, rated_current_a: 400, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 400, thermal_pickup: 0.9, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_4', toPort: 'top' });

    c.push({ id: 'motor_induction_1', type: 'motor_induction', x: X, y: Y0 + 700, rotation: 0,
      props: { name: 'Main Pump', rated_kw: 150, voltage_kv: 0.4, efficiency: 0.92, power_factor: 0.84, locked_rotor_current: 6.5, x_pp: 0.17, x_r_ratio: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_4', fromPort: 'bottom', toComponent: 'motor_induction_1', toPort: 'in' });

    // Non-essential load
    const nx = X + 160;
    c.push({ id: 'cb_5', type: 'cb', x: nx, y: Y0 + 600, rotation: 0,
      props: { name: 'CB-NonEss', rated_voltage_kv: 0.4, rated_current_a: 250, breaking_capacity_ka: 36, state: 'closed', cb_type: 'mccb', trip_rating_a: 250, thermal_pickup: 1.0, magnetic_pickup: 10, long_time_delay: 10 } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'bus_2', fromPort: 'bottom', toComponent: 'cb_5', toPort: 'top' });

    c.push({ id: 'static_load_2', type: 'static_load', x: nx, y: Y0 + 700, rotation: 0,
      props: { name: 'Non-Essential', rated_kva: 200, voltage_kv: 0.4, power_factor: 0.85, load_type: 'constant_power' } });
    w.push({ id: `wire_${wId++}`, fromComponent: 'cb_5', fromPort: 'bottom', toComponent: 'static_load_2', toPort: 'in' });

    return {
      projectName: 'Generator Island',
      baseMVA: 100, frequency: 50, defaultLengthUnit: 'km',
      nextId: 50,
      components: c, wires: w, scenarios: [],
    };
  },

  // ── UI: Template Picker ──

  show() {
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'Network Templates';

    const byCategory = {};
    for (const t of this.templates) {
      if (!byCategory[t.category]) byCategory[t.category] = [];
      byCategory[t.category].push(t);
    }

    let html = '<div class="template-grid">';
    for (const [cat, tmpls] of Object.entries(byCategory)) {
      html += `<h4 style="grid-column:1/-1;margin:8px 0 4px;color:var(--text-secondary);font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">${cat}</h4>`;
      for (const t of tmpls) {
        html += `
          <div class="template-card" data-id="${t.id}">
            <div class="template-card-header">${t.name}</div>
            <div class="template-card-preview">${t.preview}</div>
            <div class="template-card-desc">${t.description}</div>
            <button class="btn-small btn-primary template-load-btn" data-id="${t.id}">Load Template</button>
          </div>`;
      }
    }
    html += '</div>';

    modal.querySelector('#calc-modal-body').innerHTML = html;
    modal.style.display = '';

    // Bind load buttons
    modal.querySelectorAll('.template-load-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (AppState.dirty) {
          if (!confirm('You have unsaved changes. Load template?')) return;
        }
        const data = this.generate(id);
        if (!data) return;
        AppState.fromJSON(data);
        Canvas.updateTransform();
        Canvas.render();
        Properties.clear();
        document.title = `ProtectionPro \u2014 ${data.projectName}`;
        updateProjectNameDisplay(data.projectName);
        modal.style.display = 'none';
        Project._statusMsg(`Loaded template: ${data.projectName}`);
      });
    });
  },
};
