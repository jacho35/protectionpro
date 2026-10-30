"""Regression pins for the 2026-10 cold-eyes review of the IEC 60909 engine
(reviews/FAULT_ENGINE_COLD_REVIEW.md, findings F01–F18).

Each case is a reproduction in testing/fault-cold-review/findings.py: a
minimal network, an expected value from a hand calculation or from the
independent solver ref60909.py (no code shared with fault.py), and the engine
run. The test fails if any finding comes back.
"""
import contextlib
import io
import os
import sys

import pytest

_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "testing", "fault-cold-review")
sys.path.insert(0, os.path.abspath(_DIR))

import findings  # noqa: E402

_CASES = [(fid, title, tol, fn) for fid, title, tol, fn in findings.CHECKS]


@pytest.mark.parametrize("fid,title,tol,fn", _CASES, ids=[c[0] for c in _CASES])
def test_cold_review_finding_fixed(fid, title, tol, fn):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        errs = [e for e in fn() if e is not None]
    worst = max((abs(e) for e in errs), default=0.0)
    assert worst <= tol, f"{fid} {title}: worst error {worst:.2f} %\n{out.getvalue()}"
