"""Small HTTP helpers shared by the download routes."""

import re
import unicodedata
from urllib.parse import quote


def content_disposition(name, ext: str, default: str = "download") -> str:
    """`attachment` header for a user-supplied file name.

    The ASCII `filename` keeps only [A-Za-z0-9._ -] (everything else -> `_`), so quotes,
    line breaks and path separators never reach the header; `filename*` carries the
    original text percent-encoded (RFC 5987) for browsers that read it.
    """
    raw = unicodedata.normalize("NFC", str(name or "")).strip()[:100] or default
    folded = unicodedata.normalize("NFKD", raw).encode("ascii", "ignore").decode("ascii")
    safe = re.sub(r"[^A-Za-z0-9._ -]", "_", folded).strip(" .") or default
    utf8 = quote(raw.replace("\r", " ").replace("\n", " "), safe="")
    return f'attachment; filename="{safe}.{ext}"; filename*=UTF-8\'\'{utf8}.{ext}'
