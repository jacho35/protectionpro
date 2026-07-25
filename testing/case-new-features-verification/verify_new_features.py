"""Independent first-principles verification of the recently-added analysis
engines. Each check builds a minimal network whose answer is known from a
closed-form hand calculation or a standards formula, runs the engine, and
reports predicted vs computed with a % error and PASS/FAIL.

Run inside the backend Docker image from the repo root:
  docker run --rm -v "$PWD":/work -w /work -e PYTHONPATH=/work \
    protectionpro-backend \
    python testing/case-new-features-verification/verify_new_features.py

Writes results.json next to this script. See results.md for the write-up.
"""
import math
import json
import os

_HERE = os.path.dirname(os.path.abspath(__file__))

from backend.models.schemas import Component, ProjectData, Wire

RESULTS = []


def _c(cid, t, props):
    return Component(id=cid, type=t, x=0, y=0, props=props)


def _w(wid, a, b, fp="p", tp="q"):
    return Wire(id=wid, fromComponent=a, fromPort=fp, toComponent=b, toPort=tp)


def record(name, predicted, computed, tol_pct, unit="", note="", ref=""):
    if predicted is None or computed is None:
        RESULTS.append({"name": name, "predicted": predicted,
                        "computed": computed, "err": "missing value",
                        "tol_pct": tol_pct, "ok": False, "unit": unit,
                        "note": note, "ref": ref})
        print(f"[**FAIL**] {name}  (missing value: predicted={predicted}, computed={computed})")
        return
    if predicted == 0:
        err = abs(computed - predicted)
        ok = err <= tol_pct / 100.0
        errdisp = f"{err:.4g} abs"
    else:
        err = abs(computed - predicted) / abs(predicted) * 100.0
        ok = err <= tol_pct
        errdisp = f"{err:.3f}%"
    RESULTS.append({
        "name": name, "predicted": predicted, "computed": computed,
        "err": errdisp, "tol_pct": tol_pct, "ok": ok, "unit": unit,
        "note": note, "ref": ref,
    })
    status = "PASS" if ok else "**FAIL**"
    print(f"[{status}] {name}")
    print(f"        predicted = {predicted:.6g} {unit}   computed = {computed:.6g} {unit}   err = {errdisp} (tol {tol_pct}%)")
    if note:
        print(f"        {note}")


# =====================================================================
# 1. FREQUENCY SCAN — parallel resonance  h_r = sqrt(S_sc / Q_c)
# =====================================================================
def check_frequency_scan():
    from backend.analysis.frequency_scan import run_frequency_scan
    Ssc_mva = 250.0        # utility fault level
    Qc_mvar = 10.0         # shunt capacitor bank
    h_r_pred = math.sqrt(Ssc_mva / Qc_mvar)   # = 5.0
    proj = ProjectData(
        projectName="freqscan", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": Ssc_mva, "x_r_ratio": 20}),
            _c("bus-1", "bus", {"name": "MV", "voltage_kv": 11}),
            _c("capacitor_bank-1", "capacitor_bank",
               {"name": "Cap", "voltage_kv": 11, "rated_kvar": Qc_mvar * 1000.0}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "capacitor_bank-1")],
    )
    r = run_frequency_scan(proj, h_max=15.0, h_step=0.02)
    h_r_comp = r.get("worst_h", 0.0)
    record("Frequency scan: parallel resonance order h_r",
           h_r_pred, h_r_comp, 3.0, unit="(h)",
           note=f"S_sc={Ssc_mva} MVA, Q_c={Qc_mvar} MVAr -> h_r=sqrt(S_sc/Q_c). "
                f"resonance f = {r.get('worst_f_hz')} Hz",
           ref="Classic resonance screening: h_r = sqrt(S_sc/Q_c)")


# =====================================================================
# 2. FILTER SIZING — single-tuned branch actually resonates at h_t
#    Independent physics: f_res = 1/(2*pi*sqrt(L*C)) must equal h_t*f0
# =====================================================================
def check_filter_tuning():
    from backend.analysis.filter_sizing import _branch_elements
    f0 = 50.0
    v_kv = 11.0
    kvar = 3000.0
    h_t = 4.7          # e.g. detuned 5th
    q_fact = 30.0
    el = _branch_elements(kvar, v_kv, h_t, q_fact, f0)
    L = el["l_mh"] / 1e3          # H
    C = el["c_uf"] / 1e6          # F
    f_res = 1.0 / (2.0 * math.pi * math.sqrt(L * C))
    h_res = f_res / f0
    record("Filter sizing: series-resonance order of designed L-C branch",
           h_t, h_res, 0.5, unit="(h)",
           note=f"design gives C={el['c_uf']} uF, L={el['l_mh']} mH -> "
                f"1/(2pi sqrt(LC)) = {f_res:.2f} Hz = {h_res:.4f}*f0",
           ref="Single-tuned filter: tuned order = 1/(2pi sqrt(LC))/f0")


# =====================================================================
# 3. RELIABILITY — radial FMEA, single load point
#    SAIFI = sum(lambda_i),  SAIDI = sum(lambda_i * r_i)
# =====================================================================
def check_reliability():
    from backend.analysis.reliability import run_reliability
    # utility -> bus1 -> cable(2km UG) -> bus2 -> load(100 cust)
    proj = ProjectData(
        projectName="rel", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 10}),
            _c("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
            _c("cable-1", "cable", {"name": "F1", "voltage_kv": 11,
                                    "r_per_km": 0.2, "x_per_km": 0.1,
                                    "length_km": 2.0, "rated_amps": 400,
                                    "construction": "cable"}),
            _c("bus-2", "bus", {"name": "B2", "voltage_kv": 11}),
            _c("static_load-1", "static_load", {"name": "L", "rated_kva": 1000,
                                                "power_factor": 0.9,
                                                "voltage_kv": 11, "customers": 100}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )
    r = run_reliability(proj)
    # Hand calc from DEFAULT_RATES:
    #  utility: 1.0/2h ; bus1: 0.002/8h ; cable UG 2km: 0.10/26h ; bus2: 0.002/8h
    lam = {"util": 1.0, "b1": 0.002, "cab": 0.05 * 2, "b2": 0.002}
    rep = {"util": 2.0, "b1": 8.0, "cab": 26.0, "b2": 8.0}
    saifi_pred = sum(lam.values())
    saidi_pred = sum(lam[k] * rep[k] for k in lam)
    idx = r.get("indices", {})
    saifi_comp = idx.get("saifi")
    saidi_comp = idx.get("saidi_h")
    record("Reliability: SAIFI (radial series FMEA)", saifi_pred, saifi_comp,
           1.0, unit="int/cust.yr",
           note="sum of series-element failure rates on the only supply path",
           ref="Billinton & Allan radial FMEA; IEEE 1366")
    record("Reliability: SAIDI (radial series FMEA)", saidi_pred, saidi_comp,
           1.0, unit="h/cust.yr",
           note="sum(lambda*r) over the same path",
           ref="Billinton & Allan radial FMEA; IEEE 1366")
    # CAIDI = SAIDI/SAIFI
    record("Reliability: CAIDI = SAIDI/SAIFI", saidi_pred / saifi_pred,
           idx.get("caidi_h"), 1.0, unit="h/int")


# =====================================================================
# 4. VOLTAGE STABILITY — 2-bus lossless nose:  P_max = Vs^2/(2X), V_nose=0.707
# =====================================================================
def check_voltage_stability():
    from backend.analysis.voltage_stability import run_voltage_stability
    v_kv = 11.0
    base_mva = 100.0
    x_per_km = 0.4
    length = 10.0
    X_ohm = x_per_km * length            # 4.0 ohm
    z_base = v_kv ** 2 / base_mva        # 1.21 ohm
    X_pu = X_ohm / z_base
    Vs = 1.0
    P_max_pu = Vs ** 2 / (2.0 * X_pu)
    P_max_mw = P_max_pu * base_mva
    # base load: unity pf so nose theory applies
    P0_mw = 8.0
    kva = P0_mw * 1000.0                  # pf 1.0 -> P=8MW
    lam_pred = P_max_mw / P0_mw
    proj = ProjectData(
        projectName="vstab", baseMVA=base_mva, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": v_kv,
                                        "fault_mva": 1e6, "x_r_ratio": 100,
                                        "v_setpoint_pu": 1.0}),
            _c("bus-1", "bus", {"name": "Src", "voltage_kv": v_kv, "bus_type": "PQ"}),
            _c("cable-1", "cable", {"name": "Line", "voltage_kv": v_kv,
                                    "r_per_km": 0.0005, "x_per_km": x_per_km,
                                    "length_km": length, "rated_amps": 100000}),
            _c("bus-2", "bus", {"name": "Load", "voltage_kv": v_kv, "bus_type": "PQ"}),
            _c("static_load-1", "static_load", {"name": "L", "rated_kva": kva,
                                                "power_factor": 1.0,
                                                "demand_factor": 1.0,
                                                "voltage_kv": v_kv}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )
    r = run_voltage_stability(proj, lambda_max=float(lam_pred * 1.4), step=0.02)
    lam_comp = getattr(r, "lambda_critical", None)
    nose_v = getattr(r, "nose_v_pu", None)
    record("Voltage stability: lambda_critical (2-bus lossless nose)",
           lam_pred, lam_comp, 4.0, unit="",
           note=f"X_pu={X_pu:.4f}, P_max=Vs^2/(2X)={P_max_mw:.3f} MW, P0={P0_mw} MW",
           ref="Kundur: P_max = Vs^2/(2X) for unity-pf constant-P load")
    record("Voltage stability: nose voltage V = Vs/sqrt(2)",
           1.0 / math.sqrt(2), nose_v, 6.0, unit="pu",
           ref="Nose sits at V = Vs/sqrt(2) = 0.707 pu")


# =====================================================================
# 5. HOSTING CAPACITY — voltage-rise limit: P_hc = (Vmax-V0)*V / R
# =====================================================================
def check_hosting_capacity():
    from backend.analysis.hosting_capacity import run_hosting_capacity
    v_kv = 11.0
    base_mva = 100.0
    r_per_km = 0.5
    length = 2.0
    R_ohm = r_per_km * length            # 1.0 ohm
    z_base = v_kv ** 2 / base_mva
    R_pu = R_ohm / z_base
    v_max = 1.05
    Vs = 1.0
    # Exact 2-bus, unity-pf injection, negligible X: the imag power balance
    # forces angle~0, so real balance gives  P_pu = V*(V - Vs)/R_pu  (not the
    # cruder linearized (V-Vs)/R which drops the leading V factor).
    P_hc_pu = v_max * (v_max - Vs) / R_pu
    P_hc_mw = P_hc_pu * base_mva
    proj = ProjectData(
        projectName="hc", baseMVA=base_mva, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": v_kv,
                                        "fault_mva": 1e6, "x_r_ratio": 100,
                                        "v_setpoint_pu": 1.0}),
            _c("bus-1", "bus", {"name": "Src", "voltage_kv": v_kv}),
            _c("cable-1", "cable", {"name": "Line", "voltage_kv": v_kv,
                                    "r_per_km": r_per_km, "x_per_km": 0.001,
                                    "length_km": length, "rated_amps": 100000}),
            _c("bus-2", "bus", {"name": "PCC", "voltage_kv": v_kv}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2")],
    )
    r = run_hosting_capacity(proj, bus_ids=["bus-2"], power_factor=1.0,
                             v_max=v_max, v_min=0.90, loading_limit_pct=100.0,
                             step_mw=0.25, max_mw_per_bus=P_hc_mw * 1.5)
    hc = r["buses"][0]["hosting_capacity_mw"] if r.get("buses") else 0.0
    record("Hosting capacity: voltage-rise-limited PV MW",
           P_hc_mw, hc, 4.0, unit="MW",
           note=f"R_pu={R_pu:.4f}; P_hc=(Vmax-V0)/R_pu={P_hc_mw:.3f} MW; "
                f"limit={r['buses'][0].get('limiting_factor') if r.get('buses') else '?'}",
           ref="Feeder voltage rise dV_pu ~= P_pu*R_pu (unity pf)")


# =====================================================================
# 6. CT SATURATION — knee voltage & saturation current (IEC 61869-2)
# =====================================================================
def check_ct_saturation():
    from backend.analysis.ct_model import ct_saturation_params, ct_effective_current
    props = {"ratio": "400/5", "accuracy_class": "5P20", "burden_va": 15.0,
             "rct_ohm": 0.3}
    sp = ct_saturation_params(props)
    # burden_ohm = 15/25 = 0.6 ; total_z=0.9 ; Vk=0.8*ALF*Isn*totalZ=0.8*20*5*0.9=72
    vk_pred = 0.8 * 20 * 5 * (0.3 + 15 / 25.0)
    # I_sat_primary = 0.8*ALF*primary = 0.8*20*400 = 6400 A
    isat_pred = 0.8 * 20 * 400.0
    record("CT model: knee-point voltage V_k = 0.8*ALF*Isn*(Rct+Rb)",
           vk_pred, sp["knee_point_v"], 0.5, unit="V",
           ref="IEC 61869-2: V_AL=ALF*Isn*(Rct+Rb); Vk~=0.8*V_AL")
    record("CT model: saturation primary current",
           isat_pred, sp["i_sat_primary"], 0.5, unit="A",
           ref="I_sat_pri = Vk/(Rct+Rb)*ratio = 0.8*ALF*I_pri_rated")
    # Effective current at 2x saturation: ks=0.5 -> eta=sqrt(0.5)=0.7071
    i_test = 2.0 * isat_pred
    eff_pred = i_test * math.sqrt(0.5)
    eff_comp = ct_effective_current(i_test, sp)
    record("CT model: saturation-clipped effective current at 2x I_sat",
           eff_pred, eff_comp, 0.5, unit="A",
           note="ks=0.5 -> theta=pi/2 -> eta=sqrt((pi/2)/pi)=0.7071",
           ref="Waveform-clip rms: eta=sqrt((theta-sin2theta/2)/pi)")


# =====================================================================
# 7. BATTERY SIZING — energy method (IEEE 485-style)
# =====================================================================
def check_battery_sizing():
    from backend.analysis.battery_sizing import run_battery_sizing
    proj = ProjectData(
        projectName="batt", baseMVA=100.0, frequency=50,
        components=[
            _c("battery-1", "battery", {
                "name": "BESS", "voltage_kv": 0.4, "rated_kva": 500,
                "battery_chemistry": "lfp", "battery_kwh": 200,
                "battery_dod_pct": 90, "battery_rt_eff": 0.95,
                "battery_soc_pct": 100, "battery_nominal_v": 48,
                "battery_hour_rating_h": 1}),
        ],
        wires=[],
    )
    duty = [{"duration_min": 120.0, "load_kw": 50.0}]   # 100 kWh
    r = run_battery_sizing(proj, duty_cycle=duty, aging_factor=1.25,
                           design_margin=1.10, temperature_c=25.0)
    duty_kwh = 100.0
    eta = math.sqrt(0.95)
    req_pred = duty_kwh / eta / 0.90 * 1.25 * 1.10 * 1.0
    record("Battery sizing: required energy (IEEE 485 factors)",
           req_pred, r["required_kwh"], 0.5, unit="kWh",
           note=f"E=100/sqrt(.95)/0.9*1.25*1.10 ; eta_1way={eta:.4f}",
           ref="E_req = SumP.t/eta/DoD*Kage*Kdesign*Ktemp")


# =====================================================================
# 8. CAPACITOR PLACEMENT — full-compensation loss reduction fraction
#    loss_reduction ~= Q^2/(P^2+Q^2)  when caps fully offset lagging Q
# =====================================================================
def check_capacitor_placement():
    from backend.analysis.capacitor_placement import run_capacitor_placement
    v_kv = 11.0
    # load P=4MW, Q=3MVAr (pf 0.8) -> full comp removes Q
    proj = ProjectData(
        projectName="cap", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": v_kv,
                                        "fault_mva": 1e6, "x_r_ratio": 100,
                                        "v_setpoint_pu": 1.0}),
            _c("bus-1", "bus", {"name": "Src", "voltage_kv": v_kv}),
            _c("cable-1", "cable", {"name": "Line", "voltage_kv": v_kv,
                                    "r_per_km": 0.3, "x_per_km": 0.1,
                                    "length_km": 5.0, "rated_amps": 100000}),
            _c("bus-2", "bus", {"name": "Load", "voltage_kv": v_kv}),
            _c("static_load-1", "static_load", {"name": "L", "rated_kva": 5000,
                                                "power_factor": 0.8,
                                                "demand_factor": 1.0,
                                                "voltage_kv": v_kv}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )
    r = run_capacitor_placement(proj, unit_kvar=250.0, max_kvar_per_bus=3500.0,
                                max_total_kvar=3500.0, v_min=0.85, v_max=1.10)
    b_loss = r["baseline"]["losses_mw"]
    o_loss = r["optimized"]["losses_mw"]
    frac_comp = (b_loss - o_loss) / b_loss if b_loss else 0.0
    P, Q = 4.0, 3.0
    frac_pred = Q ** 2 / (P ** 2 + Q ** 2)     # 9/25 = 0.36
    record("Cap placement: loss-reduction fraction from full VAR comp",
           frac_pred, frac_comp, 12.0, unit="",
           note=f"base_loss={b_loss*1000:.2f} kW, opt_loss={o_loss*1000:.2f} kW, "
                f"placed {r['total_kvar']} kvar",
           ref="I^2R with Q->0: reduction = Q^2/(P^2+Q^2)")


# =====================================================================
# 9. OPF — merit-order economic dispatch (cheaper source ranked first)
# =====================================================================
def check_opf():
    from backend.analysis.optimal_powerflow import run_opf
    # Canonical dispatch: expensive utility swing + a cheap dispatchable
    # generator. Baseline leaves the generator on standby (utility serves all,
    # dear). Merit-order OPF commits the cheap generator -> cost must fall.
    Pload = 8.0
    proj = ProjectData(
        projectName="opf", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 800, "x_r_ratio": 12,
                                        "v_setpoint_pu": 1.0,
                                        "cost_per_mwh": 150.0}),
            _c("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
            _c("generator-1", "generator", {"name": "GenCheap", "voltage_kv": 11,
                                            "rated_mva": 15, "cost_per_mwh": 20.0,
                                            "v_setpoint_pu": 1.0, "x_r_ratio": 10,
                                            "sub_x_pct": 15}),
            _c("static_load-1", "static_load", {"name": "L",
                                                "rated_kva": Pload * 1000,
                                                "power_factor": 1.0,
                                                "demand_factor": 1.0,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"),
               _w("w2", "generator-1", "bus-1"),
               _w("w3", "bus-1", "static_load-1")],
    )
    r = run_opf(proj, objective="cost", use_capacitors=False, use_taps=False,
                use_setpoints=False)
    disp = {d["source_name"]: d for d in r.get("dispatch", [])}
    gen_mw = disp.get("GenCheap", {}).get("dispatched_mw", 0.0)
    b_cost = r["baseline"]["cost_per_h"]
    o_cost = r["optimized"]["cost_per_h"]
    # Predicted optimized cost: cheap gen serves the load (~Pload MW @ $20),
    # utility only trims losses. Baseline: utility serves all @ $150.
    cost_ok = o_cost <= b_cost - 1e-6
    committed = gen_mw > 0.5
    record("OPF: cheap generator committed by merit-order dispatch",
           1.0, 1.0 if committed else 0.0, 0.1,
           note=f"GenCheap dispatched {gen_mw:.2f} MW (baseline standby)")
    record("OPF: optimized cost strictly below baseline",
           1.0, 1.0 if cost_ok else 0.0, 0.1,
           note=f"baseline={b_cost} $/h -> optimized={o_cost} $/h")


# =====================================================================
# 10. CONTINGENCY — N-1 loss of supply on a radial feed
# =====================================================================
def check_contingency():
    from backend.analysis.contingency import run_contingency
    P0 = 4.0  # MW at pf1
    proj = ProjectData(
        projectName="cont", baseMVA=100.0, frequency=50,
        components=[
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 11,
                                        "fault_mva": 500, "x_r_ratio": 10,
                                        "v_setpoint_pu": 1.0}),
            _c("bus-1", "bus", {"name": "B1", "voltage_kv": 11}),
            _c("cable-1", "cable", {"name": "Feeder", "voltage_kv": 11,
                                    "r_per_km": 0.1, "x_per_km": 0.1,
                                    "length_km": 2.0, "rated_amps": 100000}),
            _c("bus-2", "bus", {"name": "B2", "voltage_kv": 11}),
            _c("static_load-1", "static_load", {"name": "L", "rated_kva": P0 * 1000,
                                                "power_factor": 1.0,
                                                "demand_factor": 1.0,
                                                "voltage_kv": 11}),
        ],
        wires=[_w("w1", "utility-1", "bus-1"), _w("w2", "bus-1", "cable-1"),
               _w("w3", "cable-1", "bus-2"), _w("w4", "bus-2", "static_load-1")],
    )
    r = run_contingency(proj, include_n2=False)
    n1_secure = r.n_minus_1_secure
    conts = r.contingencies
    los = [c for c in conts if c.lost_load_mw > 0
           or c.status in ("islanded",)]
    mw_lost = max((c.lost_load_mw for c in conts), default=0.0)
    record("Contingency: radial single-feed is NOT N-1 secure",
           0.0, 0.0 if (n1_secure is False) else 1.0, 0.1,
           note=f"n1_secure={n1_secure}; loss-of-supply contingencies={len(los)}")
    record("Contingency: MW lost on feeder outage = full load",
           P0, mw_lost, 5.0, unit="MW",
           note="removing the only feeder de-energizes B2")


# =====================================================================
# 11. EE-10 — exact two-port chain reduction vs explicit intermediate buses
# =====================================================================
def check_ee10_two_port():
    from backend.analysis.loadflow import run_load_flow
    # Chain (reduced):   bus_a - cable1 - XFMR(tap) - cable2 - bus_b  (no mid buses)
    # Reference (exact): same but with a bus at each transformer terminal.
    def net(with_mid_buses):
        comps = [
            _c("utility-1", "utility", {"name": "Grid", "voltage_kv": 33,
                                        "fault_mva": 2000, "x_r_ratio": 15,
                                        "v_setpoint_pu": 1.0}),
            _c("bus-a", "bus", {"name": "A", "voltage_kv": 33}),
        ]
        wires = [_w("w0", "utility-1", "bus-a")]
        cab1 = _c("cable-1", "cable", {"name": "C1", "voltage_kv": 33,
                                       "r_per_km": 0.12, "x_per_km": 0.10,
                                       "length_km": 3.0, "rated_amps": 100000})
        xf = _c("transformer-1", "transformer", {"name": "TX", "rated_mva": 20,
                                                 "z_percent": 10.0, "x_r_ratio": 20,
                                                 "voltage_hv_kv": 33, "voltage_lv_kv": 11,
                                                 "tap_percent": 5.0})
        cab2 = _c("cable-2", "cable", {"name": "C2", "voltage_kv": 11,
                                       "r_per_km": 0.08, "x_per_km": 0.09,
                                       "length_km": 2.0, "rated_amps": 100000})
        busb = _c("bus-b", "bus", {"name": "B", "voltage_kv": 11})
        load = _c("static_load-1", "static_load", {"name": "L", "rated_kva": 8000,
                                                   "power_factor": 0.9,
                                                   "demand_factor": 1.0,
                                                   "voltage_kv": 11})
        if with_mid_buses:
            busm1 = _c("bus-m1", "bus", {"name": "M1", "voltage_kv": 33})
            busm2 = _c("bus-m2", "bus", {"name": "M2", "voltage_kv": 11})
            comps += [cab1, busm1, xf, busm2, cab2, busb, load]
            wires += [_w("w1", "bus-a", "cable-1"), _w("w2", "cable-1", "bus-m1"),
                      _w("w3", "bus-m1", "transformer-1"),
                      _w("w4", "transformer-1", "bus-m2"),
                      _w("w5", "bus-m2", "cable-2"), _w("w6", "cable-2", "bus-b"),
                      _w("w7", "bus-b", "static_load-1")]
        else:
            comps += [cab1, xf, cab2, busb, load]
            wires += [_w("w1", "bus-a", "cable-1"),
                      _w("w2", "cable-1", "transformer-1"),
                      _w("w3", "transformer-1", "cable-2"),
                      _w("w4", "cable-2", "bus-b"),
                      _w("w5", "bus-b", "static_load-1")]
        return ProjectData(projectName="ee10", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    r_reduced = run_load_flow(net(False), "newton_raphson")
    r_exact = run_load_flow(net(True), "newton_raphson")
    vb_red = r_reduced.buses["bus-b"].voltage_pu
    vb_exact = r_exact.buses["bus-b"].voltage_pu
    record("EE-10: bus-b voltage, chain-reduced vs explicit-mid-bus (exact)",
           vb_exact, vb_red, 0.1, unit="pu",
           note=f"tapped XFMR + cable each side; V_exact={vb_exact:.5f}, V_reduced={vb_red:.5f}",
           ref="Kron reduction must reproduce the per-element model exactly")


# =====================================================================
# 12. FLICKER — planning Pst curve anchor & scaling (IEC 61000-3-3 Annex B)
# =====================================================================
def check_flicker():
    from backend.analysis.flicker import _pst_estimate
    # Anchor: 3% step at 1 change/min (=60/hr) -> Pst = 1.0
    p1 = _pst_estimate(3.0, 60.0)
    record("Flicker: Pst at anchor (d=3%, 1/min)", 1.0, p1, 0.5, unit="Pst",
           ref="IEC 61000-3-3 Pst=1 borderline curve anchor")
    # Linear in d: doubling d doubles Pst
    p2 = _pst_estimate(6.0, 60.0)
    record("Flicker: Pst linear in step size (d=6%)", 2.0, p2, 0.5, unit="Pst")
    # Rate roll-off exponent 0.31: 10/min vs 1/min -> 10^0.31
    p3 = _pst_estimate(3.0, 600.0)
    record("Flicker: Pst rate roll-off (r=10/min)", 10.0 ** 0.31, p3, 0.5,
           unit="Pst", ref="Pst ~ r^0.31 high-frequency roll-off")


def main():
    checks = [
        ("Frequency Scan", check_frequency_scan),
        ("Filter Sizing", check_filter_tuning),
        ("Reliability", check_reliability),
        ("Voltage Stability", check_voltage_stability),
        ("Hosting Capacity", check_hosting_capacity),
        ("CT Saturation", check_ct_saturation),
        ("Battery Sizing", check_battery_sizing),
        ("Capacitor Placement", check_capacitor_placement),
        ("Optimal Power Flow", check_opf),
        ("Contingency", check_contingency),
        ("EE-10 Two-Port", check_ee10_two_port),
        ("Flicker", check_flicker),
    ]
    for title, fn in checks:
        print("\n" + "=" * 70)
        print(title)
        print("=" * 70)
        try:
            fn()
        except Exception as e:
            import traceback
            print(f"  !!! EXCEPTION in {title}: {e}")
            traceback.print_exc()
            RESULTS.append({"name": f"{title} (crashed)", "ok": False,
                            "predicted": None, "computed": None, "err": str(e),
                            "tol_pct": 0, "unit": "", "note": "", "ref": ""})

    print("\n\n" + "#" * 70)
    print("SUMMARY")
    print("#" * 70)
    npass = sum(1 for r in RESULTS if r["ok"])
    for r in RESULTS:
        print(f"  {'PASS' if r['ok'] else 'FAIL'}  {r['name']:<55} err={r['err']}")
    print(f"\n  {npass}/{len(RESULTS)} checks passed")
    with open(os.path.join(_HERE, "results.json"), "w") as f:
        json.dump(RESULTS, f, indent=2, default=str)


if __name__ == "__main__":
    main()
