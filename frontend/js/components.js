/* ProtectionPro — Component Helpers */

const Components = {
  // Get all buses from the network
  getBuses() {
    return [...AppState.components.values()].filter(c => c.type === 'bus');
  },

  // Get all components connected to a bus via wires
  getConnectedComponents(busId) {
    const connected = [];
    for (const wire of AppState.wires.values()) {
      if (wire.fromComponent === busId) {
        connected.push({ wire, componentId: wire.toComponent, port: wire.toPort });
      }
      if (wire.toComponent === busId) {
        connected.push({ wire, componentId: wire.fromComponent, port: wire.fromPort });
      }
    }
    return connected;
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
        const connections = this.getConnectedComponents(comp.id);
        // Find which buses this branch connects
        const connectedBuses = [];
        for (const wire of AppState.wires.values()) {
          if (wire.fromComponent === comp.id || wire.toComponent === comp.id) {
            const otherId = wire.fromComponent === comp.id ? wire.toComponent : wire.fromComponent;
            const other = AppState.components.get(otherId);
            if (other && other.type === 'bus') {
              connectedBuses.push(other);
            }
          }
        }
        if (connectedBuses.length >= 2) {
          graph.branches.push({
            from: connectedBuses[0],
            to: connectedBuses[1],
            element: comp,
          });
        }
      }
    }

    return graph;
  },

  // Validate network before analysis
  validate() {
    const errors = [];
    const buses = this.getBuses();

    if (buses.length === 0) {
      errors.push('No buses found in the network. Add at least one bus.');
    }

    // Check for isolated components
    for (const comp of AppState.components.values()) {
      if (comp.type === 'bus') continue;
      if (comp.type === 'relay') continue; // Relays don't need connections
      let hasConnection = false;
      for (const wire of AppState.wires.values()) {
        if (wire.fromComponent === comp.id || wire.toComponent === comp.id) {
          hasConnection = true;
          break;
        }
      }
      if (!hasConnection) {
        errors.push(`${comp.props.name || comp.type} (${comp.id}) is not connected.`);
      }
    }

    // Check for swing bus
    const swingBus = buses.find(b => b.props.bus_type === 'Swing');
    if (buses.length > 0 && !swingBus) {
      errors.push('No Swing bus defined. At least one bus must be set as Swing for load flow.');
    }

    return errors;
  },
};
