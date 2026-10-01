"""Generate frontend/js/verification-templates.js from the testing/case-*
projects.

EXPECTED is the one source for each template's headline numbers: the
generator formats them into the template instructions and writes them to
testing/ui/verification-expected.json; backend/tests/test_verification_templates.py
runs every template through its analysis route, and
testing/ui/verify_templates_ui.mjs through the real app UI, asserting the
engine still produces them — so a template can never silently show a stale
"Expected …" value.

Run from anywhere:  python testing/build_verification_templates.py
"""
import json, os

BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(BASE), "frontend", "js", "verification-templates.js")
# EXPECTED as JSON for the headless-UI check (testing/ui/verify_templates_ui.mjs).
OUT_EXPECTED = os.path.join(BASE, "ui", "verification-expected.json")

# Ordered curated metadata. Each: (case_dir, id, name, preview, description)
CASES = [
    ("case-1-noload", "ver_sc_case1",
     "SC Case 1 — No Load (IEC 60909)",
     "Grid → 25 MVA Xfmr → 11 kV bus fault",
     "IEC 60909 short circuit — baseline network (grid → 25 MVA transformer → 11 kV bus). Reproduces the powerprojectsindia / ETAP worked example for all four fault types to within 0.01 %. Run with voltage factor c = 1.0 to match the reference screenshots."),
    ("case-2-motor", "ver_sc_case2",
     "SC Case 2 — Motor Contribution (IEC 60909)",
     "Case 1 + cable + 5 MW induction motor",
     "IEC 60909 short circuit with a 5 MW induction-motor fault contribution added via a feeder cable. Matches the ETAP reference to ≤0.09 % including the motor sub-transient split. Fault at Bus7, c = 1.0."),
    ("case-3-motor-lump", "ver_sc_case3",
     "SC Case 3 — Motor + Lump Load (IEC 60909)",
     "Case 2 + 18 MVA lump load (as motor eqv.)",
     "IEC 60909 short circuit with multiple infeeds — 5 MW motor plus an 18 MVA lump load modelled as an induction-motor equivalent. Matches ETAP to ≤0.13 %. Fault at Bus5, c = 1.0."),
    ("case-sc2-220-33kv", "ver_sc_220_33",
     "SC — 220/33 kV, 10 MVA Dyn1 (ETAP)",
     "220 kV grid → 10 MVA Dyn1 → 33 kV fault",
     "IEC 60909 short circuit on a 220/33 kV, 10 MVA Dyn1 network. Matches the second powerprojectsindia / ETAP example exactly (0.00 %) across all four fault types and exposes a base-mixing arithmetic error in the article's own hand calc. Run with c = 1.10 (the app default)."),
    ("case-cable-sizing-lv", "ver_cable_lv",
     "LV Cable Sizing (IEC 60364)",
     "0.4 kV feeder + cable thermal / VD check",
     "IEC 60364 LV cable sizing. The voltage-drop and adiabatic fault-withstand formulas reproduce the reference article exactly; the integrated engine is network-fed and sizes for the IEC 60909-0 §12 thermal-equivalent current, so its final size is deliberately more conservative."),
    ("case-loadflow-3bus", "ver_lf_3bus",
     "3-Bus Load Flow (Glover / Newton-Raphson)",
     "Slack + PV + PQ, 3 lines — NR solve",
     "Newton-Raphson load flow verified against the Glover / ESE 470 textbook 3-bus example (slack at 1.0 pu, one PV, one PQ). Reproduces the published voltages and angles to ≤0.002 pu / 0.04° with the same 4-iteration convergence."),
    ("case-arcflash-ieee1584", "ver_arcflash",
     "Arc Flash (IEEE 1584-2002)",
     "480 V MCC — incident energy & AFB",
     "IEEE 1584-2002 arc flash. Reproduces the standard's arcing-current (Eq. 1–2), incident-energy (Eq. 3–5) and arc-flash-boundary hand calculations exactly (0.000 %). End-to-end result: E ≈ 12.82 cal/cm², PPE Cat 3, AFB 1.93 m."),
    ("case-grounding-ieee80", "ver_grounding",
     "Grounding Grid (IEEE 80)",
     "Square grid + rods — touch/step/GPR",
     "IEEE 80 grounding grid on a square grid with rods. Reproduces the tolerable touch/step voltages, surface derating C_s, grid resistance R_g (Sverak), GPR, geometric factors and mesh voltage exactly (full Eq. 84–88 n / K_ii / rod-weighted L_M)."),
    ("case-earth-grid-annexh6", "ver_earth_grid_h6",
     "Earth Grid with Diagonals (IEEE 80 Annex H Grid 6)",
     "70 × 70 m, corner-to-corner diagonals, two-layer",
     "Earth grid of any shape, solved numerically: the IEEE 80-2013 Annex H.3.6 benchmark (non-orthogonal conductors, rods of unequal length, two-layer 100/300 Ω·m soil, 744.8 A). Grid resistance and worst touch/step voltage fall inside the range CDEGS, ETAP and WinIGS report (R_g 1.42–1.43 Ω, touch 134.4–140.2 V, step 77.4–99.2 V)."),
    ("case-motor-starting", "ver_motor_start",
     "Motor Starting Voltage Dip",
     "DOL/star-delta/AT/soft — dip at bus",
     "Motor starting voltage-dip study. Full-load and starting current for all five starting methods (DOL, star-delta, autotransformer, soft-starter, VFD) and the terminal voltage dip match hand calculations exactly; the terminal voltage matches the textbook constant-impedance divider V = V_pre/(1 + Z·Y) (locked rotor at pf 0.3)."),
    ("case-dc-loadflow", "ver_dc_lf",
     "DC Load Flow (first-principles)",
     "DC source → cables → loads",
     "DC load flow verified against an exact first-principles resistive-circuit solution. Bus voltages, cable currents and losses reproduce the hand calc to ≤0.005 %."),
    ("case-dc-shortcircuit", "ver_dc_sc",
     "DC Short Circuit (IEC 61660-1)",
     "Battery + converter DC fault",
     "IEC 61660-1 DC short circuit. Reproduces the published battery peak (5422 A) exactly from raw nameplate inputs — the standard factors (E_B = 1.05·U_nB, 0.9·R_B peak, +0.1·R_B for I_k) are applied internally, with cable resistance referred to 20 °C and the rise from 1/δ = 2/(R/L + 1/T_B)."),
    ("case-duty-check", "ver_duty",
     "Equipment Duty Check",
     "Breaker peak / making / breaking duty",
     "Equipment duty check layered on the verified fault engine. Peak (κ·√2·I″k), making capacity (2.5·Icu MV / IEC 60947-2 LV) and breaking-duty (Ib) comparisons reproduce the hand calculations exactly."),
    ("case-load-diversity", "ver_diversity",
     "Load Diversity / Demand Factors",
     "Grouped loads — Ks & diversified demand",
     "Load diversity study. Per-load demand factors, IEC group coincidence factor Ks, diversified demand, effective demand factor and demand current all reproduce an exact demand-aggregation hand calc."),
    ("case-dc-arcflash", "ver_dc_arcflash",
     "DC Arc Flash (Stokes & Oppenländer)",
     "DC bus — arc operating point & E",
     "DC arc flash via the Ammerman / CED published method. The Stokes & Oppenländer arc operating point and the spherical incident-energy / boundary reproduce the reference to ≤0.06 % (calorie rounding)."),
    ("case-unbalanced-loadflow", "ver_unbalanced_lf",
     "Unbalanced Load Flow (symmetrical comp.)",
     "Sequence-based unbalanced solve + VUF",
     "Unbalanced load flow (symmetrical-component engine). Collapses to the exact balanced solution when balanced, its positive sequence equals the verified Newton-Raphson balanced LF, and the phase↔sequence transform and VUF = |V2|/|V1| are exact."),
]

# IEC 60909 voltage factor c each short-circuit case was verified at (see each
# testing case's results.md). Baked into the template so loading + running
# reproduces the documented ETAP numbers instead of the app default (c = 1.10).
# The main 3-case study used c = 1.0 to match its ETAP screenshots; the
# 220/33 kV article used the default c = 1.10. Non-fault cases are unaffected.
VOLTAGE_FACTOR = {
    "ver_sc_case1": 1.0,
    "ver_sc_case2": 1.0,
    "ver_sc_case3": 1.0,
    "ver_sc_220_33": 1.10,
}

# Headline results each template must reproduce, as {template id: (analysis
# route, {name: (result path, expected[, rel tol])})}. Paths are dotted into
# the route's JSON response (list indices as integers). Values are the
# engine-verified numbers from each case's results.md; floats are checked to
# rel 1e-3 unless a tolerance is given, anything else exactly.
EXPECTED = {
    "ver_sc_case1": ("fault", {"ik3": ("buses.bus-4.ik3", 12.881)}),
    "ver_sc_case2": ("fault", {"ik3": ("buses.bus-7.ik3", 14.811)}),
    "ver_sc_case3": ("fault", {"ik3": ("buses.bus-5.ik3", 20.949)}),
    "ver_sc_220_33": ("fault", {"ik3": ("buses.bus-2.ik3", 2.296)}),
    "ver_cable_lv": ("cable-sizing", {
        "vd": ("cables.0.voltage_drop_pct", 2.08),
        "i_load": ("cables.0.load_current_a", 167.15),
        "size": ("cables.0.min_size_mm2", 120),
    }),
    "ver_lf_3bus": ("loadflow", {
        "v2": ("buses.bus-2.voltage_pu", 1.0500),
        "a2": ("buses.bus-2.angle_deg", -2.06, 2e-3),
        "v3": ("buses.bus-3.voltage_pu", 0.9782),
        "a3": ("buses.bus-3.angle_deg", -8.78, 2e-3),
        "iters": ("iterations", 4),
    }),
    "ver_arcflash": ("arcflash", {
        "e": ("buses.bus-1.incident_energy_cal", 12.82),
        "ppe": ("buses.bus-1.ppe_category", 3),
        "afb_mm": ("buses.bus-1.arc_flash_boundary_mm", 1927.0),
    }),
    "ver_grounding": ("grounding", {
        "rg": ("buses.0.grid_resistance_ohm", 2.7526),
        "gpr": ("buses.0.gpr_v", 5252.0),
        "em": ("buses.0.mesh_voltage_v", 749.0),
        "etouch": ("buses.0.tolerable_touch_v", 841.0),
    }),
    # IEEE 80 Annex H Table H.10 (CDEGS / ETAP / WinIGS): R 1.42–1.43 Ω,
    # GPR 1054–1068 V, touch 134.4–140.2 V, step 77.4–99.2 V.
    "ver_earth_grid_h6": ("grounding", {
        "rg": ("buses.0.grid_resistance_ohm", 1.4265, 5e-3),
        "gpr": ("buses.0.gpr_v", 1063.0, 5e-3),
        "touch": ("buses.0.mesh_voltage_v", 136.0, 1e-2),
        "step": ("buses.0.step_voltage_v", 86.0, 2e-2),
        "method": ("buses.0.method", "numerical"),
    }),
    # Dip hand calc (independent 2-bus constant-PQ solve) is 20.92 %; the
    # engine's 20.94 % adds the 99 999 MVA source's own impedance.
    "ver_motor_start": ("motor-starting", {
        "i_start": ("motors.0.start_current_a", 920.8),
        # [N1] constant-Z locked rotor at pf 0.3: V = 1/(1 + Z·Y) = 0.85294;
        # dip vs the 0.9841 running baseline = 13.33 % (was 0.7782 / 20.92 %
        # under the old constant-PQ rotor — an exact solve of the engine's own
        # model, not an independent anchor).
        "vt": ("motors.0.motor_terminal_voltage_pu", 0.8529),
        "dip": ("motors.0.max_system_dip_pct", 13.33, 2e-3),
        "starts": ("motors.0.motor_will_start", True),
    }),
    "ver_dc_lf": ("dc-loadflow", {
        "v_rect": ("buses.bus-1.voltage_v", 124.46),
        "v_load": ("buses.bus-2.voltage_v", 115.83),
        "drop": ("buses.bus-2.drop_pct", 7.34),
        "i_cable": ("branches.0.current_a", 86.34),
    }),
    "ver_dc_sc": ("dc-shortcircuit", {"ip_ka": ("buses.bus-2.ip_ka", 5.422)}),
    "ver_duty": ("duty-check", {
        "ik": ("devices.0.prospective_fault_ka", 20.0),
        "icu": ("devices.0.breaking_capacity_ka", 25.0),
        "ip": ("devices.0.peak_fault_ka", 49.38),
        "icm": ("devices.0.making_capacity_ka", 62.5),
        "status": ("devices.0.status", "pass"),
    }),
    "ver_diversity": ("load-diversity", {
        "installed": ("buses.0.installed_kva", 255.26),
        "ks": ("buses.0.diversity_factor", 0.85),
        "demand": ("buses.0.diversified_demand_kva", 199.97),
        "i_demand": ("buses.0.demand_current_a", 288.6),
    }),
    "ver_dc_arcflash": ("dc-arcflash", {
        "i_arc": ("buses.bus-1.dc_arcing_current_a", 6196.3),
        "e": ("buses.bus-1.incident_energy_cal", 10.82),
        "afb_mm": ("buses.bus-1.arc_flash_boundary_mm", 1366.0),
        "ppe": ("buses.bus-1.ppe_category", 3),
    }),
    # Independent phase-domain solve (Zabc = A·diag(Z0,Z1,Z2)·A⁻¹ for the line
    # AND the 200 MVA source, positive-sequence EMF held at |V1| = 1 at the
    # source bus, V iterated in phases) — see case-unbalanced-loadflow/results.md.
    # Was 0.7618 / 0.96146 / 1.00489 / 0.98922 from the old single-pass engine,
    # then 0.8045 / 0.95967 / 1.00541 / 0.98975 with the source bus wrongly held
    # at V2 = V0 = 0 (an infinite sequence sink — review U1).
    "ver_unbalanced_lf": ("unbalanced-loadflow", {
        "vuf": ("buses.bus-2.vuf_pct", 1.2330),
        "va": ("buses.bus-2.va_pu", 0.95448),
        "vb": ("buses.bus-2.vb_pu", 1.00788),
        "vc": ("buses.bus-2.vc_pu", 0.99250),
    }),
}

# Per-template usage instructions, shown in the app's Project Details →
# Description text box when the template is loaded. Says which analysis to run,
# the pre-set voltage factor, the expected headline result, and any caveat.
# {name} fields are filled from EXPECTED — never type a result number here.
INSTRUCTIONS = {
    "ver_sc_case1":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit (source: powerprojectsindia / ETAP). "
        "Voltage factor c = 1.0 is pre-set to match the reference. "
        "RUN: Fault analysis, fault at Bus4. Expected I″k3 ≈ {ik3:.2f} kA (ETAP 12.881). "
        "Full working: Help → Verification.",
    "ver_sc_case2":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit with a 5 MW induction-motor contribution "
        "(source: powerprojectsindia / ETAP). Voltage factor c = 1.0 pre-set. "
        "RUN: Fault analysis, fault at Bus7. Expected I″k3 ≈ {ik3:.2f} kA (ETAP 14.824). "
        "Full working: Help → Verification.",
    "ver_sc_case3":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit: 5 MW motor + 18 MVA lump load "
        "(source: powerprojectsindia / ETAP). Voltage factor c = 1.0 pre-set. "
        "RUN: Fault analysis, fault at Bus5. Expected I″k3 ≈ {ik3:.2f} kA (ETAP 20.976). "
        "NOTE: 'Lump2' is an 18 MVA LOAD modelled as a motor so it contributes to the FAULT (per IEC 60909) — "
        "it is not a real motor. Do NOT run Motor Starting on this template: starting a 15 MW 'motor' collapses "
        "the network voltage and the load flow will not converge (this is expected, not a bug). "
        "Full working: Help → Verification.",
    "ver_sc_220_33":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit, 220/33 kV 10 MVA Dyn1 (source: powerprojectsindia / ETAP). "
        "Voltage factor c = 1.10 (the app default) pre-set to match the reference ETAP screenshots. "
        "RUN: Fault analysis, fault at Bus2. Expected I″k3 = {ik3:.3f} kA (ETAP 2.296). "
        "Full working: Help → Verification.",
    "ver_cable_lv":
        "VERIFICATION TEMPLATE — IEC 60364 LV cable sizing (source: powerprojectsindia). "
        "RUN: Cable Sizing study. Expected running volt drop {vd:.2f} % at {i_load:.1f} A load-flow current, "
        "minimum size {size} mm². The voltage-drop and adiabatic fault-withstand formulas reproduce the article "
        "exactly; the engine sizes conservatively for the IEC 60909-0 thermal-equivalent current I_th = I″k·√(m+n), "
        "so it recommends a larger conductor than the article's bare-Isc 95 mm². Full working: Help → Verification.",
    "ver_lf_3bus":
        "VERIFICATION TEMPLATE — Newton-Raphson load flow (Glover / ESE 470 3-bus example). "
        "Gen2's reactive limits are opened up (q_max/q_min ±9999 Mvar) because the textbook PV bus is unlimited — "
        "it needs ~267 Mvar to hold 1.05 p.u., beyond a 250 MVA / 0.8 pf machine's capability. "
        "RUN: Load Flow (Newton-Raphson). Expected V2 = {v2:.3f}∠{a2:.2f}°, V3 = {v3:.3f}∠{a3:.2f}°, "
        "converges in {iters} iterations. Full working: Help → Verification.",
    "ver_arcflash":
        "VERIFICATION TEMPLATE — IEEE 1584-2002 arc flash, 480 V MCC. "
        "RUN: Arc Flash analysis. Expected E ≈ {e:.2f} cal/cm², PPE Cat {ppe}, arc-flash boundary {afb_mm:.0f} mm. "
        "Clearing time is derived from the upstream protective device (engineered to 0.2 s here). "
        "Full working: Help → Verification.",
    "ver_grounding":
        "VERIFICATION TEMPLATE — IEEE 80 grounding grid (70 × 70 m, 11 × 11 conductors, 20 rods). "
        "RUN: Grounding study. Expected grid resistance R_g = {rg:.2f} Ω, GPR = {gpr:.0f} V, mesh (touch) voltage "
        "{em:.0f} V ≤ {etouch:.0f} V tolerable. Full working: Help → Verification.",
    "ver_earth_grid_h6":
        "VERIFICATION TEMPLATE — earth grid of any shape, IEEE 80 Annex H Grid 6: 70 × 70 m with corner-to-corner "
        "diagonals, 7.5 m corner rods and 2.5 m inner rods, two-layer soil 100/300 Ω·m (6.1 m), grid current 744.8 A "
        "(the 11 kV source is sized at 14.19 MVA so the fault study's SLG current I″k1 is 744.8 A; X/R 0.05 gives D_f = 1). The IEEE 80 equations do not cover this grid, so it is solved numerically. "
        "RUN: Grounding study. Expected R_g = {rg:.3f} Ω, GPR ≈ {gpr:.0f} V, worst touch ≈ {touch:.0f} V, worst step ≈ "
        "{step:.0f} V — CDEGS / ETAP / WinIGS: 1.42–1.43 Ω, 134.4–140.2 V, 77.4–99.2 V.",
    "ver_motor_start":
        "VERIFICATION TEMPLATE — motor starting voltage dip: 1500 kW motor on a weak (~60 MVA) source, DOL. "
        "RUN: Motor Starting study. Expected DOL start current {i_start:.0f} A, terminal voltage {vt:.3f} p.u., "
        "max dip {dip:.1f} %, Will Start = NO (a deliberately weak system). Full working: Help → Verification.",
    "ver_dc_lf":
        "VERIFICATION TEMPLATE — DC load flow (exact resistive-circuit reference). "
        "RUN: Load Flow. Expected rectifier bus {v_rect:.1f} V, load bus {v_load:.1f} V ({drop:.2f} % drop), "
        "cable current {i_cable:.1f} A. Full working: Help → Verification.",
    "ver_dc_sc":
        "VERIFICATION TEMPLATE — DC short circuit, IEC 61660-1 battery (CED E03-035 Example 1). "
        "RUN: Fault analysis. Expected battery peak i_p = {ip_ka:.3f} kA at bus Brk, from nameplate "
        "(the converter current-limit check in the case notes is a separate hand calc — no converter here). "
        "Full working: Help → Verification.",
    "ver_duty":
        "VERIFICATION TEMPLATE — equipment duty check over the verified fault engine. "
        "RUN: Duty Check study. Expected fault {ik:.0f} kA vs {icu:.0f} kA breaking capacity, peak {ip:.2f} kA "
        "≤ {icm:.1f} kA making → PASS. Full working: Help → Verification.",
    "ver_diversity":
        "VERIFICATION TEMPLATE — load diversity / demand factors (IEC 60439). "
        "RUN: Load Diversity study. Expected installed {installed:.0f} kVA, coincidence factor Ks = {ks:.2f}, "
        "diversified demand {demand:.0f} kVA, demand current {i_demand:.1f} A. Full working: Help → Verification.",
    "ver_dc_arcflash":
        "VERIFICATION TEMPLATE — DC arc flash (Stokes & Oppenländer / Ammerman-CED). "
        "RUN: DC Arc Flash analysis. Expected arc current {i_arc:.0f} A, incident energy {e:.2f} cal/cm², "
        "boundary {afb_mm:.0f} mm, PPE Cat {ppe}. The DC bolted fault is set via dc_bolted_fault_ka on the bus. "
        "Full working: Help → Verification.",
    "ver_unbalanced_lf":
        "VERIFICATION TEMPLATE — unbalanced load flow (symmetrical components), phase split 60/20/20. "
        "RUN: Load Flow (unbalanced). Expected VUF {vuf:.2f} %, Va/Vb/Vc = {va:.3f} / {vb:.3f} / {vc:.3f} p.u. "
        "Full working: Help → Verification.",
}


def instructions(tid):
    """The template's instruction text with its EXPECTED values filled in."""
    values = {name: spec[1] for name, spec in EXPECTED[tid][1].items()}
    return INSTRUCTIONS[tid].format(**values)


def template_project(case_dir, tid, name):
    """The project exactly as the template embeds it."""
    with open(os.path.join(BASE, case_dir, "project.json")) as f:
        proj = json.load(f)
    # Freeze exactly as verified: prevent the fromJSON dataVersion<2 cable
    # resistance migration from rescaling raw/hot r_per_km values.
    proj["dataVersion"] = 2
    # Title bar / document name should match the template card name.
    proj["projectName"] = name
    if tid in VOLTAGE_FACTOR:
        proj["voltageFactor"] = VOLTAGE_FACTOR[tid]
    # Usage instructions shown in the app's Project Details → Description box.
    if tid in INSTRUCTIONS:
        proj.setdefault("projectDetails", {})
        proj["projectDetails"]["description"] = instructions(tid)
    return proj


def render():
    """The full verification-templates.js source."""
    meta = []
    data = {}
    for case_dir, tid, name, preview, desc in CASES:
        meta.append({"id": tid, "name": name, "category": "Verification / Standards",
                     "preview": preview, "description": desc})
        data[tid] = template_project(case_dir, tid, name)

    lines = []
    lines.append("/* ProtectionPro — Verification example projects.")
    lines.append(" *")
    lines.append(" * Ready-to-load SLDs reproducing the standards-anchored V&V cases in")
    lines.append(" * testing/ (IEC 60909 / 60364 / 61660, IEEE 1584-2002 / 80, textbook &")
    lines.append(" * first-principles examples). Each project is embedded verbatim from its")
    lines.append(" * testing case project.json and stamped dataVersion:2 so loading it")
    lines.append(" * reproduces the verified numbers exactly (no cable-resistance migration).")
    lines.append(" *")
    lines.append(" * GENERATED — do not hand-edit. Regenerate with")
    lines.append(" * `python testing/build_verification_templates.py`.")
    lines.append(" */")
    lines.append("")
    lines.append("const VerificationTemplates = {")
    lines.append("  meta: " + json.dumps(meta, indent=2).replace("\n", "\n  ") + ",")
    lines.append("")
    lines.append("  data: " + json.dumps(data, indent=2, ensure_ascii=False).replace("\n", "\n  ") + ",")
    lines.append("};")
    lines.append("")
    return "\n".join(lines)


def render_expected():
    """EXPECTED as JSON: {id: {"route", "checks": {name: [path, value, rel]}}}."""
    out = {}
    for tid, (route, checks) in EXPECTED.items():
        out[tid] = {"route": route, "checks": {
            name: [spec[0], spec[1], spec[2] if len(spec) > 2 else 1e-3]
            for name, spec in checks.items()}}
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


if __name__ == "__main__":
    with open(OUT, "w") as f:
        f.write(render())
    with open(OUT_EXPECTED, "w") as f:
        f.write(render_expected())
    print("Wrote", OUT, "and", OUT_EXPECTED)
    print("Cases:", len(CASES))
    print("Size:", os.path.getsize(OUT), "bytes")
