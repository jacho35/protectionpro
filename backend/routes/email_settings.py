"""Admin-only email (SMTP) settings. Optional: the app works fully without it."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import mailer
from ..auth import require_admin
from ..models.database import get_db, User
from ..models.schemas import EmailConfigIn

router = APIRouter(prefix="/settings/email", tags=["settings"])


@router.get("")
def get_email(admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    return mailer.public_view(db)


@router.put("")
def put_email(data: EmailConfigIn, admin: User = Depends(require_admin),
              db: Session = Depends(get_db)):
    cfg = mailer.merged(db, data)
    if cfg["enabled"]:
        if not cfg["host"]:
            raise HTTPException(status_code=400, detail="Enter the SMTP server.")
        if not mailer.valid_address(cfg["from_address"]):
            raise HTTPException(status_code=400, detail="Enter a valid sender address.")
        if not mailer.valid_base_url(cfg["app_url"]):
            raise HTTPException(status_code=400,
                                detail="Enter the address people use to reach this server (starting http:// or https://). Emailed links are built from it.")
    mailer.save_config(db, cfg)
    return mailer.public_view(db)


@router.post("/test")
def test_email(data: EmailConfigIn, admin: User = Depends(require_admin),
               db: Session = Depends(get_db)):
    """Send a test message to the signed-in admin using the (possibly unsaved) settings."""
    cfg = mailer.merged(db, data)
    if not cfg["host"] or not mailer.valid_address(cfg["from_address"]):
        return {"ok": False, "message": "Enter the SMTP server and a valid sender address first."}
    try:
        mailer.send_email(cfg, admin.email, "ProtectionPro test email",
                          "This is a test message from ProtectionPro. Your email settings work.\n")
    except mailer.MailError as e:
        return {"ok": False, "message": str(e)}
    return {"ok": True, "message": f"Sent to {admin.email}. It should arrive within a minute."}
