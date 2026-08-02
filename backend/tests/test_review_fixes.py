"""Regression tests for the independent EE / protection review of the
transient-stability engine (findings D1–D8).

Each test pins the behaviour a defect got wrong, with the physical reasoning in
the docstring, so a future change that reintroduces the defect fails here rather
than in a study. Findings, in the order they were fixed:

  D1  distance reach was scaled by the relay's own `voltage_kv` prop (which
      constants.js hard-defaults to 11 kV) instead of the bus it measures
  D7  GAST's fuel/temperature limit was compared against a system-per-unit
      command, so it never bound and the turbine had no power cap at all
  D6  self-polarized 21 and 67 elements both operated for a bolted fault at the
      relay's own bus, where V = 0 makes the polarising quantity indeterminate
  D4  the 21 element had no fault detector and no power-swing block, so a long
      Zone 3 tripped on load and a stable swing was turned into an instability
  D5  both relay elements read positive-sequence V/I as if they were phase
      quantities, which they are not while an unbalanced fault is applied
  D2  a load on a machine bus was netted off that machine's own injection
      instead of being stamped as a network shunt
  D3  ... and shedding such a load subtracted an admittance that was never
      added, injecting phantom generation
  D8  auto-reclose could only ever be onto a healthy line
"""

import math
import pytest

from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.transient_stability import run_transient_stability


def _c(cid, ctype, props):
    return Component(id=cid, type=ctype, x=0, y=0, props=props)


def _w(wid, a, b):
    return Wire(id=wid, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _load(wid, load_id, bus_id):
    return Wire(id=wid, fromComponent=load_id, fromPort="in",
                toComponent=bus_id, toPort="at_0")


# ───────────────────────── radial feeder with one relay ─────────────────────
def _feeder(bus_kv=11.0, relay_kv=None, relay_type="21", length_km=1.0,
            r_km=0.2, x_km=0.08, load_kva=500.0, mho=75, **rp):
    """util — bus_src — cb1(+ct1) — cable1 — bus_load(+load), relay at bus_src
    looking into the cable. A bolted 3-φ fault at bus_load drives bus_load to
    0 V, so the apparent impedance is exactly the cable impedance."""
    relay = {"name": "R1", "relay_type": relay_type, "associated_ct": "ct1",
             "trip_cb": "cb1", "voltage_kv": bus_kv if relay_kv is None else relay_kv}
    if relay_type == "21":
        relay.update({"z1_reach_ohm": 0.0, "z1_delay_s": 0.0,
                      "z2_reach_ohm": 0.0, "z2_delay_s": 0.3,
                      "z3_reach_ohm": 0.0, "z3_delay_s": 0.8,
                      "z3_reverse": False, "mho_angle_deg": mho})
    else:
        relay.update({"pickup_a": 200, "time_dial": 0.05,
                      "curve": "IEC Standard Inverse", "inst_pickup_a": 0})
    relay.update(rp)
    comps = [
        _c("util", "utility", {"name": "Grid", "voltage_kv": bus_kv,
                               "fault_mva": 1e6, "x_r_ratio": 1000}),
        _c("bus_src", "bus", {"name": "SRC", "voltage_kv": bus_kv}),
        _c("cb1", "cb", {"name": "CB1", "state": "closed", "trip_rating_a": 630,
                         "magnetic_pickup": 100, "long_time_delay": 10}),
        _c("ct1", "ct", {"name": "CT1", "ratio": "2000/5"}),
        _c("cable1", "cable", {"name": "F1", "voltage_kv": bus_kv, "r_per_km": r_km,
                               "x_per_km": x_km, "length_km": length_km}),
        _c("bus_load", "bus", {"name": "LOAD", "voltage_kv": bus_kv}),
        _c("ld", "static_load", {"name": "LD", "voltage_kv": bus_kv,
                                 "rated_kva": load_kva, "power_factor": 0.95,
                                 "demand_factor": 1.0}),
        _c("relay1", "relay", relay),
    ]
    wires = [_w("w1", "util", "bus_src"), _w("w2", "bus_src", "cb1"),
             _w("w3", "cb1", "ct1"), _w("w4", "ct1", "cable1"),
             _w("w5", "cable1", "bus_load"), _load("wl", "ld", "bus_load")]
    return ProjectData(projectName="p", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _feeder_fault(**extra):
    d = {"type": "fault", "bus": "bus_load", "clear_time_s": 5.0,
         "t_end_s": 1.0, "find_cct": False, "dt_s": 0.005}
    d.update(extra)
    return d


def _dist_trips(res):
    return [t for t in res["trips"] if "distance" in t.get("reason", "")]


def _oc_trips(res):
    return [t for t in res["trips"] if "overcurrent" in t.get("reason", "")]


class TestD1DistanceReachBase:
    """[D1] Zone reaches are in PRIMARY ohms at the protected line's voltage, so
    the only correct per-unit base is the near bus's nominal kV — the same base
    _collect_oc_relays already used for its current base. Honouring the relay's
    own `voltage_kv` prop instead rescaled every zone by (V_prop/V_bus)²."""

    # 20 km of 0.2+j0.08 Ω/km at 132 kV: Z_line = 4.0+j1.6 Ω, |Z| = 4.308 Ω.
    ZLINE = abs(complex(0.2, 0.08) * 20)

    def test_zone_short_of_the_fault_does_not_trip_at_132kv(self):
        # 0.1 Ω is 43x short of the 4.31 Ω fault. Scaled on the 11 kV default
        # base it became 0.083 pu against a 0.025 pu fault and tripped instantly.
        res = run_transient_stability(
            _feeder(bus_kv=132, relay_kv=11, length_km=20, z1_reach_ohm=0.1),
            _feeder_fault())
        assert _dist_trips(res) == []

    def test_zone_beyond_the_fault_still_trips_at_132kv(self):
        res = run_transient_stability(
            _feeder(bus_kv=132, relay_kv=132, length_km=20, z1_reach_ohm=10.0),
            _feeder_fault())
        assert _dist_trips(res), "a 10 Ω zone must see a 4.31 Ω fault"

    def test_apparent_impedance_is_reported_in_real_ohms(self):
        res = run_transient_stability(
            _feeder(bus_kv=132, relay_kv=132, length_km=20, z1_reach_ohm=10.0),
            _feeder_fault())
        ohms = float(_dist_trips(res)[0]["reason"].split(" at ")[1].split(" Ω")[0])
        assert ohms == pytest.approx(self.ZLINE, rel=0.05)

    def test_mismatched_relay_voltage_is_warned(self):
        res = run_transient_stability(
            _feeder(bus_kv=132, relay_kv=11, length_km=20, z1_reach_ohm=10.0),
            _feeder_fault())
        assert any("Voltage (kV) is set to 11" in w for w in res["warnings"])

    def test_mho_reach_along_the_line_follows_cos_theta_minus_phi(self):
        """The reach ALONG a line at angle φ for a mho set to |R| at angle θ is
        |R|·cos(θ−φ). Pin it on both sides of the boundary — this is the mho
        geometry the base fix must not disturb."""
        zline = abs(complex(0.2, 0.08))          # 0.2154 Ω at 21.80°
        phi = math.degrees(math.atan2(0.08, 0.2))
        for mho, reach in ((75, 0.30), (75, 0.40), (22, 0.24)):
            eff = reach * math.cos(math.radians(mho - phi))
            res = run_transient_stability(
                _feeder(mho=mho, z1_reach_ohm=reach), _feeder_fault())
            assert bool(_dist_trips(res)) is (zline <= eff), \
                f"mho={mho}°, reach={reach} Ω ⇒ {eff:.4f} Ω along a {zline:.4f} Ω line"


class TestD7GastFuelLimit:
    """[D7] gast_fuel_limit_pu is per-unit on the MACHINE base (1.15 = 115 % of
    rating); `cmd`, Pm and pmax are on the SYSTEM base. Comparing them directly
    meant the limit never bound for a machine smaller than base MVA, and GAST
    was also the only turbine model returning its output unclipped."""

    def _island(self, gov_model, gen_mva=10.0, fuel=1.15):
        comps = [
            _c("bus1", "bus", {"name": "B1", "voltage_kv": 11}),
            _c("busl", "bus", {"name": "BL", "voltage_kv": 11}),
            _c("stub", "cable", {"name": "S", "voltage_kv": 11, "r_per_km": 0.0,
                                 "x_per_km": 1e-4, "length_km": 1}),
            _c("g1", "generator", {"name": "G1", "rated_mva": gen_mva, "voltage_kv": 11,
                                   "xd_p": 0.25, "x_r_ratio": 40, "inertia_h_s": 2.0,
                                   "dispatch_mode": "must_run", "power_factor": 0.8,
                                   "gov_mode": "isochronous", "gov_model": gov_model,
                                   "gast_fuel_limit_pu": fuel, "avr_mode": "off",
                                   "min_load_pct": 0}),
            _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 6000,
                                     "power_factor": 0.9, "demand_factor": 1.0}),
        ]
        wires = [_w("w1", "g1", "bus1"), _w("w2", "bus1", "stub"),
                 _w("w3", "stub", "busl"), _load("wl", "ld", "busl")]
        return ProjectData(projectName="isl", baseMVA=100.0, frequency=50,
                           components=comps, wires=wires)

    def _peak_pm(self, gov_model, **kw):
        res = run_transient_stability(self._island(gov_model, **kw), {
            "type": "load_step", "element": "ld", "time_s": 0.5, "delta_pct": 200,
            "t_end_s": 25.0, "dt_s": 0.005})
        return max(res["curves"]["pm_pu"][0])

    def test_gast_respects_its_fuel_limit_on_the_machine_base(self):
        # 10 MVA on a 100 MVA base ⇒ rating 0.10 pu; 115 % ⇒ 0.115 pu.
        assert self._peak_pm("gast") == pytest.approx(0.115, rel=0.01)

    def test_gast_fuel_limit_scales_with_the_setting(self):
        assert self._peak_pm("gast", fuel=1.0) == pytest.approx(0.10, rel=0.01)

    @pytest.mark.parametrize("gov_model", ["first_order", "degov1", "tgov1", "hygov"])
    def test_other_governors_still_cap_at_the_rating(self, gov_model):
        assert self._peak_pm(gov_model) <= 0.1000001


# ───────────── three-bus, source at each end, relay in the middle ───────────
def _two_source(relay_type, **rp):
    """UTIL — bus1 — cabA — bus2 — cabB — bus3 — GEN, with the relay at bus2
    looking INTO cabB (i.e. forward = toward bus3). A fault at bus1 is behind
    it; a fault at bus2 is a bolted fault at the relay's own terminal, where the
    measured voltage is exactly zero."""
    relay = {"name": "R2", "associated_ct": "ct2", "trip_cb": "cb2",
             "relay_type": relay_type, "voltage_kv": 11}
    if relay_type == "21":
        relay.update({"z1_reach_ohm": 5.0, "z1_delay_s": 0.0, "z2_reach_ohm": 0.0,
                      "z3_reach_ohm": 0.0, "z3_reverse": False, "mho_angle_deg": 75})
    else:
        relay.update({"pickup_a": 200, "time_dial": 0.05, "inst_pickup_a": 0,
                      "curve": "IEC Standard Inverse", "direction": "forward",
                      "characteristic_angle_deg": 45})
    relay.update(rp)
    comps = [
        _c("util", "utility", {"name": "GRID", "voltage_kv": 11, "fault_mva": 500,
                               "x_r_ratio": 10}),
        _c("bus1", "bus", {"name": "B1", "voltage_kv": 11}),
        _c("cabA", "cable", {"name": "A", "voltage_kv": 11, "r_per_km": 0.10,
                             "x_per_km": 0.10, "length_km": 2}),
        _c("bus2", "bus", {"name": "B2", "voltage_kv": 11}),
        _c("cb2", "cb", {"name": "CB2", "state": "closed", "trip_rating_a": 1250,
                         "magnetic_pickup": 100, "long_time_delay": 10}),
        _c("ct2", "ct", {"name": "CT2", "ratio": "2000/5"}),
        _c("cabB", "cable", {"name": "B", "voltage_kv": 11, "r_per_km": 0.10,
                             "x_per_km": 0.10, "length_km": 2}),
        _c("bus3", "bus", {"name": "B3", "voltage_kv": 11}),
        _c("g1", "generator", {"name": "G1", "rated_mva": 40, "voltage_kv": 11,
                               "xd_p": 0.25, "x_r_ratio": 40, "inertia_h_s": 4,
                               "dispatch_mode": "must_run", "gov_mode": "none",
                               "avr_mode": "off"}),
        _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 8000,
                                 "power_factor": 0.9, "demand_factor": 1.0}),
        _c("relay2", "relay", relay),
    ]
    wires = [_w("w1", "util", "bus1"), _w("w2", "bus1", "cabA"),
             _w("w3", "cabA", "bus2"), _w("w4", "bus2", "cb2"),
             _w("w5", "cb2", "ct2"), _w("w6", "ct2", "cabB"),
             _w("w7", "cabB", "bus3"), _w("w8", "bus3", "g1"),
             _load("wl", "ld", "bus1")]
    return ProjectData(projectName="dir", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


def _two_source_fault(fbus):
    return {"type": "fault", "bus": fbus, "clear_time_s": 5.0, "t_end_s": 0.6,
            "find_cct": False, "dt_s": 0.002}


class TestD6MemoryPolarisation:
    """[D6] A self-polarized element has no usable polarising quantity when its
    own voltage collapses. For a bolted fault AT the relay's bus, Z = V/I = 0
    lies exactly ON a mho circle through the origin, and Re(V·conj(I)) = 0
    passes a `>= 0` sign-of-power test — so both elements operated for a fault
    BEHIND them, with the current flowing into the relay's bus, not away from
    it. The pre-fault memory phasor now polarises the decision below
    MEMORY_POL_V_PU."""

    @pytest.mark.parametrize("relay_type", ["21", "67"])
    def test_forward_fault_still_trips(self, relay_type):
        res = run_transient_stability(_two_source(relay_type),
                                      _two_source_fault("bus3"))
        assert [t for t in res["trips"] if t["element"] == "CB2"]

    @pytest.mark.parametrize("relay_type", ["21", "67"])
    def test_remote_reverse_fault_is_blocked(self, relay_type):
        res = run_transient_stability(_two_source(relay_type),
                                      _two_source_fault("bus1"))
        assert [t for t in res["trips"] if t["element"] == "CB2"] == []

    @pytest.mark.parametrize("relay_type", ["21", "67"])
    def test_bolted_reverse_fault_at_the_relay_bus_is_blocked(self, relay_type):
        """The regression: V_near = 0 exactly, and the fault current through the
        protected branch flows from bus3 INTO bus2 — reverse."""
        res = run_transient_stability(_two_source(relay_type),
                                      _two_source_fault("bus2"))
        assert [t for t in res["trips"] if t["element"] == "CB2"] == []

    def test_reverse_looking_zone3_still_sees_a_reverse_fault(self):
        """The directional supervision must not simply forbid reverse operation:
        a Zone 3 aimed backward has to pick up the fault behind the relay."""
        res = run_transient_stability(
            _two_source("21", z1_reach_ohm=0.0, z3_reach_ohm=5.0,
                        z3_delay_s=0.05, z3_reverse=True),
            _two_source_fault("bus1"))
        assert any("zone Z3" in t["reason"] for t in _dist_trips(res))


# ───────── SMIB with a long feeder the relay can over-reach across ──────────
def _swing_net(z1_reach=0.0, z2_reach=0.0, z3_reach=0.0, z3_delay=0.8, **rp):
    """GEN — bus_g == (A1 — MID — A2) == INF, plus line B from bus_g to INF
    carrying the relay. A fault at MID cleared by tripping A1 leaves a large but
    STABLE first swing whose impedance locus sweeps through a long Zone 3."""
    zb = 11.0 ** 2 / 100.0

    def cab(cid, name, xpu):
        return _c(cid, "cable", {"name": name, "voltage_kv": 11, "r_per_km": 0.0,
                                 "x_per_km": xpu * zb, "length_km": 1})
    relay = {"name": "R21", "relay_type": "21", "associated_ct": "ctB",
             "trip_cb": "cbB", "voltage_kv": 11,
             "z1_reach_ohm": z1_reach, "z1_delay_s": 0.0,
             "z2_reach_ohm": z2_reach, "z2_delay_s": 0.3,
             "z3_reach_ohm": z3_reach, "z3_delay_s": z3_delay,
             "z3_reverse": False, "mho_angle_deg": 75}
    relay.update(rp)
    comps = [
        _c("util", "utility", {"name": "GRID", "voltage_kv": 11, "fault_mva": 1e8,
                               "x_r_ratio": 10000}),
        _c("bus_inf", "bus", {"name": "INF", "voltage_kv": 11}),
        _c("bus_m", "bus", {"name": "MID", "voltage_kv": 11}),
        _c("bus_g", "bus", {"name": "GEN", "voltage_kv": 11}),
        cab("la1", "A1", 0.05), cab("la2", "A2", 0.35), cab("lb", "B", 0.40),
        _c("cbB", "cb", {"name": "CBB", "state": "closed", "trip_rating_a": 5000,
                         "magnetic_pickup": 100, "long_time_delay": 10}),
        _c("ctB", "ct", {"name": "CTB", "ratio": "4000/5"}),
        _c("g1", "generator", {"name": "G1", "rated_mva": 100, "voltage_kv": 11,
                               "xd_p": 0.25, "x_r_ratio": 10000, "inertia_h_s": 4.0,
                               "damping_pu": 0, "dispatch_mode": "must_run",
                               "gov_mode": "none", "avr_mode": "off"}),
        _c("ld", "static_load", {"name": "LD", "voltage_kv": 11, "rated_kva": 80000,
                                 "power_factor": 1.0, "demand_factor": 1.0}),
        _c("r21", "relay", relay),
    ]
    wires = [_w("w1", "util", "bus_inf"),
             _w("w2", "bus_g", "la1"), _w("w3", "la1", "bus_m"),
             _w("w4", "bus_m", "la2"), _w("w5", "la2", "bus_inf"),
             _w("w6", "bus_g", "cbB"), _w("w7", "cbB", "ctB"), _w("w8", "ctB", "lb"),
             _w("w9", "lb", "bus_inf"), _w("w10", "bus_g", "g1"),
             _load("wl", "ld", "bus_inf")]
    return ProjectData(projectName="sw", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


_SWING = {"type": "fault", "bus": "bus_m", "clear_time_s": 0.30, "find_cct": False,
          "trip_element": "la1", "t_end_s": 5.0, "dt_s": 0.002}
_LINE_B_OHM = 0.40 * (11.0 ** 2 / 100.0)      # 0.484 Ω


class TestD4FaultDetectorAndPowerSwingBlock:
    """[D4] A stepped-distance scheme carries a fault detector and an ANSI 68
    power-swing block. Without them the shipped 12 Ω Zone 3 default trips a
    healthy loaded feeder on load current alone, and a stable rotor swing —
    whose impedance locus sweeps the R-X plane straight through the zones —
    gets tripped and reported as an instability."""

    def test_no_trip_on_load_alone(self):
        res = run_transient_stability(_swing_net(z3_reach=12.0), {
            "type": "load_step", "element": "ld", "time_s": 0.5, "delta_pct": 0.0,
            "t_end_s": 3.0, "dt_s": 0.002})
        assert _dist_trips(res) == []

    def test_load_encroachment_is_warned(self):
        res = run_transient_stability(_swing_net(z3_reach=12.0), {
            "type": "load_step", "element": "ld", "time_s": 0.5, "delta_pct": 0.0,
            "t_end_s": 3.0, "dt_s": 0.002})
        assert any("load impedance" in w for w in res["warnings"])

    def test_stable_swing_is_not_tripped_into_an_instability(self):
        baseline = run_transient_stability(_swing_net(), dict(_SWING))
        assert baseline["stable"] is True and baseline["trips"] == []
        withz3 = run_transient_stability(_swing_net(z3_reach=12.0), dict(_SWING))
        assert _dist_trips(withz3) == []
        assert withz3["stable"] is baseline["stable"]

    def test_genuine_in_zone_fault_still_trips_instantly(self):
        """The block must not swallow a real fault: a bolted fault at the remote
        end of the protected line, inside Zone 1, trips on the first step."""
        res = run_transient_stability(_swing_net(z1_reach=1.0), {
            "type": "fault", "bus": "bus_inf", "clear_time_s": 5.0,
            "find_cct": False, "t_end_s": 1.0, "dt_s": 0.002})
        trips = _dist_trips(res)
        assert trips and trips[0]["t"] <= 0.01
        ohms = float(trips[0]["reason"].split(" at ")[1].split(" Ω")[0])
        assert ohms == pytest.approx(_LINE_B_OHM, rel=0.05)

    def test_fault_short_of_zone1_still_does_not_trip(self):
        res = run_transient_stability(_swing_net(z1_reach=0.3), {
            "type": "fault", "bus": "bus_inf", "clear_time_s": 5.0,
            "find_cct": False, "t_end_s": 1.0, "dt_s": 0.002})
        assert _dist_trips(res) == []

    def test_time_delayed_zone_still_times_out(self):
        """Zone entry is judged fault-like or swing-like ONCE, at entry — if it
        were re-judged every step, any zone whose own delay exceeded the swing
        transit threshold could never operate."""
        res = run_transient_stability(_swing_net(z1_reach=0.3, z2_reach=1.0), {
            "type": "fault", "bus": "bus_inf", "clear_time_s": 5.0,
            "find_cct": False, "t_end_s": 1.5, "dt_s": 0.002})
        trips = _dist_trips(res)
        assert trips and "zone Z2" in trips[0]["reason"]
        assert trips[0]["t"] == pytest.approx(0.30, abs=0.02)


class TestD5UnbalancedFaultBlocksRelays:
    """[D5] The relays measure branch_current / vbus_complex_prev, which are
    POSITIVE-SEQUENCE quantities. An unbalanced fault is modelled as a positive-
    sequence shunt, so during it V1/I1 are neither the faulted-phase current
    (I_a = 3·I₁ for SLG, √3·I₁ for LL) nor the loop impedance a ground element
    measures with residual compensation — V1/I1 carries the whole Z2+Z0 shunt,
    putting an SLG fault far outside every zone. Both elements are blocked for
    the duration rather than operating on quantities that mean something else."""

    @pytest.mark.parametrize("ftype", ["slg", "ll", "llg"])
    def test_distance_is_blocked(self, ftype):
        res = run_transient_stability(_feeder(z1_reach_ohm=1.0),
                                      _feeder_fault(fault_type=ftype))
        assert _dist_trips(res) == []

    @pytest.mark.parametrize("ftype", ["slg", "ll", "llg"])
    def test_overcurrent_is_blocked(self, ftype):
        res = run_transient_stability(_feeder(relay_type="50/51"),
                                      _feeder_fault(fault_type=ftype))
        assert _oc_trips(res) == []

    def test_balanced_fault_is_unaffected(self):
        res = run_transient_stability(_feeder(z1_reach_ohm=1.0),
                                      _feeder_fault(fault_type="3phase"))
        trips = _dist_trips(res)
        assert trips
        ohms = float(trips[0]["reason"].split(" at ")[1].split(" Ω")[0])
        assert ohms == pytest.approx(abs(complex(0.2, 0.08)), rel=0.05)

    def test_blocking_is_warned(self):
        res = run_transient_stability(_feeder(z1_reach_ohm=1.0),
                                      _feeder_fault(fault_type="slg"))
        assert any("BLOCKED" in w for w in res["warnings"])


# ───────────── the same network with the load moved off the machine ─────────
def _local_load_net(load_on_gen_bus, uv_trip=False):
    zb = 11.0 ** 2 / 100.0
    ld = {"name": "LD", "voltage_kv": 11, "rated_kva": 60000, "power_factor": 1.0,
          "demand_factor": 1.0}
    if uv_trip:
        ld.update({"load_model": "constant_power", "uv_trip_pu": 0.95,
                   "uv_trip_delay_s": 0.02})
    comps = [
        _c("util", "utility", {"name": "GRID", "voltage_kv": 11, "fault_mva": 1e7,
                               "x_r_ratio": 1000}),
        _c("bus_inf", "bus", {"name": "INF", "voltage_kv": 11}),
        _c("ln", "cable", {"name": "L", "voltage_kv": 11, "r_per_km": 0.0,
                           "x_per_km": 0.30 * zb, "length_km": 1}),
        _c("bus_gen", "bus", {"name": "GEN", "voltage_kv": 11}),
        _c("g1", "generator", {"name": "G1", "rated_mva": 100, "voltage_kv": 11,
                               "xd_p": 0.30, "x_r_ratio": 1000, "inertia_h_s": 3.5,
                               "damping_pu": 0, "dispatch_mode": "must_run",
                               "gov_mode": "none", "avr_mode": "off"}),
        _c("ld", "static_load", ld),
    ]
    wires = [_w("w1", "util", "bus_inf"), _w("w2", "bus_inf", "ln"),
             _w("w3", "ln", "bus_gen"), _w("w4", "bus_gen", "g1")]
    if load_on_gen_bus:
        wires.append(_load("wl", "ld", "bus_gen"))
    else:
        # One negligible link away — a busbar, not an impedance.
        comps += [_c("stub", "cable", {"name": "S", "voltage_kv": 11, "r_per_km": 0.0,
                                       "x_per_km": 1e-4, "length_km": 1}),
                  _c("bus_ld", "bus", {"name": "LDB", "voltage_kv": 11})]
        wires += [_w("w5", "bus_gen", "stub"), _w("w6", "stub", "bus_ld"),
                  _load("wl", "ld", "bus_ld")]
    return ProjectData(projectName="ll", baseMVA=100.0, frequency=50,
                       components=comps, wires=wires)


class TestD2LoadOnAMachineBus:
    """[D2] _load_shunts used to skip machine buses, leaving any load drawn
    there folded into the machine's own injection: a constant-power quantity
    welded to the rotor that never collapsed with voltage during a fault and
    subtracted straight off the mechanical power. The two networks below are
    electrically identical — the load moves by one zero-impedance busbar link —
    so every machine quantity and the CCT must be identical too. They were not:
    P_m read 25 MW instead of 85 MW and the CCT was inflated 2.4x."""

    def _run(self, on_bus):
        res = run_transient_stability(_local_load_net(on_bus), {
            "type": "fault", "bus": "bus_gen", "clear_time_s": 0.1,
            "find_cct": True, "t_end_s": 5.0})
        gen = next(m for m in res["machines"] if m["type"] == "generator")
        return gen, res

    def test_machine_keeps_its_own_output(self):
        gen, _ = self._run(True)
        # must_run 100 MVA x 0.85 pf = 85 MW, regardless of local load.
        assert gen["pm_pu"] == pytest.approx(0.85, rel=0.01)

    def test_position_of_the_load_does_not_change_the_machine(self):
        a, _ = self._run(True)
        b, _ = self._run(False)
        assert a["pm_pu"] == pytest.approx(b["pm_pu"], rel=1e-6)
        assert a["e_pu"] == pytest.approx(b["e_pu"], rel=1e-6)
        assert a["delta0_deg"] == pytest.approx(b["delta0_deg"], abs=1e-6)

    def test_position_of_the_load_does_not_change_the_cct(self):
        _, ra = self._run(True)
        _, rb = self._run(False)
        assert ra["cct_s"] == pytest.approx(rb["cct_s"], rel=1e-6)

    def test_a_load_on_a_machine_bus_can_be_stepped(self):
        """It used to be invisible to a load step (the disturbance scaled a bus
        shunt that was never stamped), so an islanded genset carrying its board
        on the same bus simply ignored the event."""
        res = run_transient_stability(_local_load_net(True), {
            "type": "load_step", "element": "ld", "time_s": 0.5,
            "delta_pct": -50.0, "t_end_s": 3.0, "dt_s": 0.005})
        pe = res["curves"]["pe_pu"][1]      # generator is machine index 1
        assert max(pe) - min(pe) > 0.05, "the load step must move the machine"


class TestD3SheddingAMachineBusLoad:
    """[D3] The same root cause with a sharper symptom: _dyn_shunt shed a load
    with `y[bi] -= ybase`, subtracting an admittance the machine-bus branch of
    _load_shunts had never added. A consuming admittance subtracted from zero is
    a negative conductance — the shed injected phantom GENERATION of the load's
    own size at that bus."""

    def _shed_shunt(self, on_bus):
        import numpy as np
        from backend.analysis import transient_stability as TS
        from backend.analysis.network_reduction import build_branch_ybus
        from backend.analysis.loadflow import run_load_flow
        p = _local_load_net(on_bus, uv_trip=True)
        ctx = build_branch_ybus(p)
        lf = run_load_flow(p)
        macs, _ = TS._collect_machines(p, ctx, lf)
        y0 = TS._load_shunts(p, lf, ctx, {m["bus_idx"] for m in macs})
        dyn = TS._dynamic_setup(p, ctx, lf, 50, [])
        d = dyn["loads"][0]
        vmag = {i: lf.buses[b].voltage_pu for b, i in ctx["bus_idx"].items()}
        served = TS._dyn_shunt(dyn, y0, vmag, np.zeros(0))
        shed = TS._dyn_shunt(dyn, y0, vmag, np.zeros(0), tripped_loads={0})
        v0 = d["V0"]
        mw = lambda y: (y[d["bus"]].conjugate() * v0 * v0).real * 100.0
        return mw(served), mw(shed)

    @pytest.mark.parametrize("on_bus", [True, False])
    def test_shed_removes_the_load_and_injects_nothing(self, on_bus):
        served, shed = self._shed_shunt(on_bus)
        assert served == pytest.approx(60.0, rel=0.02)
        assert shed == pytest.approx(0.0, abs=0.01)


class TestD8RecloseOntoAPermanentFault:
    """[D8] The reclose segment restored the pre-trip topology with an empty
    `grounded` set — i.e. always onto a healthy line — so the case that actually
    drives a stability study (a second shock onto a fault that did not clear)
    could not be represented at all."""

    def _run(self, **extra):
        d = {"type": "fault", "bus": "bus_m", "clear_time_s": 0.20,
             "find_cct": False, "trip_element": "la1", "t_end_s": 6.0,
             "dt_s": 0.002}
        d.update(extra)
        res = run_transient_stability(_swing_net(), d)
        return res, max(abs(x) for x in res["curves"]["delta_deg"][1])

    def test_successful_reclose_is_unchanged(self):
        base, pk0 = self._run()
        rec, pk1 = self._run(reclose_delay_s=0.5)
        assert "reclosing at 700 ms" in rec["event"]
        assert pk1 == pytest.approx(pk0, rel=1e-6)

    def test_reclose_onto_a_fault_reapplies_it_and_locks_out(self):
        res, _ = self._run(reclose_delay_s=0.5, reclose_onto_fault=True)
        assert "reclosing onto the fault at 700 ms" in res["event"]
        assert "locking out at 900 ms" in res["event"]

    def test_reclose_onto_a_fault_is_a_second_shock(self):
        _, benign = self._run(reclose_delay_s=0.5)
        _, onto = self._run(reclose_delay_s=0.5, reclose_onto_fault=True,
                            second_clear_s=0.35)
        assert onto > benign * 1.2, (
            "reclosing onto a permanent fault must swing the machine further "
            f"than a successful reclose ({onto:.1f}° vs {benign:.1f}°)")

    def test_second_clear_time_defaults_to_the_first(self):
        res, _ = self._run(reclose_delay_s=0.5, reclose_onto_fault=True)
        # first clear 0.20 s ⇒ lockout at 0.70 + 0.20 = 0.90 s
        assert "locking out at 900 ms" in res["event"]
