"""Built-in MCP endpoint (POST /mcp) — the same tools as clients/mcp, served by the app.

Stateless MCP "streamable HTTP": each POST carries one JSON-RPC message (or a batch) and
is answered with application/json. Signing in is OAuth (routes/oauth.py); the access
token (amr "mcp") names the account and the scope. Tools call the app's own REST routes
in-process with that same token, so every project permission check and every MCP
restriction in auth.py applies exactly as it does over the network.
"""

import copy
import inspect
import json
import os
import re
import typing
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit

import httpx
import jwt
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError, create_model

from .auth import decode_token
from fastapi import Depends
from sqlalchemy.orm import Session

from .models.database import get_db, OAuthGrant, User
from .routes.oauth import public_url, SCOPES

router = APIRouter(tags=["mcp"])

MAX_CHARS = 60_000
PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
CATALOG = json.loads((Path(__file__).parent / "mcp_catalog.json").read_text())

INSTRUCTIONS = ("ProtectionPro: read and edit single-line diagrams and run power-system studies. "
                "Start with list_projects. Every edit saves a revision snapshot first.")


class ToolError(Exception):
    pass


# ── tool registry ──

TOOLS: dict[str, dict] = {}


def tool(write: bool = False):
    def deco(fn):
        sig = inspect.signature(fn)
        fields = {}
        for n, p in sig.parameters.items():
            if n == "api":
                continue
            ann = p.annotation if p.annotation is not inspect._empty else Any
            fields[n] = (ann, ... if p.default is inspect._empty else p.default)
        model = create_model(fn.__name__ + "_args", **fields)
        schema = model.model_json_schema()
        schema.pop("title", None)
        for prop in schema.get("properties", {}).values():
            prop.pop("title", None)
        TOOLS[fn.__name__] = {"fn": fn, "model": model, "write": write,
                              "description": inspect.cleandoc(fn.__doc__ or ""),
                              "schema": schema}
        return fn
    return deco


class Api:
    """The caller's view of the app: REST routes called in-process with their own token."""

    def __init__(self, app, token: str):
        self._http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                       base_url="http://mcp.internal", timeout=300.0)
        self._token = token

    async def req(self, method: str, path: str, json: Any = None) -> Any:
        r = await self._http.request(method, path, json=json,
                                     headers={"Authorization": f"Bearer {self._token}"})
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except Exception:
                detail = r.text
            raise ToolError(f"HTTP {r.status_code}: {detail}")
        return r.json()

    async def project(self, pid: int) -> dict:
        return await self.req("GET", f"/api/projects/{pid}")

    async def aclose(self):
        await self._http.aclose()


def _out(data: Any) -> str:
    text = json.dumps(data, indent=1, default=str)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + f"\n… truncated ({len(text)} chars total)"
    return text


def _find(project: dict, component_id: str) -> dict:
    for c in project.get("components", []):
        if c.get("id") == component_id:
            return c
    raise ToolError(f"No component '{component_id}' in this project")


async def _mutate(api: Api, pid: int, label: str, fn) -> Any:
    """GET, apply fn(project) (raise to abort), snapshot a revision, PUT."""
    p = await api.project(pid)
    result = fn(p)
    await api.req("POST", f"/api/projects/{pid}/revisions", {"label": label})
    await api.req("PUT", f"/api/projects/{pid}", p)
    return result


def _next_id(p: dict, prefix: str) -> str:
    used = {c["id"] for c in p.get("components", [])} | {w["id"] for w in p.get("wires", [])}
    n = int(p.get("nextId") or 1)
    while f"{prefix}_{n}" in used:
        n += 1
    p["nextId"] = n + 1
    return f"{prefix}_{n}"


def _check_port(comp: dict, port: str):
    spec = CATALOG.get(comp["type"])
    if spec is None:
        return
    if comp["type"] == "bus":
        bw = (comp.get("props") or {}).get("busWidth") or 120
        n = max(1, int(bw // 40))
        m = re.fullmatch(r"(top|bottom)_(\d+)", port)
        if port in ("left", "right", "top", "bottom") or re.fullmatch(r"at_-?\d+(\.\d+)?", port) \
                or (m and int(m.group(2)) < n):
            return
        raise ToolError(f"Bus {comp['id']} has no port '{port}'. Use left, right, "
                        f"top_0..top_{n-1}, bottom_0..bottom_{n-1} or at_<x offset>.")
    if port not in spec["ports"]:
        raise ToolError(f"{comp['type']} {comp['id']} has no port '{port}'. "
                        f"Ports: {spec['ports'] or 'none (not wired)'}")


# ── read tools ──

@tool()
async def list_projects(api: Api) -> str:
    """List the projects this account can open (id, name, timestamps, access)."""
    return _out(await api.req("GET", "/api/projects"))


@tool()
async def project_overview(api: Api, project_id: int) -> str:
    """Project name, base MVA, frequency, and component counts by type."""
    p = await api.project(project_id)
    counts: dict[str, int] = {}
    for c in p.get("components", []):
        counts[c["type"]] = counts.get(c["type"], 0) + 1
    return _out({"name": p.get("projectName"), "baseMVA": p.get("baseMVA"),
                 "frequency": p.get("frequency"), "components": counts,
                 "wires": len(p.get("wires", []))})


@tool()
async def list_components(api: Api, project_id: int, type: Optional[str] = None,
                          name_contains: Optional[str] = None) -> str:
    """List components as {id, type, name}. Optionally filter by type (e.g. 'bus',
    'transformer', 'cable') and/or a case-insensitive substring of the name."""
    p = await api.project(project_id)
    rows = []
    for c in p.get("components", []):
        name = (c.get("props") or {}).get("name", "")
        if type and c["type"] != type:
            continue
        if name_contains and name_contains.lower() not in str(name).lower():
            continue
        rows.append({"id": c["id"], "type": c["type"], "name": name})
    return _out(rows)


@tool()
async def get_component(api: Api, project_id: int, component_id: str) -> str:
    """Full detail of one component (all props) plus the wires attached to it."""
    p = await api.project(project_id)
    c = _find(p, component_id)
    wires = [w for w in p.get("wires", [])
             if component_id in (w.get("fromComponent"), w.get("toComponent"))]
    return _out({"component": c, "wires": wires})


@tool()
async def list_revisions(api: Api, project_id: int) -> str:
    """Saved revision snapshots of a project (newest first)."""
    return _out(await api.req("GET", f"/api/projects/{project_id}/revisions"))


@tool()
async def run_analysis(api: Api, project_id: int, kind: str, params: Optional[dict] = None) -> str:
    """Run a study on the saved project and return the results (large results are
    truncated). `kind` is the endpoint name under /api/analysis, e.g. 'fault',
    'loadflow', 'arcflash', 'cable-sizing', 'duty-check', 'contingency',
    'voltage-stability', 'motor-starting'. `params` are that study's options
    (e.g. {"faultType": "3phase"}). Nothing is saved to the project."""
    if not re.fullmatch(r"[a-z0-9_-]+", kind):
        raise ToolError("Invalid study name")
    p = await api.project(project_id)
    payload = {**p, **{k: v for k, v in (params or {}).items() if v is not None}}
    return _out(await api.req("POST", f"/api/analysis/{kind.replace('_', '-')}", payload))


@tool()
async def list_component_types(api: Api) -> str:
    """Every component type that add_component accepts, with category, wiring ports
    (bus ports depend on its width: left, right, top_N, bottom_N, at_<x>) and the
    names of its default props."""
    return _out({t: {"name": v["name"], "category": v["category"],
                     "ports": v["ports"] or "none", "props": sorted(v["defaults"])}
                 for t, v in CATALOG.items()})


# ── write tools ──

@tool(write=True)
async def update_component_props(api: Api, project_id: int, component_id: str, props: dict,
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
            raise ToolError(f"Unknown props for {comp['type']} {component_id}: {unknown}. "
                            f"Valid: {sorted(existing)}")
        before = {k: existing.get(k) for k in props}
        existing.update(props)
        return {"updated": component_id, "before": before, "after": props}
    return _out(await _mutate(api, project_id, f"Before MCP update of {component_id}", edit))


@tool(write=True)
async def add_component(api: Api, project_id: int, type: str, x: float, y: float,
                        props: Optional[dict] = None, rotation: int = 0) -> str:
    """Add a component at diagram position (x, y) (snapped to the 20 px grid) with
    the app's default props for its type, overridden by `props`. Returns the new
    id — use it with add_wire. See list_component_types for types and ports."""
    if type not in CATALOG:
        raise ToolError(f"Unknown component type '{type}'. Use list_component_types.")
    if rotation not in (0, 90, 180, 270):
        raise ToolError("rotation must be 0, 90, 180 or 270")

    def edit(p):
        spec = CATALOG[type]
        cprops = copy.deepcopy(spec["defaults"])
        count = sum(1 for c in p.get("components", []) if c["type"] == type)
        cprops["name"] = f"{spec['defaults'].get('name', type)}{count + 1 if count else ''}"
        unknown = [k for k in (props or {}) if k not in cprops]
        if unknown:
            raise ToolError(f"Unknown props for {type}: {unknown}. Valid: {sorted(cprops)}")
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
    return _out(await _mutate(api, project_id, f"Before MCP add {type}", edit))


@tool(write=True)
async def move_component(api: Api, project_id: int, component_id: str, x: float, y: float,
                         rotation: Optional[int] = None) -> str:
    """Move a component (snapped to the 20 px grid), optionally rotating it
    (0/90/180/270). Attached wires follow."""
    if rotation not in (None, 0, 90, 180, 270):
        raise ToolError("rotation must be 0, 90, 180 or 270")

    def edit(p):
        c = _find(p, component_id)
        c["x"], c["y"] = round(x / 20) * 20, round(y / 20) * 20
        if rotation is not None:
            c["rotation"] = rotation
        return {"moved": component_id, "x": c["x"], "y": c["y"], "rotation": c.get("rotation", 0)}
    return _out(await _mutate(api, project_id, f"Before MCP move of {component_id}", edit))


@tool(write=True)
async def delete_component(api: Api, project_id: int, component_id: str) -> str:
    """Delete a component AND every wire attached to it. A revision snapshot is
    saved first, so it can be restored from the app's revision history."""
    def edit(p):
        _find(p, component_id)
        gone = [w["id"] for w in p["wires"]
                if component_id in (w["fromComponent"], w["toComponent"])]
        p["components"] = [c for c in p["components"] if c["id"] != component_id]
        p["wires"] = [w for w in p["wires"] if w["id"] not in gone]
        return {"deleted": component_id, "wires_removed": gone}
    return _out(await _mutate(api, project_id, f"Before MCP delete of {component_id}", edit))


@tool(write=True)
async def add_wire(api: Api, project_id: int, from_component: str, from_port: str,
                   to_component: str, to_port: str) -> str:
    """Connect two component ports. Ports are checked against the component type
    (see list_component_types; bus ports: left, right, top_N, bottom_N, at_<x>).
    Returns the new wire id."""
    def edit(p):
        a, b = _find(p, from_component), _find(p, to_component)
        if from_component == to_component:
            raise ToolError("Cannot wire a component to itself")
        _check_port(a, from_port)
        _check_port(b, to_port)
        for w in p.get("wires", []):
            if {(w["fromComponent"], w["fromPort"]), (w["toComponent"], w["toPort"])} == \
                    {(from_component, from_port), (to_component, to_port)}:
                raise ToolError(f"Already connected by {w['id']}")
        wire = {"id": _next_id(p, "wire"), "fromComponent": from_component,
                "fromPort": from_port, "toComponent": to_component, "toPort": to_port}
        pages = p.get("pages") or []
        page = a.get("pageId") or p.get("activePageId") or (pages[0]["id"] if pages else None)
        if page:
            wire["pageId"] = page
        p.setdefault("wires", []).append(wire)
        return {"added": wire["id"]}
    return _out(await _mutate(api, project_id, "Before MCP add wire", edit))


@tool(write=True)
async def delete_wire(api: Api, project_id: int, wire_id: str) -> str:
    """Remove one wire (the components stay)."""
    def edit(p):
        if not any(w["id"] == wire_id for w in p["wires"]):
            raise ToolError(f"No wire '{wire_id}' in this project")
        p["wires"] = [w for w in p["wires"] if w["id"] != wire_id]
        return {"deleted": wire_id}
    return _out(await _mutate(api, project_id, f"Before MCP delete of {wire_id}", edit))


@tool(write=True)
async def create_project(api: Api, name: str, base_mva: float = 100.0, frequency: int = 50) -> str:
    """Create a new empty project owned by your account → {id, name}."""
    return _out(await api.req("POST", "/api/projects", {
        "projectName": name, "baseMVA": base_mva, "frequency": frequency,
        "components": [], "wires": [], "nextId": 1}))


@tool(write=True)
async def rename_project(api: Api, project_id: int, name: str) -> str:
    """Rename a project (revision snapshot saved first)."""
    def edit(p):
        p["projectName"] = name
        return {"id": project_id, "name": name}
    return _out(await _mutate(api, project_id, "Before MCP rename", edit))


@tool(write=True)
async def create_revision(api: Api, project_id: int, label: str = "") -> str:
    """Save a labelled snapshot of the project's current state."""
    await api.req("POST", f"/api/projects/{project_id}/revisions", {"label": label})
    return "Revision saved."


# ── transport ──

def _origin_ok(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True                      # not a browser: nothing to defend against
    host = urlsplit(origin).hostname or ""
    allowed = {urlsplit(public_url(request)).hostname}
    allowed |= {h.strip() for h in os.environ.get("PP_MCP_ALLOWED_ORIGINS", "").split(",") if h.strip()}
    return host in allowed or host in ("localhost", "127.0.0.1", "::1")


def _unauthorized(request: Request, detail: str):
    meta = f"{public_url(request)}/.well-known/oauth-protected-resource"
    return JSONResponse({"error": "invalid_token", "error_description": detail}, status_code=401,
                        headers={"WWW-Authenticate": f'Bearer resource_metadata="{meta}"'})


def _principal(request: Request, db):
    """(token, scope) for a valid, unrevoked MCP access token, else None."""
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    token = auth[7:].strip()
    try:
        payload = decode_token(token)
        if payload.get("amr") != "mcp":
            return None
        uid, gid = int(payload["sub"]), int(payload["gid"])
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None
    user = db.query(User).filter(User.id == uid).first()
    grant = db.query(OAuthGrant).filter(OAuthGrant.id == gid).first()
    if (user is None or not user.is_active or grant is None or grant.revoked
            or int(payload.get("tv", 0) or 0) != (user.token_version or 0)):
        return None
    return token, str(payload.get("scope", ""))


def _visible(scope: str):
    can_write = "mcp:write" in scope.split()
    return {n: t for n, t in TOOLS.items() if can_write or not t["write"]}


def _err(rid, code, msg):
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": msg}}


async def _handle(msg: Any, request: Request, token: str, scope: str):
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0":
        return _err(None, -32600, "Invalid request")
    rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if "id" not in msg:
        return None                                  # notification: nothing to answer
    if method == "initialize":
        want = params.get("protocolVersion")
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "protectionpro", "version": "1.0"},
            "instructions": INSTRUCTIONS}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    tools = _visible(scope)
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": [
            {"name": n, "description": t["description"], "inputSchema": t["schema"]}
            for n, t in tools.items()]}}
    if method == "tools/call":
        t = tools.get(params.get("name"))
        if t is None:
            return _err(rid, -32602, f"Unknown tool '{params.get('name')}'")
        try:
            args = t["model"](**(params.get("arguments") or {}))
        except ValidationError as e:
            return {"jsonrpc": "2.0", "id": rid, "result": {
                "isError": True, "content": [{"type": "text", "text": f"Invalid arguments: {e}"}]}}
        api = Api(request.app, token)
        try:
            text = await t["fn"](api, **{k: getattr(args, k) for k in type(args).model_fields})
            is_err = False
        except ToolError as e:
            text, is_err = str(e), True
        except Exception as e:                       # a tool bug must not become a 500 for the client
            text, is_err = f"{type(e).__name__}: {e}", True
        finally:
            await api.aclose()
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "isError": is_err, "content": [{"type": "text", "text": text}]}}
    return _err(rid, -32601, f"Method not found: {method}")


@router.post("/mcp")
async def mcp_post(request: Request, db: Session = Depends(get_db)):
    if not _origin_ok(request):
        return JSONResponse({"error": "forbidden_origin"}, status_code=403)
    who = _principal(request, db)
    if who is None:
        return _unauthorized(request, "Missing, expired or revoked access token")
    token, scope = who
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(_err(None, -32700, "Parse error"), status_code=400)
    if isinstance(body, list):
        replies = [r for r in [await _handle(m, request, token, scope) for m in body] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await _handle(body, request, token, scope)
    return JSONResponse(reply) if reply is not None else Response(status_code=202)


@router.get("/mcp")
@router.delete("/mcp")
async def mcp_other():
    # No server-initiated stream and no sessions to end.
    return Response(status_code=405, headers={"Allow": "POST"})
