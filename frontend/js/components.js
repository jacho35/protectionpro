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

  // Trace from sources to a target component, collecting all protection and
  // thermal devices on the source-to-target paths. Returns a Set of component IDs.
  traceUpstreamProtection(targetId) {
    const PROTECTION_TYPES = new Set(['cb', 'fuse', 'relay']);
    const THERMAL_TYPES = new Set(['transformer', 'cable']);

    // Build adjacency from wires
    const adj = new Map();
    for (const wire of AppState.wires.values()) {
      if (!adj.has(wire.fromComponent)) adj.set(wire.fromComponent, []);
      if (!adj.has(wire.toComponent)) adj.set(wire.toComponent, []);
      adj.get(wire.fromComponent).push(wire.toComponent);
      adj.get(wire.toComponent).push(wire.fromComponent);
    }

    // Find all sources
    const sources = [];
    for (const [id, comp] of AppState.components) {
      if (comp.type === 'utility' || comp.type === 'generator') sources.push(id);
    }

    // DFS from each source; collect paths that reach the target.
    // Simple-path enumeration is exponential on meshed networks. Cap BOTH the
    // number of completed paths AND the number of node expansions — on a
    // meshed/source-isolated graph almost no path reaches the target, so a
    // path-count cap alone never fires while the traversal blows up.
    const MAX_PATHS = 500;
    const MAX_EXPANSIONS = 20000;
    let pathsFound = 0;
    let expansions = 0;
    const relevant = new Set([targetId]);
    for (const srcId of sources) {
      if (pathsFound >= MAX_PATHS || expansions >= MAX_EXPANSIONS) break;
      const stack = [{ node: srcId, visited: new Set([srcId]), trail: [] }];
      while (stack.length > 0) {
        if (expansions >= MAX_EXPANSIONS) break;
        expansions++;
        const { node, visited, trail } = stack.pop();
        const comp = AppState.components.get(node);
        if (!comp) continue;

        const currentTrail = [...trail, node];

        // Found the target — add all protection/thermal devices on this path
        if (node === targetId) {
          for (const id of currentTrail) {
            const c = AppState.components.get(id);
            if (c && (PROTECTION_TYPES.has(c.type) || THERMAL_TYPES.has(c.type))) {
              relevant.add(id);
            }
          }
          pathsFound++;
          if (pathsFound >= MAX_PATHS) break;
          continue; // don't traverse past the target
        }

        for (const neighbor of (adj.get(node) || [])) {
          if (!visited.has(neighbor)) {
            const newVisited = new Set(visited);
            newVisited.add(neighbor);
            stack.push({ node: neighbor, visited: newVisited, trail: currentTrail });
          }
        }
      }
    }
    return relevant;
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

  // Get the effective ports for a component (dynamic for buses, static otherwise)
  getEffectivePorts(comp) {
    const def = COMPONENT_DEFS[comp.type];
    if (!def || !def.ports) return [];
    if (comp.type === 'bus' && typeof Symbols !== 'undefined' && Symbols.getBusPorts) {
      return Symbols.getBusPorts(comp);
    }
    return def.ports;
  },

  // Get all unconnected ports across all components
  // For buses, only show warnings when the bus has no connections at all
  getUnconnectedPorts() {
    const unconnected = [];
    const pageComps = AppState.getActivePageComponents();
    for (const comp of pageComps.values()) {
      const ports = this.getEffectivePorts(comp);
      if (comp.type === 'bus') {
        // Buses use free-position 'at_<x>' attachments, which never match
        // the generated port ids — connected means ANY wire touches the bus
        let hasAnyConnection = false;
        for (const wire of AppState.wires.values()) {
          if (wire.fromComponent === comp.id || wire.toComponent === comp.id) {
            hasAnyConnection = true;
            break;
          }
        }
        if (hasAnyConnection) continue;
        // Unconnected bus: a single marker at the bar centre
        unconnected.push({ comp, port: { id: 'at_0', side: 'top' } });
        continue;
      }
      for (const port of ports) {
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

    // "Transparent" elements: zero-impedance pass-through components
    const TRANSPARENT = new Set(['cb', 'switch', 'fuse', 'ct', 'pt', 'surge_arrester', 'offpage_connector']);

    // Check if a component is transparent and in closed state
    const isTransparentClosed = (comp) => {
      if (!TRANSPARENT.has(comp.type)) return false;
      if (comp.type === 'cb' || comp.type === 'switch') {
        if (comp.props.state === 'open') return false;
      }
      return true;
    };

    for (const comp of AppState.components.values()) {
      if (comp.type === 'bus') {
        graph.buses.push(comp);
      }
    }

    // Build adjacency from wires: compId -> [{id, localPort}]
    const adj = new Map();
    for (const wire of AppState.wires.values()) {
      if (!adj.has(wire.fromComponent)) adj.set(wire.fromComponent, []);
      if (!adj.has(wire.toComponent)) adj.set(wire.toComponent, []);
      adj.get(wire.fromComponent).push({ id: wire.toComponent, localPort: wire.fromPort });
      adj.get(wire.toComponent).push({ id: wire.fromComponent, localPort: wire.toPort });
    }

    // Link matched off-page connectors as virtual wires (same label = same node)
    const offpageByLabel = new Map();
    for (const comp of AppState.components.values()) {
      if (comp.type === 'offpage_connector') {
        const lbl = comp.props.name || '';
        if (!offpageByLabel.has(lbl)) offpageByLabel.set(lbl, []);
        offpageByLabel.get(lbl).push(comp);
      }
    }
    for (const [, connectors] of offpageByLabel) {
      for (let i = 0; i < connectors.length; i++) {
        for (let j = i + 1; j < connectors.length; j++) {
          const a = connectors[i].id, b = connectors[j].id;
          if (!adj.has(a)) adj.set(a, []);
          if (!adj.has(b)) adj.set(b, []);
          adj.get(a).push({ id: b, localPort: 'port' });
          adj.get(b).push({ id: a, localPort: 'port' });
        }
      }
    }

    // BFS from a component port through transparent elements to find a bus
    const findBusFromPort = (startId, portId) => {
      const visited = new Set([startId]);
      const startNeighbors = (adj.get(startId) || [])
        .filter(n => n.localPort === portId)
        .map(n => n.id);
      const queue = [...startNeighbors];
      while (queue.length > 0) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        const comp = AppState.components.get(id);
        if (!comp) continue;
        if (comp.type === 'bus') return comp;
        if (isTransparentClosed(comp)) {
          for (const { id: nid } of (adj.get(id) || [])) {
            if (!visited.has(nid)) queue.push(nid);
          }
        }
      }
      return null;
    };

    // For each bus, find sources/loads connected (walking through transparent elements)
    for (const bus of graph.buses) {
      const visited = new Set([bus.id]);
      const queue = (adj.get(bus.id) || []).map(n => n.id);
      while (queue.length > 0) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        const comp = AppState.components.get(id);
        if (!comp) continue;
        if (['utility', 'generator', 'solar_pv', 'wind_turbine'].includes(comp.type)) {
          graph.sources.push({ bus, source: comp });
        } else if (['static_load', 'motor_induction', 'motor_synchronous', 'capacitor_bank'].includes(comp.type)) {
          graph.loads.push({ bus, load: comp });
        } else if (isTransparentClosed(comp)) {
          for (const { id: nid } of (adj.get(id) || [])) {
            if (!visited.has(nid)) queue.push(nid);
          }
        }
        // Don't walk through other buses, transformers, or cables
      }
    }

    // Find bus-to-bus branches: for each transformer/cable, find the bus reachable from each port
    const foundBranches = new Set();
    for (const comp of AppState.components.values()) {
      if (!['transformer', 'cable'].includes(comp.type)) continue;
      const def = COMPONENT_DEFS[comp.type];
      if (!def || !def.ports || def.ports.length < 2) continue;

      const port1 = def.ports[0]; // primary / from
      const port2 = def.ports[1]; // secondary / to
      const bus1 = findBusFromPort(comp.id, port1.id);
      const bus2 = findBusFromPort(comp.id, port2.id);

      if (bus1 && bus2 && bus1.id !== bus2.id) {
        const key = [bus1.id, bus2.id, comp.id].sort().join('-');
        if (!foundBranches.has(key)) {
          foundBranches.add(key);
          graph.branches.push({
            from: bus1,
            to: bus2,
            fromPort: port1.id,
            toPort: port2.id,
            element: comp,
          });
        }
      }
    }

    // Find direct bus-to-bus connections (solid links / bus couplers)
    // Walk from each bus through transparent elements; if we reach another bus, add a branch
    const busSet = new Set(graph.buses.map(b => b.id));
    for (const bus of graph.buses) {
      const visited = new Set([bus.id]);
      const queue = (adj.get(bus.id) || []).map(n => n.id);
      while (queue.length > 0) {
        const id = queue.shift();
        if (visited.has(id)) continue;
        visited.add(id);
        const comp = AppState.components.get(id);
        if (!comp) continue;
        if (comp.type === 'bus') {
          // Direct bus-to-bus connection (possibly through CBs/switches)
          const key = [bus.id, comp.id].sort().join('-link-');
          if (!foundBranches.has(key)) {
            foundBranches.add(key);
            graph.branches.push({
              from: bus,
              to: comp,
              fromPort: 'link',
              toPort: 'link',
              element: null, // zero-impedance solid link
            });
          }
        } else if (isTransparentClosed(comp)) {
          for (const { id: nid } of (adj.get(id) || [])) {
            if (!visited.has(nid)) queue.push(nid);
          }
        }
        // Don't walk through transformers, cables, sources, loads
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
      const ports = this.getEffectivePorts(comp);
      if (ports.length === 0) continue;
      let hasAnyConnection = false;
      if (comp.type === 'bus') {
        // Free-position 'at_<x>' attachments don't match generated port ids
        for (const wire of AppState.wires.values()) {
          if (wire.fromComponent === comp.id || wire.toComponent === comp.id) {
            hasAnyConnection = true;
            break;
          }
        }
      } else {
        for (const port of ports) {
          if (this.isPortConnected(comp.id, port.id)) {
            hasAnyConnection = true;
            break;
          }
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

    // 3. Check for swing bus (load flow only — the backend auto-promotes a
    // utility-connected bus, and fault-only studies don't need one)
    const swingBus = buses.find(b => b.props.bus_type === 'Swing');
    if (!swingBus) {
      warnings.push({ type: 'warning', msg: 'No Swing bus defined. Load flow will auto-select a slack bus; set one bus to "Swing" for deterministic results.', compId: null });
    }

    // 4. Check each bus has at least one source path
    //    Use full wire-graph BFS from every source, walking through all
    //    element types (transparent, cables, transformers, buses) to find
    //    every reachable bus — not limited to pre-built branches.
    const graph = this.buildNetworkGraph();

    // Build simple adjacency (component id -> [neighbor ids]) for reachability
    const reachAdj = new Map();
    for (const wire of AppState.wires.values()) {
      if (!reachAdj.has(wire.fromComponent)) reachAdj.set(wire.fromComponent, []);
      if (!reachAdj.has(wire.toComponent)) reachAdj.set(wire.toComponent, []);
      reachAdj.get(wire.fromComponent).push(wire.toComponent);
      reachAdj.get(wire.toComponent).push(wire.fromComponent);
    }

    // BFS from all sources through the full wire graph
    const busesWithSource = new Set();
    const SOURCE_TYPES_FOR_REACH = new Set(['utility', 'generator', 'solar_pv', 'wind_turbine']);
    const sourceIds = [...AppState.components.values()]
      .filter(c => SOURCE_TYPES_FOR_REACH.has(c.type))
      .map(c => c.id);

    const reachVisited = new Set();
    const reachQueue = [...sourceIds];
    for (const id of reachQueue) reachVisited.add(id);

    while (reachQueue.length > 0) {
      const id = reachQueue.shift();
      const comp = AppState.components.get(id);
      if (!comp) continue;
      if (comp.type === 'bus') busesWithSource.add(id);

      // Walk through everything except open CBs/switches
      if (comp.type === 'cb' || comp.type === 'switch') {
        if (comp.props.state === 'open') continue; // open device blocks path
      }

      for (const nid of (reachAdj.get(id) || [])) {
        if (!reachVisited.has(nid)) {
          reachVisited.add(nid);
          reachQueue.push(nid);
        }
      }
    }

    for (const bus of buses) {
      if (!busesWithSource.has(bus.id)) {
        // Not an error: load flow reports sourceless islands as de-energized
        // (0 V) instead of failing, so the user can study switching states.
        warnings.push({
          type: 'warning',
          msg: `${bus.props.name || 'Bus'} has no closed path to any source ` +
            '(utility, generator, solar or wind) — it will be reported de-energized (0 V).',
          compId: bus.id,
        });
      }
    }

    // 4b. Loads/sources behind a terminal cable/transformer (no intervening
    // bus) never enter the analysis graph — warn so they aren't silently
    // dropped (e.g. Bus → Cable → Motor with no bus at the motor end).
    {
      const LOAD_TYPES = ['static_load', 'motor_induction', 'motor_synchronous', 'capacitor_bank'];
      const SOURCE_TYPES = ['utility', 'generator', 'solar_pv', 'wind_turbine'];
      const TRANSPARENT_TYPES = new Set(['cb', 'switch', 'fuse', 'ct', 'pt', 'surge_arrester', 'offpage_connector']);
      const includedIds = new Set([
        ...graph.loads.map(l => l.load.id),
        ...graph.sources.map(s => s.source.id),
      ]);
      for (const comp of AppState.components.values()) {
        if (!LOAD_TYPES.includes(comp.type) && !SOURCE_TYPES.includes(comp.type)) continue;
        if (includedIds.has(comp.id)) continue;
        // Walk from the dropped load/source through transparent elements to
        // find the cable/transformer it hangs off
        const visited = new Set([comp.id]);
        const queue = [...(reachAdj.get(comp.id) || [])];
        let blocker = null;
        while (queue.length > 0) {
          const id = queue.shift();
          if (visited.has(id)) continue;
          visited.add(id);
          const c = AppState.components.get(id);
          if (!c) continue;
          if (c.type === 'cable' || c.type === 'transformer') { blocker = c; break; }
          if (TRANSPARENT_TYPES.has(c.type)) {
            for (const nid of (reachAdj.get(id) || [])) {
              if (!visited.has(nid)) queue.push(nid);
            }
          }
        }
        if (blocker) {
          warnings.push({
            type: 'warning',
            msg: `${comp.props.name || comp.type} connects through ${blocker.props.name || blocker.type} without an intervening bus — it will be excluded from analysis; insert a bus node between them.`,
            compId: comp.id,
          });
        }
      }
    }

    // 5. Voltage consistency: transformer secondary should match downstream bus voltage
    for (const branch of graph.branches) {
      if (!branch.element || branch.element.type !== 'transformer') continue;
      const xfmr = branch.element;
      const isStepUp = xfmr.props.winding_config === 'step_up';
      // Determine which bus is HV and which is LV based on port and winding config
      // Step-down (default): primary (top) = HV, secondary (bottom) = LV
      // Step-up: primary (top) = LV, secondary (bottom) = HV
      let primaryBus, secondaryBus;
      if (branch.fromPort === 'primary') {
        primaryBus = branch.from;
        secondaryBus = branch.to;
      } else if (branch.fromPort === 'secondary') {
        primaryBus = branch.to;
        secondaryBus = branch.from;
      } else if (branch.toPort === 'primary') {
        primaryBus = branch.to;
        secondaryBus = branch.from;
      } else {
        primaryBus = branch.from;
        secondaryBus = branch.to;
      }
      let hvBus, lvBus;
      if (isStepUp) {
        hvBus = secondaryBus;
        lvBus = primaryBus;
      } else {
        hvBus = primaryBus;
        lvBus = secondaryBus;
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
      if (!branch.element || branch.element.type !== 'cable') continue;
      const cable = branch.element;
      const v1 = branch.from.props.voltage_kv;
      const v2 = branch.to.props.voltage_kv;
      if (v1 && v2 && Math.abs(v1 - v2) / Math.max(v1, v2) > 0.01) {
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

    // 6b. Check generator and utility source voltages match their connected bus
    for (const { bus, source } of graph.sources) {
      const busV = bus.props.voltage_kv;
      const srcV = source.props.voltage_kv;
      if (busV && srcV) {
        const tolerance = 0.15;
        if (Math.abs(busV - srcV) / srcV > tolerance) {
          const typeName = source.type === 'utility' ? 'Utility source' : 'Generator';
          warnings.push({
            type: 'warning',
            msg: `${source.props.name} voltage (${srcV} kV) doesn't match ${bus.props.name} voltage (${busV} kV).`,
            compId: source.id,
          });
        }
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
        if (p.x_r_ratio !== undefined && p.x_r_ratio <= 0) {
          errors.push({ type: 'error', msg: `${name}: X/R ratio must be greater than zero.`, compId: comp.id });
        }
      }
      if (comp.type === 'generator') {
        if (!p.rated_mva || p.rated_mva <= 0) {
          errors.push({ type: 'error', msg: `${name}: Rating (MVA) must be greater than zero.`, compId: comp.id });
        }
        if (p.xd_pp !== undefined && p.xd_pp <= 0) {
          errors.push({ type: 'error', msg: `${name}: Xd'' (sub-transient reactance) must be greater than zero.`, compId: comp.id });
        }
      }
      if (comp.type === 'cable') {
        if (!p.length_km || p.length_km <= 0) {
          warnings.push({ type: 'warning', msg: `${name}: Cable length is zero or not set.`, compId: comp.id });
        }
        if ((p.r_per_km || 0) <= 0 && (p.x_per_km || 0) <= 0) {
          errors.push({ type: 'error', msg: `${name}: Cable impedance is zero or negative (R₁ and X₁ both ≤ 0).`, compId: comp.id });
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
      if (!branch.element || branch.element.type !== 'transformer') continue;
      const xfmr = branch.element;
      const isStepUp8 = xfmr.props.winding_config === 'step_up';
      // For step-down: secondary (bottom) is LV side, check downstream matches LV voltage
      // For step-up: secondary (bottom) is HV side, check downstream matches HV voltage
      let downstreamBus;
      if (branch.fromPort === 'secondary') {
        downstreamBus = branch.from;
      } else if (branch.toPort === 'secondary') {
        downstreamBus = branch.to;
      } else {
        // Fallback: use the bus with lower voltage
        downstreamBus = (branch.from.props.voltage_kv || 0) <= (branch.to.props.voltage_kv || 0) ? branch.from : branch.to;
      }

      const expectedV = isStepUp8 ? xfmr.props.voltage_hv_kv : xfmr.props.voltage_lv_kv;
      if (!expectedV || !downstreamBus) continue;

      // BFS downstream from the secondary-side bus through non-transformer branches
      const visited = new Set([downstreamBus.id]);
      const queue = [downstreamBus.id];
      while (queue.length > 0) {
        const busId = queue.shift();
        for (const br of graph.branches) {
          if (br.element && br.element.type === 'transformer') continue; // don't cross transformers
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
