"""Read a Relux "Simulation Results" PDF into per-room reference figures (comparison only).

parse_relux_text(pages)  pages = list of page texts (pypdf extract_text, or pdftotext)
parse_relux_pdf(data)    bytes of the PDF -> the same result

Result: { "project", "date", "rooms": { name: { luminaires, area, volume, power, wm2, mf, hLum,
          em, emin, uo, ud, ezEh, emCyl, rug, ceilEm, wallEm: [..], wallUo: [..], page } } }
Nothing here is used by the calculation; the app shows it beside its own result.
"""
import io
import re


def _norm(t: str) -> str:
    t = t.replace("\u0305", "")
    t = re.sub(r"E\s*m\b", "Em", t)
    return re.sub(r"[ \t]+", " ", t)


def _num(pat: str, s: str):
    m = re.search(pat, s)
    return float(m.group(1)) if m else None


def parse_relux_text(pages: list) -> dict:
    out = {"project": None, "date": None, "rooms": {}}
    pages = [_norm(p or "") for p in pages]
    names = []
    for t in pages:                                    # room names from the result pages
        if "Maintenance factor" in t and "Evaluation area 1" in t:
            h = re.match(r"\s*\d+ ([^\n]+)\n", t)
            if h:
                names.append(h.group(1).strip())
    counts = {}
    for t in pages:                                    # overview pages: "<room> N x Luminaires" (name and count may touch)
        for line in t.split("\n"):
            m = re.match(r"(.+?)\s*(\d+) x Luminaires\s*$", line)
            if not m:
                continue
            raw = line.strip()
            hit = [n for n in names if raw.startswith(n) and re.fullmatch(r"\s*\d+ x Luminaires", raw[len(n):])]
            counts[max(hit, key=len) if hit else m.group(1).strip()] = int(m.group(2))
    for i, t in enumerate(pages):
        if out["project"] is None:
            m = re.search(r"Project number\s*\n?[:\s]*\n?(?:[:\s]*)\n?[:\s]*(R\d+)", t) or re.search(r": (R\d{3,5})\b", t)
            if m:
                out["project"] = m.group(1)
            d = re.search(r": (\d{2}\.\d{2}\.\d{4})", t)
            if d:
                out["date"] = d.group(1)
        if "Maintenance factor" not in t or "Evaluation area 1" not in t:
            continue
        head = re.match(r"\s*\d+ ([^\n]+)\n", t)
        if not head:
            continue
        name = head.group(1).strip()
        cyl = re.search(r"\nEm (\d+) lx (\d+) lx", t)
        wall_rows = re.findall(r"\(Wall\) (\d+) lx ([\d.]+)", t)
        r = {
            "page": i + 1,
            "luminaires": counts.get(name),
            "hLum": _num(r"Height of luminaire plane ([\d.]+) m", t),
            "mf": _num(r"Maintenance factor ([\d.]+)", t),
            "power": _num(r"Total power ([\d.]+) W\n", t),
            "area": _num(r"Total power per area \(([\d.]+) m", t),
            "wm2": _num(r"\) ([\d.]+) W/m", t),
            "em": float(cyl.group(1)) if cyl else _num(r"\nEm (\d+) lx", t),
            "emCyl": float(cyl.group(2)) if cyl else None,
            "emin": _num(r"\nEmin (\d+) lx", t),
            "uo": _num(r"Emin/Em \(Uo\) ([\d.]+)", t),
            "ud": _num(r"Emin/Emax \(Ud\) ([\d.]+)", t),
            "ezEh": _num(r"Ez/Eh ([\d.]+)", t),
            "rug": _num(r"RUG \([^)]*\) <=([\d.]+)", t),
            "ceilEm": _num(r"\(Ceiling\) (\d+) lx", t),
            "wallEm": [float(a) for a, _ in wall_rows],
            "wallUo": [float(b) for _, b in wall_rows],
        }
        out["rooms"][name] = r
    return out


def parse_relux_pdf(data: bytes) -> dict:
    from pypdf import PdfReader
    try:
        rd = PdfReader(io.BytesIO(data))
        pages = [p.extract_text() or "" for p in rd.pages]
    except Exception as e:
        raise ValueError(f"Not a readable PDF: {e}")
    res = parse_relux_text(pages)
    if not res["rooms"]:
        raise ValueError("No Relux room results found in this PDF (expected 'Result overview, Evaluation area 1' pages)")
    return res
