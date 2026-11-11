"""OAuth 2.1 (authorization code + PKCE) for the built-in MCP endpoint.

An AI client is pointed at /mcp, learns where to sign in from the discovery documents,
registers itself, sends the person to the app's consent screen (/#mcp-consent=<id>),
and swaps the one-time code for a short access token and a rotating refresh token.
The access token is an ordinary app JWT with amr="mcp", a scope and the grant id, so it
acts as the approving account and nothing more (see auth._check_mcp_token).
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from ..auth import create_access_token, get_current_user
from ..models.database import get_db, User, OAuthClient, OAuthAuthRequest, OAuthGrant
from .auth import _ip_limit, _clean_text

SCOPES = ("mcp:read", "mcp:write")
ACCESS_TTL = timedelta(hours=1)
REFRESH_TTL = timedelta(days=30)
CODE_TTL = timedelta(minutes=10)
MAX_CLIENTS = 500

public = APIRouter(tags=["oauth"])                          # /.well-known, /oauth
app_router = APIRouter(prefix="/oauth", tags=["oauth"])      # signed-in app screens (/api/oauth)


def _sha(value: str) -> str:
    return hashlib.sha256((value or "").encode()).hexdigest()


def _utc(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _now():
    return datetime.now(timezone.utc)


def public_url(request: Request) -> str:
    """The one fixed address clients see. PUBLIC_URL wins; else what the proxy forwarded."""
    env = os.environ.get("PUBLIC_URL", "").strip().rstrip("/")
    if env:
        return env
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


def _oauth_error(error: str, desc: str = "", status: int = 400):
    body = {"error": error}
    if desc:
        body["error_description"] = desc
    return JSONResponse(body, status_code=status, headers={"Cache-Control": "no-store"})


# ── Discovery ──

@public.get("/.well-known/oauth-protected-resource")
@public.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource(request: Request):
    base = public_url(request)
    return {"resource": f"{base}/mcp", "authorization_servers": [base],
            "scopes_supported": list(SCOPES), "bearer_methods_supported": ["header"]}


@public.get("/.well-known/oauth-authorization-server")
@public.get("/.well-known/oauth-authorization-server/mcp")
def authorization_server(request: Request):
    base = public_url(request)
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "revocation_endpoint": f"{base}/oauth/revoke",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": list(SCOPES),
    }


# ── Registration ──

def _redirect_ok(uri: str) -> bool:
    """https anywhere, or http only to the machine itself; no fragment, no credentials."""
    try:
        u = urlsplit(uri)
    except ValueError:
        return False
    if u.fragment or u.username or u.password or not u.hostname or len(uri) > 500:
        return False
    if u.scheme == "https":
        return True
    return u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")


@public.post("/oauth/register")
async def register(request: Request, db: Session = Depends(get_db)):
    _ip_limit(request, "oauth")
    try:
        data = await request.json()
        assert isinstance(data, dict)
    except Exception:
        return _oauth_error("invalid_client_metadata", "Send a JSON object")
    uris = data.get("redirect_uris")
    if not isinstance(uris, list) or not uris or len(uris) > 5 or \
            not all(isinstance(u, str) and _redirect_ok(u) for u in uris):
        return _oauth_error("invalid_redirect_uri",
                            "redirect_uris must be 1-5 https:// URLs (http:// only for localhost)")
    if db.query(OAuthClient).count() >= MAX_CLIENTS:
        # make room: forget clients that never got a grant
        old = (db.query(OAuthClient).order_by(OAuthClient.created_at).limit(100).all())
        for c in old:
            if not db.query(OAuthGrant).filter(OAuthGrant.client_id == c.client_id).first():
                db.delete(c)
        db.commit()
        if db.query(OAuthClient).count() >= MAX_CLIENTS:
            raise HTTPException(status_code=429, detail="Too many registered clients")
    name = _clean_text(str(data.get("client_name") or ""), 60) or "AI app"
    cid = secrets.token_urlsafe(24)
    db.add(OAuthClient(client_id=cid, client_name=name, redirect_uris=json.dumps(uris)))
    db.commit()
    return JSONResponse({
        "client_id": cid, "client_name": name, "redirect_uris": uris,
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
    }, status_code=201)


# ── Authorize: park the request, send the browser to the app's consent screen ──

def _clean_scope(raw: str) -> str:
    asked = [s for s in (raw or "").split() if s in SCOPES]
    if not asked:
        asked = list(SCOPES)
    if "mcp:write" in asked and "mcp:read" not in asked:
        asked.insert(0, "mcp:read")
    return " ".join(asked)


@public.get("/oauth/authorize")
def authorize(request: Request, db: Session = Depends(get_db)):
    _ip_limit(request, "oauth")
    q = request.query_params
    client = db.query(OAuthClient).filter(OAuthClient.client_id == q.get("client_id", "")).first()
    redirect_uri = q.get("redirect_uri", "")
    # Until client and redirect are proven, never redirect: show the error instead.
    if client is None or redirect_uri not in json.loads(client.redirect_uris or "[]"):
        return _oauth_error("invalid_request", "Unknown client or redirect_uri")

    def back(error, desc):
        params = {"error": error, "error_description": desc}
        if q.get("state"):
            params["state"] = q["state"]
        sep = "&" if "?" in redirect_uri else "?"
        return RedirectResponse(redirect_uri + sep + urlencode(params), status_code=302)

    if q.get("response_type") != "code":
        return back("unsupported_response_type", "Only response_type=code")
    challenge = q.get("code_challenge", "")
    if q.get("code_challenge_method") != "S256" or not (43 <= len(challenge) <= 128):
        return back("invalid_request", "PKCE with code_challenge_method=S256 is required")
    now = _now()
    db.query(OAuthAuthRequest).filter(OAuthAuthRequest.expires_at < now - timedelta(hours=1)).delete()
    if db.query(OAuthAuthRequest).filter(OAuthAuthRequest.status == "pending",
                                         OAuthAuthRequest.expires_at > now).count() >= 200:
        return back("temporarily_unavailable", "Too many pending requests")
    rid = secrets.token_urlsafe(24)
    db.add(OAuthAuthRequest(
        id=rid, client_id=client.client_id, redirect_uri=redirect_uri,
        state=(q.get("state") or "")[:500], code_challenge=challenge,
        scope_requested=_clean_scope(q.get("scope", "")), expires_at=now + CODE_TTL))
    db.commit()
    # The id travels in the fragment, so it never reaches server logs.
    return RedirectResponse(f"/#mcp-consent={rid}", status_code=302)


# ── Consent (the signed-in app calls these with the person's normal token) ──

def _pending(db: Session, rid: str) -> OAuthAuthRequest:
    row = db.query(OAuthAuthRequest).filter(OAuthAuthRequest.id == rid).first()
    if row is None or _utc(row.expires_at) < _now():
        raise HTTPException(status_code=404,
                            detail="This request has expired. Start it again from the AI app.")
    return row


@app_router.get("/consent/{rid}")
def consent_info(rid: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    row = _pending(db, rid)
    client = db.query(OAuthClient).filter(OAuthClient.client_id == row.client_id).first()
    return {"client_name": client.client_name if client else "AI app",
            "redirect_host": urlsplit(row.redirect_uri).netloc,
            "scope": row.scope_requested.split(), "status": row.status, "email": user.email}


def _decide(rid, approve, scope, user, db):
    row = _pending(db, rid)
    if row.status != "pending":
        raise HTTPException(status_code=409, detail="This request was already answered")
    params = {}
    if row.state:
        params["state"] = row.state
    if approve:
        granted = [s for s in (scope or row.scope_requested).split()
                   if s in row.scope_requested.split()]
        if "mcp:read" not in granted:
            granted.insert(0, "mcp:read")
        code = secrets.token_urlsafe(32)
        row.status, row.user_id = "approved", user.id
        row.scope, row.code_hash = " ".join(granted), _sha(code)
        row.expires_at = _now() + CODE_TTL
        params["code"] = code
    else:
        row.status, row.user_id = "denied", user.id
        params.update(error="access_denied", error_description="Denied in ProtectionPro")
    db.commit()
    print(f"[mcp-oauth] {'approve' if approve else 'deny'} user={user.id} client={row.client_id} scope={row.scope!r}")
    sep = "&" if "?" in row.redirect_uri else "?"
    return {"status": row.status, "redirect_url": row.redirect_uri + sep + urlencode(params)}


@app_router.post("/consent/{rid}/approve")
async def consent_approve(rid: str, request: Request, user: User = Depends(get_current_user),
                          db: Session = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        body = {}
    scope = body.get("scope") if isinstance(body, dict) else None
    return _decide(rid, True, scope if isinstance(scope, str) else None, user, db)


@app_router.post("/consent/{rid}/deny")
def consent_deny(rid: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _decide(rid, False, None, user, db)


# ── Token ──

def _issue(db: Session, user: User, grant: OAuthGrant, refresh: str) -> dict:
    access = create_access_token(user, amr="mcp", ttl=ACCESS_TTL,
                                 extra={"scope": grant.scope, "gid": grant.id, "cid": grant.client_id})
    return {"access_token": access, "token_type": "Bearer",
            "expires_in": int(ACCESS_TTL.total_seconds()),
            "refresh_token": refresh, "scope": grant.scope}


def _revoke_grant(db: Session, grant: OAuthGrant, why: str):
    grant.revoked = True
    db.commit()
    print(f"[mcp-oauth] revoke grant={grant.id} user={grant.user_id} client={grant.client_id} ({why})")


@public.post("/oauth/token")
async def token(request: Request, db: Session = Depends(get_db)):
    _ip_limit(request, "oauth")
    form = await request.form()
    gt = form.get("grant_type")
    client_id = form.get("client_id") or ""
    now = _now()

    if gt == "authorization_code":
        code = form.get("code") or ""
        row = db.query(OAuthAuthRequest).filter(OAuthAuthRequest.code_hash == _sha(code)).first() if code else None
        if row is None:
            return _oauth_error("invalid_grant", "Unknown code")
        if row.status == "used":
            # a code swapped twice: whoever got tokens from it may be a thief
            g = db.query(OAuthGrant).filter(OAuthGrant.id == row.grant_id).first() if row.grant_id else None
            if g:
                _revoke_grant(db, g, "code reuse")
            return _oauth_error("invalid_grant", "Code already used")
        if row.status != "approved" or _utc(row.expires_at) < now:
            return _oauth_error("invalid_grant", "Code expired")
        if row.client_id != client_id or row.redirect_uri != (form.get("redirect_uri") or ""):
            return _oauth_error("invalid_grant", "client_id or redirect_uri does not match")
        verifier = form.get("code_verifier") or ""
        want = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        if not (43 <= len(verifier) <= 128) or not hmac.compare_digest(want, row.code_challenge):
            return _oauth_error("invalid_grant", "PKCE verification failed")
        user = db.query(User).filter(User.id == row.user_id).first()
        if user is None or not user.is_active:
            return _oauth_error("invalid_grant", "Account unavailable")
        refresh = secrets.token_urlsafe(40)
        grant = OAuthGrant(client_id=client_id, user_id=user.id, scope=row.scope,
                           refresh_hash=_sha(refresh), expires_at=now + REFRESH_TTL, last_used_at=now)
        db.add(grant)
        db.flush()
        row.status, row.grant_id = "used", grant.id
        db.commit()
        return JSONResponse(_issue(db, user, grant, refresh), headers={"Cache-Control": "no-store"})

    if gt == "refresh_token":
        presented = _sha(form.get("refresh_token") or "")
        grant = db.query(OAuthGrant).filter(OAuthGrant.refresh_hash == presented).first()
        if grant is None:
            old = db.query(OAuthGrant).filter(OAuthGrant.prev_hash == presented).first()
            if old is not None:
                _revoke_grant(db, old, "refresh token reuse")      # rotated-out token came back
            return _oauth_error("invalid_grant", "Unknown refresh token")
        if grant.client_id != client_id or grant.revoked or _utc(grant.expires_at) < now:
            return _oauth_error("invalid_grant", "Refresh token no longer valid")
        user = db.query(User).filter(User.id == grant.user_id).first()
        if user is None or not user.is_active:
            return _oauth_error("invalid_grant", "Account unavailable")
        refresh = secrets.token_urlsafe(40)
        grant.prev_hash, grant.refresh_hash = grant.refresh_hash, _sha(refresh)
        grant.expires_at, grant.last_used_at = now + REFRESH_TTL, now
        db.commit()
        return JSONResponse(_issue(db, user, grant, refresh), headers={"Cache-Control": "no-store"})

    return _oauth_error("unsupported_grant_type")


@public.post("/oauth/revoke")
async def revoke(request: Request, db: Session = Depends(get_db)):
    """RFC 7009: always 200, whether or not the token was known."""
    _ip_limit(request, "oauth")
    form = await request.form()
    digest = _sha(form.get("token") or "")
    grant = db.query(OAuthGrant).filter(
        (OAuthGrant.refresh_hash == digest) | (OAuthGrant.prev_hash == digest)).first()
    if grant and grant.client_id == (form.get("client_id") or ""):
        _revoke_grant(db, grant, "client revoke")
    return JSONResponse({}, headers={"Cache-Control": "no-store"})


# ── "Connected AI apps" in the account menu ──

@app_router.get("/grants")
def list_grants(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    rows = (db.query(OAuthGrant, OAuthClient)
            .join(OAuthClient, OAuthClient.client_id == OAuthGrant.client_id)
            .filter(OAuthGrant.user_id == user.id, OAuthGrant.revoked == False,  # noqa: E712
                    OAuthGrant.expires_at > _now().replace(tzinfo=None))
            .order_by(OAuthGrant.created_at.desc()).all())
    return [{"id": g.id, "client_name": c.client_name, "scope": g.scope.split(),
             "connected": g.created_at.isoformat() if g.created_at else None,
             "last_used": g.last_used_at.isoformat() if g.last_used_at else None}
            for g, c in rows]


@app_router.delete("/grants/{grant_id}")
def delete_grant(grant_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    g = db.query(OAuthGrant).filter(OAuthGrant.id == grant_id, OAuthGrant.user_id == user.id).first()
    if g is None:
        raise HTTPException(status_code=404, detail="Not found")
    _revoke_grant(db, g, "user disconnect")
    return {"ok": True}
