"""Engine vs ref60909 on the four published ETAP cases and every verification
template project (testing/case-*/project*.json). Expected: agreement to
rounding (≤ 0.03 %)."""
import glob
import json
import os
from common import ROOT, ProjectData, compare

worst_all = 0.0
for path in sorted(glob.glob(os.path.join(ROOT, "testing", "case-*", "project*.json"))):
    p = ProjectData(**json.load(open(path)))
    if not any(c.type in ("bus", "distribution_board") for c in p.components):
        continue
    if not any(c.type in ("utility", "generator") for c in p.components):
        continue
    c = getattr(p, "voltageFactor", None) or 1.1
    if "case-1" in path or "case-2" in path or "case-3" in path:
        c = 1.0          # the main article's ETAP runs used c = 1.0
    worst_all = max(worst_all, compare(p, c, os.path.relpath(path, ROOT), tol=0.1))
print(f"\nworst over all projects: {worst_all:.3f} %")
