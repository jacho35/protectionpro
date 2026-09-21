"""Off-page connectors — join linked pairs into one node before analysis.

A diagram can span several pages; the network is the union of them, joined
where two ``offpage_connector`` components are linked. A connector points at
its partner with ``props.linked_to`` (set from either end). Projects saved
before links existed paired connectors by identical ``name``; connectors with
no link at either end still do, matching ``Components.offpagePairs()`` in the
frontend.

Engines build topology from wires between component ports and know nothing of
a page, so the analysis routes call ``expand_offpage_links`` once on the
incoming project. Each *paired* connector becomes a closed two-terminal
``switch`` (its ``port`` wires land on the switch's ``top``) and a wire joins
the two switches' ``bottom`` ports, so the pair is a zero-impedance
pass-through exactly as the diagram draws it. An unpaired connector is left
as it is (a dead end).
"""

from __future__ import annotations

OFFPAGE = "offpage_connector"


def offpage_pairs(components):
    """[(id_a, id_b), ...] — same rule as ``Components.offpagePairs()``."""
    conns = {c.id: c for c in components if c.type == OFFPAGE}
    pairs, seen, linked = [], set(), set()
    for c in conns.values():
        t = (c.props or {}).get("linked_to")
        if not t or t not in conns or t == c.id:
            continue
        linked.add(c.id)
        linked.add(t)
        key = tuple(sorted((c.id, t)))
        if key not in seen:
            seen.add(key)
            pairs.append(key)
    by_label = {}
    for c in conns.values():
        if c.id in linked or (c.props or {}).get("linked_to"):
            continue
        by_label.setdefault((c.props or {}).get("name") or "", []).append(c.id)
    for ids in by_label.values():
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs.append((ids[i], ids[j]))
    return pairs


def _expand(components, wires):
    pairs = offpage_pairs(components)
    if not pairs:
        return components, wires
    joined = {i for p in pairs for i in p}
    out_comps = []
    for c in components:
        if c.id in joined:
            props = {"name": (c.props or {}).get("name") or c.id,
                     "state": "closed", "offpage_id": c.id}
            c = c.model_copy(update={"type": "switch", "props": props})
        out_comps.append(c)

    out_wires = []
    for w in wires:
        upd = {}
        if w.fromComponent in joined:
            upd["fromPort"] = "top"
        if w.toComponent in joined:
            upd["toPort"] = "top"
        out_wires.append(w.model_copy(update=upd) if upd else w)

    wire_cls = type(wires[0]) if wires else None
    if wire_cls is None:
        from ..models.schemas import Wire as wire_cls
    for n, (a, b) in enumerate(pairs):
        out_wires.append(wire_cls(id=f"offpage-link-{n}__{a}__{b}",
                                  fromComponent=a, fromPort="bottom",
                                  toComponent=b, toPort="bottom"))
    return out_comps, out_wires


def expand_offpage_links(project):
    """Copy of ``project`` with every linked off-page connector pair joined —
    including the network snapshots inside Load Flow Study Manager ``cases``.
    Returns ``project`` itself when nothing is linked."""
    comps, wires = _expand(project.components, project.wires)
    update = {}
    if comps is not project.components:
        update["components"] = comps
        update["wires"] = wires
    cases = getattr(project, "cases", None)
    if cases:
        new_cases, changed = [], False
        for case in cases:
            cc, cw = _expand(case.components, case.wires)
            if cc is not case.components:
                case = case.model_copy(update={"components": cc, "wires": cw})
                changed = True
            new_cases.append(case)
        if changed:
            update["cases"] = new_cases
    return project.model_copy(update=update) if update else project
