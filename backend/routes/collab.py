"""Live co-editing relay: WS /api/projects/{id}/live.

One in-memory room per project (single uvicorn process). The server does not
interpret the edits: it authenticates each socket, enforces view/edit, and relays
`ops` (per-component / per-wire changes made by one editor) and `presence` to the
others in the room. Every client keeps the whole project, so whoever saves has
everything; after a PUT the server broadcasts `saved` with the new version so the
connected editors adopt it instead of tripping each other's save-conflict check.
Presence and edits never touch the database.

Messages (JSON):
  client -> server  {type:"hello", token, session, since?}    first message, required;
                                                              since = last op seq seen (reconnect)
                    {type:"ops", ops:[...]}                   edit access only
                    {type:"presence", ...}                    any role; relayed as-is
                    {type:"ping"}
  server -> client  {type:"welcome", client_id, role, slot, version, seq, resync, peers:[...]}
                    {type:"replay", batches:[{seq, from, ops}]}   edits missed while disconnected
                    {type:"peer_join"|"peer_leave", peer|client_id}
                    {type:"ops", from, seq, ops} / {type:"presence", from, ...}
                    {type:"saved", version, by}
                    {type:"error", message}
"""

import json
import time
from collections import deque

import anyio
import jwt
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from ..auth import decode_token, resolve_access
from ..models.database import get_db, Project, User
from ..notifications import display_name

router = APIRouter()

MAX_SLOTS = 16
LOG_BATCHES = 500   # op batches kept per live project for reconnect replay
MAX_MESSAGE_BYTES = 2_000_000
MAX_LOG_BYTES = 32_000_000     # replay log per project, by retained op payload size
MAX_OPS_PER_BATCH = 5000
OPS_WINDOW_S, OPS_PER_WINDOW = 10.0, 100   # op batches one client may send per window
HELLO_TIMEOUT_S = 10
_COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#008080",
           "#9a6324", "#800000", "#808000", "#000075"]

# project_id -> {client_id: Peer}
_rooms: dict[int, dict[str, "Peer"]] = {}
# project_id -> [last seq, deque[(seq, client_id, session, ops)]]; lives as long as the room
_logs: dict[int, list] = {}
_next_client = 0


class Peer:
    def __init__(self, ws, client_id, user_id, name, role, color, slot, session=None, exp=None):
        self.ws, self.client_id, self.user_id, self.session = ws, client_id, user_id, session
        self.exp = exp              # token expiry (epoch seconds); the socket ends with it
        self.sent_ops = deque()     # monotonic times of recent op batches (rate limit)
        self.name, self.role, self.color, self.slot = name, role, color, slot

    def info(self):
        return {"client_id": self.client_id, "user_id": self.user_id,
                "name": self.name, "role": self.role, "color": self.color, "slot": self.slot}


async def _send(peer: Peer, msg: dict) -> bool:
    try:
        await peer.ws.send_text(json.dumps(msg))
        return True
    except Exception:
        return False


async def _broadcast(project_id: int, msg: dict, exclude: str | None = None):
    now = time.time()
    for peer in list(_rooms.get(project_id, {}).values()):
        if peer.exp is not None and peer.exp <= now:
            await _refuse(peer.ws, 4401)   # token expired: stop feeding it
            continue
        if peer.client_id != exclude:
            await _send(peer, msg)


async def _kick(project_id: int | None, user_id: int):
    """Close a user's live sockets (on one project, or all) so access is decided afresh
    when they reconnect."""
    for pid, room in list(_rooms.items()):
        if project_id is not None and pid != project_id:
            continue
        for peer in list(room.values()):
            if peer.user_id == user_id:
                await _refuse(peer.ws, 4403)


def revoke_access(user_id: int, project_id: int | None = None):
    """Called by the (sync) routes that remove or change someone's access: share removed
    or changed, account deactivated / deleted / password changed or reset."""
    if not _rooms:
        return
    try:
        anyio.from_thread.run(_kick, project_id, user_id)
    except Exception:
        pass  # not under a worker thread (scripts/tests); nobody to tell


def _user_from_token(db: Session, token) -> User | None:
    try:
        payload = decode_token(token)
        if payload.get("amr") == "mcp":
            return None      # MCP tokens reach projects through /mcp only
        user = db.query(User).filter(User.id == int(payload["sub"])).first()
    except (jwt.PyJWTError, KeyError, ValueError, TypeError):
        return None
    if user is None or not user.is_active:
        return None
    if int(payload.get("tv", 0) or 0) != (user.token_version or 0):
        return None
    return user


def notify_saved(project_id: int, version: int, user: User):
    """Called by the (sync) save route: tell the project's live editors a save landed."""
    if project_id not in _rooms:
        return
    msg = {"type": "saved", "version": version, "by": display_name(user), "by_id": user.id}
    try:
        anyio.from_thread.run(_broadcast, project_id, msg)
    except Exception:
        pass  # not running under a worker thread (scripts/tests); nobody to tell


async def _refuse(ws: WebSocket, code: int):
    """Close with a reason code; the client may already be gone (reload, dropped link)."""
    try:
        await ws.close(code=code)
    except Exception:
        pass


async def _recv(ws: WebSocket, timeout: float) -> str:
    with anyio.fail_after(timeout):
        return await ws.receive_text()


@router.websocket("/projects/{project_id}/live")
async def live(ws: WebSocket, project_id: int, db: Session = Depends(get_db)):
    global _next_client
    await ws.accept()
    # Token travels in the first message (it lives in localStorage, not a cookie,
    # and must not end up in a URL/access log).
    try:
        hello = json.loads(await _recv(ws, HELLO_TIMEOUT_S))
        if hello.get("type") != "hello":
            raise ValueError
    except Exception:
        await _refuse(ws, 4400)
        return
    user = _user_from_token(db, hello.get("token"))
    if user is None:
        await _refuse(ws, 4401)
        return
    try:
        exp = float(decode_token(hello.get("token")).get("exp"))
    except (jwt.PyJWTError, TypeError, ValueError):
        exp = None
    project = db.query(Project).filter(Project.id == project_id).first()
    level = resolve_access(db, project, user) if project else None
    if level is None:
        await _refuse(ws, 4404)   # no access looks like no project
        return
    version = project.version or 1
    name = display_name(user)
    uid = user.id
    db.close()   # don't hold a connection for the life of the socket

    _next_client += 1
    client_id = f"c{_next_client}"
    room = _rooms.setdefault(project_id, {})
    log = _logs.setdefault(project_id, [0, deque(maxlen=LOG_BATCHES), 0])
    # Lowest free 0..MAX_SLOTS-1: the client strides its generated ids by it so two
    # editors never mint the same `bus_12` (see collab.js).
    taken = {p.slot for p in room.values()}
    slot = next((i for i in range(MAX_SLOTS) if i not in taken), None)
    if slot is None:
        await _refuse(ws, 4429)   # room full
        return
    peer = Peer(ws, client_id, uid, name, "edit" if level in ("edit", "owner") else "view",
                _COLORS[uid % len(_COLORS)], slot, str(hello.get("session") or "")[:64], exp=exp)
    others = [p.info() for p in room.values()]
    room[client_id] = peer
    # A reconnecting client says the last seq it saw: replay what it missed if the log
    # still covers it, otherwise tell it to resync from the saved project.
    since = hello.get("since")
    seq, batches = log[0], log[1]
    resync, missed = False, []
    if isinstance(since, int) and not isinstance(since, bool) and since != seq:
        missed = [b for b in batches if b[0] > since]
        covered = since < seq and missed and missed[0][0] == since + 1
        if not covered:
            resync, missed = True, []
    await _send(peer, {"type": "welcome", "client_id": client_id, "role": peer.role, "slot": slot,
                       "version": version, "seq": seq, "resync": resync, "peers": others})
    # Own edits made before the drop are already in this client's state; don't replay them.
    missed = [{"seq": b[0], "from": b[1], "ops": b[3]} for b in missed
              if not (peer.session and b[2] == peer.session)]
    if missed:
        await _send(peer, {"type": "replay", "batches": missed})
    await _broadcast(project_id, {"type": "peer_join", "peer": peer.info()}, exclude=client_id)
    try:
        while True:
            raw = await ws.receive_text()
            if peer.exp is not None and peer.exp <= time.time():
                await _refuse(ws, 4401)
                break
            if len(raw) > MAX_MESSAGE_BYTES:
                await _send(peer, {"type": "error", "message": "message too large"})
                continue
            try:
                msg = json.loads(raw)
                kind = msg.get("type")
            except (ValueError, AttributeError):
                continue
            if kind == "ping":
                await _send(peer, {"type": "pong"})
            elif kind == "ops":
                if peer.role != "edit":
                    await _send(peer, {"type": "error", "message": "view-only"})
                    continue
                ops = msg.get("ops") or []
                if (not isinstance(ops, list) or len(ops) > MAX_OPS_PER_BATCH
                        or not all(isinstance(o, dict) for o in ops)):
                    await _send(peer, {"type": "error", "message": "malformed ops"})
                    continue
                t = time.monotonic()
                while peer.sent_ops and t - peer.sent_ops[0] > OPS_WINDOW_S:
                    peer.sent_ops.popleft()
                if len(peer.sent_ops) >= OPS_PER_WINDOW:
                    await _send(peer, {"type": "error", "message": "too many edits, slow down"})
                    continue
                peer.sent_ops.append(t)
                log[0] += 1
                log[1].append((log[0], client_id, peer.session, ops, len(raw)))
                log[2] += len(raw)
                while log[2] > MAX_LOG_BYTES and log[1]:
                    log[2] -= log[1].popleft()[4]
                await _broadcast(project_id, {"type": "ops", "from": client_id, "seq": log[0],
                                              "ops": ops}, exclude=client_id)
            elif kind == "presence":
                msg = {k: v for k, v in msg.items() if k != "type"}
                await _broadcast(project_id, {"type": "presence", "from": client_id, **msg},
                                 exclude=client_id)
    except WebSocketDisconnect:
        pass
    finally:
        room.pop(client_id, None)
        if not room:
            _rooms.pop(project_id, None)
            _logs.pop(project_id, None)
        await _broadcast(project_id, {"type": "peer_leave", "client_id": client_id})
