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
    report.sections.push(this._checkMotorCircuits());
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

    // [L5] validate() keys the component as compId, not id
    const who = (x) => {
      const id = x.compId || x.id;
      return id ? (AppState.components.get(id)?.props?.name || id) : '—';
    };
    for (const e of errors) {
      section.items.push({ status: 'fail', component: who(e), message: e.msg, detail: 'Must be resolved before analysis.' });
    }
    for (const w of warnings) {
      section.items.push({ status: 'warn', component: who(w), message: w.msg, detail: 'May affect results accuracy.' });
    }

    if (errors.length === 0 && warnings.length === 0) {
      section.items.push({ status: 'pass', component: '—', message: 'Network topology is valid.', detail: 'All components connected, sources and buses present.' });
    }

    // [L1] The load flow picks each island's slack from its sources (the
    // utility, else the largest machine) — a bus labelled Swing is optional,
    // so its absence is not a finding. A network with no source at all is.
    const hasSource = [...AppState.components.values()]
      .some(c => this._SOURCE_TYPES.includes(c.type) || c.type === 'battery');
    if (!hasSource) {
      section.items.push({ status: 'warn', component: '—', message: 'No source in the network.', detail: 'Add a utility, generator, PV, wind or battery source — load flow and fault studies have no infeed without one.' });
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

      // Breaking duty, mirroring backend duty_check.py [DU1][DU2]: the largest
      // PHASE current of any fault type (I"k3, I"k1, I"kLL — ikLLG is the
      // earth current I"kE2E, not a pole current). Only an MV breaker
      // (IEC 62271-100) may take the decayed Ib for the balanced fault; LV
      // breakers (IEC 60947-2) and fuses (IEC 60269) are rated against the
      // prospective I"k.
      const unbal = Math.max(faultResult.ik1 || 0, faultResult.ikLL || 0);
      const ikMax = Math.max(ik3, unbal);
      const busKv = faultResult.voltage_kv || busComp?.props?.voltage_kv || 0;
      const ipKA = faultResult.ip != null ? faultResult.ip * (ik3 > 0 ? ikMax / ik3 : 1) : null;

      // Find protection devices connected to this bus (walk through wires)
      const connectedDevices = this._findConnectedDevices(busId, ['cb', 'fuse']);

      for (const dev of connectedDevices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        const breakingKA = devComp.props?.breaking_capacity_ka;

        const mvCb = devComp.type === 'cb' && busKv > 1.0;
        const ibKA = (mvCb && faultResult.ib != null) ? Math.max(faultResult.ib, unbal) : ikMax;
        const ibLabel = (mvCb && faultResult.ib != null && faultResult.ib >= unbal) ? 'Ib' : 'largest I"k';
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
            makingFactor = icu <= 4.5 ? 1.41 : icu <= 6 ? 1.5 : icu <= 10 ? 1.7 : icu <= 20 ? 2.0 : icu <= 50 ? 2.1 : 2.2;
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
  // Adiabatic criterion: the protective device must clear a fault before the
  // conductor exceeds its final short-circuit temperature, i.e.
  // t_clear ≤ k²·S²/Ith², with k per IEC 60364-4-43 Table 43A.
  //
  // [C2] Checked at BOTH ends of the fault-current range, as the reviewed
  // Cable Sizing study does ([CS2]/[CS5]): (a) the LARGEST current of any
  // fault type at either end, as the IEC 60909-0 §12 thermal-equivalent
  // Ith = I″k·√(m+1) — the fast, high-energy case; (b) the SMALLEST current
  // at the far end from the minimum study (c_min, hot conductors) — a
  // time-inverse device is slowest there. The old check used only the
  // far-end I″k3 of the MAXIMUM study, which is neither: it passed a cable
  // that fails at the source-end Ik1 and one a slow device overheats at
  // the far-end minimum. Only the supply-side device counts — a load-side
  // device sees no current for a fault in the cable.
  _checkCableWithstand() {
    const section = { title: 'Cable Short-Circuit Withstand', standard: 'IEC 60364-4-43 / SANS 10142-1', items: [] };

    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Cable withstand check: fault analysis not run.', detail: 'Run Fault Analysis to verify t_clear ≤ k²S²/I² per IEC 60364-4-43 §434.5.2.' });
      return section;
    }

    const maxB = AppState.faultResults.buses;
    const minB = AppState.faultResultsMin?.buses || null;
    const freq = Number(AppState.frequency) || 50;
    const fmtT = (t) => (t >= 100 ? t.toFixed(0) : t >= 10 ? t.toFixed(1) : t >= 1 ? t.toFixed(2) : t.toFixed(3));
    const T_ADIABATIC = 5.0; // §434.5.2 is valid up to 5 s
    let anyCable = false;
    let farSkipped = false;

    for (const [cableId, comp] of AppState.components) {
      if (comp.type !== 'cable') continue;
      anyCable = true;
      const cableName = comp.props?.name || cableId;
      const { size: sizeMm2, conductor, insulation } = this._cableBasics(comp);

      if (!(sizeMm2 > 0)) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'Conductor cross-section unknown — short-circuit withstand not verified.',
          detail: 'Select a standard cable type (or set the conductor size) to enable the IEC 60364-4-43 §434.5.2 adiabatic check.',
        });
        continue;
      }
      const kFactor = this._kFactor(conductor, insulation, sizeMm2);
      const kDesc = `k = ${kFactor} (${conductor}/${insulation}${insulation === 'PVC' && sizeMm2 > 300 ? ' > 300 mm²' : ''}), S = ${sizeMm2} mm²`;

      const ends = this._faultNodes(cableId, this._TRANSPARENT).filter(e => maxB[e.key]);
      if (ends.length === 0) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'No fault result at a connected bus — short-circuit withstand not verified.',
          detail: `${kDesc}. Ensure the cable's buses are included in the fault study.`,
        });
        continue;
      }

      const dev = this._cableDevice(cableId);
      if (!dev) {
        section.items.push({
          status: 'info',
          component: cableName,
          message: 'No protective device found for cable — clearing time cannot be evaluated.',
          detail: `${kDesc}. Add an upstream circuit breaker or fuse to enable the check.`,
        });
        continue;
      }
      const devName = dev.props?.name || dev.id;

      // (a) the largest current of any fault type at either end (max study)
      let iMaxKA = 0, kappa = null, atName = '', atType = '';
      for (const e of ends) {
        const r = maxB[e.key];
        for (const [v, lbl] of [[r.ik3, 'I"k3'], [r.ik1, 'I"k1'], [r.ikLL, 'I"kLL'], [r.ikLLG, 'I"kLLG']]) {
          if (v > iMaxKA) { iMaxKA = v; kappa = r.kappa; atName = e.name; atType = lbl; }
        }
      }
      const ta = this._deviceClearTime(dev, iMaxKA * 1000);
      if (ta.t === null) {
        section.items.push({
          status: 'info', component: devName,
          message: `${ta.why} — withstand of cable ${cableName} not evaluated here.`,
          detail: `${kDesc}. Run the Cable Sizing study, which evaluates the relay curve through its CT.`,
        });
        continue;
      }
      this._pushWithstand(section, {
        devName, cableName, kDesc, kFactor, sizeMm2, freq, fmtT, T_ADIABATIC,
        iKA: iMaxKA, kappa, t: ta.t, devDesc: ta.desc,
        where: `${atType} = ${iMaxKA.toFixed(2)} kA at ${atName} (largest fault current, maximum study)`,
      });

      // (b) the smallest current at the far end (minimum study)
      let far = ends.filter(e => !this._leadsToSource(e.compId, cableId));
      if (ends.length > 1 && (far.length === 0 || far.length === ends.length)) {
        // supply side not resolved (a ring, generation at both ends, or no
        // source modelled) — the lower-I"k3 end is the far end
        far = [[...ends].sort((a, b) => maxB[a.key].ik3 - maxB[b.key].ik3)[0]];
      }
      if (far.length === 0) continue;
      if (!minB) { farSkipped = true; continue; }
      let iMinKA = Infinity, kapFar = null, farName = '';
      for (const e of far) {
        const r = minB[e.key];
        if (!r) continue;
        for (const v of [r.ik3, r.ikLL, r.ik1]) {
          if (v > 0 && v < iMinKA) { iMinKA = v; kapFar = r.kappa; farName = e.name; }
        }
      }
      if (!isFinite(iMinKA)) continue;
      const tb = this._deviceClearTime(dev, iMinKA * 1000);
      if (tb.t === null) continue;
      if (!isFinite(tb.t) || tb.t >= T_ADIABATIC) {
        // §435.1: a device that gives §433 overload protection also covers
        // the conductor on its load side against short circuit
        const iz = (parseFloat(comp.props?.rated_amps) || 0) * this._cableBasics(comp).n;
        const ol = this._overloadCoord(dev, iz);
        const covered = ol && ol.ok1 && ol.ok2;
        section.items.push({
          status: covered ? 'pass' : 'fail', component: devName,
          message: covered
            ? `Minimum far-end fault (${(iMinKA * 1000).toFixed(0)} A at ${farName}) is cleared by the overload element — cable ${cableName} covered by §435.1.`
            : `Minimum far-end fault (${(iMinKA * 1000).toFixed(0)} A at ${farName}) is not cleared within ${T_ADIABATIC} s — cable ${cableName} is not protected against short circuit.`,
          detail: covered
            ? `${kDesc}. ${tb.desc} takes ${isFinite(tb.t) ? fmtT(tb.t) + ' s' : '∞'}, but it satisfies IEC 60364-4-43 §433.1 for this cable (In ${ol.In.toFixed(0)} A ≤ Iz ${iz.toFixed(0)} A, I2 ${ol.I2.toFixed(0)} A ≤ 1.45·Iz), so §435.1 applies. Basis: minimum study (c_min).`
            : `${kDesc}. ${tb.desc} takes ${isFinite(tb.t) ? fmtT(tb.t) + ' s' : '∞'} at the minimum fault current (IEC 60364-4-43 §434.5.2, valid to ${T_ADIABATIC} s) and does not give §433.1 overload protection of the cable. Lower the pickup, shorten the run or upsize the conductor.`,
        });
        continue;
      }
      this._pushWithstand(section, {
        devName, cableName, kDesc, kFactor, sizeMm2, freq, fmtT, T_ADIABATIC,
        iKA: iMinKA, kappa: kapFar, t: tb.t, devDesc: tb.desc,
        where: `${(iMinKA * 1000).toFixed(0)} A at ${farName} (smallest fault current, minimum study)`,
      });
    }

    if (farSkipped) {
      section.items.push({ status: 'warn', component: '—', message: 'Minimum fault study not available — the far-end (smallest current) withstand check was skipped.', detail: 'Re-run Fault Analysis: the companion minimum-current study (c_min, hot conductors) is fetched automatically.' });
    }
    if (!anyCable) {
      section.items.push({ status: 'info', component: '—', message: 'No cables in the network for short-circuit withstand check.', detail: 'IEC 60364-4-43 §434.5.2 applies to cables protected by an upstream overcurrent device.' });
    }

    return section;
  },

  // One §434.5.2 verdict: t_clear ≤ (k·S/Ith)², Ith = I·√(m+1) per IEC 60909-0 §12
  _pushWithstand(section, a) {
    const f = Math.sqrt(this._thermalM(a.kappa, a.t, a.freq) + 1);
    const ithA = a.iKA * 1000 * f;
    const tMax = Math.pow((a.kFactor * a.sizeMm2) / ithA, 2);
    const basis = `${a.kDesc}, ${a.where}, Ith = I·√(m+1) = ${(ithA / 1000).toFixed(2)} kA → withstand k²S²/Ith² = ${a.fmtT(tMax)} s`;
    if (!isFinite(a.t) || a.t >= a.T_ADIABATIC) {
      section.items.push({
        status: 'fail', component: a.devName,
        message: `Device does not clear ${(a.iKA * 1000).toFixed(0)} A within ${a.T_ADIABATIC} s — cable ${a.cableName} is unprotected against short circuit.`,
        detail: `${basis}. ${a.devDesc}: ${isFinite(a.t) ? a.fmtT(a.t) + ' s' : 'no trip'}. Lower the pickup or use a more sensitive device.`,
      });
    } else if (a.t > tMax) {
      section.items.push({
        status: 'fail', component: a.devName,
        message: `Clearing time ${a.fmtT(a.t)} s EXCEEDS cable ${a.cableName} withstand ${a.fmtT(tMax)} s.`,
        detail: `${basis}. ${a.devDesc} clears in ${a.fmtT(a.t)} s — IEC 60364-4-43 §434.5.2 requires t ≤ k²S²/I². Upsize the conductor or speed up the protection.`,
      });
    } else {
      const marginPct = (tMax / a.t - 1) * 100;
      section.items.push({
        status: marginPct < 20 ? 'warn' : 'pass', component: a.devName,
        message: marginPct < 20
          ? `Clearing time ${a.fmtT(a.t)} s within cable ${a.cableName} withstand ${a.fmtT(tMax)} s, but margin is only ${marginPct.toFixed(0)}%.`
          : `Clearing time ${a.fmtT(a.t)} s ≤ cable ${a.cableName} withstand ${a.fmtT(tMax)} s.`,
        detail: `${basis}. ${a.devDesc}.${marginPct < 20 ? ' Curve tolerance or a higher fault level could exceed the adiabatic limit.' : ' Complies with IEC 60364-4-43 §434.5.2.'}`,
      });
    }
  },

  // ── 6. Protection Device Checks ──
  _checkProtectionDevices() {
    const section = { title: 'Protection Device Ratings', standard: 'IEC 62271 / IEC 60947', items: [] };

    // Check CB and fuse rated voltages against the bus voltage
    for (const [id, comp] of AppState.components) {
      if (!['cb', 'fuse', 'switch', 'changeover'].includes(comp.type)) continue;
      const name = comp.props?.name || id;
      const ratedV = parseFloat(comp.props?.rated_voltage_kv);
      if (!(ratedV > 0)) continue;

      // Find the bus this device is connected to
      const buses = this._findConnectedDevices(id, ['bus']);
      for (const b of buses) {
        const busComp = AppState.components.get(b.id);
        if (!busComp) continue;
        const busV = parseFloat(busComp.props?.voltage_kv || busComp.props?.voltage);
        if (!(busV > 0)) continue;
        const busName = busComp.props?.name || b.id;
        // [C7] MV: IEC 62271-1 requires the rated voltage Ur ≥ Um, the IEC
        // 60038 highest voltage for equipment (12 kV on an 11 kV system) —
        // as the Duty Check does ([L1]). Below nominal fails; between
        // nominal and Um warns (a nominal typed as the rating is common).
        const um = this._highestSystemVoltageKv(busV);

        if (ratedV < busV - 1e-9) {
          section.items.push({
            status: 'fail',
            component: name,
            message: `Rated voltage (${ratedV} kV) is BELOW bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}. Device is under-rated for the system voltage.`,
          });
        } else if (busV > 1.0 && ratedV < um - 1e-9) {
          section.items.push({
            status: 'warn',
            component: name,
            message: `Rated voltage (${ratedV} kV) is below Um = ${um} kV of the ${busV} kV system.`,
            detail: `Connected to bus ${busName}. IEC 62271-1 requires Ur ≥ Um (IEC 60038 highest voltage for equipment). Enter the device's IEC rated voltage (e.g. 12 kV for 11 kV).`,
          });
          break;
        } else {
          section.items.push({
            status: 'pass',
            component: name,
            message: `Rated voltage (${ratedV} kV) adequate for bus voltage (${busV} kV).`,
            detail: `Connected to bus ${busName}.${busV > 1.0 ? ` Ur ≥ Um = ${um} kV (IEC 62271-1).` : ''}`,
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

  // ── 6b. Motor Circuit Protection (nameplate, no load flow needed) ──
  // For a device that protects a SINGLE motor (dedicated feeder), compare its
  // rated current against the motor's full-load current, and its magnetic trip
  // against the motor's starting current. Nameplate-based, so it flags an
  // under-rated device even before load flow is run (and after edits clear it).
  _checkMotorCircuits() {
    const section = { title: 'Motor Circuit Protection', standard: 'IEC 60947-4-1', items: [] };
    let any = false;

    for (const comp of AppState.components.values()) {
      if (comp.type !== 'motor_induction' && comp.type !== 'motor_synchronous') continue;
      const name = comp.props?.name || comp.id;
      const flc = this._motorFLC(comp);
      if (flc == null) continue;

      // Only single-motor (dedicated) feeders — a shared/diversified feeder
      // can legitimately be rated below the sum of its loads, so skip those.
      const { devices, otherLoads } = this._motorProtectiveDevices(comp.id);
      if (otherLoads.length > 0) continue;

      if (devices.length === 0) {
        section.items.push({ status: 'warn', component: name,
          message: `No dedicated overcurrent device protects this motor (FLC ≈ ${flc.toFixed(1)} A).`,
          detail: 'Add a breaker or fuse in the motor feeder sized for the motor.' });
        any = true;
        continue;
      }

      const start = this._motorStartMultiple(comp);
      const iStart = flc * start.mult;

      for (const devId of devices) {
        const dev = AppState.components.get(devId);
        if (!dev) continue;
        const dname = dev.props?.name || devId;
        const In = parseFloat(dev.props?.rated_current_a);
        if (!(In > 0)) {
          section.items.push({ status: 'warn', component: dname,
            message: `No rated current set — cannot check against motor ${name} (FLC ≈ ${flc.toFixed(1)} A).`,
            detail: 'Set the device rated current.' });
          any = true;
          continue;
        }

        // Full-load current: device must carry at least the motor FLC.
        if (In < flc) {
          section.items.push({ status: 'fail', component: dname,
            message: `Rated ${In} A is BELOW motor ${name} full-load current (${flc.toFixed(1)} A).`,
            detail: `IEC 60947-4-1: a motor's protective device must carry at least the motor FLC. Undersized — will trip under normal running. Size ≥ FLC (and for starting).` });
          any = true;
        } else {
          section.items.push({ status: 'pass', component: dname,
            message: `Rated ${In} A ≥ motor ${name} FLC (${flc.toFixed(1)} A).`,
            detail: 'Adequate for continuous running.' });
          any = true;
        }

        // Starting current: magnetic/instantaneous trip must sit above inrush.
        const trip = this._deviceMagneticTripA(dev);
        if (trip && iStart > trip.a) {
          section.items.push({ status: 'warn', component: dname,
            message: `Starting current ≈ ${iStart.toFixed(0)} A (${start.label}) exceeds the magnetic no-trip limit (${trip.a.toFixed(0)} A, ${trip.desc}).`,
            detail: `The breaker is not guaranteed to hold when motor ${name} starts (the RMS starting current is inside or above its magnetic tolerance band; the first-cycle asymmetric peak is higher still). Use a higher trip curve (C/D), raise the instantaneous pickup, or size the device for starting.` });
          any = true;
        }
      }
    }

    if (!any) {
      section.items.push({ status: 'info', component: '—', message: 'No motor circuits to check.', detail: 'Add induction or synchronous motors fed by a breaker or fuse.' });
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
    this._sans10142_earthingSystem(section);
    this._sans10142_maxDemand(section);
    this._sans10142_earthFaultCurrent(section);
    this._sans10142_dbCircuits(section);

    if (section.items.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No SANS 10142 checks applicable to current network.', detail: 'Add LV components (cables, transformers, CBs) to enable SANS 10142 checks.' });
    }

    return section;
  },

  // Distribution-board circuit schedules — the per-way verdicts from the
  // db-circuit-check engine (derated ampacity + Ib≤In≤Iz, voltage drop, ECC
  // size, earth-fault loop Zs).
  //
  // Until this existed, a board's ways produced ZERO compliance items: the
  // Cl. 5.5.2 and Cl. 5.6.3 checks above only walk `cable` SLD components, so
  // an undersized way inside a schedule was invisible to the report.
  MAX_DB_CIRCUIT_ITEMS: 60,

  _sans10142_dbCircuits(section) {
    const boards = [...AppState.components.values()]
      .filter(c => c.type === 'distribution_board' && (c.props?.circuits || []).length);
    if (boards.length === 0) return;   // not applicable, not a finding

    const res = AppState.dbCheckResults;
    if (!res || !Array.isArray(res.ways)) {
      section.items.push({
        status: 'info', component: '—',
        message: 'DB circuit check not run — per-way ampacity, voltage drop, ECC and earth-loop impedance are unverified.',
        detail: `${boards.length} distribution board(s) carry circuit schedules. Open the Schedules workspace and press "Check circuits" to verify each way against SANS 10142-1 Cl. 5.5.2 / 5.5.6 / 6.6 and IEC 60364-5-54 Table 54.7.`,
      });
      return;
    }

    const basis = res.basis || {};
    const basisNote = `Basis: ${basis.ampacity_basis || 'IEC 60364-5-52'}; disconnection on ${basis.fault_basis || 'the minimum-current basis'}.`;
    if (basis.load_flow_converged === false) {
      section.items.push({
        status: 'warn', component: '—',
        message: 'Voltage drop checked without upstream drop — load flow unavailable.',
        detail: 'SANS 10142-1 Cl. 6.6 limits the TOTAL drop from the point of supply. Run Load Flow so each way can be checked cumulatively rather than on its own length alone.',
      });
    }

    const flagged = res.ways.filter(w => w.status === 'fail' || w.status === 'warn');
    for (const w of flagged.slice(0, this.MAX_DB_CIRCUIT_ITEMS)) {
      section.items.push({
        status: w.status,
        component: `${w.board_name} way ${w.way}${w.description ? ' — ' + w.description : ''}`,
        message: (w.messages && w.messages[0]) || 'Circuit check finding.',
        detail: `${(w.messages || []).join(' · ')} — ${basisNote}`,
      });
    }
    if (flagged.length > this.MAX_DB_CIRCUIT_ITEMS) {
      section.items.push({
        status: 'info', component: '—',
        message: `${flagged.length - this.MAX_DB_CIRCUIT_ITEMS} further circuit finding(s) not listed.`,
        detail: 'Open the Schedules workspace for the full per-way breakdown.',
      });
    }

    for (const b of (res.boards || [])) {
      const c = b.counts || {};
      if (!b.way_count || c.fail || c.warn) continue;
      section.items.push({
        status: 'pass',
        component: b.name,
        message: `All ${b.way_count} way(s) comply — Ib ≤ In ≤ Iz, voltage drop, ECC size and earth-fault loop.`,
        detail: `${basisNote}${c.info ? ` ${c.info} way(s) could not be fully evaluated — see the Schedules workspace.` : ''}`,
      });
    }
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

  // SANS 10142-1 Cl. 5.5.2 / IEC 60364-4-43 §433.1: overload coordination.
  // [C3] Both conditions: In ≤ Iz AND I2 ≤ 1.45·Iz, with I2 the device's
  // conventional operating current (gG fuse 1.6 In above 16 A, so a fuse
  // needs In ≤ 0.91·Iz). In is a breaker's current SETTING Ir (trip rating ×
  // thermal pickup), not its frame, and Iz covers every parallel run — as
  // in the Cable Sizing study ([CS3]).
  _sans10142_cableProtection(section) {
    let checked = 0;

    for (const [cableId, comp] of AppState.components) {
      if (comp.type !== 'cable') continue;
      const cableName = comp.props?.name || cableId;
      const izOne = parseFloat(comp.props?.rated_amps); // Cable ampacity (Iz), per run
      const cableVoltageKV = this._resolveCableVoltage(cableId, comp);

      if (!(izOne > 0) || !cableVoltageKV || cableVoltageKV > 1.0) continue; // Only LV cables
      checked++;
      const n = this._cableBasics(comp).n;
      const iz = izOne * n;
      const izDesc = n > 1 ? `${n} × ${izOne} A = ${iz} A` : `${iz} A`;

      // Protective devices at either end of the cable (§433.2.2 allows the
      // overload device anywhere along a run without branches)
      const devices = this._findConnectedDevices(cableId, ['cb', 'fuse']);

      if (devices.length === 0) {
        section.items.push({
          status: 'warn',
          component: cableName,
          message: `LV cable has no upstream overcurrent protection device.`,
          detail: `Cable ampacity Iz = ${izDesc}. SANS 10142-1 Cl. 5.5.2 requires every LV circuit to be protected against overcurrent.`,
        });
        continue;
      }

      for (const dev of devices) {
        const devComp = AppState.components.get(dev.id);
        if (!devComp) continue;
        const devName = devComp.props?.name || dev.id;
        const ol = this._overloadCoord(devComp, iz);

        if (!ol) {
          section.items.push({
            status: 'warn',
            component: devName,
            message: this._relayTripping(dev.id)
              ? `Relay-tripped breaker — overload coordination with cable ${cableName} not evaluated here.`
              : `No rated current specified; cannot verify In ≤ Iz for cable ${cableName}.`,
            detail: `IEC 60364-4-43 §433.1 / SANS 10142-1 Cl. 5.5.2: In ≤ Iz = ${izDesc} and I2 ≤ 1.45·Iz. See the Cable Sizing study.`,
          });
          continue;
        }
        const i2Str = `I2 = ${ol.f}·In = ${ol.I2.toFixed(0)} A`;
        if (!ol.ok1) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Protection rating In (${ol.In.toFixed(0)} A) EXCEEDS cable ampacity Iz (${izDesc}). Cable ${cableName} is unprotected.`,
            detail: `IEC 60364-4-43 §433.1 / SANS 10142-1 Cl. 5.5.2 require In ≤ Iz (${ol.label}). Reduce the rating/setting or upsize the cable.`,
          });
        } else if (!ol.ok2) {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `${i2Str} EXCEEDS 1.45·Iz = ${(1.45 * iz).toFixed(0)} A for cable ${cableName} (In ${ol.In.toFixed(0)} A ≤ Iz ${izDesc}).`,
            detail: `IEC 60364-4-43 §433.1(b): the conventional operating current I2 must not exceed 1.45·Iz (${ol.label}). Use a device of In ≤ ${(1.45 * iz / ol.f).toFixed(0)} A or upsize the cable.`,
          });
        } else {
          section.items.push({
            status: 'pass',
            component: devName,
            message: `In (${ol.In.toFixed(0)} A) ≤ Iz (${izDesc}) and ${i2Str} ≤ 1.45·Iz for cable ${cableName}.`,
            detail: `Complies with IEC 60364-4-43 §433.1 / SANS 10142-1 Cl. 5.5.2 (${ol.label}). Protection margin: ${(((iz / ol.In) - 1) * 100).toFixed(1)}%.`,
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

      // [L2] Size from the library entry / ampacity calculator too — a
      // library pick does not write size_mm2, so the check skipped every
      // library cable.
      const sizeMm2 = this._cableBasics(comp).size;
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
      const vgStr = String(comp.props?.vector_group || 'Dyn11');
      const groundingLv = comp.props?.grounding_lv;
      const earthingSystem = comp.props?.earthing_system || 'TN-S';

      // [C5] IEC 60076-1 vector-group notation is case-sensitive: CAPITALS
      // are the HV winding, lower case the LV. Lower-casing the whole string
      // read the HV "YN" of a YNd11 as an earthed LV neutral (PASS for a
      // delta LV winding). As in the fault engine, the LV letter only says
      // delta (no neutral) or star/zigzag; for a star/zigzag winding the
      // grounding_lv prop is authoritative (a Dy11 with its neutral solidly
      // earthed is earthed), with the 'n' letter as the fallback when the
      // prop is absent.
      const lvPart = vgStr.replace(/^[A-Z]+/, '');        // "Dyn11" → "yn11", "YNd11" → "d11"
      const lvDelta = /^d/i.test(lvPart);
      const g = groundingLv == null ? null : String(groundingLv).toLowerCase();
      const lvEarthed = !lvDelta && (g == null
        ? /^(yn|zn)/i.test(lvPart)
        : !['ungrounded', 'isolated', 'none', 'unearthed'].includes(g));
      const lvSolidlyEarthed = lvEarthed && (g == null || g === 'solidly_grounded');

      if (lvDelta) {
        section.items.push({
          status: earthingSystem === 'IT' ? 'info' : 'warn',
          component: xfName,
          message: `LV winding is delta (${vgStr}) — no LV neutral${earthingSystem === 'IT' ? ', consistent with the declared IT system' : `, but ${earthingSystem} is declared`}.`,
          detail: earthingSystem === 'IT'
            ? 'SANS 10142-1 Cl. 8.3.1: IT systems have an unearthed source; an insulation-monitoring device is required. See the earthing-system check.'
            : `SANS 10142-1 Cl. 8.3.1: TN/TT systems require an earthed neutral at the LV source. Use a Dyn/Dzn winding, add an earthing transformer, or declare the system IT.`,
        });
      } else if (!lvEarthed) {
        // An ungrounded LV neutral is a fault for TN/TT, but is exactly what an
        // IT system declares — treat it as consistent when IT is selected.
        if (earthingSystem === 'IT') {
          section.items.push({
            status: 'info',
            component: xfName,
            message: `LV neutral ungrounded — consistent with the declared IT system.`,
            detail: `SANS 10142-1 Cl. 8.3.1: IT systems have an unearthed (or high-impedance) source neutral and require an insulation-monitoring device. See the earthing-system check.`,
          });
        } else {
          section.items.push({
            status: 'fail',
            component: xfName,
            message: `LV neutral is ungrounded (${vgStr}, declared ${earthingSystem}).`,
            detail: `SANS 10142-1 Cl. 8.3.1: the LV neutral must be earthed (solidly or via low-resistance) for TN/TT systems. Ungrounded LV is only permitted for IT systems with insulation monitoring.`,
          });
        }
      } else if (lvSolidlyEarthed) {
        section.items.push({
          status: 'pass',
          component: xfName,
          message: `LV neutral solidly earthed (${vgStr}) — ${earthingSystem} earthing confirmed.`,
          detail: `SANS 10142-1 Cl. 8.3.1: earthed neutral at LV source provides automatic disconnection capability.`,
        });
      } else {
        // Neutral earthed through an impedance (resistance / reactance grounded)
        section.items.push({
          status: 'warn',
          component: xfName,
          message: `LV neutral earthed via impedance (${g.replace(/_/g, ' ')}). Verify disconnection times.`,
          detail: `SANS 10142-1 Cl. 8.3.1: impedance-earthed LV neutrals increase earth fault loop impedance. Verify that disconnection times for all circuits comply with Cl. 5.5.6.`,
        });
      }
    }

    if (checked === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV distribution transformers (≤1 kV secondary) found for neutral earthing check.', detail: 'SANS 10142-1 Cl. 8.3.1 applies to transformers supplying LV premises installations.' });
    }
  },

  // Collect the declared earthing system of every LV source (transformer with
  // an LV secondary ≤1 kV, or a utility supplying at ≤1 kV), each with its
  // LV zone ([C4]): every component reachable from the source without
  // crossing a transformer or entering a bus above 1 kV. The earthing system
  // — and the RCDs that serve it — belong to that zone, not the project.
  _lvEarthingSources() {
    const out = [];
    const adj = this._getAdjacency();
    for (const [id, comp] of AppState.components) {
      let lvKV = null;
      if (comp.type === 'transformer') {
        lvKV = comp.props?.voltage_lv_kv ?? comp.props?.voltage_lv;
      } else if (comp.type === 'utility') {
        lvKV = comp.props?.voltage_kv ?? comp.props?.voltage;
      } else {
        continue;
      }
      if (!lvKV || lvKV > 1.0) continue;

      // A transformer enters its zone through its LV port only
      let start = adj.get(id) || [];
      if (comp.type === 'transformer') {
        const lvPort = comp.props?.winding_config === 'step_up' ? 'primary' : 'secondary';
        start = [];
        for (const w of AppState.wires.values()) {
          if (w.fromComponent === id && w.fromPort === lvPort) start.push(w.toComponent);
          if (w.toComponent === id && w.toPort === lvPort) start.push(w.fromComponent);
        }
      }
      const zone = new Set([id]);
      const queue = [];
      for (const nb of start) {
        const c = AppState.components.get(nb);
        if (!c || zone.has(nb) || c.type === 'transformer' || c.type === 'autotransformer') continue;
        zone.add(nb);
        queue.push(nb);
      }
      while (queue.length) {
        const cur = queue.shift();
        if (this._isOpen(AppState.components.get(cur))) continue;
        for (const nb of adj.get(cur) || []) {
          if (zone.has(nb)) continue;
          const c = AppState.components.get(nb);
          if (!c || c.type === 'transformer' || c.type === 'autotransformer') continue;
          if (c.type === 'bus' && parseFloat(c.props?.voltage_kv) > 1.0) continue;
          zone.add(nb);
          queue.push(nb);
        }
      }

      out.push({
        id, comp, zone,
        system: comp.props?.earthing_system || 'TN-S',
        r_a: Number(comp.props?.earth_electrode_r_installation) || 0,
        r_b: Number(comp.props?.earth_electrode_r_source) || 0,
      });
    }
    return out;
  },

  // Earthing systems of the LV zones containing compId (empty when no LV
  // source reaches it — treated as TN-S, the engine default)
  _earthingOf(compId, sources) {
    return [...new Set(sources.filter(s => s.zone.has(compId)).map(s => s.system))];
  },

  // [C4] Residual-current devices in an LV zone and the largest IΔn (A):
  // a distribution board's earth-leakage groups (el_ratings, mA; 300 mA
  // assumed when a group has no rating) and a CB's integral earth-fault
  // release (ef_trip_ct, pickup ef_pickup_a in A). The old check read only
  // board ratings project-wide and took 300 mA for a CB release — a 5 A
  // release on R_A = 20 Ω (100 V) passed as 6 V.
  _residualDevices(zone) {
    let present = false;
    let idnA = 0;
    const unset = [];
    for (const id of zone) {
      const comp = AppState.components.get(id);
      if (!comp) continue;
      if (comp.type === 'distribution_board') {
        const groups = new Set((comp.props?.circuits || [])
          .map(c => String(c.el_group || '').trim()).filter(Boolean));
        if (!groups.size) continue;
        present = true;
        const ratings = (comp.props?.el_ratings && typeof comp.props.el_ratings === 'object')
          ? comp.props.el_ratings : {};
        for (const g of groups) idnA = Math.max(idnA, (Number(ratings[g]) || 300) / 1000);
      } else if (comp.type === 'cb' && comp.props?.ef_trip_ct) {
        present = true;
        const a = parseFloat(comp.props?.ef_pickup_a);
        if (a > 0) idnA = Math.max(idnA, a);
        else unset.push(comp.props?.name || id);
      }
    }
    return { present, idnA, unset };
  },

  // SANS 10142-1 Cl. 6 / IEC 60364-1 §312: LV earthing-system arrangement and
  // the protective measure each type requires (RCD for TT, insulation
  // monitoring for IT, no RCD on a combined PEN for TN-C).
  _sans10142_earthingSystem(section) {
    const sources = this._lvEarthingSources();
    if (sources.length === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV sources (≤1 kV) found for earthing-system check.', detail: 'IEC 60364-1 §312 applies to LV installations supplied by a transformer or utility at ≤1 kV.' });
      return;
    }
    for (const s of sources) {
      const name = s.comp.props?.name || s.id;
      const rcd = this._residualDevices(s.zone);
      switch (s.system) {
        case 'TN-S':
          section.items.push({
            status: 'pass', component: name,
            message: `TN-S: separate neutral and protective conductors — metallic earth-fault return.`,
            detail: `IEC 60364-1 §312.2.1.1: overcurrent devices provide automatic disconnection (verify Cl. 5.5.6). RCDs are permitted for additional protection.`,
          });
          break;
        case 'TN-C-S':
          section.items.push({
            status: 'info', component: name,
            message: `TN-C-S (PME): combined PEN upstream, split to N + PE at the installation.`,
            detail: `IEC 60364-1 §312.2.1.3 / SANS 10142-1: any RCD must sit downstream of the N/PE separation point — an RCD cannot operate on the combined PEN.`,
          });
          break;
        case 'TN-C':
          section.items.push({
            status: rcd.present ? 'fail' : 'warn', component: name,
            message: rcd.present
              ? `TN-C with a residual-current device in its installation — an RCD cannot operate on a combined PEN.`
              : `TN-C: combined PEN throughout — RCD protection is not possible.`,
            detail: `IEC 60364-4-41 §411.4.5 / SANS 10142-1: RCDs are not permitted in TN-C. Ensure PEN continuity and adequate cross-section. Use TN-S or TN-C-S where earth-leakage protection is required.`,
          });
          break;
        case 'TT':
          if (!rcd.present) {
            section.items.push({
              status: 'fail', component: name,
              message: `TT system without an RCD in its installation — overcurrent devices cannot guarantee earth-fault disconnection.`,
              detail: `IEC 60364-4-41 §411.5 / SANS 10142-1: TT earth-fault current returns through soil (R_A + R_B), so an RCD is required. Add an earth-leakage device.`,
            });
          } else if (rcd.idnA <= 0) {
            section.items.push({
              status: 'warn', component: name,
              message: `TT with an earth-fault release whose pickup is not set (${rcd.unset.join(', ')}) — R_A·IΔn ≤ 50 V cannot be verified.`,
              detail: `IEC 60364-4-41 §411.5.3: set the E/F pickup of the breaker's earth-fault release.`,
            });
          } else {
            const touch = s.r_a * rcd.idnA;
            const ok = touch <= 50;
            const idnStr = rcd.idnA < 1 ? `${(rcd.idnA * 1000).toFixed(0)} mA` : `${rcd.idnA.toFixed(1)} A`;
            section.items.push({
              status: ok ? 'pass' : 'fail', component: name,
              message: `TT with RCD: R_A·IΔn = ${s.r_a.toFixed(1)} Ω × ${idnStr} = ${touch.toFixed(1)} V ${ok ? '≤' : '>'} 50 V.`,
              detail: `IEC 60364-4-41 §411.5.3 / SANS 10142-1: R_A·IΔn ≤ 50 V is required (the least sensitive residual device in this installation).${rcd.unset.length ? ` Earth-fault release pickup not set: ${rcd.unset.join(', ')}.` : ''} ${ok ? 'Complies.' : 'Reduce R_A (improve the installation earth electrode) or fit a more sensitive RCD.'}`,
            });
          }
          break;
        case 'IT':
          section.items.push({
            status: 'warn', component: name,
            message: `IT system: source unearthed / high-impedance — the first earth fault does not disconnect.`,
            detail: `IEC 60364-4-41 §411.6 / SANS 10142-1: IT installations require an insulation-monitoring device (IMD); a second earth fault is cleared as in TN/TT. Permitted only where continuity of supply is justified.`,
          });
          break;
        default:
          section.items.push({
            status: 'info', component: name,
            message: `Earthing system '${s.system}' not recognised.`,
            detail: `Set the LV source earthing system to one of TN-S, TN-C, TN-C-S, TT or IT.`,
          });
      }
    }
  },

  // SANS 10142-1 Appendix B / NRS 034: Maximum demand vs supply capacity.
  // [C6] Nameplate-based (no load flow needed): the diversified rating of
  // every LV load against the installed LV transformer capacity. The old
  // check read p_mw / rated_mw / rated_mva — props no load has — so it
  // summed zero and never produced a result.
  _sans10142_maxDemand(section) {
    // Sum rated MVA of all LV-side transformers (supply to premises)
    let totalXfMVA = 0;
    const xfNames = [];
    for (const comp of AppState.components.values()) {
      if (comp.type !== 'transformer') continue;
      const lvKV = comp.props?.voltage_lv_kv ?? comp.props?.voltage_lv;
      if (!lvKV || lvKV > 1.0) continue;
      const mva = parseFloat(comp.props?.rated_mva) || 0;
      totalXfMVA += mva;
      xfNames.push(comp.props?.name || 'unnamed');
    }

    // Diversified LV demand, P and Q summed as vectors
    let totalKW = 0;
    let totalKVAR = 0;
    for (const comp of AppState.components.values()) {
      const d = this._loadDemandKva(comp);
      if (!d) continue;
      let v = parseFloat(comp.props?.voltage_kv);
      if (!(v > 0)) {
        const b = this._findConnectedDevices(comp.id, ['bus'])[0];
        v = parseFloat(b && AppState.components.get(b.id)?.props?.voltage_kv);
      }
      if (!(v > 0) || v > 1.0) continue;
      totalKW += d.kva * d.pf;
      totalKVAR += d.kva * Math.sqrt(Math.max(0, 1 - d.pf * d.pf));
    }
    const totalLoadMVA = Math.sqrt(totalKW ** 2 + totalKVAR ** 2) / 1000;

    if (totalXfMVA > 0 && totalLoadMVA > 0) {
      const utilPct = (totalLoadMVA / totalXfMVA) * 100;
      const basis = 'Nameplate demand × demand factor of each LV load (induction motors at input kVA = kW/(η·pf)).';
      if (utilPct > 100) {
        section.items.push({
          status: 'fail',
          component: '—',
          message: `Total LV load (${totalLoadMVA.toFixed(3)} MVA) EXCEEDS installed LV transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Utilisation: ${utilPct.toFixed(1)}%. ${basis} SANS 10142-1 Appendix B / NRS 034: maximum demand must not exceed supply capacity. Increase transformer rating or reduce demand.`,
        });
      } else if (utilPct > 80) {
        section.items.push({
          status: 'warn',
          component: '—',
          message: `LV demand (${totalLoadMVA.toFixed(3)} MVA) is ${utilPct.toFixed(1)}% of transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Above 80% utilisation. ${basis} SANS 10142-1 Appendix B: consider diversity factors and apply demand factor analysis. Limited capacity for load growth or derating.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: '—',
          message: `LV maximum demand (${totalLoadMVA.toFixed(3)} MVA) within transformer capacity (${totalXfMVA.toFixed(3)} MVA).`,
          detail: `Utilisation: ${utilPct.toFixed(1)}%. ${basis} Complies with SANS 10142-1 Appendix B supply capacity requirement. Transformers: ${xfNames.join(', ')}.`,
        });
      }
    } else if (totalXfMVA === 0 && totalLoadMVA === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV transformers or LV loads found for maximum demand check.', detail: 'SANS 10142-1 Appendix B: supply capacity analysis requires LV transformers and LV loads.' });
    } else if (totalXfMVA === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV distribution transformer found; cannot evaluate maximum demand against supply capacity.', detail: 'Add a transformer with an LV secondary (≤1 kV) to enable this check.' });
    } else {
      section.items.push({ status: 'info', component: '—', message: 'No rated LV loads found for maximum demand check.', detail: 'Set the rating of the LV loads (kVA, or kW for induction motors) to compare demand against transformer capacity.' });
    }
  },

  // Diversified apparent demand {kva, pf} of a load from its nameplate
  _loadDemandKva(comp) {
    const p = comp.props || {};
    const df = p.demand_factor != null && p.demand_factor !== '' ? (parseFloat(p.demand_factor) || 0) : 1;
    const pf = Math.min(1, Math.abs(parseFloat(p.power_factor)) || 0.85);
    if (comp.type === 'static_load' || comp.type === 'distribution_board' || comp.type === 'motor_synchronous') {
      const kva = parseFloat(p.rated_kva) || 0;
      return kva > 0 ? { kva: kva * df, pf } : null;
    }
    if (comp.type === 'motor_induction') {
      const kw = parseFloat(p.rated_kw) || 0;
      const eff = parseFloat(p.efficiency) || 0.93;
      return kw > 0 ? { kva: kw / (eff * pf) * df, pf } : null;
    }
    return null;
  },

  // SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41 §411.4: automatic disconnection
  // on LV TN systems — the device must clear the earth fault at the END of
  // the circuit it protects within the Table 41.1 / §411.3.2.3 time.
  //
  // [C1] Each device is judged at the far end of its circuit: the node with
  // the smallest minimum-study Ik1 among the buses (or bus-less load
  // terminals) on its load side, reached through its cable and non-
  // protective series devices. The old check looped over buses and judged
  // every device on a bus at THAT bus's Ik1 — an outgoing feeder breaker at
  // its supply-end fault level, where it always trips instantaneously. A
  // 32 A type-C MCB on 60 m of 4 mm² (Ik1 287 A at the socket end, 1.98 s)
  // passed at the board's 1026 A.
  //
  // [C4] The TN criterion applies per LV installation: devices in a TT or
  // IT zone are covered by the earthing-system check; a TT source elsewhere
  // in the project no longer switches the check off for the TN parts.
  _sans10142_earthFaultCurrent(section) {
    if (!this._hasFault()) {
      section.items.push({ status: 'info', component: '—', message: 'Earth fault disconnection check: fault analysis not run.', detail: 'Run Fault Analysis to verify minimum earth fault current for disconnection per SANS 10142-1 Cl. 5.5.6.' });
      return;
    }

    const LV_THRESHOLD_KV = 1.0;
    const DISCONNECTION_FACTOR = 10; // legacy proxy: Isc ≥ 10 × In implies instantaneous trip
    const sources = this._lvEarthingSources();
    const isTN = (compId) => {
      const sys = this._earthingOf(compId, sources);
      return sys.length === 0 || sys.every(x => String(x).startsWith('TN'));
    };

    // [PS-3] Disconnection must be verified against the MINIMUM earth-fault
    // current (IEC 60909-0 §5.3.1: c_min = 0.95, hot-conductor resistance),
    // not the maximum-current study — c_max + cold conductors overstate Ik1
    // by ≥16 %, passing circuits the standard fails. app.js fetches the
    // companion minimum study into AppState.faultResultsMin on every fault
    // run; older saved results fall back to the maximum figures with a
    // warning so the report is explicit about its basis.
    const maxBuses = AppState.faultResults.buses;
    const minBuses = AppState.faultResultsMin?.buses || null;
    const usingMin = !!(minBuses && Object.keys(minBuses).length > 0);
    const useBuses = usingMin ? minBuses : maxBuses;
    const basisNote = usingMin
      ? 'Basis: minimum-current study (c_min = 0.95, conductors at their end-of-fault temperature — PVC 160 °C, XLPE 250 °C) per IEC 60909-0 §2.5'
      : 'Basis: MAXIMUM-current study (c_max = 1.10, 20 °C) — re-run Fault Analysis to compute the minimum-current study; these PASS verdicts are optimistic';
    if (!usingMin) {
      section.items.push({
        status: 'warn', component: '—',
        message: 'Minimum earth-fault current study not available — disconnection checked against maximum-current figures.',
        detail: 'IEC 60909-0 §5.3.1 / SANS 10142-1 Cl. 5.5.6 require disconnection to be verified with c_min = 0.95 and hot-conductor resistance. Re-run Fault Analysis (the companion minimum study is fetched automatically).',
      });
    }
    const nodeKv = (n) => {
      const bc = AppState.components.get(n.key);
      const v = parseFloat(bc?.props?.voltage_kv ?? bc?.props?.voltage);
      return v > 0 ? v : (parseFloat(maxBuses[n.key]?.voltage_kv) || 0);
    };

    let checked = 0;
    const covered = new Set();
    const nonTN = new Set();

    for (const [devId, devComp] of AppState.components) {
      if (devComp.type !== 'cb' && devComp.type !== 'fuse') continue;
      if (this._isOpen(devComp)) continue;

      // The device's circuit: every fault node reached through its cable and
      // non-protective series devices; the load side is what it protects.
      const zone = this._faultNodes(devId, this._ZONE_TYPES).filter(n => useBuses[n.key]);
      if (zone.length === 0) continue;
      if (!zone.every(n => { const v = nodeKv(n); return v > 0 && v <= LV_THRESHOLD_KV; })) continue;
      let loadSide = zone.filter(n => !this._leadsToSource(n.compId, devId));
      if (loadSide.length === 0) loadSide = zone; // supply side not resolved
      const tnSide = loadSide.filter(n => isTN(n.compId));
      for (const n of loadSide) if (!isTN(n.compId)) this._earthingOf(n.compId, sources).forEach(x => nonTN.add(x));
      if (tnSide.length === 0) continue;

      let far = null;
      for (const n of tnSide) {
        const ik1 = useBuses[n.key]?.ik1;
        if (ik1 == null) continue;
        if (!far || ik1 < far.ik1) far = { ...n, ik1 };
      }
      if (!far) continue;
      tnSide.forEach(n => covered.add(n.key));
      checked++;

      const devName = devComp.props?.name || devId;
      const farName = far.name;
      const islgA = far.ik1 * 1000;
      const nominalKV = nodeKv(far);

      // [R3/PS-1 fallback] A per-path fallback on a meshed topology
      // OVERSTATES the fault current — a disconnection PASS built on it is
      // unreliable. Refuse to verify rather than silently pass.
      if (useBuses[far.key]?.thevenin_basis === 'per-path-fallback'
          || maxBuses[far.key]?.thevenin_basis === 'per-path-fallback') {
        section.items.push({
          status: 'fail',
          component: devName,
          message: `Disconnection cannot be verified at ${farName} — the fault current is a per-path fallback on a meshed topology (nodal solve failed) and is overstated.`,
          detail: 'The meshed-network Thevenin solution failed and the engine fell back to the per-path combination, which overstates earth-fault current. A disconnection PASS on this basis would be non-conservative; simplify or correct the network model and re-run Fault Analysis.',
        });
        continue;
      }

      const in_ = parseFloat(devComp.props?.rated_current_a);
      if (!(in_ > 0)) continue;

      // [PS-3] Primary criterion: the device's actual disconnection time at
      // the minimum earth-fault current vs the SANS 10142-1 / IEC 60364-4-41
      // limit. [R3 Finding 12] The limit is keyed on CIRCUIT TYPE and U0
      // (Table 41.1 / §411.3.2.2-3), not on In alone — the old `In ≤ 32`
      // proxy was non-conservative for 33-63 A socket-outlet finals and for
      // U0 > 230 V, and conservative for ≤32 A distribution circuits.
      //   final_socket : Table 41.1 up to In ≤ 63 A (§411.3.2.2)
      //   final_fixed  : Table 41.1 up to In ≤ 32 A
      //   distribution : 5 s (§411.3.2.3)
      //   undeclared   : assumed FINAL (conservative) up to 63 A, else 5 s
      // Table 41.1 (TN), keyed on nominal U0 = V_LL/√3 with band tolerance:
      // ≤120 V → 0.8 s · ≤230 V → 0.4 s · ≤400 V → 0.2 s · >400 V → 0.1 s.
      const circuitType = devComp.props?.circuit_type || '';
      const u0 = (nominalKV * 1000) / Math.sqrt(3);
      const t411 = u0 <= 132 ? 0.8 : u0 <= 253 ? 0.4 : u0 <= 440 ? 0.2 : 0.1;
      const finalCapA = circuitType === 'final_fixed' ? 32 : 63;
      let tLimit;
      let limitBasis;
      if (circuitType === 'distribution') {
        tLimit = 5.0;
        limitBasis = 'distribution circuit — 5 s per IEC 60364-4-41 §411.3.2.3';
      } else if (in_ > finalCapA) {
        tLimit = 5.0;
        limitBasis = `In = ${in_} A exceeds the §411.3.2.2 final-circuit scope (≤ ${finalCapA} A) — 5 s per §411.3.2.3`;
      } else {
        tLimit = t411;
        limitBasis = `${circuitType ? (circuitType === 'final_socket' ? 'socket-outlet final circuit' : 'fixed-equipment final circuit') : 'circuit type not set — assumed final circuit (conservative)'} — Table 41.1 at U0 = ${u0.toFixed(0)} V`;
      }

      const ct = this._deviceClearTime(devComp, islgA, true);
      if (ct.t === null) {
        section.items.push({
          status: 'info', component: devName,
          message: `${ct.why} — earth-fault disconnection at ${farName} (Ik1 = ${islgA.toFixed(0)} A) not evaluated here.`,
          detail: `Check the relay's operating time at ${islgA.toFixed(0)} A against the ${tLimit} s limit (${limitBasis}) in the TCC view. ${basisNote}.`,
        });
        continue;
      }
      const tDisc = ct.t;
      const where = `at the far end ${farName}`;

      if (tDisc != null && isFinite(tDisc)) {
        if (tDisc <= tLimit) {
          section.items.push({
            status: 'pass',
            component: devName,
            message: `Disconnects in ${tDisc < 0.01 ? '<0.01' : tDisc.toFixed(2)} s at Ik1 = ${islgA.toFixed(0)} A ${where} (limit ${tLimit} s). Automatic disconnection confirmed.`,
            detail: `SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41: ${ct.desc} operating time evaluated at the earth-fault current at the end of its circuit vs the ${tLimit} s disconnection limit (${limitBasis}). ${basisNote}.`,
          });
        } else {
          section.items.push({
            status: 'fail',
            component: devName,
            message: `Takes ${tDisc.toFixed(2)} s to clear Ik1 = ${islgA.toFixed(0)} A ${where} — exceeds the ${tLimit} s disconnection limit.`,
            detail: `SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41: disconnection within ${tLimit} s (${limitBasis}) not achieved at the ${usingMin ? 'minimum' : 'available'} earth-fault current at the end of the circuit. Reduce loop impedance, lower the device rating/pickup, add an RCD — or set the device's Circuit Type if this is a distribution circuit (5 s limit). ${basisNote}.`,
          });
        }
        continue;
      }
      if (tDisc === Infinity) {
        section.items.push({
          status: 'fail',
          component: devName,
          message: `Does not operate at Ik1 = ${islgA.toFixed(0)} A ${where} — the ${tLimit} s disconnection limit is not met.`,
          detail: `SANS 10142-1 Cl. 5.5.6 / IEC 60364-4-41: ${ct.desc} does not trip at the earth-fault current at the end of its circuit (${limitBasis}). Reduce loop impedance, lower the pickup or add an RCD. ${basisNote}.`,
        });
        continue;
      }

      // No usable curve — fall back to the legacy 10×In screening proxy.
      const requiredIscA = in_ * DISCONNECTION_FACTOR;
      if (islgA < requiredIscA) {
        section.items.push({
          status: 'fail',
          component: devName,
          message: `Earth fault current (${islgA.toFixed(0)} A ${where}) may be insufficient to guarantee instantaneous trip (In = ${in_} A).`,
          detail: `SANS 10142-1 Cl. 5.5.6: for TN systems, single-line-to-ground fault current should be ≥ 10 × In = ${requiredIscA.toFixed(0)} A for instantaneous disconnection (device curve not evaluable). ${basisNote}.`,
        });
      } else {
        section.items.push({
          status: 'pass',
          component: devName,
          message: `Earth fault current (${islgA.toFixed(0)} A ${where}) ≥ 10 × In (${requiredIscA.toFixed(0)} A). Automatic disconnection confirmed.`,
          detail: `SANS 10142-1 Cl. 5.5.6: sufficient earth fault current for instantaneous disconnection in TN system (device curve not evaluable). ${basisNote}.`,
        });
      }
    }

    // LV TN buses no device's circuit reaches — nothing verifiable disconnects them
    for (const [busId, fr] of Object.entries(maxBuses)) {
      const busComp = AppState.components.get(busId);
      if (!busComp || busComp.type !== 'bus' || covered.has(busId)) continue;
      const v = parseFloat(busComp.props?.voltage_kv ?? busComp.props?.voltage);
      if (!(v > 0) || v > LV_THRESHOLD_KV || fr.ik1 == null || !isTN(busId)) continue;
      checked++;
      const busName = busComp.props?.name || busId;
      section.items.push({
        status: 'warn',
        component: busName,
        message: `No LV protective device found on the circuit feeding this bus — earth fault disconnection cannot be verified.`,
        detail: `Earth fault current Ik1 = ${((useBuses[busId]?.ik1 ?? fr.ik1) * 1000).toFixed(0)} A at ${busName}. Add a circuit breaker or fuse (e.g. an LV incomer) to enable the SANS 10142-1 Cl. 5.5.6 disconnection check. ${basisNote}.`,
      });
    }

    if (nonTN.size) {
      section.items.push({
        status: 'info', component: '—',
        message: `Circuits in ${[...nonTN].join(', ')} installations are assessed by the earthing-system check.`,
        detail: `SANS 10142-1: the overcurrent disconnection criterion applies to TN systems. TT (RCD, R_A·IΔn ≤ 50 V) and IT (insulation monitoring) are verified in the earthing-system check above.`,
      });
    }

    if (checked === 0) {
      section.items.push({ status: 'info', component: '—', message: 'No LV TN circuits with earth fault data found for disconnection check.', detail: 'SANS 10142-1 Cl. 5.5.6 applies to LV TN system circuits (nominal voltage ≤ 1 kV).' });
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

  // Series devices the protection walkers cross (backend TRANSPARENT_TYPES)
  _TRANSPARENT: ['cb', 'fuse', 'switch', 'changeover', 'ct', 'pt', 'surge_arrester'],
  // A protective device's own circuit: its cable and non-protective series
  // devices — another CB/fuse starts another circuit, a transformer another
  // system
  _ZONE_TYPES: ['switch', 'changeover', 'ct', 'pt', 'surge_arrester', 'cable', 'bus_duct'],
  // As cable_sizing._SOURCE_TYPES
  _SOURCE_TYPES: ['utility', 'generator', 'solar_pv', 'wind_turbine'],

  _isOpen(c) {
    return !!c && (c.type === 'cb' || c.type === 'switch') && c.props?.state === 'open';
  },

  // True when a source is reachable from startId without passing back
  // through excludeId — startId lies on the supply side of excludeId.
  // Mirrors cable_sizing._leads_to_source; open CBs/switches are not crossed.
  _leadsToSource(startId, excludeId) {
    const adj = this._getAdjacency();
    const visited = new Set([excludeId, startId]);
    const stack = [startId];
    while (stack.length) {
      const id = stack.pop();
      const c = AppState.components.get(id);
      if (!c) continue;
      if (this._SOURCE_TYPES.includes(c.type)) return true;
      if (this._isOpen(c)) continue;
      for (const nb of adj.get(id) || []) {
        if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
      }
    }
    return false;
  },

  // Fault-result nodes at the boundary of a walk from startId through the
  // `through` component types: buses, and the synthetic terminal node the
  // fault engine gives a load/source fed through a cable with no bus of its
  // own (`__term__<id>`, kept in fault results). → [{ key, compId, name }]
  _faultNodes(startId, through) {
    const adj = this._getAdjacency();
    const results = AppState.faultResults?.buses || {};
    const visited = new Set([startId]);
    const queue = [startId];
    const out = [];
    while (queue.length) {
      for (const nb of adj.get(queue.shift()) || []) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const c = AppState.components.get(nb);
        if (!c) continue;
        if (c.type === 'bus') { out.push({ key: nb, compId: nb, name: c.props?.name || nb }); continue; }
        const term = '__term__' + nb;
        if (results[term]) { out.push({ key: term, compId: nb, name: `${c.props?.name || nb} terminals` }); continue; }
        if (through.includes(c.type) && !this._isOpen(c)) queue.push(nb);
      }
    }
    return out;
  },

  // [C2] The device that clears a fault in the cable: the nearest CB/fuse on
  // its supply side (cable_sizing._find_protective_device). Falls back to a
  // load-side device when no supply side resolves (no source modelled).
  _cableDevice(cableId) {
    const adj = this._getAdjacency();
    const visited = new Set([cableId]);
    const stack = [...(adj.get(cableId) || [])];
    let fallback = null;
    while (stack.length) {
      const id = stack.pop();
      if (visited.has(id)) continue;
      visited.add(id);
      const c = AppState.components.get(id);
      if (!c) continue;
      if (c.type === 'cb' || c.type === 'fuse') {
        if (this._leadsToSource(id, cableId)) return c;
        if (!fallback) fallback = c;
        continue;
      }
      if ((this._TRANSPARENT.includes(c.type) || c.type === 'bus' || c.type === 'distribution_board')
          && !this._isOpen(c)) {
        for (const nb of adj.get(id) || []) if (!visited.has(nb)) stack.push(nb);
      }
    }
    return fallback;
  },

  // An overcurrent relay set to trip this breaker (relay.trip_cb)
  _relayTripping(cbId) {
    for (const c of AppState.components.values()) {
      if (c.type === 'relay' && c.props?.trip_cb === cbId) return c;
    }
    return null;
  },

  _cbParams(dev) {
    const p = dev.props || {};
    return {
      cb_type: p.cb_type || 'mccb',
      trip_rating_a: p.trip_rating_a || p.rated_current_a,
      thermal_pickup: p.thermal_pickup || 1.0,
      magnetic_pickup: p.magnetic_pickup || 10,
      long_time_delay: p.long_time_delay || 10,
      short_time_pickup: p.short_time_pickup || 0,
      short_time_delay: p.short_time_delay || 0,
      instantaneous_pickup: p.instantaneous_pickup || 0,
      trip_unit_kind: p.trip_unit_kind || '',
    };
  },

  // Clearing time of a CB/fuse at currentA, from the TCC curve models (a gG
  // fuse's total clearing = 1.2 × pre-arc). → { t, desc, why }:
  //   t number  — seconds (Infinity: never operates)
  //   t null    — relay-tripped breaker: its time is the relay's, through
  //               its CT (evaluated by the Cable Sizing study and the TCC)
  //   t undefined — no rating, no curve
  // earthFault: a breaker's integral earth-fault release (ef_trip_ct,
  // ef_pickup_a, ef_delay_s) also acts.
  _deviceClearTime(dev, currentA, earthFault = false) {
    const p = dev.props || {};
    if (dev.type === 'fuse') {
      const In = parseFloat(p.rated_current_a);
      const desc = `gG fuse ${In} A (total clearing = 1.2× pre-arc)`;
      if (!(In > 0)) return { t: undefined, desc };
      const pre = fuseTripTime(In, currentA);
      if (pre == null) return { t: undefined, desc };
      return { t: isFinite(pre) ? pre * 1.2 : Infinity, desc };
    }
    const relay = this._relayTripping(dev.id);
    if (relay) return { t: null, desc: '', why: `Breaker tripped by relay ${relay.props?.name || relay.id}` };
    const params = this._cbParams(dev);
    const desc = `${String(params.cb_type).toUpperCase()} trip unit, Ir = ${(params.trip_rating_a * params.thermal_pickup)} A`;
    if (!params.trip_rating_a) return { t: undefined, desc };
    let t = cbTripTime(params, currentA);
    if (t == null) t = Infinity;
    if (earthFault && p.ef_trip_ct) {
      const efA = parseFloat(p.ef_pickup_a);
      if (efA > 0 && currentA >= efA) {
        const tef = (parseFloat(p.ef_delay_s) || 0) + 0.02;
        if (tef < t) return { t: tef, desc: `earth-fault release ${efA} A / ${parseFloat(p.ef_delay_s) || 0} s` };
      }
    }
    return { t, desc };
  },

  // Cable construction: cross-section, conductor, insulation, parallel runs.
  // Library entry first, then the ampacity-calculator block, then props.
  _cableBasics(comp) {
    const p = comp.props || {};
    const std = STANDARD_CABLES.find(c => c.id === (p.standard_type || ''));
    const amp = (p.ampacity && p.ampacity.applied) ? p.ampacity : null;
    const size = Number((std && std.size_mm2) || (amp && amp.size_mm2) || p.size_mm2) || 0;
    const cond = String((std && std.conductor) || (amp && amp.conductor) || p.conductor || 'Cu');
    const ins = String((std && std.insulation) || (amp && amp.insulation) || p.insulation || 'XLPE').toUpperCase();
    return {
      size,
      conductor: cond.toLowerCase().startsWith('al') ? 'Al' : 'Cu',
      insulation: ins,
      n: Math.max(1, parseInt(p.num_parallel, 10) || 1),
    };
  },

  // Adiabatic k, IEC 60364-4-43 Table 43A (as cable_sizing._k_factor): PVC
  // above 300 mm² has a 140 °C final temperature — 103 Cu / 68 Al; an
  // insulation not in the table takes the conductor's PVC value.
  _kFactor(conductor, insulation, size) {
    const al = conductor === 'Al';
    if (insulation === 'XLPE' || insulation === 'EPR') return al ? 94 : 143;
    if (insulation === 'BARE') return al ? 84 : 129;
    if (insulation === 'PVC' && size > 300) return al ? 68 : 103;
    return al ? 76 : 115;
  },

  // IEC 60909-0 §12 dc heat factor m (as fault.thermal_m_factor)
  _thermalM(kappa, t, f) {
    if (!kappa || kappa <= 1 + 1e-9 || !(t > 0) || !(f > 0)) return 0;
    const x = Math.log(Math.min(kappa, 2) - 1);
    if (Math.abs(x) < 1e-9) return 2;
    const ft = f * t;
    return (Math.exp(4 * ft * x) - 1) / (2 * ft * x);
  },

  // [C3] IEC 60364-4-43 §433.1 overload coordination of a device with a
  // cable of installed rating izTotal (as cable_sizing._overload_device):
  // In = a breaker's setting Ir (trip rating × thermal pickup) or a fuse's
  // rating; I2 = 1.45 In (IEC 60898-1 MCB), 1.30 Ir (IEC 60947-2 MCCB/ACB),
  // 1.6 / 1.9 / 2.1 In (IEC 60269 gG, In ≥ 16 / ≥ 4 / < 4 A). null when not
  // evaluable (no rating, relay-tripped breaker).
  _overloadCoord(dev, izTotal) {
    const p = dev.props || {};
    let In, f, label;
    if (dev.type === 'fuse') {
      In = parseFloat(p.rated_current_a);
      f = In >= 16 ? 1.6 : In >= 4 ? 1.9 : 2.1;
      label = `gG fuse, I2 = ${f}·In (IEC 60269)`;
    } else {
      if (this._relayTripping(dev.id)) return null;
      In = (parseFloat(p.trip_rating_a) || parseFloat(p.rated_current_a)) * (parseFloat(p.thermal_pickup) || 1);
      const mcb = String(p.cb_type || 'mccb').toLowerCase() === 'mcb';
      f = mcb ? 1.45 : 1.30;
      label = mcb ? 'MCB, I2 = 1.45·In (IEC 60898-1)' : `${String(p.cb_type || 'mccb').toUpperCase()} setting Ir, I2 = 1.30·Ir (IEC 60947-2)`;
    }
    if (!(In > 0) || !(izTotal > 0)) return null;
    const I2 = f * In;
    return { In, I2, f, label, ok1: In <= izTotal * (1 + 1e-9), ok2: I2 <= 1.45 * izTotal * (1 + 1e-9) };
  },

  // IEC 60038 Um for a nominal system voltage above 1 kV (as
  // duty_check.highest_system_voltage_kv: smallest standard Um ≥ 1.05·Un)
  _highestSystemVoltageKv(unKv) {
    if (unKv <= 1.0) return unKv;
    for (const um of [3.6, 7.2, 12, 17.5, 24, 36, 40.5, 52, 72.5, 100, 123, 145, 170, 245, 300, 362, 420, 550, 800]) {
      if (um >= 1.05 * unKv - 1e-9) return um;
    }
    return unKv * 1.1;
  },


  _hasFault() {
    return !!(AppState.faultResults && AppState.faultResults.buses && Object.keys(AppState.faultResults.buses).length > 0);
  },

  // Under-rated protective devices, keyed by component id → { level, reasons }.
  // Nameplate-only checks (rated voltage vs bus, dedicated-motor FLC) always
  // apply; the breaking-capacity-vs-fault check adds when fault results exist.
  // Powers the on-diagram warning markers (Canvas) and is cheap enough to call
  // per render for typical networks.
  deviceRatingFlags() {
    this._adj = null; // rebuild the wire adjacency for this pass
    const flags = new Map();
    const add = (id, level, reason) => {
      const f = flags.get(id) || { level: 'warn', reasons: [] };
      if (level === 'fail') f.level = 'fail';
      f.reasons.push(reason);
      flags.set(id, f);
    };

    // Rated voltage below the connected bus voltage
    for (const [id, comp] of AppState.components) {
      if (!['cb', 'fuse', 'switch', 'changeover'].includes(comp.type)) continue;
      const ratedV = parseFloat(comp.props?.rated_voltage_kv);
      if (!(ratedV > 0)) continue;
      for (const b of this._findConnectedDevices(id, ['bus'])) {
        const busV = parseFloat(AppState.components.get(b.id)?.props?.voltage_kv);
        if (busV > 0 && ratedV < busV - 1e-9) {
          add(id, 'fail', `Rated ${ratedV} kV below bus voltage ${busV} kV`);
          break;
        }
      }
    }

    // Dedicated motor protective device rated below the motor's full-load current
    for (const comp of AppState.components.values()) {
      if (comp.type !== 'motor_induction' && comp.type !== 'motor_synchronous') continue;
      const flc = this._motorFLC(comp);
      if (flc == null) continue;
      const { devices, otherLoads } = this._motorProtectiveDevices(comp.id);
      if (otherLoads.length > 0) continue;
      for (const devId of devices) {
        const In = parseFloat(AppState.components.get(devId)?.props?.rated_current_a);
        if (In > 0 && In < flc) {
          add(devId, 'fail', `Rated ${In} A below motor ${comp.props?.name || comp.id} FLC (${flc.toFixed(1)} A)`);
        }
      }
    }

    // Breaking capacity below the prospective fault current (needs fault results)
    if (this._hasFault()) {
      for (const [id, comp] of AppState.components) {
        if (!['cb', 'fuse'].includes(comp.type)) continue;
        const kaRating = parseFloat(comp.props?.breaking_capacity_ka);
        if (!(kaRating > 0)) continue;
        for (const b of this._findConnectedDevices(id, ['bus'])) {
          const r = AppState.faultResults.buses[b.id];
          if (!r || r.ik3 == null) continue;
          // [C8] Same basis as the report ([DU1]/[DU2]): the largest phase
          // current of any fault type — Ik1 exceeds Ik3 near a Dyn
          // transformer. An MV breaker may use the decayed Ib for the
          // balanced fault (IEC 62271-100).
          const busKv = parseFloat(r.voltage_kv) || parseFloat(AppState.components.get(b.id)?.props?.voltage_kv) || 0;
          const unbal = Math.max(r.ik1 || 0, r.ikLL || 0);
          const duty = (comp.type === 'cb' && busKv > 1.0 && r.ib != null)
            ? Math.max(r.ib, unbal) : Math.max(r.ik3, unbal);
          if (duty > kaRating + 1e-9) {
            add(id, 'fail', `Breaking capacity ${kaRating} kA below fault level ${duty.toFixed(1)} kA`);
            break;
          }
        }
      }
    }

    return flags;
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
    const transparent = ['cb', 'fuse', 'switch', 'changeover', 'ct', 'pt', 'surge_arrester'];

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
    // [C9] A transformer branch reports its LV-side current. A device on
    // the HV side carries S/(√3·U_HV) — comparing it with the LV current
    // failed every HV breaker feeding a transformer (1 MVA 11/0.4 kV:
    // 1443 A against a 630 A breaker that carries 52 A).
    let devKv = 0;
    for (const b of this._findConnectedDevices(deviceId, ['bus'])) {
      devKv = parseFloat(AppState.components.get(b.id)?.props?.voltage_kv) || 0;
      if (devKv > 0) break;
    }
    for (const cb of connBranches) {
      const br = branches.find(b => b.elementId === cb.id);
      if (br && br.i_amps > 0) {
        const comp = AppState.components.get(cb.id);
        let current = br.i_amps;
        if (comp?.type === 'transformer' && devKv > 0 && br.s_mva > 0) {
          const lvKv = parseFloat(comp.props?.voltage_lv_kv) || 0;
          if (lvKv > 0 && Math.abs(devKv - lvKv) / lvKv > 0.2) {
            current = br.s_mva * 1000 / (Math.sqrt(3) * devKv);
          }
        }
        results.push({ branchName: comp?.props?.name || cb.id, current });
      }
    }
    return results;
  },

  // Motor full-load current (A) from nameplate — matches the backend
  // motor_starting convention (induction rated in shaft kW, synchronous in kVA).
  _motorFLC(comp) {
    const p = comp.props || {};
    const v = parseFloat(p.voltage_kv);
    if (!(v > 0)) return null;
    if (comp.type === 'motor_synchronous') {
      const kva = parseFloat(p.rated_kva);
      return kva > 0 ? kva / (Math.sqrt(3) * v) : null;
    }
    const kw = parseFloat(p.rated_kw);
    if (!(kw > 0)) return null;
    const eff = parseFloat(p.efficiency) || 0.93;
    const pf = parseFloat(p.power_factor) || 0.85;
    return kw / (Math.sqrt(3) * v * eff * pf);
  },

  // Starting-current multiple of FLC, per starting method (same reductions as
  // the backend motor-starting engine: DOL 1×LRC, star-delta ⅓, autotransformer
  // 0.64, soft starter its current limit else ½, VFD ≈ FLC).
  _motorStartMultiple(comp) {
    const p = comp.props || {};
    const lrc = parseFloat(p.locked_rotor_current) || 6;
    switch (String(p.starting_method || 'dol').toLowerCase()) {
      case 'star_delta': return { mult: lrc / 3, label: 'star-delta' };
      case 'autotransformer': return { mult: lrc * 0.64, label: 'autotransformer' };
      case 'soft_starter': {
        const lim = parseFloat(p.ss_current_limit_xflc);
        return { mult: lim > 0 ? lim : lrc * 0.5, label: 'soft starter' };
      }
      case 'vfd': return { mult: 1.0, label: 'VFD' };
      default: return { mult: lrc, label: 'DOL' };
    }
  },

  // [L4] Largest current a breaker's magnetic/instantaneous element is
  // guaranteed NOT to trip at — the bottom of its tolerance band, which is
  // what a starting current must stay under: IEC 60898-1 MCB B 3×, C 5×,
  // D 10× In (the band tops 5/10/20× are where it is certain to trip);
  // IEC 60947-2 §8.3.3.1.2 instantaneous release ±20 % of its setting.
  // Returns null when not assessable (fuses — time-current, not a fixed
  // threshold; or no data).
  _deviceMagneticTripA(dev) {
    const p = dev.props || {};
    const In = parseFloat(p.rated_current_a);
    if (!(In > 0) || dev.type === 'fuse') return null;
    if (String(p.cb_type || 'mccb').toLowerCase() === 'mcb') {
      const curve = String(p.mcb_curve || 'C').toUpperCase();
      const lo = curve === 'B' ? 3 : curve === 'D' ? 10 : 5;
      const hi = curve === 'B' ? 5 : curve === 'D' ? 20 : 10;
      return { a: lo * In, desc: `Type-${curve} MCB, no-trip limit ${lo}× In (band ${lo}–${hi}× In)` };
    }
    const inst = parseFloat(p.instantaneous_pickup) || parseFloat(p.magnetic_pickup) || 0;
    return inst > 0 ? { a: 0.8 * inst * In, desc: `instantaneous ${inst}× In −20 % tolerance` } : null;
  },

  // Devices at the boundary of a motor's dedicated feeder, and any OTHER loads
  // sharing that feeder. Walk out from the motor: cb/fuse are boundaries
  // (recorded, not crossed); buses/cables/transformers/switchgear are traversed;
  // other motors/loads/sources stop that branch. If otherLoads is empty and one
  // device is found, it dedicatedly protects this motor.
  _motorProtectiveDevices(motorId) {
    const adj = this._getAdjacency();
    const traversable = new Set(['bus', 'cable', 'transformer', 'switch', 'changeover', 'ct', 'pt', 'surge_arrester']);
    const loadTypes = new Set(['motor_induction', 'motor_synchronous', 'static_load', 'capacitor_bank']);
    const visited = new Set([motorId]);
    const queue = [motorId];
    const devices = new Set();
    const otherLoads = new Set();
    while (queue.length) {
      for (const nb of (adj.get(queue.shift()) || [])) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        const c = AppState.components.get(nb);
        if (!c) continue;
        if (c.type === 'cb' || c.type === 'fuse') { devices.add(nb); continue; }
        if (loadTypes.has(c.type)) { otherLoads.add(nb); continue; }
        if (traversable.has(c.type)) queue.push(nb);
        // sources terminate the branch (not a load, not traversed)
      }
    }
    return { devices: [...devices], otherLoads: [...otherLoads] };
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
