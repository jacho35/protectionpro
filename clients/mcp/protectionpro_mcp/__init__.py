"""MCP server for ProtectionPro — lets an AI agent read and update projects.

A thin layer over the REST API (via ``protectionpro_client``). The agent works
with single components instead of the whole ProjectData blob: every write does
GET → patch one thing → PUT, after saving a revision snapshot so it can be
undone from the app's revision history.

Configuration (environment):
    PROTECTIONPRO_URL       backend root (default http://localhost:8000)
    PROTECTIONPRO_EMAIL / PROTECTIONPRO_PASSWORD
                            account to log in as (re-login on expiry). Use a
                            dedicated user for the agent.
    PROTECTIONPRO_TOKEN     alternative: an existing JWT (expires after 7 days)
    PROTECTIONPRO_READONLY  "1" → register only the read/analysis tools
"""

import copy
import json
import os
import re
from pathlib import Path
from typing import Any, Optional

from mcp.server.fastmcp import FastMCP
from protectionpro_client import ProtectionPro, ProtectionProError

MAX_CHARS = 60_000  # cap on any single tool result, to protect the agent's context

# Component types, ports and default props — generated from the frontend's
# COMPONENT_DEFS by build_catalog.mjs (rerun it after changing constants.js).
CATALOG = json.loads((Path(__file__).parent / "component_catalog.json").read_text())

mcp = FastMCP("protectionpro")
_pp: Optional[ProtectionPro] = None


def _client() -> ProtectionPro:
    global _pp
    if _pp is None:
        _pp = ProtectionPro(os.environ.get("PROTECTIONPRO_URL", "http://localhost:8000"),
                            token=os.environ.get("PROTECTIONPRO_TOKEN"))
        if not _pp.token:
            _login(_pp)
    return _pp


def _login(pp: ProtectionPro):
    email, pw = os.environ.get("PROTECTIONPRO_EMAIL"), os.environ.get("PROTECTIONPRO_PASSWORD")
    if not (email and pw):
        raise RuntimeError("Set PROTECTIONPRO_EMAIL and PROTECTIONPRO_PASSWORD "
                           "(or PROTECTIONPRO_TOKEN).")
    pp.login(email, pw)


def _call(fn, *args, **kwargs):
    """Run a client call; on a 401 log in again once and retry."""
    pp = _client()
    try:
        return fn(pp, *args, **kwargs)
    except ProtectionProError as e:
        if e.status_code == 401 and os.environ.get("PROTECTIONPRO_EMAIL"):
            _login(pp)
            return fn(pp, *args, **kwargs)
        raise


def _out(data: Any) -> str:
    text = json.dumps(data, indent=1, default=str)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + f"\n… truncated ({len(text)} chars total)"
    return text


def _find(project: dict, component_id: str) -> dict:
    for c in project.get("components", []):
        if c.get("id") == component_id:
            return c
    raise ValueError(f"No component '{component_id}' in this project")


def _snapshot(project_id: int, label: str):
    _call(lambda pp: pp._req("POST", f"/api/projects/{project_id}/revisions",
                             json={"label": label}))


# ── read tools ───────────────────────────────────────────────────────

@mcp.tool()
def list_projects() -> str:
    """List the projects this account can open (id, name, timestamps, access)."""
    return _out(_call(lambda pp: pp.projects()))


@mcp.tool()
def project_overview(project_id: int) -> str:
    """Project name, base MVA, frequency, and component counts by type."""
    p = _call(lambda pp: pp.project(project_id))
    counts: dict[str, int] = {}
    for c in p.get("components", []):
        counts[c["type"]] = counts.get(c["type"], 0) + 1
    return _out({"name": p.get("projectName"), "baseMVA": p.get("baseMVA"),
                 "frequency": p.get("frequency"), "components": counts,
                 "wires": len(p.get("wires", []))})


@mcp.tool()
def list_components(project_id: int, type: Optional[str] = None,
                    name_contains: Optional[str] = None) -> str:
    """List components as {id, type, name}. Optionally filter by type (e.g. 'bus',
    'transformer', 'cable') and/or a case-insensitive substring of the name."""
    p = _call(lambda pp: pp.project(project_id))
    rows = []
    for c in p.get("components", []):
        name = (c.get("props") or {}).get("name", "")
        if type and c["type"] != type:
            continue
        if name_contains and name_contains.lower() not in str(name).lower():
            continue
        rows.append({"id": c["id"], "type": c["type"], "name": name})
    return _out(rows)


@mcp.tool()
def get_component(project_id: int, component_id: str) -> str:
    """Full detail of one component (all props) plus the wires attached to it."""
    p = _call(lambda pp: pp.project(project_id))
    c = _find(p, component_id)
    wires = [w for w in p.get("wires", [])
             if component_id in (w.get("fromComponent"), w.get("toComponent"))]
    return _out({"component": c, "wires": wires})


@mcp.tool()
def list_revisions(project_id: int) -> str:
    """Saved revision snapshots of a project (newest first)."""
    return _out(_call(lambda pp: pp._req("GET", f"/api/projects/{project_id}/revisions")))


@mcp.tool()
def run_analysis(project_id: int, kind: str, params: Optional[dict] = None) -> str:
    """Run a study on the saved project and return the results (large results are
    truncated). `kind` is the endpoint name under /api/analysis, e.g. 'fault',
    'loadflow', 'arcflash', 'cable-sizing', 'duty-check', 'contingency',
    'voltage-stability', 'motor-starting'. `params` are that study's options
    (e.g. {"fault_type": "3phase"}). Nothing is saved to the project."""
    p = _call(lambda pp: pp.project(project_id))
    return _out(_call(lambda pp: pp.analyze(kind, p, **(params or {}))))


# ── write tools ──────────────────────────────────────────────────────

WRITE = os.environ.get("PROTECTIONPRO_READONLY") != "1"


def _write_tool(fn):
    return mcp.tool()(fn) if WRITE else fn


def _mutate(project_id: int, label: str, fn) -> Any:
    """GET the project, apply `fn(project)` (raise to abort), then snapshot a
    revision and PUT. Validation errors therefore leave no snapshot behind."""
    p = _call(lambda pp: pp.project(project_id))
    result = fn(p)
    _snapshot(project_id, label)
    _call(lambda pp: pp.update_project(project_id, p))
    return result


def _next_id(p: dict, prefix: str) -> str:
    """Id from the project's nextId counter, skipping any id already in use."""
    used = {c["id"] for c in p.get("components", [])} | {w["id"] for w in p.get("wires", [])}
    n = int(p.get("nextId") or 1)
    while f"{prefix}_{n}" in used:
        n += 1
    p["nextId"] = n + 1
    return f"{prefix}_{n}"


def _check_port(comp: dict, port: str):
    spec = CATALOG.get(comp["type"])
    if spec is None:
        return  # unknown/custom type: cannot validate
    if comp["type"] == "bus":
        bw = (comp.get("props") or {}).get("busWidth") or 120
        n = max(1, int(bw // 40))
        m = re.fullmatch(r"(top|bottom)_(\d+)", port)
        if port in ("left", "right", "top", "bottom") or re.fullmatch(r"at_-?\d+(\.\d+)?", port) \
                or (m and int(m.group(2)) < n):
            return
        raise ValueError(f"Bus {comp['id']} has no port '{port}'. Use left, right, "
                         f"top_0..top_{n-1}, bottom_0..bottom_{n-1} or at_<x offset>.")
    if port not in spec["ports"]:
        raise ValueError(f"{comp['type']} {comp['id']} has no port '{port}'. "
                         f"Ports: {spec['ports'] or 'none (not wired)'}")


@_write_tool
def update_component_props(project_id: int, component_id: str, props: dict,
                           allow_new_keys: bool = False) -> str:
    """Change properties of ONE component, e.g. {"name": "TX1", "rated_mva": 2.5}.
    Only the given props change. Unknown prop names are rejected (catches typos)
    unless allow_new_keys=True — call get_component first to see valid names.
    A revision snapshot is saved before the change."""
    def edit(p):
        comp = _find(p, component_id)
        existing = comp.setdefault("props", {})
        unknown = [k for k in props if k not in existing]
        if unknown and not allow_new_keys:
            raise ValueError(f"Unknown props for {comp['type']} {component_id}: {unknown}. "
                             f"Valid: {sorted(existing)}")
        before = {k: existing.get(k) for k in props}
        existing.update(props)
        return {"updated": component_id, "before": before, "after": props}
    return _out(_mutate(project_id, f"Before MCP update of {component_id}", edit))


@mcp.tool()
def list_component_types() -> str:
    """Every component type that add_component accepts, with category, wiring ports
    (bus ports depend on its width: left, right, top_N, bottom_N, at_<x>) and the
    names of its default props."""
    return _out({t: {"name": v["name"], "category": v["category"],
                     "ports": v["ports"] or "none", "props": sorted(v["defaults"])}
                 for t, v in CATALOG.items()})


@_write_tool
def add_component(project_id: int, type: str, x: float, y: float,
                  props: Optional[dict] = None, rotation: int = 0) -> str:
    """Add a component at diagram position (x, y) (snapped to the 20 px grid) with
    the app's default props for its type, overridden by `props`. Returns the new
    id — use it with add_wire. See list_component_types for types and ports."""
    if type not in CATALOG:
        raise ValueError(f"Unknown component type '{type}'. Use list_component_types.")
    if rotation not in (0, 90, 180, 270):
        raise ValueError("rotation must be 0, 90, 180 or 270")

    def edit(p):
        spec = CATALOG[type]
        cprops = copy.deepcopy(spec["defaults"])
        count = sum(1 for c in p.get("components", []) if c["type"] == type)
        cprops["name"] = f"{spec['defaults'].get('name', type)}{count + 1 if count else ''}"
        unknown = [k for k in (props or {}) if k not in cprops]
        if unknown:
            raise ValueError(f"Unknown props for {type}: {unknown}. Valid: {sorted(cprops)}")
        cprops.update(props or {})
        comp = {"id": _next_id(p, type), "type": type,
                "x": round(x / 20) * 20, "y": round(y / 20) * 20,
                "rotation": rotation, "props": cprops}
        pages = p.get("pages") or []
        page = p.get("activePageId") or (pages[0]["id"] if pages else None)
        if page:
            comp["pageId"] = page
        p.setdefault("components", []).append(comp)
        return {"added": comp["id"], "type": type, "name": cprops["name"],
                "x": comp["x"], "y": comp["y"]}
    return _out(_mutate(project_id, f"Before MCP add {type}", edit))


@_write_tool
def move_component(project_id: int, component_id: str, x: float,
                   y: float, rotation: Optional[int] = None) -> str:
    """Move a component (snapped to the 20 px grid), optionally rotating it
    (0/90/180/270). Attached wires follow."""
    if rotation not in (None, 0, 90, 180, 270):
        raise ValueError("rotation must be 0, 90, 180 or 270")

    def edit(p):
        c = _find(p, component_id)
        c["x"], c["y"] = round(x / 20) * 20, round(y / 20) * 20
        if rotation is not None:
            c["rotation"] = rotation
        return {"moved": component_id, "x": c["x"], "y": c["y"], "rotation": c.get("rotation", 0)}
    return _out(_mutate(project_id, f"Before MCP move of {component_id}", edit))


@_write_tool
def delete_component(project_id: int, component_id: str) -> str:
    """Delete a component AND every wire attached to it. A revision snapshot is
    saved first, so it can be restored from the app's revision history."""
    def edit(p):
        _find(p, component_id)
        gone = [w["id"] for w in p["wires"]
                if component_id in (w["fromComponent"], w["toComponent"])]
        p["components"] = [c for c in p["components"] if c["id"] != component_id]
        p["wires"] = [w for w in p["wires"] if w["id"] not in gone]
        return {"deleted": component_id, "wires_removed": gone}
    return _out(_mutate(project_id, f"Before MCP delete of {component_id}", edit))


@_write_tool
def add_wire(project_id: int, from_component: str, from_port: str,
             to_component: str, to_port: str) -> str:
    """Connect two component ports. Ports are checked against the component type
    (see list_component_types; bus ports: left, right, top_N, bottom_N, at_<x>).
    Returns the new wire id."""
    def edit(p):
        a, b = _find(p, from_component), _find(p, to_component)
        if from_component == to_component:
            raise ValueError("Cannot wire a component to itself")
        _check_port(a, from_port)
        _check_port(b, to_port)
        for w in p.get("wires", []):
            if {(w["fromComponent"], w["fromPort"]), (w["toComponent"], w["toPort"])} == \
                    {(from_component, from_port), (to_component, to_port)}:
                raise ValueError(f"Already connected by {w['id']}")
        wire = {"id": _next_id(p, "wire"), "fromComponent": from_component,
                "fromPort": from_port, "toComponent": to_component, "toPort": to_port}
        pages = p.get("pages") or []
        page = a.get("pageId") or p.get("activePageId") or (pages[0]["id"] if pages else None)
        if page:
            wire["pageId"] = page
        p.setdefault("wires", []).append(wire)
        return {"added": wire["id"]}
    return _out(_mutate(project_id, "Before MCP add wire", edit))


@_write_tool
def delete_wire(project_id: int, wire_id: str) -> str:
    """Remove one wire (the components stay)."""
    def edit(p):
        if not any(w["id"] == wire_id for w in p["wires"]):
            raise ValueError(f"No wire '{wire_id}' in this project")
        p["wires"] = [w for w in p["wires"] if w["id"] != wire_id]
        return {"deleted": wire_id}
    return _out(_mutate(project_id, f"Before MCP delete of {wire_id}", edit))


@_write_tool
def create_project(name: str, base_mva: float = 100.0, frequency: int = 50) -> str:
    """Create a new empty project owned by the agent's account → {id, name}."""
    return _out(_call(lambda pp: pp.save_project({
        "projectName": name, "baseMVA": base_mva, "frequency": frequency,
        "components": [], "wires": [], "nextId": 1})))


@_write_tool
def rename_project(project_id: int, name: str) -> str:
    """Rename a project (revision snapshot saved first)."""
    def edit(p):
        p["projectName"] = name
        return {"id": project_id, "name": name}
    return _out(_mutate(project_id, "Before MCP rename", edit))


@_write_tool
def create_revision(project_id: int, label: str = "") -> str:
    """Save a labelled snapshot of the project's current state."""
    _snapshot(project_id, label)
    return "Revision saved."


def main():
    mcp.run()


if __name__ == "__main__":
    main()
