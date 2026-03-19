/* ProtectionPro — Component Helpers & Validation */

const Components = {
  // Get all buses from the network
  getBuses() {
    return [...AppState.components.values()].filter(c => c.type === 'bus');
  },

  // Get all components connected to a given component via wires
  getConnectedComponents(compId) {
    const connected = [];
    for (const wire of AppState.wires.values()) {
      if (wire.fromComponent === compId) {
        connected.push({ wire, componentId: wire.toComponent, port: wire.toPort, localPort: wire.fromPort });
      }
      if (wire.toComponent === compId) {
        connected.push({ wire, componentId: wire.fromComponent, port: wire.fromPort, localPort: wire.toPort });
      }
    }
    return connected;
  },

  // Check if a specific port on a component has a wire connected
  isPortConnected(compId, portId) {
    for (const wire of AppState.wires.values()) {
      if ((wire.fromComponent === compId && wire.fromPort === portId) ||
          (wire.toComponent === compId && wire.toPort === portId)) {
        return true;
      }
    }
    return false;
  },

  // Get all unconnected ports across all components
  getUnconnectedPorts() {
    const unconnected = [];
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      if (!def || !def.ports) continue;
      for (const port of def.ports) {
        if (!this.isPortConnected(comp.id, port.id)) {
          unconnected.push({ comp, port });
        }
      }
    }
    return unconnected;
  },

  // Build network adjacency for analysis
  buildNetworkGraph() {
    const graph = {
      buses: [],
      branches: [],
      sources: [],
      loads: [],
    };

    for (const comp of AppState.components.values()) {
      if (comp.type === 'bus') {
        graph.buses.push(comp);
      }
    }

    // Find branches between buses (transformers, cables, switches, etc.)
    for (const wire of AppState.wires.values()) {
      const from = AppState.components.get(wire.fromComponent);
      const to = AppState.components.get(wire.toComponent);
      if (!from || !to) continue;

      // Identify branch types
      if (from.type === 'bus' || to.type === 'bus') {
        const bus = from.type === 'bus' ? from : to;
        const other = from.type === 'bus' ? to : from;

        if (['utility', 'generator'].includes(other.type)) {
          graph.sources.push({ bus, source: other });
        } else if (['static_load', 'motor_induction', 'motor_synchronous'].includes(other.type)) {
          graph.loads.push({ bus, load: other });
        }
      }
    }

    // Find bus-to-bus branches (via transformers, cables, etc.)
    for (const comp of AppState.components.values()) {
      if (['transformer', 'cable', 'cb', 'switch', 'fuse'].includes(comp.type)) {
        const connectedBuses = [];
        for (const wire of AppState.wires.values()) {
          if (wire.fromComponent === comp.id || wire.toComponent === comp.id) {
            const otherId = wire.fromComponent === comp.id ? wire.toComponent : wire.fromComponent;
            const other = AppState.components.get(otherId);
            if (other && other.type === 'bus') {
              const localPort = wire.fromComponent === comp.id ? wire.fromPort : wire.toPort;
              connectedBuses.push({ bus: other, port: localPort });
            }
          }
        }
        if (connectedBuses.length >= 2) {
          graph.branches.push({
            from: connectedBuses[0].bus,
            to: connectedBuses[1].bus,
            fromPort: connectedBuses[0].port,
            toPort: connectedBuses[1].port,
            element: comp,
          });
        }
      }
    }

    return graph;
  },

  // ─── Comprehensive Validation ───
  validate() {
    const errors = [];   // blocking errors
    const warnings = []; // non-blocking warnings
    const buses = this.getBuses();

    // 1. Must have at least one bus
    if (buses.length === 0) {
      errors.push({ type: 'error', msg: 'No buses found. Add at least one bus to the network.', compId: null });
      return { errors, warnings };
    }

    // 2. Check for isolated components (no connections at all)
    for (const comp of AppState.components.values()) {
      if (comp.type === 'relay') continue;
      const def = COMPONENT_DEFS[comp.type];
      if (!def.ports || def.ports.length === 0) continue;
      let hasAnyConnection = false;
      for (const port of def.ports) {
        if (this.isPortConnected(comp.id, port.id)) {
          hasAnyConnection = true;
          break;
        }
      }
      if (!hasAnyConnection) {
        errors.push({
          type: 'error',
          msg: `${comp.props.name || comp.type} is not connected to anything.`,
          compId: comp.id,
        });
      }
    }

    // 3. Check for swing bus (required for load flow)
    const swingBus = buses.find(b => b.props.bus_type === 'Swing');
    if (!swingBus) {
      errors.push({ type: 'error', msg: 'No Swing bus defined. Set at least one bus to "Swing" type for load flow.', compId: null });
    }

    // 4. Check each bus has at least one source path
    const graph = this.buildNetworkGraph();
    const busesWithSource = new Set();
    for (const { bus } of graph.sources) {
      busesWithSource.add(bus.id);
    }
    // Propagate source reachability through branches
    let changed = true;
    while (changed) {
      changed = false;
      for (const branch of graph.branches) {
        if (busesWithSource.has(branch.from.id) && !busesWithSource.has(branch.to.id)) {
          busesWithSource.add(branch.to.id);
          changed = true;
        }
        if (busesWithSource.has(branch.to.id) && !busesWithSource.has(branch.from.id)) {
          busesWithSource.add(branch.from.id);
          changed = true;
        }
      }
    }
    for (const bus of buses) {
      if (!busesWithSource.has(bus.id)) {
        errors.push({
          type: 'error',
          msg: `${bus.props.name || 'Bus'} has no path to any source (Utility or Generator).`,
          compId: bus.id,
        });
      }
    }

    // 5. Voltage consistency: transformer secondary should match downstream bus voltage
    for (const branch of graph.branches) {
      if (branch.element.type !== 'transformer') continue;
      const xfmr = branch.element;
      // Determine which bus is primary and which is secondary based on port
      let hvBus, lvBus;
      if (branch.fromPort === 'primary') {
        hvBus = branch.from;
        lvBus = branch.to;
      } else if (branch.fromPort === 'secondary') {
        hvBus = branch.to;
        lvBus = branch.from;
      } else if (branch.toPort === 'primary') {
        hvBus = branch.to;
        lvBus = branch.from;
      } else {
        hvBus = branch.from;
        lvBus = branch.to;
      }

      const xfmrHV = xfmr.props.voltage_hv_kv;
      const xfmrLV = xfmr.props.voltage_lv_kv;
      const tapPct = xfmr.props.tap_percent || 0;
      const tolerance = 0.15; // 15% tolerance for tap range

      // Check HV bus voltage matches transformer HV
      if (hvBus) {
        const busV = hvBus.props.voltage_kv;
        if (busV && xfmrHV && Math.abs(busV - xfmrHV) / xfmrHV > tolerance) {
          warnings.push({
            type: 'warning',
            msg: `${hvBus.props.name} voltage (${busV} kV) doesn't match ${xfmr.props.name} HV rating (${xfmrHV} kV).`,
            compId: hvBus.id,
          });
        }
      }

      // Check LV bus voltage matches transformer LV (accounting for tap)
      if (lvBus) {
        const busV = lvBus.props.voltage_kv;
        const expectedLV = xfmrLV * (1 + tapPct / 100);
        if (busV && xfmrLV && Math.abs(busV - expectedLV) / expectedLV > tolerance) {
          warnings.push({
            type: 'warning',
            msg: `${lvBus.props.name} voltage (${busV} kV) doesn't match ${xfmr.props.name} LV rating (${xfmrLV} kV). Expected ~${expectedLV.toFixed(2)} kV.`,
            compId: lvBus.id,
          });
        }
      }
    }

    // 6. Check cables connect buses at same voltage level
    for (const branch of graph.branches) {
      if (branch.element.type !== 'cable') continue;
      const cable = branch.element;
      const v1 = branch.from.props.voltage_kv;
      const v2 = branch.to.props.voltage_kv;
      if (v1 && v2 && v1 !== v2) {
        warnings.push({
          type: 'warning',
          msg: `${cable.props.name} connects buses at different voltages: ${branch.from.props.name} (${v1} kV) and ${branch.to.props.name} (${v2} kV).`,
          compId: cable.id,
        });
      }
      // Check cable voltage rating matches bus voltage
      const cableV = cable.props.voltage_kv;
      if (cableV && v1 && Math.abs(cableV - v1) / v1 > 0.15) {
        warnings.push({
          type: 'warning',
          msg: `${cable.props.name} rated voltage (${cableV} kV) doesn't match connected bus voltage (${v1} kV).`,
          compId: cable.id,
        });
      }
    }

    // 7. Check for missing/zero critical properties
    for (const comp of AppState.components.values()) {
      const p = comp.props;
      const name = p.name || comp.type;

      if (comp.type === 'transformer') {
        if (!p.rated_mva || p.rated_mva <= 0) {
          errors.push({ type: 'error', msg: `${name}: Rating (MVA) must be greater than zero.`, compId: comp.id });
        }
        if (!p.z_percent || p.z_percent <= 0) {
          errors.push({ type: 'error', msg: `${name}: Z% must be greater than zero.`, compId: comp.id });
        }
      }
      if (comp.type === 'utility') {
        if (!p.fault_mva || p.fault_mva <= 0) {
          errors.push({ type: 'error', msg: `${name}: Fault level (MVA) must be greater than zero.`, compId: comp.id });
        }
      }
      if (comp.type === 'generator') {
        if (!p.rated_mva || p.rated_mva <= 0) {
          errors.push({ type: 'error', msg: `${name}: Rating (MVA) must be greater than zero.`, compId: comp.id });
        }
      }
      if (comp.type === 'cable') {
        if (!p.length_km || p.length_km <= 0) {
          warnings.push({ type: 'warning', msg: `${name}: Cable length is zero or not set.`, compId: comp.id });
        }
      }
      if (comp.type === 'bus') {
        if (!p.voltage_kv || p.voltage_kv <= 0) {
          errors.push({ type: 'error', msg: `${name}: Bus voltage must be greater than zero.`, compId: comp.id });
        }
      }
    }

    // 8. Check components downstream of transformer match its secondary voltage
    // Walk from each transformer's secondary bus downstream through cables/CBs/etc.
    for (const branch of graph.branches) {
      if (branch.element.type !== 'transformer') continue;
      const xfmr = branch.element;
      let lvBus;
      if (branch.fromPort === 'secondary') {
        lvBus = branch.from;
      } else if (branch.toPort === 'secondary') {
        lvBus = branch.to;
      } else {
        // Fallback: use the bus with lower voltage
        lvBus = (branch.from.props.voltage_kv || 0) <= (branch.to.props.voltage_kv || 0) ? branch.from : branch.to;
      }

      const expectedV = xfmr.props.voltage_lv_kv;
      if (!expectedV || !lvBus) continue;

      // BFS downstream from lvBus through non-transformer branches
      const visited = new Set([lvBus.id]);
      const queue = [lvBus.id];
      while (queue.length > 0) {
        const busId = queue.shift();
        for (const br of graph.branches) {
          if (br.element.type === 'transformer') continue; // don't cross transformers
          let nextBus = null;
          if (br.from.id === busId && !visited.has(br.to.id)) nextBus = br.to;
          if (br.to.id === busId && !visited.has(br.from.id)) nextBus = br.from;
          if (nextBus) {
            visited.add(nextBus.id);
            queue.push(nextBus.id);
            if (nextBus.props.voltage_kv && Math.abs(nextBus.props.voltage_kv - expectedV) / expectedV > 0.15) {
              warnings.push({
                type: 'warning',
                msg: `${nextBus.props.name} (${nextBus.props.voltage_kv} kV) is downstream of ${xfmr.props.name} but doesn't match secondary voltage (${expectedV} kV).`,
                compId: nextBus.id,
              });
            }
          }
        }
      }
    }

    return { errors, warnings };
  },

  // Simple validate for backward compat (returns string array)
  validateSimple() {
    const { errors, warnings } = this.validate();
    return [...errors.map(e => e.msg), ...warnings.map(w => '⚠ ' + w.msg)];
  },
};
