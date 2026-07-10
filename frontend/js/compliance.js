/* ProtectionPro — Compliance Report Engine
 *
 * Generates an IEC 60909 / IEC 60364 compliance report by cross-checking
 * analysis results against equipment ratings and standards limits.
 *
 * Sections:
 *   1. Network Validation
 *   2. Fault Duty Assessment (IEC 60909)
 *   3. Voltage Compliance (IEC 60038)
 *   4. Thermal Loading (IEC 60364)
 *   5. Cable Short-Circuit Withstand (IEC 60364-4-43)
 *   6. Protection Device Ratings (IEC 62271 / IEC 60947)
 *   7. SANS 10142 — Wiring of Premises
 *   8. Equipment Summary
 */

const Compliance = {

  // Run all checks and return structured report data
  generate() {
    this._adj = null; // rebuild the wire adjacency index for this run
    const report = {
      projectName: AppState.projectName || 'Untitled Project',
      baseMVA: AppState.baseMVA,
      frequency: AppState.frequency,
      timestamp: new Date().toISOString(),
      hasFault: !!(AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0),
      hasLoadFlow: !!(AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0),
      sections: [],
      totals: { pass: 0, fail: 0, warn: 0, info: 0 },
    };

    report.sections.push(this._checkNetworkValidation());
    report.sections.push(this._checkFaultDuty());
    report.sections.push(this._checkVoltageCompliance());
    report.sections.push(this._checkThermalLoading());
    report.sections.push(this._checkCableWithstand());
    report.sections.push(this._checkProtectionDevices());
    report.sections.push(this._checkSANS10142());
    report.sections.push(this._checkPVStrings());
    report.sections.push(this._buildEquipmentSummary());

    // Tally totals
    for (const section of report.sections) {
      for (const item of section.items) {
        report.totals[item.status]++;
      }
    }

    return report;
  },

  // ── 1. Network Validation ──
  _checkNetworkValidation() {
    const section = { title: 'Network Validation', standard: 'General', items: [] };
    const { errors, warnings } = Components.validate();

    for (const e of errors) {
      section.items.push({ status: 'fail', component: e.id || '—', message: e.msg, detail: 'Must be resolved before analysis.' });
    }
    for (const w of warnings) {
      section.items.push({ status: 'warn', component: w.id || '—', message: w.msg, detail: 'May affect results accuracy.' });
    }

    if (errors.length === 0 && warnings.length === 0) {
      section.items.push({ status: 'pass', component: '—', message: 'Network topology is valid.', detail: 'All components connected, sources and buses present.' });
    }

    // Check swing bus
    let hasSwing = false;
    for (const comp of AppState.components.values()) {
      if (comp.type === 'bus' && comp.props?.bus_type === 'Swing') hasSwing = true;
    }
    if (!hasSwing) {
      section.items.push({ status: 'warn', component: '—', message: 'No Swing (slack) bus defined.', detail: 'Load flow requires a Swing bus as voltage reference. One bus will be assumed.' });
    }

    return section;
  },

  // ── 2. Fault Duty Assessment (IEC 60909) ──
  _checkFaultDuty() {
    const section = { title: 'Fault Duty Assessment', standard: 'IEC 60909', items: [] };

    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Fault analysis not run.', detail: 'Run Fault Analysis to check equipment duty ratings.' });
      return section;
    }

    const faultBuses = AppState.faultResults.buses;

    // For each bus, find connected CBs, fuses, and check breaking capacity
    for (const [busId, faultResult] of Object.entries(faultBuses)) {
      const busComp = AppState.components.get(busId);
      const busName = busComp?.props?.name || busId;
      const ik3 = faultResult.ik3;
      if (ik3 == null) continue;

      // Breaking duty: compare the symmetrical breaking current Ib when the
      // engine provides it (IEC 60909 §9); fall back to I"k3 (conservative)
      const ibKA = faultResult.ib != null ? faultResult.ib : ik3;
      const ibLabel = faultResult.ib != null ? 'Ib' : 'I"k3';
      const ipKA = faultResult.ip; // Peak (making) current

      // Find protection devices connected to this bus (walk through wires)
      const connectedDevices = this._findConnectedDevices(busId, ['cb', 'fuse']);

      for (const dev of connectedDevices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        const breakingKA = devComp.props?.breaking_capacity_ka;

        if (breakingKA == null || breakingKA <= 0) {
          section.items.push({
            status: 'warn',
            component: devName,
            message: `No breaking capacity specified for ${devComp.type === 'cb' ? 'circuit breaker' : 'fuse'}.`,
            detail: `Cannot verify fault duty at bus ${busName}.`,
          });
          continue;
        }

        if (ibKA > breakingKA) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Breaking duty ${ibLabel} (${ibKA.toFixed(2)} kA) EXCEEDS breaking capacity (${breakingKA} kA).`,
            detail: `At bus ${busName}. ${devComp.type === 'cb' ? 'Circuit breaker' : 'Fuse'} is under-rated for the prospective fault level. Replace with higher rated device.`,
          });
        } else {
          const margin = ((breakingKA / ibKA) - 1) * 100;
          if (margin < 10) {
            section.items.push({
              status: 'warn',
              component: devName,
              message: `Breaking duty ${ibLabel} (${ibKA.toFixed(2)} kA) within capacity (${breakingKA} kA) but margin is only ${margin.toFixed(1)}%.`,
              detail: `At bus ${busName}. Margin below 10% — network growth or data uncertainty could exceed the rating. Consider a higher rated device.`,
            });
          } else {
            section.items.push({
              status: 'pass',
              component: devName,
              message: `Breaking duty ${ibLabel} (${ibKA.toFixed(2)} kA) within breaking capacity (${breakingKA} kA).`,
              detail: `At bus ${busName}. Margin: ${margin.toFixed(1)}%.`,
            });
          }
        }

        // Making (peak) duty: ip vs making capacity. When no explicit making
        // rating is given, derive it the same way as the backend duty check:
        // MV (>1 kV) uses the IEC 62271-100 rated making factor — 2.5× breaking
        // at 50 Hz, 2.6× at 60 Hz; LV uses the IEC 60947-2 Table 2 ratio
        // n = Icm/Icu stepped by Icu.
        if (ipKA != null) {
          const explicitMaking = devComp.props?.making_capacity_ka;
          const devVkv = faultResult.voltage_kv || busComp?.props?.voltage_kv || 11;
          let makingFactor, factorLabel;
          if (devVkv > 1.0) {
            const freq = Number(AppState.frequency) || 50;
            makingFactor = freq === 60 ? 2.6 : 2.5;
            factorLabel = `${makingFactor}× breaking, IEC 62271-100 at ${freq} Hz`;
          } else {
            const icu = breakingKA;
            makingFactor = icu <= 6 ? 1.5 : icu <= 10 ? 1.7 : icu <= 20 ? 2.0 : icu <= 50 ? 2.1 : 2.2;
            factorLabel = `${makingFactor}× breaking, IEC 60947-2`;
          }
          const makingKA = explicitMaking || breakingKA * makingFactor;
          const makingSrc = explicitMaking ? `${makingKA} kA rated` : `${makingKA.toFixed(1)} kA assumed (${factorLabel})`;
          if (ipKA > makingKA) {
            section.items.push({
              status: 'fail',
              component: devName,
              message: `Peak fault current ip (${ipKA.toFixed(2)} kA) EXCEEDS making capacity (${makingSrc}).`,
              detail: `At bus ${busName}. Device may fail on closing onto a fault. Verify the manufacturer's making/peak withstand rating.`,
            });
          } else {
            section.items.push({
              status: 'pass',
              component: devName,
              message: `Peak fault current ip (${ipKA.toFixed(2)} kA) within making capacity (${makingSrc}).`,
              detail: `At bus ${busName}.`,
            });
          }
        }
      }

      // Check if bus has NO protection devices
      if (connectedDevices.length === 0) {
        section.items.push({
          status: 'warn',
          component: busName,
          message: `No circuit breaker or fuse connected to bus.`,
          detail: `I"k3 = ${ik3.toFixed(2)} kA. Consider adding protection.`,
        });
      }
    }

    return section;
  },

  // ── 3. Voltage Compliance (IEC 60038) ──
  _checkVoltageCompliance() {
    const section = { title: 'Voltage Compliance', standard: 'IEC 60038', items: [] };

    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'Load flow not run.', detail: 'Run Load Flow to check voltage compliance.' });
      return section;
    }

    if (!AppState.loadFlowResults.converged) {
      section.items.push({ status: 'fail', component: '—', message: 'Load flow did NOT converge.', detail: 'Results may be unreliable. Check network configuration and bus types.' });
    }

    const lfBuses = AppState.loadFlowResults.buses;

    for (const [busId, lfResult] of Object.entries(lfBuses)) {
      const busComp = AppState.components.get(busId);
      const busName = busComp?.props?.name || busId;
      const nominalKV = busComp?.props?.voltage_kv || busComp?.props?.voltage;
      const vpu = lfResult.voltage_pu;

      // Voltage limits: ±10% for LV buses (≤ 1 kV, IEC 60038 utilization
      // voltage tolerance — consistent with the SANS 10142-1 / NRS 048-2
      // section); ±5% for MV/HV buses (typical planning-level norm)
      const isLV = nominalKV != null && nominalKV <= 1.0;
      const lo = isLV ? 0.90 : 0.95;
      const hi = isLV ? 1.10 : 1.05;
      const limitRef = isLV
        ? 'IEC 60038 LV utilization tolerance ±10%'
        : 'MV/HV planning-level norm ±5%';

      if (vpu < lo) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `Under-voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Below ${lo} p.u. limit (${limitRef}). Nominal: ${nominalKV || '?'} kV. Consider reactive compensation or tap adjustment.`,
        });
      } else if (vpu > hi) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `Over-voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Above ${hi} p.u. limit (${limitRef}). Nominal: ${nominalKV || '?'} kV. Check tap settings and reactive sources.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: busName,
          message: `Voltage: ${vpu.toFixed(4)} p.u. (${lfResult.voltage_kv.toFixed(2)} kV).`,
          detail: `Within ${lo}–${hi} p.u. range (${limitRef}). Nominal: ${nominalKV || '?'} kV.`,
        });
      }
    }

    return section;
  },

  // ── 4. Thermal Loading (IEC 60364) ──
  _checkThermalLoading() {
    const section = { title: 'Thermal Loading', standard: 'IEC 60364 / IEC 60076', items: [] };

    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'Load flow not run.', detail: 'Run Load Flow to check equipment loading.' });
      return section;
    }

    const branches = AppState.loadFlowResults.branches || [];

    for (const br of branches) {
      const comp = AppState.components.get(br.elementId);
      if (!comp) continue;
      const name = comp.props?.name || br.elementId;
      const loading = br.loading_pct;
      const current = br.i_amps;

      if (loading == null || loading <= 0) continue;

      if (comp.type === 'cable') {
        const ratedAmps = comp.props?.rated_amps;
        if (loading > 100) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Cable OVERLOADED: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Exceeds continuous current rating per IEC 60364-5-52. Upsize cable, reduce load, or add parallel run.`,
          });
        } else if (loading > 80) {
          section.items.push({
            status: 'warn',
            component: name,
            message: `Cable heavily loaded: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Above 80% utilisation. Limited headroom for derating factors or future load growth.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Cable loading: ${loading.toFixed(1)}% (${current.toFixed(1)} A / ${ratedAmps} A rated).`,
            detail: `Within acceptable limits.`,
          });
        }
      } else if (comp.type === 'transformer') {
        const ratedMVA = comp.props?.rated_mva || comp.props?.ratedMVA;
        if (loading > 100) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Transformer OVERLOADED: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Exceeds nameplate rating per IEC 60076. Risk of thermal damage and reduced lifespan.`,
          });
        } else if (loading > 80) {
          section.items.push({
            status: 'warn',
            component: name,
            message: `Transformer heavily loaded: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Above 80% utilisation. Consider ambient temperature derating per IEC 60076-7.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Transformer loading: ${loading.toFixed(1)}% of ${ratedMVA} MVA rating.`,
            detail: `Within acceptable limits.`,
          });
        }
      }
    }

    if (branches.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No branch flow data available.', detail: 'Ensure cables and transformers connect buses.' });
    }

    return section;
  },

  // ── 5. Cable Short-Circuit Withstand (IEC 60364-4-43 §434.5.2) ──
  // Adiabatic criterion: the protective device must clear a through-fault
  // before the conductor exceeds its final short-circuit temperature, i.e.
  // t_clear ≤ k²·S²/I², with k per IEC 60364-5-54 for the conductor material
  // and insulation, S the cross-section in mm² and I the through-fault current.
  _checkCableWithstand() {
    const section = { title: 'Cable Short-Circuit Withstand', standard: 'IEC 60364-4-43 / SANS 10142-1', items: [] };

    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Cable withstand check: fault analysis not run.', detail: 'Run Fault Analysis to verify t_clear ≤ k²S²/I² per IEC 60364-4-43 §434.5.2.' });
      return section;
    }

    const faultBuses = AppState.faultResults.buses;
    const fmtT = (t) => (t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t >= 1 ? t.toFixed(2) : t.toFixed(3));
    let anyCable = false;

    for (const [cableId, comp] of AppState.components) {
      if (comp.type !== 'cable') continue;
      anyCable = true;
      const cableName = comp.props?.name || cableId;

      // Resolve cross-section, conductor material and insulation: library
      // entry first, cable props as fallback (same resolution as the TCC
      // cable thermal damage curve)
      const stdCable = STANDARD_CABLES.find(c => c.id === (comp.props?.standard_type || ''));
      const sizeMm2 = stdCable ? stdCable.size_mm2 : (comp.props?.size_mm2 || 0);
      const conductor = stdCable ? stdCable.conductor : (comp.props?.conductor || 'Cu');
      const insulation = stdCable ? stdCable.insulation : (comp.props?.insulation || 'XLPE');

      if (!(sizeMm2 > 0)) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'Conductor cross-section unknown — short-circuit withstand not verified.',
          detail: 'Select a standard cable type (or set the conductor size) to enable the IEC 60364-4-43 §434.5.2 adiabatic check.',
        });
        continue;
      }

      // Adiabatic k factor per IEC 60364-5-54 (same values as the TCC damage
      // curve): Cu/XLPE 143, Cu/PVC 115, Al/XLPE 94, Al/PVC 76
      let kFactor = 143;
      if (conductor === 'Cu' && insulation === 'PVC') kFactor = 115;
      else if (conductor === 'Al' && insulation === 'XLPE') kFactor = 94;
      else if (conductor === 'Al' && insulation === 'PVC') kFactor = 76;

      // Through-fault current: a fault at the cable's remote (downstream) end
      // flows through the whole cable. Of the connected buses with fault
      // results, the lower-I"k3 end is the downstream end.
      const buses = this._findConnectedDevices(cableId, ['bus']);
      let faultKA = null;
      let faultBusName = null;
      for (const b of buses) {
        const fr = faultBuses[b.id];
        if (!fr || fr.ik3 == null) continue;
        if (faultKA == null || fr.ik3 < faultKA) {
          faultKA = fr.ik3;
          faultBusName = AppState.components.get(b.id)?.props?.name || b.id;
        }
      }

      if (faultKA == null) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'No fault result at a connected bus — short-circuit withstand not verified.',
          detail: `k = ${kFactor} (${conductor}/${insulation}), S = ${sizeMm2} mm². Ensure the cable's buses are included in the fault study.`,
        });
        continue;
      }

      const faultI = faultKA * 1000; // A
      const tMax = Math.pow((kFactor * sizeMm2) / faultI, 2); // k²S²/I² in seconds
      const basisStr = `k = ${kFactor} (${conductor}/${insulation}), S = ${sizeMm2} mm², I = ${faultKA.toFixed(2)} kA (I"k3 at ${faultBusName}) → withstand t = k²S²/I² = ${fmtT(tMax)} s`;

      const devices = this._findConnectedDevices(cableId, ['cb', 'fuse']);
      if (devices.length === 0) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'No protective device found for cable — clearing time cannot be evaluated.',
          detail: `${basisStr}. Add an upstream circuit breaker or fuse to enable the check.`,
        });
        continue;
      }

      for (const dev of devices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        let tClear;
        let devDesc;

        if (devComp.type === 'fuse') {
          const ratingA = devComp.props?.rated_current_a;
          if (!ratingA) {
            section.items.push({
              status: 'info',
              component: devName,
              message: `No fuse rating specified — cannot evaluate clearing time for cable ${cableName}.`,
              detail: `${basisStr}.`,
            });
            continue;
          }
          // Total clearing ≈ 1.2 × pre-arcing time (IEC 60269 practice, as in TCC grading)
          const preArc = fuseTripTime(ratingA, faultI);
          tClear = (preArc != null && isFinite(preArc)) ? preArc * 1.2 : preArc;
          devDesc = `gG fuse ${ratingA} A, total clearing (1.2× pre-arc)`;
        } else {
          const params = {
            cb_type: devComp.props?.cb_type || 'mccb',
            trip_rating_a: devComp.props?.trip_rating_a || devComp.props?.rated_current_a,
            thermal_pickup: devComp.props?.thermal_pickup || 1.0,
            magnetic_pickup: devComp.props?.magnetic_pickup || 10,
            long_time_delay: devComp.props?.long_time_delay || 10,
            short_time_pickup: devComp.props?.short_time_pickup || 0,
            short_time_delay: devComp.props?.short_time_delay || 0,
            instantaneous_pickup: devComp.props?.instantaneous_pickup || 0,
          };
          if (!params.trip_rating_a) {
            section.items.push({
              status: 'info',
              component: devName,
              message: `No trip rating specified — cannot evaluate clearing time for cable ${cableName}.`,
              detail: `${basisStr}.`,
            });
            continue;
          }
          tClear = cbTripTime(params, faultI);
          devDesc = `${(params.cb_type || 'mccb').toUpperCase()} trip unit`;
        }

        if (tClear == null || !isFinite(tClear)) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Device does NOT operate at the through-fault current — cable ${cableName} is unprotected against short circuit.`,
            detail: `${basisStr}. ${devDesc}: no trip at ${faultKA.toFixed(2)} kA, so the conductor exceeds its adiabatic limit. Lower the pickup or use a more sensitive device.`,
          });
          continue;
        }

        if (tClear > tMax) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Clearing time ${fmtT(tClear)} s EXCEEDS cable ${cableName} withstand ${fmtT(tMax)} s.`,
            detail: `${basisStr}. ${devDesc} clears in ${fmtT(tClear)} s — IEC 60364-4-43 §434.5.2 requires t_clear ≤ k²S²/I². Upsize the conductor or speed up the protection.`,
          });
        } else {
          const marginPct = (tMax / tClear - 1) * 100;
          if (marginPct < 20) {
            section.items.push({
              status: 'warn',
              component: devName,
              message: `Clearing time ${fmtT(tClear)} s within cable ${cableName} withstand ${fmtT(tMax)} s, but margin is only ${marginPct.toFixed(0)}%.`,
              detail: `${basisStr}. ${devDesc}. Curve tolerance or a higher fault level could exceed the adiabatic limit.`,
            });
          } else {
            section.items.push({
              status: 'pass',
              component: devName,
              message: `Clearing time ${fmtT(tClear)} s ≤ cable ${cableName} withstand ${fmtT(tMax)} s.`,
              detail: `${basisStr}. ${devDesc}. Complies with IEC 60364-4-43 §434.5.2.`,
            });
          }
        }
      }
    }

    if (!anyCable) {
      section.items.push({ status: 'info', component: '—', message: 'No cables in the network for short-circuit withstand check.', detail: 'IEC 60364-4-43 §434.5.2 applies to cables protected by an upstream overcurrent device.' });
    }

    return section;
  },

  // ── 6. Protection Device Checks ──
  _checkProtectionDevices() {
    const section = { title: 'Protection Device Ratings', standard: 'IEC 62271 / IEC 60947', items: [] };

    // Check CB and fuse rated voltages match bus voltage
    for (const [id, comp] of AppState.components) {
      if (comp.type !== 'cb' && comp.type !== 'fuse' && comp.type !== 'switch') continue;
      const name = comp.props?.name || id;
      const ratedV = comp.props?.rated_voltage_kv;
      if (!ratedV) continue;

      // Find the bus this device is connected to
      const buses = this._findConnectedDevices(id, ['bus']);
      for (const b of buses) {
        const busComp = AppState.components.get(b.id);
        if (!busComp) continue;
        const busV = busComp.props?.voltage_kv || busComp.props?.voltage;
        if (!busV) continue;
        const busName = busComp.props?.name || b.id;

        if (ratedV < busV) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Rated voltage (${ratedV} kV) is BELOW bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}. Device is under-rated for the system voltage.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Rated voltage (${ratedV} kV) adequate for bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}.`,
          });
          break; // One pass check per device is enough
        }
      }

      // Check rated current vs load flow current (if available)
      if (this._hasLoadFlow() && (comp.type === 'cb' || comp.type === 'fuse')) {
        const ratedI = comp.props?.rated_current_a;
        if (!ratedI) continue;

        // Find branch flow through adjacent cables/transformers
        const adjBranches = this._findAdjacentBranchCurrents(id);
        for (const ab of adjBranches) {
          if (ab.current > ratedI) {
            section.items.push({
              status: 'fail',
              component: name,
              message: `Load current (${ab.current.toFixed(1)} A) EXCEEDS rated current (${ratedI} A).`,
              detail: `Through adjacent ${ab.branchName}. Device will trip or be damaged under normal load.`,
            });
          }
        }
      }
    }

    if (section.items.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No protection devices to check.', detail: 'Add circuit breakers or fuses to the network for protection compliance checks.' });
    }

    return section;
  },

  // ── 7. SANS 10142 Wiring of Premises ──
  // ── PV DC string design (IEC 62548) ──
  // For every solar_pv in array mode: coldest string Voc vs the inverter's
  // max DC input, hottest string Vmp vs the MPPT window, and 1.25×Isc per
  // MPPT vs the input current limit. DC/AC ratio > 1.5 warns.
  _checkPVStrings() {
    const section = { title: 'PV DC String Design', standard: 'IEC 62548', items: [] };
    let any = false;
    for (const comp of AppState.components.values()) {
      if (comp.type !== 'solar_pv' || comp.props?.pv_array_mode !== 'array') continue;
      any = true;
      const p = comp.props;
      const name = p.name || comp.id;
      const pps = Math.max(1, Math.round(p.pv_panels_per_string || 1));
      const strings = Math.max(1, Math.round(p.pv_strings || 1));
      const tMin = p.site_temp_min_c ?? -5;
      const tCellMax = p.site_cell_temp_max_c ?? 70;
      const vocCold = pps * (p.pv_voc || 0) * (1 + (p.pv_beta_voc || 0) / 100 * (tMin - 25));
      const vmpHot = pps * (p.pv_vmp || 0) * (1 + (p.pv_gamma_vmp || 0) / 100 * (tCellMax - 25));
      const dcMaxV = p.dc_max_v || 1000;
      const mpptMin = p.mppt_min_v || 0;
      const mpptMax = p.mppt_max_v || dcMaxV;
      const stringsPerMppt = Math.ceil(strings / Math.max(1, Math.round(p.mppt_count || 1)));
      const iString = stringsPerMppt * (p.pv_isc || 0) * 1.25;
      const mpptMaxA = p.mppt_max_a || 0;

      section.items.push({
        status: vocCold <= dcMaxV ? 'pass' : 'fail', component: name,
        message: `String Voc at ${tMin}°C: ${vocCold.toFixed(0)} V vs ${dcMaxV} V max DC input.`,
        detail: vocCold <= dcMaxV
          ? 'IEC 62548 §7.2: maximum system voltage respected at the coldest expected temperature.'
          : 'IEC 62548 §7.2: coldest open-circuit voltage exceeds the inverter/array maximum — reduce panels per string.',
      });
      if (mpptMin > 0) {
        const inWindow = vmpHot >= mpptMin && vmpHot <= mpptMax;
        section.items.push({
          status: inWindow ? 'pass' : 'fail', component: name,
          message: `String Vmp at ${tCellMax}°C cell: ${vmpHot.toFixed(0)} V vs MPPT window ${mpptMin}–${mpptMax} V.`,
          detail: inWindow
            ? 'Operating voltage stays inside the MPPT tracking window at the hottest cell temperature.'
            : 'Hot-weather operating voltage leaves the MPPT window — the inverter cannot track peak power; adjust panels per string.',
        });
      }
      if (mpptMaxA > 0) {
        section.items.push({
          status: iString <= mpptMaxA ? 'pass' : 'fail', component: name,
          message: `String current 1.25×Isc: ${iString.toFixed(1)} A (${stringsPerMppt} string/MPPT) vs ${mpptMaxA} A limit.`,
          detail: iString <= mpptMaxA
            ? 'IEC 62548 §7.3: design current within the MPPT input limit.'
            : 'IEC 62548 §7.3: design current exceeds the MPPT input limit — spread strings across more trackers.',
        });
      }
      const acKw = (p.rated_kw || 0) * Math.max(1, p.num_inverters || 1);
      const dcKw = (p.pv_panel_w || 0) * pps * strings * Math.max(1, p.num_inverters || 1) / 1000;
      if (acKw > 0 && dcKw / acKw > 1.5) {
        section.items.push({
          status: 'warn', component: name,
          message: `DC/AC ratio ${(dcKw / acKw).toFixed(2)} — array heavily oversized vs the ${acKw.toFixed(0)} kW inverter.`,
          detail: 'Energy is lost to clipping near full sun; confirm the inverter permits this DC oversizing.',
        });
      }
    }
    if (!any) {
      section.items.push({ status: 'info', component: '—',
        message: 'No PV arrays in string-sizing mode.',
        detail: 'Set a Solar PV\'s PV Sizing Mode to "Strings × Panels" to enable IEC 62548 checks.' });
    }
    return section;
  },

  _checkSANS10142() {
    const section = { title: 'SANS 10142 — Wiring of Premises', standard: 'SANS 10142-1', items: [] };

    this._sans10142_lvVoltage(section);
    this._sans10142_cableProtection(section);
    this._sans10142_minCableSize(section);
    this._sans10142_transformerNeutral(section);
    this._sans10142_maxDemand(section);
    this._sans10142_earthFaultCurrent(section);

    if (section.items.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No SANS 10142 checks applicable to current network.', detail: 'Add LV components (cables, transformers, CBs) to enable SANS 10142 checks.' });
    }

    return section;
  },

  // SANS 10142-1 Cl. 5.3.2 / NRS 048-2: LV supply voltage tolerance ±10%
  _sans10142_lvVoltage(section) {
    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'LV voltage compliance (±10%): load flow not run.', detail: 'Run Load Flow to verify LV bus voltages per SANS 10142-1 Cl. 5.3.2 and NRS 048-2.' });
      return;
    }

    const LV_THRESHOLD_KV = 1.0; // Buses ≤ 1 kV are LV
    const LO = 0.90;
    const HI = 1.10;
    let checked = 0;

    for (const [busId, lfResult] of Object.entries(AppState.loadFlowResults.buses)) {
      const busComp = AppState.components.get(busId);
      const nominalKV = busComp?.props?.voltage_kv ?? busComp?.props?.voltage;
      if (!nominalKV || nominalKV > LV_THRESHOLD_KV) continue; // Only LV buses

      checked++;
      const busName = busComp?.props?.name || busId;
      const vpu = lfResult.voltage_pu;

      if (vpu < LO) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `LV under-voltage: ${vpu.toFixed(4)} p.u. (${(vpu * nominalKV * 1000).toFixed(0)} V).`,
          detail: `Below ${LO} p.u. (${(LO * nominalKV * 1000).toFixed(0)} V). SANS 10142-1 Cl. 5.3.2 / NRS 048-2 require ±10% of nominal ${(nominalKV * 1000).toFixed(0)} V.`,
        });
      } else if (vpu > HI) {
        section.items.push({
          status: 'fail',
          component: busName,
          message: `LV over-voltage: ${vpu.toFixed(4)} p.u. (${(vpu * nominalKV * 1000).toFixed(0)} V).`,
          detail: `Above ${HI} p.u. (${(HI * nominalKV * 1000).toFixed(0)} V). SANS 10142-1 Cl. 5.3.2 / NRS 048-2 require ±10% of nominal ${(nominalKV * 1000).toFixed(0)} V.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: busName,
          message: `LV voltage: ${vpu.toFixed(4)} p.u. (${(vpu * nominalKV * 1000).toFixed(0)} V).`,
          detail: `Within ±10% of ${(nominalKV * 1000).toFixed(0)} V nominal. Complies with SANS 10142-1 Cl. 5.3.2 / NRS 048-2.`,
        });
      }
    }

    if (checked === 0 && this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'No LV buses (≤1 kV) found for SANS 10142 voltage check.', detail: 'LV voltage tolerance check applies to buses with nominal voltage ≤ 1 kV.' });
    }
  },

  // SANS 10142-1 Cl. 5.5.2: Overcurrent protection coordination — In ≤ Iz (device rating ≤ cable ampacity)
  _sans10142_cableProtection(section) {
    let checked = 0;

    for (const [cableId, comp] of AppState.components) {
      if (comp.type !== 'cable') continue;
      const cableName = comp.props?.name || cableId;
      const iz = comp.props?.rated_amps; // Cable ampacity (Iz)
      const cableVoltageKV = this._resolveCableVoltage(cableId, comp);

      if (!iz || !cableVoltageKV || cableVoltageKV > 1.0) continue; // Only LV cables
      checked++;

      // Find upstream protective devices (CBs, fuses) connected to this cable
      const devices = this._findConnectedDevices(cableId, ['cb', 'fuse']);

      if (devices.length === 0) {
        section.items.push({
          status: 'warn',
          component: cableName,
          message: `LV cable has no upstream overcurrent protection device.`,
          detail: `Cable ampacity Iz = ${iz} A. SANS 10142-1 Cl. 5.5.2 requires every LV circuit to be protected against overcurrent.`,
        });
        continue;
      }

      for (const dev of devices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        const in_ = devComp.props?.rated_current_a; // Device nominal current (In)

        if (in_ == null || in_ <= 0) {
          section.items.push({
            status: 'warn',
            component: devName,
            message: `No rated current specified; cannot verify In ≤ Iz for cable ${cableName}.`,
            detail: `SANS 10142-1 Cl. 5.5.2: protection device rated current In must not exceed cable ampacity Iz = ${iz} A.`,
          });
          continue;
        }

        if (in_ > iz) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Protection rating In (${in_} A) EXCEEDS cable ampacity Iz (${iz} A). Cable ${cableName} is unprotected.`,
            detail: `SANS 10142-1 Cl. 5.5.2 requires In ≤ Iz. Reduce device rating to ≤ ${iz} A or upsize cable.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: devName,
            message: `In (${in_} A) ≤ Iz (${iz} A) for cable ${cableName}. Cable is adequately protected.`,
            detail: `Complies with SANS 10142-1 Cl. 5.5.2. Protection margin: ${(((iz / in_) - 1) * 100).toFixed(1)}%.`,
          });
        }
      }
    }

    if (checked === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV cables found for SANS 10142-1 Cl. 5.5.2 coordination check.', detail: 'Add LV cables with rated ampacity to enable overcurrent coordination checks.' });
    }
  },

  // SANS 10142-1 Cl. 5.6.3.2: Minimum conductor cross-section for LV fixed wiring
  _sans10142_minCableSize(section) {
    const MIN_SIZE_FIXED = 1.5;   // mm² — minimum for fixed wiring (Cl. 5.6.3.2 Table 52A)
    const MIN_SIZE_SOCKET = 2.5;  // mm² — recommended for socket-outlet final circuits
    let checked = 0;

    for (const [cableId, comp] of AppState.components) {
      if (comp.type !== 'cable') continue;
      const cableVoltageKV = this._resolveCableVoltage(cableId, comp);
      if (!cableVoltageKV || cableVoltageKV > 1.0) continue; // Only LV

      const sizeMm2 = comp.props?.size_mm2;
      if (!sizeMm2) continue;
      checked++;

      const cableName = comp.props?.name || cableId;

      if (sizeMm2 < MIN_SIZE_FIXED) {
        section.items.push({
          status: 'fail',
          component: cableName,
          message: `Conductor ${sizeMm2} mm² is BELOW minimum ${MIN_SIZE_FIXED} mm² for LV fixed wiring.`,
          detail: `SANS 10142-1 Cl. 5.6.3.2 Table 52A: minimum conductor size for fixed wiring is 1.5 mm² (copper). Use a larger conductor.`,
        });
      } else if (sizeMm2 < MIN_SIZE_SOCKET) {
        section.items.push({
          status: 'warn',
          component: cableName,
          message: `Conductor ${sizeMm2} mm² meets minimum but is below 2.5 mm² socket-circuit recommendation.`,
          detail: `SANS 10142-1 Cl. 5.6.3.3: socket-outlet circuits require ≥ 2.5 mm². Acceptable for lighting circuits only.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: cableName,
          message: `Conductor size ${sizeMm2} mm² meets SANS 10142-1 Cl. 5.6.3.2 minimum requirements.`,
          detail: `≥ 2.5 mm² — suitable for socket-outlet and lighting final circuits.`,
        });
      }
    }

    if (checked === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV cables with size data found for minimum conductor size check.', detail: 'Select a standard cable type to enable SANS 10142-1 Cl. 5.6.3 size checks.' });
    }
  },

  // SANS 10142-1 Cl. 8.3.1 / IEC 60364-1: LV distribution transformer neutral earthing
  _sans10142_transformerNeutral(section) {
    let checked = 0;

    for (const [xfId, comp] of AppState.components) {
      if (comp.type !== 'transformer') continue;
      const lvKV = comp.props?.voltage_lv_kv ?? comp.props?.voltage_lv;
      if (!lvKV || lvKV > 1.0) continue; // Only transformers with LV secondary
      checked++;

      const xfName = comp.props?.name || xfId;
      const vectorGroup = (comp.props?.vector_group || '').toLowerCase();
      const groundingLv = comp.props?.grounding_lv || '';

      // LV neutral is accessible when vector group contains 'yn' or 'zn' on LV side
      // e.g. Dyn11 → LV is yn → neutral accessible and earthed
      const lvNeutralAccessible = /yn|zn/.test(vectorGroup);
      const lvSolidlyEarthed = groundingLv === 'solidly_grounded';
      const lvUngrounded = groundingLv === 'ungrounded';

      if (!lvNeutralAccessible && !lvSolidlyEarthed) {
        section.items.push({
          status: 'info',
          component: xfName,
          message: `LV winding vector group '${comp.props?.vector_group || '?'}' — no accessible LV neutral.`,
          detail: `SANS 10142-1 Cl. 8.3.1: TN/TT systems require an earthed neutral at the LV source. Consider Dyn11 configuration with solidly earthed neutral.`,
        });
      } else if (lvUngrounded) {
        section.items.push({
          status: 'fail',
          component: xfName,
          message: `LV neutral is ungrounded on a distribution transformer with accessible neutral.`,
          detail: `SANS 10142-1 Cl. 8.3.1: the LV neutral must be earthed (solidly or via low-resistance) for TN/TT systems. Ungrounded LV is only permitted for IT systems with insulation monitoring.`,
        });
      } else if (lvNeutralAccessible && lvSolidlyEarthed) {
        section.items.push({
          status: 'pass',
          component: xfName,
          message: `LV neutral solidly earthed (${comp.props?.vector_group || '—'}) — TN system earthing confirmed.`,
          detail: `SANS 10142-1 Cl. 8.3.1: earthed neutral at LV source provides automatic disconnection capability.`,
        });
      } else {
        // Neutral accessible but grounding not solidly set (resistance / reactance grounded)
        section.items.push({
          status: 'warn',
          component: xfName,
          message: `LV neutral earthed via impedance (${groundingLv.replace(/_/g, ' ')}). Verify disconnection times.`,
          detail: `SANS 10142-1 Cl. 8.3.1: impedance-earthed LV neutrals increase earth fault loop impedance. Verify that disconnection times for all circuits comply with Cl. 5.5.6.`,
        });
      }
    }

    if (checked === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV distribution transformers (≤1 kV secondary) found for neutral earthing check.', detail: 'SANS 10142-1 Cl. 8.3.1 applies to transformers supplying LV premises installations.' });
    }
  },

  // SANS 10142-1 Appendix B / NRS 034: Maximum demand vs supply capacity
  _sans10142_maxDemand(section) {
    if (!this._hasLoadFlow()) {
      section.items.push({ status: 'info', component: '—', message: 'Maximum demand check: load flow not run.', detail: 'Run Load Flow to compare total LV demand against supply authority capacity.' });
      return;
    }

    // Sum rated MVA of all LV-side transformers (supply to premises)
    let totalXfMVA = 0;
    const xfNames = [];
    for (const comp of AppState.components.values()) {
      if (comp.type !== 'transformer') continue;
      const lvKV = comp.props?.voltage_lv_kv ?? comp.props?.voltage_lv;
      if (!lvKV || lvKV > 1.0) continue;
      const mva = comp.props?.rated_mva || 0;
      totalXfMVA += mva;
      xfNames.push(comp.props?.name || 'unnamed');
    }

    // Collect total LV load from load flow (sum of loads at LV buses)
    let totalLoadMW = 0;
    let totalLoadMVAR = 0;
    for (const comp of AppState.components.values()) {
      if (!['static_load', 'motor_induction', 'motor_synchronous'].includes(comp.type)) continue;
      // Check if this load is on an LV bus
      const connBuses = this._findConnectedDevices(comp.id || comp.props?.name, ['bus']);
      for (const b of connBuses) {
        const busComp = AppState.components.get(b.id);
        const busV = busComp?.props?.voltage_kv ?? busComp?.props?.voltage;
        if (!busV || busV > 1.0) continue;
        const p = comp.props?.p_mw || (comp.props?.rated_mw) || ((comp.props?.rated_mva || 0) * (comp.props?.power_factor || 0.85));
        totalLoadMW += p;
        const q = comp.props?.q_mvar || ((comp.props?.rated_mva || 0) * Math.sqrt(1 - Math.pow(comp.props?.power_factor || 0.85, 2)));
        totalLoadMVAR += q;
        break;
      }
    }
    const totalLoadMVA = Math.sqrt(totalLoadMW ** 2 + totalLoadMVAR ** 2);

    if (totalXfMVA > 0 && totalLoadMVA > 0) {
      const utilPct = (totalLoadMVA / totalXfMVA) * 100;
      if (utilPct > 100) {
        section.items.push({
          status: 'fail',
          component: '—',
          message: `Total LV load (${totalLoadMVA.toFixed(3)} MVA) EXCEEDS installed LV transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Utilisation: ${utilPct.toFixed(1)}%. SANS 10142-1 Appendix B / NRS 034: maximum demand must not exceed supply capacity. Increase transformer rating or reduce demand.`,
        });
      } else if (utilPct > 80) {
        section.items.push({
          status: 'warn',
          component: '—',
          message: `LV demand (${totalLoadMVA.toFixed(3)} MVA) is ${utilPct.toFixed(1)}% of transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Above 80% utilisation. SANS 10142-1 Appendix B: consider diversity factors and apply demand factor analysis. Limited capacity for load growth or derating.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: '—',
          message: `LV maximum demand (${totalLoadMVA.toFixed(3)} MVA) within transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Utilisation: ${utilPct.toFixed(1)}%. Complies with SANS 10142-1 Appendix B supply capacity requirement. Transformers: ${xfNames.join(', ')}.`,
        });
      }
    } else if (totalXfMVA === 0 && totalLoadMVA === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV transformers or LV loads found for maximum demand check.', detail: 'SANS 10142-1 Appendix B: supply capacity analysis requires LV transformers and LV loads.' });
    } else if (totalXfMVA === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV distribution transformer found; cannot evaluate maximum demand against supply capacity.', detail: 'Add a transformer with an LV secondary (≤1 kV) to enable this check.' });
    }
  },

  // SANS 10142-1 Cl. 5.5.6: Minimum earth fault current for automatic disconnection on LV TN systems
  _sans10142_earthFaultCurrent(section) {
    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Earth fault disconnection check: fault analysis not run.', detail: 'Run Fault Analysis to verify minimum earth fault current for disconnection per SANS 10142-1 Cl. 5.5.6.' });
      return;
    }

    const LV_THRESHOLD_KV = 1.0;
    const DISCONNECTION_FACTOR = 10; // In TN system: Isc ≥ 10 × In for instantaneous CB trip (conservative threshold)
    let checked = 0;

    for (const [busId, faultResult] of Object.entries(AppState.faultResults.buses)) {
      const busComp = AppState.components.get(busId);
      const nominalKV = busComp?.props?.voltage_kv ?? busComp?.props?.voltage;
      if (!nominalKV || nominalKV > LV_THRESHOLD_KV) continue; // LV buses only

      const islg = faultResult.ik1; // Single-line-to-ground (earth) fault current in kA
      if (islg == null) continue;
      checked++;

      const busName = busComp?.props?.name || busId;
      const islgA = islg * 1000; // Convert kA → A

      // Find the minimum-rated upstream protection device
      const devices = this._findConnectedDevices(busId, ['cb', 'fuse']);
      for (const dev of devices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const in_ = devComp.props?.rated_current_a;
        if (!in_) continue;

        const devName = devComp.props?.name || dev.id;
        const requiredIscA = in_ * DISCONNECTION_FACTOR;

        if (islgA < requiredIscA) {
          section.items.push({
            status: 'fail',
            component: busName,
            message: `Earth fault current (${islgA.toFixed(0)} A) may be insufficient to guarantee instantaneous trip of ${devName} (In = ${in_} A).`,
            detail: `SANS 10142-1 Cl. 5.5.6: for TN systems, single-line-to-ground fault current should be ≥ 10 × In = ${requiredIscA.toFixed(0)} A for instantaneous disconnection. Verify earth fault loop impedance and consider lower-rated or more sensitive protection.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: busName,
            message: `Earth fault current (${islgA.toFixed(0)} A) ≥ 10 × In (${requiredIscA.toFixed(0)} A) of ${devName}. Automatic disconnection confirmed.`,
            detail: `SANS 10142-1 Cl. 5.5.6: sufficient earth fault current for instantaneous disconnection in TN system at ${busName}.`,
          });
        }
      }

      if (devices.length === 0) {
        section.items.push({
          status: 'warn',
          component: busName,
          message: `LV bus has no protection device — earth fault disconnection cannot be verified.`,
          detail: `Earth fault current Islg = ${islgA.toFixed(0)} A at ${busName}. Add a circuit breaker or fuse to enable SANS 10142-1 Cl. 5.5.6 disconnection check.`,
        });
      }
    }

    if (checked === 0 && this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'No LV buses with earth fault data found for disconnection check.', detail: 'SANS 10142-1 Cl. 5.5.6 applies to LV TN system buses (nominal voltage ≤ 1 kV).' });
    }
  },

  // ── 8. Equipment Summary ──
  _buildEquipmentSummary() {
    const section = { title: 'Equipment Inventory', standard: 'Reference', items: [] };
    const counts = {};
    for (const comp of AppState.components.values()) {
      const def = COMPONENT_DEFS[comp.type];
      const label = def ? def.label : comp.type;
      counts[label] = (counts[label] || 0) + 1;
    }
    for (const [type, count] of Object.entries(counts)) {
      section.items.push({ status: 'info', component: '—', message: `${type}: ${count}`, detail: '' });
    }
    if (AppState.components.size === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No equipment in the network.', detail: '' });
    }
    return section;
  },

  // ── Helpers ──

  _hasFault() {
    return !!(AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0);
  },

  _hasLoadFlow() {
    return !!(AppState.loadFlowResults && AppState.loadFlowResults.buses && Object.keys(AppState.loadFlowResults.buses).length > 0);
  },

  // Resolve a cable's operating voltage: use its own voltage_kv prop when set,
  // otherwise inherit the voltage of a connected bus (via the wire walker)
  _resolveCableVoltage(cableId, comp) {
    const own = comp.props?.voltage_kv;
    if (own) return own;
    const buses = this._findConnectedDevices(cableId, ['bus']);
    for (const b of buses) {
      const busComp = AppState.components.get(b.id);
      const busV = busComp?.props?.voltage_kv ?? busComp?.props?.voltage;
      if (busV) return busV;
    }
    return null;
  },

  // Build (and cache for this report run) a compId → [neighbourId] adjacency
  // index so _findConnectedDevices doesn't rescan every wire per BFS node.
  _getAdjacency() {
    if (this._adj) return this._adj;
    const adj = new Map();
    for (const wire of AppState.wires.values()) {
      if (!adj.has(wire.fromComponent)) adj.set(wire.fromComponent, []);
      if (!adj.has(wire.toComponent)) adj.set(wire.toComponent, []);
      adj.get(wire.fromComponent).push(wire.toComponent);
      adj.get(wire.toComponent).push(wire.fromComponent);
    }
    this._adj = adj;
    return adj;
  },

  // Walk through wires to find components of given types connected to a component
  _findConnectedDevices(compId, types) {
    const found = [];
    const visited = new Set([compId]);
    const queue = [compId];
    const adj = this._getAdjacency();
    const transparent = ['cb', 'fuse', 'switch', 'ct', 'pt', 'surge_arrester'];

    while (queue.length > 0) {
      const current = queue.shift();
      for (const neighborCompId of (adj.get(current) || [])) {
        if (visited.has(neighborCompId)) continue;
        visited.add(neighborCompId);

        const neighborComp = AppState.components.get(neighborCompId);
        if (!neighborComp) continue;

        if (types.includes(neighborComp.type)) {
          found.push({ id: neighborCompId, type: neighborComp.type });
        }

        // Walk through transparent elements (CBs, switches, fuses, CTs, PTs,
        // arresters) — including matched protective devices, so every device
        // in a series stack (switch–fuse, CB-then-fuse) is collected rather
        // than only the nearest one. Buses still terminate the walk.
        if (transparent.includes(neighborComp.type)) {
          queue.push(neighborCompId);
        }
      }
    }
    return found;
  },

  _findAdjacentBranchCurrents(deviceId) {
    if (!this._hasLoadFlow()) return [];
    const results = [];
    const branches = AppState.loadFlowResults.branches || [];

    // Find cables/transformers connected through this device
    const connBranches = this._findConnectedDevices(deviceId, ['cable', 'transformer']);
    for (const cb of connBranches) {
      const br = branches.find(b => b.elementId === cb.id);
      if (br && br.i_amps > 0) {
        const comp = AppState.components.get(cb.id);
        results.push({ branchName: comp?.props?.name || cb.id, current: br.i_amps });
      }
    }
    return results;
  },

  // ── Render to HTML ──

  renderHTML(report) {
    const statusIcon = { pass: '\u2705', fail: '\u274C', warn: '\u26A0\uFE0F', info: '\u2139\uFE0F' };
    const statusLabel = { pass: 'PASS', fail: 'FAIL', warn: 'WARNING', info: 'INFO' };

    let html = `<div class="compliance-header">
      <div class="compliance-meta">
        <strong>${escHtml(report.projectName)}</strong> &mdash;
        Base: ${report.baseMVA} MVA, ${report.frequency} Hz &mdash;
        Generated: ${new Date(report.timestamp).toLocaleString()}
      </div>
    </div>`;

    for (const section of report.sections) {
      const sectionCounts = { pass: 0, fail: 0, warn: 0, info: 0 };
      for (const item of section.items) sectionCounts[item.status]++;

      let badge = '';
      if (sectionCounts.fail > 0) badge = `<span class="compliance-badge badge-fail">${sectionCounts.fail} FAIL</span>`;
      else if (sectionCounts.warn > 0) badge = `<span class="compliance-badge badge-warn">${sectionCounts.warn} WARN</span>`;
      else if (sectionCounts.pass > 0) badge = `<span class="compliance-badge badge-pass">ALL PASS</span>`;
      else badge = `<span class="compliance-badge badge-info">INFO</span>`;

      html += `<div class="compliance-section">
        <div class="compliance-section-header">
          <h4>${section.title} <span class="compliance-standard">${section.standard}</span></h4>
          ${badge}
        </div>
        <table class="compliance-table">
          <thead><tr><th></th><th>Component</th><th>Check</th><th>Detail</th></tr></thead>
          <tbody>`;

      for (const item of section.items) {
        html += `<tr class="compliance-row compliance-${item.status}">
          <td class="compliance-status-cell">${statusIcon[item.status]}</td>
          <td class="compliance-comp-cell">${escHtml(item.component)}</td>
          <td>${escHtml(item.message)}</td>
          <td class="compliance-detail-cell">${escHtml(item.detail)}</td>
        </tr>`;
      }

      html += `</tbody></table></div>`;
    }

    return html;
  },

  // ── Export to PDF ──

  exportPDF(report) {
    const { jsPDF } = window.jspdf;
    if (!jsPDF) return;

    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 15;
    const name = report.projectName;

    // Title
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text('ProtectionPro \u2014 Compliance Report', margin, margin + 6);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${name}  |  Base MVA: ${report.baseMVA}  |  Frequency: ${report.frequency} Hz`, margin, margin + 13);
    doc.text(`Generated: ${new Date(report.timestamp).toLocaleString()}`, margin, margin + 19);

    // Summary
    const t = report.totals;
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text('Summary', margin, margin + 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(`Pass: ${t.pass}   |   Fail: ${t.fail}   |   Warnings: ${t.warn}   |   Info: ${t.info}`, margin, margin + 34);

    let startY = margin + 42;

    const statusSymbol = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', info: 'INFO' };
    const statusColor = {
      pass: [46, 125, 50],
      fail: [211, 47, 47],
      warn: [245, 124, 0],
      info: [100, 100, 100],
    };

    for (const section of report.sections) {
      // Check if we need a new page
      if (startY > pageH - 50) {
        doc.addPage();
        startY = margin + 6;
      }

      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text(`${section.title}  (${section.standard})`, margin, startY);
      doc.setFont('helvetica', 'normal');
      startY += 4;

      const tableData = section.items.map(item => [
        statusSymbol[item.status],
        item.component,
        item.message,
        item.detail,
      ]);

      doc.autoTable({
        startY: startY,
        margin: { left: margin, right: margin },
        head: [['Status', 'Component', 'Check', 'Detail']],
        body: tableData,
        styles: { fontSize: 7.5, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: [60, 60, 60], textColor: 255, fontStyle: 'bold', fontSize: 8 },
        columnStyles: {
          0: { cellWidth: 14, halign: 'center', fontStyle: 'bold' },
          1: { cellWidth: 28 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 55, fontSize: 7, textColor: [100, 100, 100] },
        },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 0) {
            const status = data.cell.raw;
            const colorMap = { PASS: [46, 125, 50], FAIL: [211, 47, 47], WARN: [245, 124, 0], INFO: [100, 100, 100] };
            data.cell.styles.textColor = colorMap[status] || [0, 0, 0];
          }
        },
        alternateRowStyles: { fillColor: [248, 248, 248] },
      });

      startY = doc.lastAutoTable.finalY + 8;
    }

    // Footer on all pages
    const totalPages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(150);
      doc.text(`ProtectionPro Compliance Report \u2014 ${name}`, margin, pageH - 5);
      doc.text(`Page ${i} of ${totalPages}`, pageW - margin, pageH - 5, { align: 'right' });
      doc.setTextColor(0);
    }

    doc.save(`${name}_compliance.pdf`);
  },
};
