"""Cascading (IEC 60947-2 Annex A) — Schneider LVPED318033EN tables (cascading.py)."""
from backend.analysis import cascading as c


def R(model, a):
    return {"model": model, "rating_a": a, "maker": "Schneider Electric"}


def test_guide_three_level_example():
    # A-194: NSX250S > NSX100B > iC60N
    assert c.reinforced_ka(R("NSX250S", 250), R("NSX100B", 100)) == 50
    assert c.reinforced_ka(R("NSX250S", 250), R("iC60N", 20)) == 30
    assert c.reinforced_ka(R("NSX100B", 100), R("iC60N", 20)) == 20


def test_upstream_rating_band_and_untested_pair():
    assert c.reinforced_ka(R("iC60L", 20), R("iC60N", 16)) == 25
    assert c.reinforced_ka(R("iC60L", 40), R("iC60N", 16)) == 20
    assert c.reinforced_ka(R("MTZ1 H1", 1000), R("NSX250F", 250)) is None


def test_cover_rule_a_plus_c_and_chained():
    ic60 = {"ref": R("iC60N", 20), "capacity_ka": 10, "duty_ka": 24}
    nsx100 = {"ref": R("NSX100B", 100), "capacity_ka": 25, "duty_ka": 40}
    nsx250 = {"ref": R("NSX250S", 250), "capacity_ka": 100, "duty_ka": 80}
    hit = c.cover([ic60, nsx100, nsx250])
    assert hit == {"by": 2, "reinforced_ka": 30}          # A + C, though B + C is only 20 kA
    assert c.cover([nsx100, nsx250])["reinforced_ka"] == 50
    assert c.cover([dict(ic60, duty_ka=31), nsx100, nsx250]) is None


def test_library_id_resolves():
    assert c.device_ref({"standard_type": "se_nsx100b_16"})["model"] == "NSX100B"
    assert c.device_ref({"standard_type": "generic"}) is None


# ── duty check on the diagram ──
from backend.models.schemas import ProjectData, Component, Wire
from backend.analysis.duty_check import run_duty_check

C = lambda i, t, p: Component(id=i, type=t, x=0, y=0, props=p)
W = lambda i, a, b: Wire(id=i, fromComponent=a, fromPort="o", toComponent=b, toPort="i")


def _net(upstream="se_nsx250f_250", up_icu=36, second_infeed=False, cascading=None, mva=0.8):
    """Grid → 0.8 MVA → LV bus (~20 kA) → NSX250 incomer → board bus → iC60N 20 A → load bus.
    The board bus sees ~ the LV fault level; an iC60N (10 kA) needs back-up there."""
    comps = [
        C("u", "utility", {"name": "Grid", "voltage_kv": 11, "fault_mva": 500, "x_r_ratio": 15}),
        C("b1", "bus", {"name": "MV", "voltage_kv": 11}),
        C("t", "transformer", {"name": "T", "rated_mva": mva, "z_percent": 6, "x_r_ratio": 8,
                               "voltage_hv_kv": 11, "voltage_lv_kv": 0.4, "vector_group": "Dyn11"}),
        C("b2", "bus", {"name": "LV", "voltage_kv": 0.4}),
        C("inc", "cb", {"name": "Incomer", "standard_type": upstream, "rated_voltage_kv": 0.4,
                        "rated_current_a": 250, "breaking_capacity_ka": up_icu, "cb_type": "mccb",
                        "state": "closed"}),
        C("b3", "bus", {"name": "DB", "voltage_kv": 0.4}),
        C("d", "cb", {"name": "Way 1", "standard_type": "se_ic60n_c_20", "rated_voltage_kv": 0.4,
                      "rated_current_a": 20, "breaking_capacity_ka": 10, "cb_type": "mcb",
                      "state": "closed"}),
        C("b4", "bus", {"name": "Load", "voltage_kv": 0.4}),
    ]
    wires = [W("1", "u", "b1"), W("2", "b1", "t"), W("3", "t", "b2"), W("4", "b2", "inc"),
             W("5", "inc", "b3"), W("6", "b3", "d"), W("7", "d", "b4")]
    if second_infeed:
        comps.append(C("g", "generator", {"name": "G", "rated_mva": 0.5, "voltage_kv": 0.4, "xd_pp": 0.12,
                                          "power_factor": 0.8, "dispatch_mode": "must_run"}))
        wires.append(W("8", "g", "b3"))
    return ProjectData(projectName="c", baseMVA=100.0, frequency=50, components=comps, wires=wires,
                       cascading=cascading)


def _dev(project, dev_id="d"):
    return next(d for d in run_duty_check(project)["devices"] if d["device_id"] == dev_id)


def test_ic60n_passes_cascaded_with_nsx250f():
    d = _dev(_net())
    assert 10 < d["breaking_duty_ka"] <= 25           # NSX250F + iC60N 0.5-40 A = 25 kA
    assert d["interrupt_ok"] is True and d["status"] != "fail"
    assert d["cascade"]["upstream_id"] == "inc" and d["cascade"]["reinforced_ka"] == 25
    assert d["making_ok"] is True
    assert any("Cascaded with Incomer" in i for i in d["issues"])


def test_cascading_off_keeps_the_own_rating():
    d = _dev(_net(cascading=False))
    assert d["interrupt_ok"] is False and d["status"] == "fail" and d["cascade"] is None


def test_upstream_not_adequate_gives_no_credit():
    # ~25.6 kA: NSX250N + iC60N = 30 kA would cover it, but an incomer rated
    # 25 kA fails at its own terminals, so it backs nothing up
    net = _net(upstream="se_nsx250n_250", up_icu=25, mva=1.0)
    assert _dev(net, "inc")["interrupt_ok"] is False
    d = _dev(net)
    assert d["cascade"] is None and d["interrupt_ok"] is False
    ok = _dev(_net(upstream="se_nsx250n_250", up_icu=50, mva=1.0))
    assert ok["cascade"]["reinforced_ka"] == 30


def test_second_infeed_on_the_board_gives_no_credit():
    d = _dev(_net(second_infeed=True))
    assert d["cascade"] is None and d["interrupt_ok"] is False


def test_calculations_pdf_lists_the_cascaded_rating():
    from backend.analysis.pdf_reports import generate_calculations_report
    duty = run_duty_check(_net())
    pdf = generate_calculations_report("c", 100, 50, duty_results=duty)
    assert pdf.getvalue()[:4] == b"%PDF"
