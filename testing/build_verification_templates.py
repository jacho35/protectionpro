import json, os

BASE = "/root/protectionpro/testing"
OUT = "/root/protectionpro/frontend/js/verification-templates.js"

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
    ("case-motor-starting", "ver_motor_start",
     "Motor Starting Voltage Dip",
     "DOL/star-delta/AT/soft — dip at bus",
     "Motor starting voltage-dip study. Full-load and starting current for all five starting methods (DOL, star-delta, autotransformer, soft-starter, VFD) and the terminal voltage dip match hand calculations / an independent 2-bus solve exactly (constant-PQ rotor model, conservative for weak systems)."),
    ("case-dc-loadflow", "ver_dc_lf",
     "DC Load Flow (first-principles)",
     "DC source → cables → loads",
     "DC load flow verified against an exact first-principles resistive-circuit solution. Bus voltages, cable currents and losses reproduce the hand calc to ≤0.005 %."),
    ("case-dc-shortcircuit", "ver_dc_sc",
     "DC Short Circuit (IEC 61660-1)",
     "Battery + converter DC fault",
     "IEC 61660-1 DC short circuit. Reproduces the published battery peak (5422 A) exactly from raw nameplate inputs — the full standard factors (E_B = 1.05·U_nB, 0.9·R_B peak, +0.1·R_B for I_k, T_B = 30 ms) are applied internally; converter current-limit is exact."),
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

# Per-template usage instructions, shown in the app's Project Details →
# Description text box when the template is loaded. Says which analysis to run,
# the pre-set voltage factor, the expected headline result, and any caveat.
INSTRUCTIONS = {
    "ver_sc_case1":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit (source: powerprojectsindia / ETAP). "
        "Voltage factor c = 1.0 is pre-set to match the reference. "
        "RUN: Fault analysis, fault at Bus4. Expected I″k3 ≈ 12.88 kA (ETAP 12.881, ≤0.01 %). "
        "Full working: Help → Verification.",
    "ver_sc_case2":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit with a 5 MW induction-motor contribution "
        "(source: powerprojectsindia / ETAP). Voltage factor c = 1.0 pre-set. "
        "RUN: Fault analysis, fault at Bus7. Expected I″k3 ≈ 14.81 kA (ETAP 14.824). "
        "Full working: Help → Verification.",
    "ver_sc_case3":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit: 5 MW motor + 18 MVA lump load "
        "(source: powerprojectsindia / ETAP). Voltage factor c = 1.0 pre-set. "
        "RUN: Fault analysis, fault at Bus5. Expected I″k3 ≈ 20.95 kA (ETAP 20.976). "
        "NOTE: 'Lump2' is an 18 MVA LOAD modelled as a motor so it contributes to the FAULT (per IEC 60909) — "
        "it is not a real motor. Do NOT run Motor Starting on this template: starting a 15 MW 'motor' collapses "
        "the network voltage and the load flow will not converge (this is expected, not a bug). "
        "Full working: Help → Verification.",
    "ver_sc_220_33":
        "VERIFICATION TEMPLATE — IEC 60909 short circuit, 220/33 kV 10 MVA Dyn1 (source: powerprojectsindia / ETAP). "
        "Voltage factor c = 1.10 (the app default) pre-set to match the reference ETAP screenshots. "
        "RUN: Fault analysis, fault at Bus2. Expected I″k3 = 2.296 kA (matches ETAP exactly). "
        "Full working: Help → Verification.",
    "ver_cable_lv":
        "VERIFICATION TEMPLATE — IEC 60364 LV cable sizing (source: powerprojectsindia). "
        "RUN: Cable Sizing study. The voltage-drop and adiabatic fault-withstand formulas reproduce the article "
        "exactly; the engine sizes conservatively for the IEC 60909-0 thermal-equivalent current I_th = I″k·√(m+n), "
        "so it recommends a larger conductor than the article's bare-Isc value. Full working: Help → Verification.",
    "ver_lf_3bus":
        "VERIFICATION TEMPLATE — Newton-Raphson load flow (Glover / ESE 470 3-bus example). "
        "RUN: Load Flow (Newton-Raphson). Expected V2 = 1.050∠−2.06°, V3 = 0.978∠−8.78°, converges in 4 iterations. "
        "Full working: Help → Verification.",
    "ver_arcflash":
        "VERIFICATION TEMPLATE — IEEE 1584-2002 arc flash, 480 V MCC. "
        "RUN: Arc Flash analysis. Expected E ≈ 12.82 cal/cm², PPE Cat 3, arc-flash boundary 1.93 m. "
        "Clearing time is derived from the upstream protective device (engineered to 0.2 s here). "
        "Full working: Help → Verification.",
    "ver_grounding":
        "VERIFICATION TEMPLATE — IEEE 80 grounding grid (70 × 70 m, 11 × 11 conductors, 20 rods). "
        "RUN: Grounding study. Expected grid resistance R_g = 2.75 Ω, GPR = 5252 V, mesh (touch) voltage 749 V "
        "≤ 841 V tolerable. Full working: Help → Verification.",
    "ver_motor_start":
        "VERIFICATION TEMPLATE — motor starting voltage dip: 1500 kW motor on a weak (~60 MVA) source, DOL. "
        "RUN: Motor Starting study. Expected DOL start current 921 A, terminal voltage 0.778 p.u., max dip 20.9 %, "
        "Will Start = NO (a deliberately weak system). Full working: Help → Verification.",
    "ver_dc_lf":
        "VERIFICATION TEMPLATE — DC load flow (exact resistive-circuit reference). "
        "RUN: Load Flow. Expected rectifier bus 124.5 V, load bus 115.8 V (7.34 % drop), cable current 86.3 A. "
        "Full working: Help → Verification.",
    "ver_dc_sc":
        "VERIFICATION TEMPLATE — DC short circuit, IEC 61660-1 battery (CED E03-035 Example 1). "
        "RUN: Fault analysis. Expected battery peak i_p = 5422 A from nameplate; converter I_k = 300 A, i_p = 315 A. "
        "Full working: Help → Verification.",
    "ver_duty":
        "VERIFICATION TEMPLATE — equipment duty check over the verified fault engine. "
        "RUN: Duty Check study. Expected fault 20 kA vs 25 kA breaking capacity, peak 49.38 kA ≤ 62.5 kA making "
        "→ PASS. Full working: Help → Verification.",
    "ver_diversity":
        "VERIFICATION TEMPLATE — load diversity / demand factors (IEC 60439). "
        "RUN: Load Diversity study. Expected installed 255 kVA, coincidence factor Ks = 0.85, diversified demand "
        "200 kVA, demand current 288.6 A. Full working: Help → Verification.",
    "ver_dc_arcflash":
        "VERIFICATION TEMPLATE — DC arc flash (Stokes & Oppenländer / Ammerman-CED). "
        "RUN: DC Arc Flash analysis. Expected arc current 6196 A, incident energy 10.82 cal/cm², boundary 1.37 m, "
        "PPE Cat 3. The DC bolted fault is set via dc_bolted_fault_ka on the bus. Full working: Help → Verification.",
    "ver_unbalanced_lf":
        "VERIFICATION TEMPLATE — unbalanced load flow (symmetrical components), phase split 60/20/20. "
        "RUN: Load Flow (unbalanced). Expected VUF 0.76 %, Va/Vb/Vc = 0.962 / 1.005 / 0.989 p.u. "
        "Full working: Help → Verification.",
}

meta = []
data = {}
for case_dir, tid, name, preview, desc in CASES:
    path = os.path.join(BASE, case_dir, "project.json")
    with open(path) as f:
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
        proj["projectDetails"]["description"] = INSTRUCTIONS[tid]
    meta.append({"id": tid, "name": name, "category": "Verification / Standards",
                 "preview": preview, "description": desc})
    data[tid] = proj

lines = []
lines.append("/* ProtectionPro — Verification example projects.")
lines.append(" *")
lines.append(" * Ready-to-load SLDs reproducing the standards-anchored V&V cases in")
lines.append(" * testing/ (IEC 60909 / 60364 / 61660, IEEE 1584-2002 / 80, textbook &")
lines.append(" * first-principles examples). Each project is embedded verbatim from its")
lines.append(" * testing case project.json and stamped dataVersion:2 so loading it")
lines.append(" * reproduces the verified numbers exactly (no cable-resistance migration).")
lines.append(" *")
lines.append(" * GENERATED — do not hand-edit. Regenerate from the testing case files.")
lines.append(" */")
lines.append("")
lines.append("const VerificationTemplates = {")
lines.append("  meta: " + json.dumps(meta, indent=2).replace("\n", "\n  ") + ",")
lines.append("")
lines.append("  data: " + json.dumps(data, indent=2, ensure_ascii=False).replace("\n", "\n  ") + ",")
lines.append("};")
lines.append("")

with open(OUT, "w") as f:
    f.write("\n".join(lines))

print("Wrote", OUT)
print("Cases:", len(meta))
print("Size:", os.path.getsize(OUT), "bytes")
