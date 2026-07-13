/* ProtectionPro — Verification example projects.
 *
 * Ready-to-load SLDs reproducing the standards-anchored V&V cases in
 * testing/ (IEC 60909 / 60364 / 61660, IEEE 1584-2002 / 80, textbook &
 * first-principles examples). Each project is embedded verbatim from its
 * testing case project.json and stamped dataVersion:2 so loading it
 * reproduces the verified numbers exactly (no cable-resistance migration).
 *
 * GENERATED — do not hand-edit. Regenerate from the testing case files.
 */

const VerificationTemplates = {
  meta: [
    {
      "id": "ver_sc_case1",
      "name": "SC Case 1 \u2014 No Load (IEC 60909)",
      "category": "Verification / Standards",
      "preview": "Grid \u2192 25 MVA Xfmr \u2192 11 kV bus fault",
      "description": "IEC 60909 short circuit \u2014 baseline network (grid \u2192 25 MVA transformer \u2192 11 kV bus). Reproduces the powerprojectsindia / ETAP worked example for all four fault types to within 0.01 %. Run with voltage factor c = 1.0 to match the reference screenshots."
    },
    {
      "id": "ver_sc_case2",
      "name": "SC Case 2 \u2014 Motor Contribution (IEC 60909)",
      "category": "Verification / Standards",
      "preview": "Case 1 + cable + 5 MW induction motor",
      "description": "IEC 60909 short circuit with a 5 MW induction-motor fault contribution added via a feeder cable. Matches the ETAP reference to \u22640.09 % including the motor sub-transient split. Fault at Bus7, c = 1.0."
    },
    {
      "id": "ver_sc_case3",
      "name": "SC Case 3 \u2014 Motor + Lump Load (IEC 60909)",
      "category": "Verification / Standards",
      "preview": "Case 2 + 18 MVA lump load (as motor eqv.)",
      "description": "IEC 60909 short circuit with multiple infeeds \u2014 5 MW motor plus an 18 MVA lump load modelled as an induction-motor equivalent. Matches ETAP to \u22640.13 %. Fault at Bus5, c = 1.0."
    },
    {
      "id": "ver_sc_220_33",
      "name": "SC \u2014 220/33 kV, 10 MVA Dyn1 (ETAP)",
      "category": "Verification / Standards",
      "preview": "220 kV grid \u2192 10 MVA Dyn1 \u2192 33 kV fault",
      "description": "IEC 60909 short circuit on a 220/33 kV, 10 MVA Dyn1 network. Matches the second powerprojectsindia / ETAP example exactly (0.00 %) across all four fault types and exposes a base-mixing arithmetic error in the article's own hand calc. Run with c = 1.10 (the app default)."
    },
    {
      "id": "ver_cable_lv",
      "name": "LV Cable Sizing (IEC 60364)",
      "category": "Verification / Standards",
      "preview": "0.4 kV feeder + cable thermal / VD check",
      "description": "IEC 60364 LV cable sizing. The voltage-drop and adiabatic fault-withstand formulas reproduce the reference article exactly; the integrated engine is network-fed and sizes for the IEC 60909-0 \u00a712 thermal-equivalent current, so its final size is deliberately more conservative."
    },
    {
      "id": "ver_lf_3bus",
      "name": "3-Bus Load Flow (Glover / Newton-Raphson)",
      "category": "Verification / Standards",
      "preview": "Slack + PV + PQ, 3 lines \u2014 NR solve",
      "description": "Newton-Raphson load flow verified against the Glover / ESE 470 textbook 3-bus example (slack at 1.0 pu, one PV, one PQ). Reproduces the published voltages and angles to \u22640.002 pu / 0.04\u00b0 with the same 4-iteration convergence."
    },
    {
      "id": "ver_arcflash",
      "name": "Arc Flash (IEEE 1584-2002)",
      "category": "Verification / Standards",
      "preview": "480 V MCC \u2014 incident energy & AFB",
      "description": "IEEE 1584-2002 arc flash. Reproduces the standard's arcing-current (Eq. 1\u20132), incident-energy (Eq. 3\u20135) and arc-flash-boundary hand calculations exactly (0.000 %). End-to-end result: E \u2248 12.82 cal/cm\u00b2, PPE Cat 3, AFB 1.93 m."
    },
    {
      "id": "ver_grounding",
      "name": "Grounding Grid (IEEE 80)",
      "category": "Verification / Standards",
      "preview": "Square grid + rods \u2014 touch/step/GPR",
      "description": "IEEE 80 grounding grid on a square grid with rods. Reproduces the tolerable touch/step voltages, surface derating C_s, grid resistance R_g (Sverak), GPR, geometric factors and mesh voltage exactly (full Eq. 84\u201388 n / K_ii / rod-weighted L_M)."
    },
    {
      "id": "ver_motor_start",
      "name": "Motor Starting Voltage Dip",
      "category": "Verification / Standards",
      "preview": "DOL/star-delta/AT/soft \u2014 dip at bus",
      "description": "Motor starting voltage-dip study. Full-load and starting current for all five starting methods (DOL, star-delta, autotransformer, soft-starter, VFD) and the terminal voltage dip match hand calculations / an independent 2-bus solve exactly (constant-PQ rotor model, conservative for weak systems)."
    },
    {
      "id": "ver_dc_lf",
      "name": "DC Load Flow (first-principles)",
      "category": "Verification / Standards",
      "preview": "DC source \u2192 cables \u2192 loads",
      "description": "DC load flow verified against an exact first-principles resistive-circuit solution. Bus voltages, cable currents and losses reproduce the hand calc to \u22640.005 %."
    },
    {
      "id": "ver_dc_sc",
      "name": "DC Short Circuit (IEC 61660-1)",
      "category": "Verification / Standards",
      "preview": "Battery + converter DC fault",
      "description": "IEC 61660-1 DC short circuit. Reproduces the published battery peak (5422 A) exactly from raw nameplate inputs \u2014 the full standard factors (E_B = 1.05\u00b7U_nB, 0.9\u00b7R_B peak, +0.1\u00b7R_B for I_k, T_B = 30 ms) are applied internally; converter current-limit is exact."
    },
    {
      "id": "ver_duty",
      "name": "Equipment Duty Check",
      "category": "Verification / Standards",
      "preview": "Breaker peak / making / breaking duty",
      "description": "Equipment duty check layered on the verified fault engine. Peak (\u03ba\u00b7\u221a2\u00b7I\u2033k), making capacity (2.5\u00b7Icu MV / IEC 60947-2 LV) and breaking-duty (Ib) comparisons reproduce the hand calculations exactly."
    },
    {
      "id": "ver_diversity",
      "name": "Load Diversity / Demand Factors",
      "category": "Verification / Standards",
      "preview": "Grouped loads \u2014 Ks & diversified demand",
      "description": "Load diversity study. Per-load demand factors, IEC group coincidence factor Ks, diversified demand, effective demand factor and demand current all reproduce an exact demand-aggregation hand calc."
    },
    {
      "id": "ver_dc_arcflash",
      "name": "DC Arc Flash (Stokes & Oppenl\u00e4nder)",
      "category": "Verification / Standards",
      "preview": "DC bus \u2014 arc operating point & E",
      "description": "DC arc flash via the Ammerman / CED published method. The Stokes & Oppenl\u00e4nder arc operating point and the spherical incident-energy / boundary reproduce the reference to \u22640.06 % (calorie rounding)."
    },
    {
      "id": "ver_unbalanced_lf",
      "name": "Unbalanced Load Flow (symmetrical comp.)",
      "category": "Verification / Standards",
      "preview": "Sequence-based unbalanced solve + VUF",
      "description": "Unbalanced load flow (symmetrical-component engine). Collapses to the exact balanced solution when balanced, its positive sequence equals the verified Newton-Raphson balanced LF, and the phase\u2194sequence transform and VUF = |V2|/|V1| are exact."
    }
  ],

  data: {
    "ver_sc_case1": {
      "projectName": "SC Case 1 — No Load (IEC 60909)",
      "baseMVA": 100.0,
      "frequency": 50,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "GRID",
            "voltage_kv": 110,
            "fault_mva": 7621.023,
            "x_r_ratio": 14,
            "z2_z1_ratio": 1.0,
            "z0_z1_ratio": 1.0,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-3",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "Bus3",
            "voltage_kv": 110
          }
        },
        {
          "id": "transformer-1",
          "type": "transformer",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "T1",
            "rated_mva": 25,
            "z_percent": 10,
            "x_r_ratio": 20,
            "voltage_hv_kv": 110,
            "voltage_lv_kv": 11,
            "vector_group": "Dyn11",
            "winding_config": "step_down",
            "grounding_lv": "solidly_grounded",
            "grounding_hv": "ungrounded"
          }
        },
        {
          "id": "bus-4",
          "type": "bus",
          "x": 200,
          "y": 300,
          "rotation": 0,
          "props": {
            "name": "Bus4",
            "voltage_kv": 11
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-3",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-3",
          "fromPort": "p1",
          "toComponent": "transformer-1",
          "toPort": "primary"
        },
        {
          "id": "w3",
          "fromComponent": "transformer-1",
          "fromPort": "secondary",
          "toComponent": "bus-4",
          "toPort": "p0"
        }
      ],
      "nextId": 100,
      "dataVersion": 2,
      "voltageFactor": 1.0
    },
    "ver_sc_case2": {
      "projectName": "SC Case 2 — Motor Contribution (IEC 60909)",
      "baseMVA": 100.0,
      "frequency": 50,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "GRID",
            "voltage_kv": 110,
            "fault_mva": 7621.023,
            "x_r_ratio": 14,
            "z2_z1_ratio": 1.0,
            "z0_z1_ratio": 1.0,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-8",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "Bus8",
            "voltage_kv": 110
          }
        },
        {
          "id": "transformer-3",
          "type": "transformer",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "T3",
            "rated_mva": 25,
            "z_percent": 10,
            "x_r_ratio": 20,
            "voltage_hv_kv": 110,
            "voltage_lv_kv": 11,
            "vector_group": "Dyn11",
            "winding_config": "step_down",
            "grounding_lv": "solidly_grounded",
            "grounding_hv": "ungrounded"
          }
        },
        {
          "id": "bus-7",
          "type": "bus",
          "x": 200,
          "y": 300,
          "rotation": 0,
          "props": {
            "name": "Bus7",
            "voltage_kv": 11
          }
        },
        {
          "id": "cable-8",
          "type": "cable",
          "x": 300,
          "y": 380,
          "rotation": 0,
          "props": {
            "name": "Cable",
            "r_per_km": 9.8,
            "x_per_km": 9.0,
            "length_km": 0.01,
            "r0_per_km": 0,
            "x0_per_km": 0,
            "voltage_kv": 11,
            "num_parallel": 1
          }
        },
        {
          "id": "bus-10",
          "type": "bus",
          "x": 200,
          "y": 460,
          "rotation": 0,
          "props": {
            "name": "Bus10",
            "voltage_kv": 11
          }
        },
        {
          "id": "motor_induction-3",
          "type": "motor_induction",
          "x": 300,
          "y": 540,
          "rotation": 0,
          "props": {
            "name": "Mtr3",
            "rated_kw": 5000,
            "voltage_kv": 11,
            "efficiency": 0.9,
            "power_factor": 0.95,
            "x_pp": 0.15319,
            "x_r_ratio": 10.825,
            "x2": 0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-8",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-8",
          "fromPort": "p1",
          "toComponent": "transformer-3",
          "toPort": "primary"
        },
        {
          "id": "w3",
          "fromComponent": "transformer-3",
          "fromPort": "secondary",
          "toComponent": "bus-7",
          "toPort": "p0"
        },
        {
          "id": "w4",
          "fromComponent": "bus-7",
          "fromPort": "p1",
          "toComponent": "cable-8",
          "toPort": "from"
        },
        {
          "id": "w5",
          "fromComponent": "cable-8",
          "fromPort": "to",
          "toComponent": "bus-10",
          "toPort": "p0"
        },
        {
          "id": "w6",
          "fromComponent": "bus-10",
          "fromPort": "p1",
          "toComponent": "motor_induction-3",
          "toPort": "in"
        }
      ],
      "nextId": 100,
      "dataVersion": 2,
      "voltageFactor": 1.0
    },
    "ver_sc_case3": {
      "projectName": "SC Case 3 — Motor + Lump Load (IEC 60909)",
      "baseMVA": 100.0,
      "frequency": 50,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "GRID",
            "voltage_kv": 110,
            "fault_mva": 7621.023,
            "x_r_ratio": 14,
            "z2_z1_ratio": 1.0,
            "z0_z1_ratio": 1.0,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-6",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "Bus6",
            "voltage_kv": 110
          }
        },
        {
          "id": "transformer-2",
          "type": "transformer",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "T2",
            "rated_mva": 25,
            "z_percent": 10,
            "x_r_ratio": 20,
            "voltage_hv_kv": 110,
            "voltage_lv_kv": 11,
            "vector_group": "Dyn11",
            "winding_config": "step_down",
            "grounding_lv": "solidly_grounded",
            "grounding_hv": "ungrounded"
          }
        },
        {
          "id": "bus-5",
          "type": "bus",
          "x": 200,
          "y": 300,
          "rotation": 0,
          "props": {
            "name": "Bus5",
            "voltage_kv": 11
          }
        },
        {
          "id": "cable-21",
          "type": "cable",
          "x": 400,
          "y": 380,
          "rotation": 0,
          "props": {
            "name": "Cable",
            "r_per_km": 9.8,
            "x_per_km": 9.0,
            "length_km": 0.01,
            "r0_per_km": 0,
            "x0_per_km": 0,
            "voltage_kv": 11,
            "num_parallel": 1
          }
        },
        {
          "id": "bus-11",
          "type": "bus",
          "x": 350,
          "y": 460,
          "rotation": 0,
          "props": {
            "name": "Bus11",
            "voltage_kv": 11
          }
        },
        {
          "id": "motor_induction-1",
          "type": "motor_induction",
          "x": 400,
          "y": 540,
          "rotation": 0,
          "props": {
            "name": "Mtr1",
            "rated_kw": 5000,
            "voltage_kv": 11,
            "efficiency": 0.9,
            "power_factor": 0.95,
            "x_pp": 0.15319,
            "x_r_ratio": 10.825,
            "x2": 0
          }
        },
        {
          "id": "motor_induction-2",
          "type": "motor_induction",
          "x": 150,
          "y": 380,
          "rotation": 0,
          "props": {
            "name": "Lump2",
            "rated_kw": 15300,
            "voltage_kv": 11,
            "efficiency": 1.0,
            "power_factor": 0.85,
            "x_pp": 0.15308,
            "x_r_ratio": 10,
            "x2": 0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-6",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-6",
          "fromPort": "p1",
          "toComponent": "transformer-2",
          "toPort": "primary"
        },
        {
          "id": "w3",
          "fromComponent": "transformer-2",
          "fromPort": "secondary",
          "toComponent": "bus-5",
          "toPort": "p0"
        },
        {
          "id": "w4",
          "fromComponent": "bus-5",
          "fromPort": "p1",
          "toComponent": "cable-21",
          "toPort": "from"
        },
        {
          "id": "w5",
          "fromComponent": "cable-21",
          "fromPort": "to",
          "toComponent": "bus-11",
          "toPort": "p0"
        },
        {
          "id": "w6",
          "fromComponent": "bus-11",
          "fromPort": "p1",
          "toComponent": "motor_induction-1",
          "toPort": "in"
        },
        {
          "id": "w7",
          "fromComponent": "bus-5",
          "fromPort": "p2",
          "toComponent": "motor_induction-2",
          "toPort": "in"
        }
      ],
      "nextId": 100,
      "dataVersion": 2,
      "voltageFactor": 1.0
    },
    "ver_sc_220_33": {
      "projectName": "SC — 220/33 kV, 10 MVA Dyn1 (ETAP)",
      "baseMVA": 100.0,
      "frequency": 50,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Grid1",
            "voltage_kv": 220,
            "fault_mva": 15242.047,
            "x_r_ratio": 10,
            "z2_z1_ratio": 1.0,
            "z0_z1_ratio": 1.0,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "Bus1",
            "voltage_kv": 220
          }
        },
        {
          "id": "transformer-1",
          "type": "transformer",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "T1",
            "rated_mva": 10,
            "z_percent": 8.35,
            "x_r_ratio": 13,
            "voltage_hv_kv": 220,
            "voltage_lv_kv": 33,
            "vector_group": "Dyn1",
            "winding_config": "step_down",
            "grounding_lv": "solidly_grounded",
            "grounding_hv": "ungrounded"
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 200,
          "y": 300,
          "rotation": 0,
          "props": {
            "name": "Bus2",
            "voltage_kv": 33
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "transformer-1",
          "toPort": "primary"
        },
        {
          "id": "w3",
          "fromComponent": "transformer-1",
          "fromPort": "secondary",
          "toComponent": "bus-2",
          "toPort": "p0"
        }
      ],
      "nextId": 100,
      "dataVersion": 2,
      "voltageFactor": 1.1
    },
    "ver_cable_lv": {
      "projectName": "LV Cable Sizing (IEC 60364)",
      "baseMVA": 100.0,
      "frequency": 50,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 0.415,
            "fault_mva": 28.75204340564336,
            "x_r_ratio": 5,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-a",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "BusA",
            "voltage_kv": 0.415
          }
        },
        {
          "id": "cable-1",
          "type": "cable",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "Cable",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 95,
            "r_per_km": 0.247,
            "x_per_km": 0.0734,
            "length_km": 0.12,
            "voltage_kv": 0.415,
            "rated_amps": 254,
            "num_parallel": 1,
            "ampacity_standard": "IEC"
          }
        },
        {
          "id": "bus-b",
          "type": "bus",
          "x": 200,
          "y": 280,
          "rotation": 0,
          "props": {
            "name": "BusB",
            "voltage_kv": 0.415
          }
        },
        {
          "id": "static_load-1",
          "type": "static_load",
          "x": 300,
          "y": 360,
          "rotation": 0,
          "props": {
            "name": "Motor90kW",
            "rated_kva": 117.646,
            "voltage_kv": 0.415,
            "power_factor": 0.85,
            "load_type": "constant_power",
            "demand_factor": 1.0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-a",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-a",
          "fromPort": "p1",
          "toComponent": "cable-1",
          "toPort": "from"
        },
        {
          "id": "w3",
          "fromComponent": "cable-1",
          "fromPort": "to",
          "toComponent": "bus-b",
          "toPort": "p0"
        },
        {
          "id": "w4",
          "fromComponent": "bus-b",
          "fromPort": "p1",
          "toComponent": "static_load-1",
          "toPort": "in"
        }
      ],
      "nextId": 100,
      "dataVersion": 2
    },
    "ver_lf_3bus": {
      "projectName": "3-Bus Load Flow (Glover / Newton-Raphson)",
      "baseMVA": 100.0,
      "frequency": 50,
      "dataVersion": 2,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 160,
          "y": 60,
          "rotation": 0,
          "props": {
            "name": "Slack",
            "voltage_kv": 230.0,
            "fault_mva": 99999,
            "x_r_ratio": 10,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 160,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "Bus1",
            "voltage_kv": 230.0,
            "bus_type": "Swing"
          }
        },
        {
          "id": "generator-1",
          "type": "generator",
          "x": 680,
          "y": 600,
          "rotation": 0,
          "props": {
            "name": "Gen2",
            "rated_mva": 250,
            "voltage_kv": 230.0,
            "power_factor": 0.8,
            "xd_pp": 0.2,
            "x_r_ratio": 40,
            "dispatch_mode": "must_run",
            "voltage_setpoint_pu": 1.05
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 680,
          "y": 480,
          "rotation": 0,
          "props": {
            "name": "Bus2",
            "voltage_kv": 230.0,
            "bus_type": "PV"
          }
        },
        {
          "id": "bus-3",
          "type": "bus",
          "x": 1200,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "Bus3",
            "voltage_kv": 230.0,
            "bus_type": "PQ"
          }
        },
        {
          "id": "static_load-1",
          "type": "static_load",
          "x": 1320,
          "y": 340,
          "rotation": 0,
          "props": {
            "name": "Load3",
            "rated_kva": 509902.0,
            "voltage_kv": 230.0,
            "power_factor": 0.980581,
            "load_type": "constant_power",
            "demand_factor": 1.0
          }
        },
        {
          "id": "cable-12",
          "type": "cable",
          "x": 0,
          "y": 0,
          "rotation": 0,
          "props": {
            "name": "L1-2",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 500,
            "r_per_km": 2.4466,
            "x_per_km": 25.0714,
            "length_km": 1.0,
            "voltage_kv": 230.0,
            "num_parallel": 1,
            "rated_amps": 2000,
            "ampacity_standard": "IEC"
          }
        },
        {
          "id": "cable-13",
          "type": "cable",
          "x": 0,
          "y": 0,
          "rotation": 0,
          "props": {
            "name": "L1-3",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 500,
            "r_per_km": 3.2967,
            "x_per_km": 33.3741,
            "length_km": 1.0,
            "voltage_kv": 230.0,
            "num_parallel": 1,
            "rated_amps": 2000,
            "ampacity_standard": "IEC"
          }
        },
        {
          "id": "cable-23",
          "type": "cable",
          "x": 0,
          "y": 0,
          "rotation": 0,
          "props": {
            "name": "L2-3",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 500,
            "r_per_km": 2.4466,
            "x_per_km": 25.0714,
            "length_km": 1.0,
            "voltage_kv": 230.0,
            "num_parallel": 1,
            "rated_amps": 2000,
            "ampacity_standard": "IEC"
          }
        }
      ],
      "wires": [
        {
          "id": "w-u",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        },
        {
          "id": "w-g",
          "fromComponent": "generator-1",
          "fromPort": "out",
          "toComponent": "bus-2",
          "toPort": "p0"
        },
        {
          "id": "w-l",
          "fromComponent": "bus-3",
          "fromPort": "p9",
          "toComponent": "static_load-1",
          "toPort": "in"
        },
        {
          "id": "w12a",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "cable-12",
          "toPort": "from"
        },
        {
          "id": "w12b",
          "fromComponent": "cable-12",
          "fromPort": "to",
          "toComponent": "bus-2",
          "toPort": "p1"
        },
        {
          "id": "w13a",
          "fromComponent": "bus-1",
          "fromPort": "p2",
          "toComponent": "cable-13",
          "toPort": "from"
        },
        {
          "id": "w13b",
          "fromComponent": "cable-13",
          "fromPort": "to",
          "toComponent": "bus-3",
          "toPort": "p1"
        },
        {
          "id": "w23a",
          "fromComponent": "bus-2",
          "fromPort": "p2",
          "toComponent": "cable-23",
          "toPort": "from"
        },
        {
          "id": "w23b",
          "fromComponent": "cable-23",
          "fromPort": "to",
          "toComponent": "bus-3",
          "toPort": "p2"
        }
      ],
      "nextId": 100
    },
    "ver_arcflash": {
      "projectName": "Arc Flash (IEEE 1584-2002)",
      "baseMVA": 100.0,
      "frequency": 50,
      "voltageFactor": 1.0,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 0.48,
            "fault_mva": 20.7846,
            "x_r_ratio": 10,
            "grounding": "solidly"
          }
        },
        {
          "id": "cb-1",
          "type": "cb",
          "x": 300,
          "y": 140,
          "rotation": 0,
          "props": {
            "name": "CB",
            "cb_type": "acb",
            "state": "closed"
          }
        },
        {
          "id": "relay-1",
          "type": "relay",
          "x": 420,
          "y": 140,
          "rotation": 0,
          "props": {
            "name": "R1",
            "relay_type": "50/51",
            "curve": "Definite Time",
            "pickup_a": 1000,
            "time_dial": 0.12,
            "inst_pickup_a": 0,
            "trip_cb": "cb-1"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 240,
          "rotation": 0,
          "props": {
            "name": "MCC-480V",
            "voltage_kv": 0.48,
            "working_distance_mm": 455.0,
            "electrode_config": "VCB"
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "cb-1",
          "toPort": "top"
        },
        {
          "id": "w2",
          "fromComponent": "cb-1",
          "fromPort": "bottom",
          "toComponent": "bus-1",
          "toPort": "p0"
        }
      ],
      "nextId": 100,
      "dataVersion": 2
    },
    "ver_grounding": {
      "projectName": "Grounding Grid (IEEE 80)",
      "baseMVA": 100.0,
      "frequency": 50,
      "voltageFactor": 1.0,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 11.0,
            "fault_mva": 36.3523,
            "x_r_ratio": 0.05,
            "grounding": "ungrounded"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 160,
          "rotation": 0,
          "props": {
            "name": "GridBus",
            "voltage_kv": 11.0,
            "soil_resistivity": 400.0,
            "crushed_rock_resistivity": 2500.0,
            "crushed_rock_depth": 0.102,
            "grid_length": 70.0,
            "grid_width": 70.0,
            "grid_depth": 0.5,
            "num_conductors_x": 11,
            "num_conductors_y": 11,
            "ground_rod_length": 7.5,
            "num_ground_rods": 20,
            "conductor_diameter": 0.01,
            "conductor_material": "copper_hard",
            "fault_duration": 0.5,
            "fault_clearing_time": 0.5,
            "ambient_temp": 40.0,
            "body_weight": 70
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        }
      ],
      "nextId": 100,
      "dataVersion": 2
    },
    "ver_motor_start": {
      "projectName": "Motor Starting Voltage Dip",
      "baseMVA": 100.0,
      "frequency": 50,
      "dataVersion": 2,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Grid",
            "voltage_kv": 6.6,
            "fault_mva": 99999,
            "x_r_ratio": 10,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 140,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 6.6,
            "bus_type": "Swing"
          }
        },
        {
          "id": "cable-1",
          "type": "cable",
          "x": 300,
          "y": 220,
          "rotation": 0,
          "props": {
            "name": "SysZ",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 300,
            "r_per_km": 0.0722,
            "x_per_km": 0.7224,
            "length_km": 1.0,
            "voltage_kv": 6.6,
            "num_parallel": 1,
            "rated_amps": 600,
            "ampacity_standard": "IEC"
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 200,
          "y": 320,
          "rotation": 0,
          "props": {
            "name": "MotorBus",
            "voltage_kv": 6.6,
            "bus_type": "PQ"
          }
        },
        {
          "id": "motor_induction-1",
          "type": "motor_induction",
          "x": 300,
          "y": 400,
          "rotation": 0,
          "props": {
            "name": "M1",
            "rated_kw": 1500.0,
            "voltage_kv": 6.6,
            "efficiency": 0.95,
            "power_factor": 0.9,
            "locked_rotor_current": 6.0,
            "starting_method": "dol"
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "cable-1",
          "toPort": "from"
        },
        {
          "id": "w3",
          "fromComponent": "cable-1",
          "fromPort": "to",
          "toComponent": "bus-2",
          "toPort": "p0"
        },
        {
          "id": "w4",
          "fromComponent": "bus-2",
          "fromPort": "p1",
          "toComponent": "motor_induction-1",
          "toPort": "in"
        }
      ],
      "nextId": 100
    },
    "ver_dc_lf": {
      "projectName": "DC Load Flow (first-principles)",
      "baseMVA": 100,
      "frequency": 50,
      "components": [
        {
          "id": "bus-1",
          "type": "bus",
          "x": 100,
          "y": 100,
          "rotation": 0,
          "props": {
            "name": "RectBus",
            "system": "dc",
            "voltage_dc_v": 125
          }
        },
        {
          "id": "rectifier-1",
          "type": "rectifier",
          "x": 100,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Rect",
            "voltage_dc_v": 125,
            "rated_kw": 25
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 300,
          "y": 100,
          "rotation": 0,
          "props": {
            "name": "LoadBus",
            "system": "dc",
            "voltage_dc_v": 125
          }
        },
        {
          "id": "cable-1",
          "type": "cable",
          "x": 200,
          "y": 100,
          "rotation": 0,
          "props": {
            "name": "DCcbl",
            "r_per_km": 0.1,
            "x_per_km": 0.08,
            "length_km": 0.5,
            "num_parallel": 1,
            "rated_amps": 300
          }
        },
        {
          "id": "dc_load-1",
          "type": "dc_load",
          "x": 300,
          "y": 180,
          "rotation": 0,
          "props": {
            "name": "Ld",
            "load_model": "constant_power",
            "load_kw": 10
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "rectifier-1",
          "fromPort": "o",
          "toComponent": "bus-1",
          "toPort": "i"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "o",
          "toComponent": "cable-1",
          "toPort": "i"
        },
        {
          "id": "w3",
          "fromComponent": "cable-1",
          "fromPort": "o",
          "toComponent": "bus-2",
          "toPort": "i"
        },
        {
          "id": "w4",
          "fromComponent": "bus-2",
          "fromPort": "o",
          "toComponent": "dc_load-1",
          "toPort": "i"
        }
      ],
      "nextId": 50,
      "dataVersion": 2
    },
    "ver_dc_sc": {
      "projectName": "DC Short Circuit (IEC 61660-1)",
      "baseMVA": 100,
      "frequency": 50,
      "components": [
        {
          "id": "dcb-1",
          "type": "dc_battery",
          "x": 100,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Bat",
            "nominal_v": 120.0,
            "internal_r_mohm": 18.6,
            "internal_l_uh": 14.61,
            "ah_capacity": 200
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 100,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "BatBus",
            "system": "dc",
            "voltage_dc_v": 120.0
          }
        },
        {
          "id": "cable-1",
          "type": "cable",
          "x": 100,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "cbl",
            "r_per_km": 0.006498,
            "x_per_km": 0.004398,
            "length_km": 0.5,
            "num_parallel": 1,
            "rated_amps": 6000
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 100,
          "y": 280,
          "rotation": 0,
          "props": {
            "name": "Brk",
            "system": "dc",
            "voltage_dc_v": 120.0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "dcb-1",
          "fromPort": "o",
          "toComponent": "bus-1",
          "toPort": "i"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "o",
          "toComponent": "cable-1",
          "toPort": "i"
        },
        {
          "id": "w3",
          "fromComponent": "cable-1",
          "fromPort": "o",
          "toComponent": "bus-2",
          "toPort": "i"
        }
      ],
      "nextId": 50,
      "dataVersion": 2
    },
    "ver_duty": {
      "projectName": "Equipment Duty Check",
      "baseMVA": 100,
      "frequency": 50,
      "voltageFactor": 1.0,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Grid",
            "voltage_kv": 6.6,
            "fault_mva": 228.631,
            "x_r_ratio": 10,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 140,
          "rotation": 0,
          "props": {
            "name": "Bus1",
            "voltage_kv": 6.6
          }
        },
        {
          "id": "cb-1",
          "type": "cb",
          "x": 200,
          "y": 240,
          "rotation": 0,
          "props": {
            "name": "CB1",
            "cb_type": "vcb",
            "breaking_capacity_ka": 25,
            "rated_current_a": 1250,
            "rated_voltage_kv": 7.2
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "cb-1",
          "toPort": "top"
        }
      ],
      "nextId": 50,
      "dataVersion": 2
    },
    "ver_diversity": {
      "projectName": "Load Diversity / Demand Factors",
      "baseMVA": 100,
      "frequency": 50,
      "components": [
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 100,
          "rotation": 0,
          "props": {
            "name": "LVBus",
            "voltage_kv": 0.4
          }
        },
        {
          "id": "static_load-1",
          "type": "static_load",
          "x": 100,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "L1",
            "rated_kva": 100,
            "power_factor": 0.9,
            "demand_factor": 0.8
          }
        },
        {
          "id": "static_load-2",
          "type": "static_load",
          "x": 250,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "L2",
            "rated_kva": 50,
            "power_factor": 0.85,
            "demand_factor": 1.0
          }
        },
        {
          "id": "motor_induction-1",
          "type": "motor_induction",
          "x": 400,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "M1",
            "rated_kw": 90,
            "efficiency": 0.95,
            "power_factor": 0.9,
            "demand_factor": 1.0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "bus-1",
          "fromPort": "p0",
          "toComponent": "static_load-1",
          "toPort": "in"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "static_load-2",
          "toPort": "in"
        },
        {
          "id": "w3",
          "fromComponent": "bus-1",
          "fromPort": "p2",
          "toComponent": "motor_induction-1",
          "toPort": "in"
        }
      ],
      "nextId": 50,
      "dataVersion": 2
    },
    "ver_dc_arcflash": {
      "projectName": "DC Arc Flash (Stokes & Oppenländer)",
      "baseMVA": 100,
      "frequency": 50,
      "voltageFactor": 1.0,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 0.25,
            "fault_mva": 4.3301,
            "x_r_ratio": 10,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 140,
          "rotation": 0,
          "props": {
            "name": "DCbus",
            "voltage_kv": 0.25,
            "dc_bolted_fault_ka": 10.0,
            "gap_mm": 25.0,
            "working_distance_mm": 455.0
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        }
      ],
      "nextId": 50,
      "dataVersion": 2
    },
    "ver_unbalanced_lf": {
      "projectName": "Unbalanced Load Flow (symmetrical comp.)",
      "baseMVA": 100.0,
      "frequency": 50,
      "dataVersion": 2,
      "components": [
        {
          "id": "utility-1",
          "type": "utility",
          "x": 300,
          "y": 40,
          "rotation": 0,
          "props": {
            "name": "Grid",
            "voltage_kv": 11.0,
            "fault_mva": 200,
            "x_r_ratio": 10,
            "z2_z1_ratio": 1.0,
            "z0_z1_ratio": 1.0,
            "grounding": "solidly"
          }
        },
        {
          "id": "bus-1",
          "type": "bus",
          "x": 200,
          "y": 120,
          "rotation": 0,
          "props": {
            "name": "Src",
            "voltage_kv": 11.0,
            "bus_type": "Swing"
          }
        },
        {
          "id": "cable-1",
          "type": "cable",
          "x": 300,
          "y": 200,
          "rotation": 0,
          "props": {
            "name": "Ln",
            "conductor": "Cu",
            "insulation": "XLPE",
            "size_mm2": 120,
            "r_per_km": 0.5,
            "x_per_km": 1.0,
            "length_km": 1.0,
            "r0_per_km": 1.5,
            "x0_per_km": 3.0,
            "num_parallel": 1,
            "rated_amps": 300,
            "ampacity_standard": "IEC"
          }
        },
        {
          "id": "bus-2",
          "type": "bus",
          "x": 200,
          "y": 300,
          "rotation": 0,
          "props": {
            "name": "LoadBus",
            "voltage_kv": 11.0,
            "bus_type": "PQ"
          }
        },
        {
          "id": "static_load-1",
          "type": "static_load",
          "x": 300,
          "y": 380,
          "rotation": 0,
          "props": {
            "name": "Ld",
            "rated_kva": 2000,
            "power_factor": 0.9,
            "phase_connection": "3P",
            "phase_a_pct": 60,
            "phase_b_pct": 20,
            "phase_c_pct": 20
          }
        }
      ],
      "wires": [
        {
          "id": "w1",
          "fromComponent": "utility-1",
          "fromPort": "out",
          "toComponent": "bus-1",
          "toPort": "p0"
        },
        {
          "id": "w2",
          "fromComponent": "bus-1",
          "fromPort": "p1",
          "toComponent": "cable-1",
          "toPort": "from"
        },
        {
          "id": "w3",
          "fromComponent": "cable-1",
          "fromPort": "to",
          "toComponent": "bus-2",
          "toPort": "p0"
        },
        {
          "id": "w4",
          "fromComponent": "bus-2",
          "fromPort": "p1",
          "toComponent": "static_load-1",
          "toPort": "in"
        }
      ],
      "nextId": 50
    }
  },
};
