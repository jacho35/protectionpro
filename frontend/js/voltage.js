// voltage.js — Automatic voltage propagation across connected components
// When components are wired together or bus voltages change, this module
// propagates the correct voltage level through each "voltage zone" (a set of
// components at the same voltage, bounded by transformers).

const VoltagePropagation = {

  // Maps component type → property key that stores its voltage (in kV).
  // Transformer and multi-voltage types are handled separately.
  VOLTAGE_KEYS: {
    bus:               'voltage_kv',
    utility:           'voltage_kv',
    generator:         'voltage_kv',
    solar_pv:          'voltage_kv',
    wind_turbine:      'voltage_kv',
    cable:             'voltage_kv',
    motor_induction:   'voltage_kv',
    motor_synchronous: 'voltage_kv',
    static_load:       'voltage_kv',
    capacitor_bank:    'voltage_kv',
    relay:             'voltage_kv',
    cb:                'rated_voltage_kv',
    fuse:              'rated_voltage_kv',
    switch:            'rated_voltage_kv',
    surge_arrester:    'rated_voltage_kv',
    // DC system AC-side voltages
    ups:               'voltage_in_kv',
    rectifier:         'voltage_ac_kv',
    charger:           'voltage_ac_kv',
  },

  // Types that don't define their own voltage — BFS walks through them
  // but they have no voltage property to update.
  NO_VOLTAGE: new Set(['ct', 'pt', 'offpage_connector']),

  // ─── Helpers ────────────────────────────────────────────────────────

  /** Get the voltage property key for a component type, or null */
  getVoltageKey(type) {
    return this.VOLTAGE_KEYS[type] || null;
  },

  /** Get the current voltage value for a component */
  getVoltage(comp) {
    if (comp.type === 'transformer') return null; // handled separately
    const key = this.getVoltageKey(comp.type);
    return key ? comp.props[key] : null;
  },

  /** Get the default voltage for a component type from COMPONENT_DEFS */
  getDefaultVoltage(type) {
    if (type === 'transformer') return null;
    const key = this.getVoltageKey(type);
    if (!key) return null;
    const def = COMPONENT_DEFS[type];
    return def && def.defaults ? def.defaults[key] : null;
  },

  /** Check whether a component's voltage is still at its default */
  isDefaultVoltage(comp) {
    const v = this.getVoltage(comp);
    if (v === null) return true;
    return v === this.getDefaultVoltage(comp.type);
  },

  /**
   * Determine which transformer voltage field a given port corresponds to.
   * Returns { thisKey, otherKey, otherPortSide } or null.
   *   thisKey   — the voltage field facing the given port ('voltage_hv_kv' or 'voltage_lv_kv')
   *   otherKey  — the voltage field on the opposite winding
   *   otherPortSide — 'primary' or 'secondary' (the opposite port id)
   */
  getTransformerSide(xfmr, portId) {
    const isStepDown = (xfmr.props.winding_config || 'step_down') === 'step_down';
    // primary port (top) faces HV in step_down, LV in step_up
    const isPrimary = portId === 'primary' || (portId && portId.startsWith('top'));
    if (isStepDown) {
      if (isPrimary) return { thisKey: 'voltage_hv_kv', otherKey: 'voltage_lv_kv', otherPortSide: 'secondary' };
      else           return { thisKey: 'voltage_lv_kv', otherKey: 'voltage_hv_kv', otherPortSide: 'primary' };
    } else {
      if (isPrimary) return { thisKey: 'voltage_lv_kv', otherKey: 'voltage_hv_kv', otherPortSide: 'secondary' };
      else           return { thisKey: 'voltage_hv_kv', otherKey: 'voltage_lv_kv', otherPortSide: 'primary' };
    }
  },

  // ─── Zone Building ──────────────────────────────────────────────────

  /**
   * BFS from startCompId, collecting all component IDs in the same voltage
   * zone. Stops at transformers (records them as boundary transformers).
   *
   * Returns {
   *   componentIds: Set<string>,           // all components in the zone
   *   boundaryTransformers: Map<string, string>  // xfmrId → portId facing this zone
   * }
   */
  buildVoltageZone(startCompId) {
    const componentIds = new Set();
    const boundaryTransformers = new Map();
    const visited = new Set();
    const queue = [startCompId];
    visited.add(startCompId);

    const startComp = AppState.components.get(startCompId);
    if (!startComp) return { componentIds, boundaryTransformers };

    // Don't start from a transformer — callers should start from the
    // component on one side of the transformer.
    if (startComp.type === 'transformer') {
      return { componentIds, boundaryTransformers };
    }

    componentIds.add(startCompId);

    while (queue.length > 0) {
      const compId = queue.shift();
      const neighbors = Components.getConnectedComponents(compId);

      for (const n of neighbors) {
        if (visited.has(n.componentId)) continue;
        visited.add(n.componentId);

        const nComp = AppState.components.get(n.componentId);
        if (!nComp) continue;

        if (nComp.type === 'transformer') {
          // Record which port of the transformer faces this zone
          boundaryTransformers.set(n.componentId, n.port);
          continue; // don't cross the transformer
        }

        componentIds.add(n.componentId);
        queue.push(n.componentId);
      }
    }

    return { componentIds, boundaryTransformers };
  },

  // ─── Voltage Resolution ─────────────────────────────────────────────

  /**
   * Find the authoritative voltage for a zone. Priority:
   *  1. Non-default bus voltage
   *  2. Non-default source (utility/generator) voltage
   *  3. Non-default other component voltage
   *  4. null (everything is at defaults — no propagation)
   */
  resolveZoneVoltage(componentIds) {
    let busVoltage = null;
    let sourceVoltage = null;
    let otherVoltage = null;

    for (const id of componentIds) {
      const comp = AppState.components.get(id);
      if (!comp) continue;
      if (this.isDefaultVoltage(comp)) continue;

      const v = this.getVoltage(comp);
      if (v === null) continue;

      if (comp.type === 'bus') {
        busVoltage = v;
      } else if (comp.type === 'utility' || comp.type === 'generator') {
        if (sourceVoltage === null) sourceVoltage = v;
      } else {
        if (otherVoltage === null) otherVoltage = v;
      }
    }

    return busVoltage ?? sourceVoltage ?? otherVoltage ?? null;
  },

  // ─── Apply Voltage ──────────────────────────────────────────────────

  /** Set the voltage on every component in a zone */
  applyVoltageToZone(componentIds, voltage) {
    if (voltage === null || voltage === undefined) return;
    for (const id of componentIds) {
      const comp = AppState.components.get(id);
      if (!comp) continue;
      const key = this.getVoltageKey(comp.type);
      if (key) {
        comp.props[key] = voltage;
      }
      // For UPS, also set output voltage to match input
      if (comp.type === 'ups') {
        comp.props.voltage_out_kv = voltage;
      }
    }
  },

  // ─── Main Entry Points ─────────────────────────────────────────────

  /**
   * Called after a new wire is created. Propagates voltage across the
   * zone that the wire joins, and recursively across transformer boundaries.
   */
  propagateFromWire(wireId) {
    const wire = AppState.wires.get(wireId);
    if (!wire) return;

    const compA = AppState.components.get(wire.fromComponent);
    const compB = AppState.components.get(wire.toComponent);
    if (!compA || !compB) return;

    // If one side is a transformer, start the zone from the other side
    // so the BFS correctly stops at the transformer boundary.
    const processedTransformers = new Set();

    if (compA.type === 'transformer' && compB.type === 'transformer') {
      // Two transformers connected directly — unusual, skip propagation
      return;
    }

    if (compA.type === 'transformer') {
      this._propagateZone(wire.toComponent, processedTransformers);
    } else if (compB.type === 'transformer') {
      this._propagateZone(wire.fromComponent, processedTransformers);
    } else {
      // Both are non-transformer — just propagate the combined zone
      this._propagateZone(wire.fromComponent, processedTransformers);
    }
  },

  /**
   * Internal: propagate voltage within a zone starting from startCompId,
   * then handle transformer cross-zone propagation.
   */
  _propagateZone(startCompId, processedTransformers) {
    const zone = this.buildVoltageZone(startCompId);
    const voltage = this.resolveZoneVoltage(zone.componentIds);

    if (voltage !== null) {
      this.applyVoltageToZone(zone.componentIds, voltage);
    }

    // Handle transformer cross-zone propagation
    for (const [xfmrId, facingPort] of zone.boundaryTransformers) {
      if (processedTransformers.has(xfmrId)) continue;
      processedTransformers.add(xfmrId);

      const xfmr = AppState.components.get(xfmrId);
      if (!xfmr) continue;

      const side = this.getTransformerSide(xfmr, facingPort);
      if (!side) continue;

      // Set the transformer winding voltage facing this zone
      if (voltage !== null) {
        xfmr.props[side.thisKey] = voltage;
      }

      // Get the other winding's voltage and propagate into the other zone
      const otherVoltage = xfmr.props[side.otherKey];

      // Find a component on the other side of the transformer
      const otherSideNeighbors = Components.getConnectedComponents(xfmrId);
      for (const n of otherSideNeighbors) {
        // Only follow connections on the other port side
        if (n.port !== facingPort) continue; // n.port is the port on the neighbor; skip
        // Actually, n.localPort is the transformer's port that this neighbor connects to
      }

      // Walk the transformer's connections to find which ones are on the other side
      for (const n of otherSideNeighbors) {
        const nComp = AppState.components.get(n.componentId);
        if (!nComp || nComp.type === 'transformer') continue;

        // n.localPort is the port on the transformer this neighbor connects to
        // We want neighbors on the OTHER side of the transformer
        const nSide = this.getTransformerSide(xfmr, n.localPort);
        if (!nSide || nSide.thisKey === side.thisKey) continue; // same side, skip

        // This neighbor is on the other side — propagate the other voltage
        const otherZone = this.buildVoltageZone(n.componentId);
        if (otherVoltage !== null) {
          this.applyVoltageToZone(otherZone.componentIds, otherVoltage);
        }

        // Recurse for chained transformers
        for (const [chainXfmrId, chainPort] of otherZone.boundaryTransformers) {
          if (!processedTransformers.has(chainXfmrId)) {
            processedTransformers.add(chainXfmrId);
            const chainXfmr = AppState.components.get(chainXfmrId);
            if (!chainXfmr) continue;
            const chainSide = this.getTransformerSide(chainXfmr, chainPort);
            if (!chainSide) continue;
            if (otherVoltage !== null) {
              chainXfmr.props[chainSide.thisKey] = otherVoltage;
            }
            // Find other-side neighbors and propagate
            const chainNeighbors = Components.getConnectedComponents(chainXfmrId);
            for (const cn of chainNeighbors) {
              const cnComp = AppState.components.get(cn.componentId);
              if (!cnComp || cnComp.type === 'transformer') continue;
              const cnSide = this.getTransformerSide(chainXfmr, cn.localPort);
              if (!cnSide || cnSide.thisKey === chainSide.thisKey) continue;
              this._propagateZone(cn.componentId, processedTransformers);
            }
          }
        }
      }
    }
  },

  /**
   * Called when a bus voltage is manually changed in the properties panel.
   * Shows a confirmation dialog before applying to all connected components.
   *
   * @param {string} busId - The bus component ID
   * @param {number} newVoltage - The new voltage value
   * @param {Function} onDone - Callback after propagation is applied (or cancelled)
   */
  propagateFromBusChange(busId, newVoltage, onDone) {
    const bus = AppState.components.get(busId);
    if (!bus) { if (onDone) onDone(); return; }

    const zone = this.buildVoltageZone(busId);
    // Remove the bus itself to count only affected components
    const affectedIds = new Set(zone.componentIds);
    affectedIds.delete(busId);

    // Also count transformer boundary components
    const processedTransformers = new Set();
    const xfmrAffected = [];
    for (const [xfmrId] of zone.boundaryTransformers) {
      const xfmr = AppState.components.get(xfmrId);
      if (xfmr) xfmrAffected.push(xfmr);
    }

    const totalAffected = affectedIds.size + xfmrAffected.length;

    if (totalAffected === 0) {
      // No connected components — just apply directly
      if (onDone) onDone();
      return;
    }

    // Build list of affected component names for the dialog
    const names = [];
    for (const id of affectedIds) {
      const comp = AppState.components.get(id);
      if (comp) names.push(comp.props.name || `${comp.type}-${comp.id}`);
    }
    for (const xfmr of xfmrAffected) {
      names.push((xfmr.props.name || `${xfmr.type}-${xfmr.id}`) + ' (winding)');
    }

    this._showConfirmDialog(
      bus.props.name || busId,
      newVoltage,
      names,
      () => {
        // Apply: propagate through the zone
        this.applyVoltageToZone(zone.componentIds, newVoltage);

        // Handle transformer boundaries
        for (const [xfmrId, facingPort] of zone.boundaryTransformers) {
          if (processedTransformers.has(xfmrId)) continue;
          processedTransformers.add(xfmrId);

          const xfmr = AppState.components.get(xfmrId);
          if (!xfmr) continue;
          const side = this.getTransformerSide(xfmr, facingPort);
          if (!side) continue;
          xfmr.props[side.thisKey] = newVoltage;

          // Propagate other side
          const otherVoltage = xfmr.props[side.otherKey];
          const otherNeighbors = Components.getConnectedComponents(xfmrId);
          for (const n of otherNeighbors) {
            const nComp = AppState.components.get(n.componentId);
            if (!nComp || nComp.type === 'transformer') continue;
            const nSide = this.getTransformerSide(xfmr, n.localPort);
            if (!nSide || nSide.thisKey === side.thisKey) continue;
            const otherZone = this.buildVoltageZone(n.componentId);
            if (otherVoltage !== null) {
              this.applyVoltageToZone(otherZone.componentIds, otherVoltage);
            }
          }
        }

        AppState.dirty = true;
        if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
        Canvas.render();

        // Re-render properties panel if it's showing a component that was updated
        if (typeof Properties !== 'undefined' && Properties.currentCompId) {
          Properties.show(Properties.currentCompId);
        }

        if (onDone) onDone();
      },
      () => {
        // Cancel — no propagation
        if (onDone) onDone();
      }
    );
  },

  /**
   * Called when a transformer voltage is manually changed in the properties panel.
   * Propagates the changed winding voltage into the connected zone on that side,
   * and the other winding voltage into the zone on the other side.
   */
  propagateFromTransformerChange(xfmrId, changedField) {
    const xfmr = AppState.components.get(xfmrId);
    if (!xfmr) return;

    const processedTransformers = new Set([xfmrId]);

    // Determine which side changed
    const isHV = changedField === 'voltage_hv_kv';
    const changedVoltage = xfmr.props[changedField];
    const otherField = isHV ? 'voltage_lv_kv' : 'voltage_hv_kv';
    const otherVoltage = xfmr.props[otherField];

    const neighbors = Components.getConnectedComponents(xfmrId);

    for (const n of neighbors) {
      const nComp = AppState.components.get(n.componentId);
      if (!nComp || nComp.type === 'transformer') continue;

      const side = this.getTransformerSide(xfmr, n.localPort);
      if (!side) continue;

      const voltage = (side.thisKey === changedField) ? changedVoltage : otherVoltage;
      if (voltage === null || voltage === undefined) continue;

      const zone = this.buildVoltageZone(n.componentId);
      this.applyVoltageToZone(zone.componentIds, voltage);

      // Handle chained transformers in this zone
      for (const [chainXfmrId, chainPort] of zone.boundaryTransformers) {
        if (processedTransformers.has(chainXfmrId)) continue;
        processedTransformers.add(chainXfmrId);
        this._propagateZone(n.componentId, processedTransformers);
      }
    }
  },

  // ─── Confirmation Dialog ────────────────────────────────────────────

  _showConfirmDialog(busName, newVoltage, affectedNames, onConfirm, onCancel) {
    // Remove existing dialog if present
    const existing = document.getElementById('voltage-propagation-dialog');
    if (existing) existing.remove();

    const truncated = affectedNames.length > 8;
    const displayNames = truncated ? affectedNames.slice(0, 8) : affectedNames;

    const overlay = document.createElement('div');
    overlay.id = 'voltage-propagation-dialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:var(--bg-primary,#fff);color:var(--text-primary,#222);border-radius:8px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:inherit;';

    dialog.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:16px;">Update Connected Components?</h3>
      <p style="margin:0 0 12px;font-size:14px;opacity:0.8;">
        Changing <strong>${busName}</strong> to <strong>${newVoltage} kV</strong>
        will also update <strong>${affectedNames.length}</strong> connected component${affectedNames.length > 1 ? 's' : ''}:
      </p>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:13px;max-height:160px;overflow-y:auto;">
        ${displayNames.map(n => `<li>${n}</li>`).join('')}
        ${truncated ? `<li style="opacity:0.6;">...and ${affectedNames.length - 8} more</li>` : ''}
      </ul>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="voltage-dialog-cancel" style="padding:6px 16px;border:1px solid var(--border-color,#ccc);background:transparent;border-radius:4px;cursor:pointer;color:inherit;">Cancel</button>
        <button id="voltage-dialog-apply" style="padding:6px 16px;border:none;background:var(--accent-color,#2563eb);color:#fff;border-radius:4px;cursor:pointer;">Apply</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const cleanup = () => overlay.remove();

    document.getElementById('voltage-dialog-apply').addEventListener('click', () => {
      cleanup();
      onConfirm();
    });

    document.getElementById('voltage-dialog-cancel').addEventListener('click', () => {
      cleanup();
      onCancel();
    });

    // Close on overlay click (outside dialog)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        onCancel();
      }
    });
  },
};
