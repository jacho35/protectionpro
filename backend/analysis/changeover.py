"""Changeover switch — rewrite into two-terminal devices before analysis.

A changeover switch has THREE terminals (``in_1``, ``in_2``, ``out``) and
connects ``out`` to at most one input at a time (``state``: ``in_1`` / ``off``
/ ``in_2``). Every engine builds its topology from component-level adjacency
and knows only two-terminal switching devices, so a three-terminal component
would join all three wires whenever it was "closed".

Instead of teaching each engine about it, the analysis routes call
``expand_changeovers`` once on the incoming project. Each changeover becomes:

* its own id, as a ``switch`` (or ``cb`` for ``co_type = breaker_pair``)
  wired selected-input -> ``out``; closed, or open when ``state = off``
  (``in_1`` is then the one wired through);
* ``<id>__in_1`` / ``<id>__in_2``: an OPEN stub device of the same type on
  the input that isn't wired through, so that supply sees an open switching
  device, exactly as it does in the real switchboard.

The load side therefore follows the blade in load flow, fault, arc flash,
duty, reliability and every other study with no engine change, and the
result naming keeps the changeover's own id for the live contact.
"""

from __future__ import annotations

CHANGEOVER = "changeover"
INPUT_PORTS = ("in_1", "in_2")
_ROMAN = {"in_1": "I", "in_2": "II"}

# Props handed to the rewritten devices (the rest stay on the changeover).
_RATING_KEYS = ("rated_voltage_kv", "rated_current_a", "breaking_capacity_ka")


def changeover_position(comp) -> str:
    """'in_1' | 'off' | 'in_2' — anything unrecognised reads as in_1."""
    state = str((comp.props or {}).get("state", "in_1"))
    return state if state in ("in_1", "off", "in_2") else "in_1"


def _leg_props(comp, port: str, closed: bool) -> dict:
    props = dict(comp.props or {})
    name = props.get("name") or comp.id
    leg = {k: props[k] for k in _RATING_KEYS if k in props}
    leg["name"] = f"{name} ({_ROMAN[port]})"
    leg["state"] = "closed" if closed else "open"
    leg["changeover_id"] = comp.id
    if props.get("co_type") == "breaker_pair":
        # Keep any breaker settings the user entered on the changeover; a
        # trip rating defaults to the frame rating like a fresh CB.
        for k, v in props.items():
            if k not in leg and k not in ("co_type", "state", "contact_duty",
                                          "input_1_label", "input_2_label"):
                leg[k] = v
        leg.setdefault("cb_type", "acb")
        if "rated_current_a" in leg:
            leg.setdefault("trip_rating_a", leg["rated_current_a"])
    return leg


def _expand(components, wires):
    """Return (components, wires) with every changeover rewritten, or the
    inputs unchanged when there is none."""
    changeovers = {c.id: c for c in components if c.type == CHANGEOVER}
    if not changeovers:
        return components, wires

    comp_cls = type(next(iter(changeovers.values())))
    out_comps = []
    # (changeover id, port) -> (device id, device port)
    port_map = {}
    for c in components:
        if c.id not in changeovers:
            out_comps.append(c)
            continue
        pos = changeover_position(c)
        through = "in_1" if pos == "off" else pos
        stub = "in_2" if through == "in_1" else "in_1"
        dev_type = "cb" if (c.props or {}).get("co_type") == "breaker_pair" else "switch"
        base = dict(x=c.x, y=c.y, rotation=c.rotation)
        out_comps.append(comp_cls(id=c.id, type=dev_type,
                                  props=_leg_props(c, through, pos != "off"), **base))
        stub_id = f"{c.id}__{stub}"
        out_comps.append(comp_cls(id=stub_id, type=dev_type,
                                  props=_leg_props(c, stub, False), **base))
        port_map[(c.id, through)] = (c.id, "top")
        port_map[(c.id, "out")] = (c.id, "bottom")
        port_map[(c.id, stub)] = (stub_id, "top")

    out_wires = []
    for w in wires:
        f = port_map.get((w.fromComponent, w.fromPort))
        t = port_map.get((w.toComponent, w.toPort))
        if (w.fromComponent in changeovers and not f) or (w.toComponent in changeovers and not t):
            continue  # a wire on an unknown changeover port carries nothing
        if f or t:
            w = w.model_copy(update={
                **({"fromComponent": f[0], "fromPort": f[1]} if f else {}),
                **({"toComponent": t[0], "toPort": t[1]} if t else {}),
            })
        out_wires.append(w)
    return out_comps, out_wires


def expand_changeovers(project):
    """Copy of ``project`` (same model class, extra fields kept) with every
    changeover rewritten into two-terminal devices — including the network
    snapshots inside Load Flow Study Manager ``cases``. Returns ``project``
    itself when it holds no changeover."""
    comps, wires = _expand(project.components, project.wires)
    update = {}
    if comps is not project.components:
        update["components"] = comps
        update["wires"] = wires
    cases = getattr(project, "cases", None)
    if cases:
        new_cases = []
        changed = False
        for case in cases:
            cc, cw = _expand(case.components, case.wires)
            if cc is not case.components:
                case = case.model_copy(update={"components": cc, "wires": cw})
                changed = True
            new_cases.append(case)
        if changed:
            update["cases"] = new_cases
    return project.model_copy(update=update) if update else project
