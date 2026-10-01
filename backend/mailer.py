"""Outgoing email (optional): SMTP config kept in app_settings, invite/reset messages.

Email is never compulsory — every caller checks `get_config(db)` first and falls
back to a copy-able link when it is None. The SMTP password is stored in the
app_settings table (the same place as the JWT secret) and is never returned by
the API.
"""

import json
import re
import smtplib
import socket
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from html import escape

from .models.database import AppSetting

_KEY = "email_config"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
SECURITY = ("starttls", "ssl", "none")


class MailError(Exception):
    """A send failed; the message is safe to show the administrator."""


def valid_address(addr: str) -> bool:
    return bool(_EMAIL_RE.match((addr or "").strip()))


def valid_base_url(url: str) -> bool:
    return bool(re.match(r"^https?://[^\s/<>\"']+(/[^\s<>\"']*)?$", url or "", re.I))


def _row(db):
    return db.query(AppSetting).filter(AppSetting.key == _KEY).first()


def load_raw(db) -> dict:
    row = _row(db)
    if not row:
        return {}
    try:
        return json.loads(row.value)
    except ValueError:
        return {}


def get_config(db):
    """The active config, or None when email is off / incomplete."""
    cfg = load_raw(db)
    if cfg.get("enabled") and cfg.get("host") and valid_address(cfg.get("from_address", "")):
        return cfg
    return None


def public_view(db) -> dict:
    cfg = load_raw(db)
    return {
        "enabled": bool(cfg.get("enabled")),
        "host": cfg.get("host", ""), "port": cfg.get("port", 587),
        "security": cfg.get("security", "starttls"),
        "username": cfg.get("username", ""), "has_password": bool(cfg.get("password")),
        "from_name": cfg.get("from_name", "ProtectionPro"),
        "from_address": cfg.get("from_address", ""), "app_url": cfg.get("app_url", ""),
        "welcome_auto": cfg.get("welcome_auto", True), "welcome_note": cfg.get("welcome_note", ""),
        "configured": get_config(db) is not None,
    }


def save_config(db, cfg: dict):
    row = _row(db)
    if row:
        row.value = json.dumps(cfg)
    else:
        db.add(AppSetting(key=_KEY, value=json.dumps(cfg)))
    db.commit()


def merged(db, data) -> dict:
    """Request model → stored dict, keeping the saved password when none sent."""
    old = load_raw(db)
    pw = data.password if data.password is not None else old.get("password", "")
    return {
        "enabled": data.enabled, "host": data.host.strip(), "port": data.port,
        "security": data.security if data.security in SECURITY else "starttls",
        "username": data.username.strip(), "password": pw,
        "from_name": data.from_name.strip() or "ProtectionPro",
        "from_address": data.from_address.strip(), "app_url": data.app_url.strip().rstrip("/"),
        "welcome_auto": data.welcome_auto, "welcome_note": data.welcome_note.strip(),
    }


def _friendly(exc: Exception, cfg: dict) -> str:
    host = f"{cfg.get('host')}:{cfg.get('port')}"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        return "The mail server rejected the username or password."
    if isinstance(exc, (socket.gaierror,)):
        return f"Couldn't find a mail server called {cfg.get('host')}. Check the server name."
    if isinstance(exc, (socket.timeout, TimeoutError, ConnectionRefusedError, OSError)) and \
            not isinstance(exc, ssl.SSLError):
        return f"Couldn't connect to {host}. Check the server name, port and security setting."
    if isinstance(exc, ssl.SSLError):
        return "The secure connection failed. Try the other security setting (STARTTLS on 587, SSL/TLS on 465)."
    if isinstance(exc, smtplib.SMTPRecipientsRefused):
        return "The mail server refused the recipient address."
    if isinstance(exc, smtplib.SMTPSenderRefused):
        return "The mail server refused the sender address — it may need to match the login."
    if isinstance(exc, smtplib.SMTPException):
        return f"The mail server reported: {str(exc)[:160]}"
    return f"Sending failed: {str(exc)[:160]}"


def send_email(cfg: dict, to: str, subject: str, text: str, html: str = None):
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = formataddr((cfg.get("from_name") or "ProtectionPro", cfg["from_address"]))
    msg["To"] = to
    msg.set_content(text)
    if html:
        msg.add_alternative(html, subtype="html")
    sec = cfg.get("security", "starttls")
    try:
        if sec == "ssl":
            smtp = smtplib.SMTP_SSL(cfg["host"], int(cfg["port"]), timeout=15,
                                    context=ssl.create_default_context())
        else:
            smtp = smtplib.SMTP(cfg["host"], int(cfg["port"]), timeout=15)
        with smtp:
            if sec == "starttls":
                smtp.starttls(context=ssl.create_default_context())
            if cfg.get("username"):
                smtp.login(cfg["username"], cfg.get("password", ""))
            smtp.send_message(msg)
    except Exception as exc:  # noqa: BLE001 — translated for the admin
        raise MailError(_friendly(exc, cfg)) from exc


# ── Messages ──

def _shell(title_html: str, body_html: str, button: str, link: str, foot: str) -> str:
    return f"""<div style="font-family:Segoe UI,Arial,sans-serif;color:#14202B;max-width:540px;margin:0 auto;padding:24px">
<div style="font-size:18px;font-weight:600;margin-bottom:16px">{title_html}</div>
<div style="font-size:15px;line-height:1.55">{body_html}</div>
<p style="margin:24px 0"><a href="{escape(link)}" style="background:#0B6E99;color:#fff;text-decoration:none;font-weight:600;padding:13px 24px;border-radius:6px;display:inline-block">{escape(button)}</a></p>
<p style="font-size:13px;color:#4A5A68;line-height:1.5">If the button doesn’t work, paste this into your browser:<br><span style="word-break:break-all">{escape(link)}</span></p>
<p style="font-size:13px;color:#4A5A68;border-top:1px solid #E1E8ED;padding-top:14px">{escape(foot)}</p></div>"""


def invite_message(inviter: str, link: str, days: int, note: str = ""):
    subject = f"{inviter} invited you to ProtectionPro"
    note_txt = f'\n"{note}"\n' if note else ""
    text = (f"{inviter} has invited you to join ProtectionPro.\n{note_txt}\n"
            f"Accept the invitation: {link}\n\n"
            f"This link works once and expires in {days} days.\n"
            "Not expecting this? Ignore it — no account is created until you accept.\n")
    note_html = (f'<p style="padding:12px 14px;background:#F3F6F8;border-radius:6px;font-style:italic">“{escape(note)}”</p>'
                 if note else "")
    html = _shell(escape(subject), f"<p>{escape(inviter)} has invited you to join the team on ProtectionPro.</p>{note_html}",
                  "Accept invitation", link,
                  f"This link works once and expires in {days} days. Not expecting this? Ignore it — no account is created until you accept.")
    return subject, text, html


def reset_message(name: str, link: str, minutes: int):
    subject = "Reset your ProtectionPro password"
    hi = f"Hi {name}," if name else "Hi,"
    text = (f"{hi}\n\nWe received a request to reset your ProtectionPro password.\n"
            f"Choose a new password: {link}\n\n"
            f"This link works once and expires in {minutes // 60 if minutes >= 60 else minutes} "
            f"{'hour' if minutes == 60 else 'minutes'}.\n"
            "Didn’t ask for this? Ignore this email — your password stays as it is.\n")
    html = _shell(escape(hi), "<p>We received a request to reset the password for your ProtectionPro account.</p>",
                  "Choose a new password", link,
                  "This link works once and expires in 1 hour. Didn’t ask for this? Ignore this email — your password stays as it is.")
    return subject, text, html


def welcome_message(name: str, email: str, link: str, note: str = ""):
    subject = "Welcome to ProtectionPro"
    hi = f"Hi {name}," if name else "Hi,"
    note_txt = f"\n{note}\n" if note else ""
    text = (f"{hi}\n\nYour ProtectionPro account is ready. Sign in with {email}.\n{note_txt}\n"
            f"Open ProtectionPro: {link}\n\n"
            "Forgot your password? Use “Forgot your password?” on the sign-in page and we’ll email you a reset link.\n")
    note_html = (f'<p style="padding:12px 14px;background:#F3F6F8;border-radius:6px;white-space:pre-line">{escape(note)}</p>'
                 if note else "")
    html = _shell(escape(subject),
                  f"<p>{escape(hi)}</p><p>Your ProtectionPro account is ready. Sign in with <b>{escape(email)}</b>.</p>{note_html}",
                  "Open ProtectionPro", link,
                  "Forgot your password? Use “Forgot your password?” on the sign-in page and we’ll email you a reset link.")
    return subject, text, html
