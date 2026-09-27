"""Verification templates reproduce their documented results.

Every Help → Templates → "Verification / Standards" project is built from a
testing/case-*/project.json and tells the user which analysis to run and what
number to expect. Those expected numbers live in one table (EXPECTED in
testing/build_verification_templates.py); this test runs each template's
project through the same analysis route the app calls and asserts the engine
still produces them, and that the shipped frontend/js/verification-templates.js
and testing/ui/verification-expected.json are exactly what the generator
renders today.

A failure here means either an engine changed a verified result (investigate
before touching the table) or the templates file is stale (regenerate it with
`python testing/build_verification_templates.py`).
"""

import importlib.util
import inspect
from pathlib import Path

import pytest
from fastapi.encoders import jsonable_encoder

from backend.routes.analysis import router

ROOT = Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location(
    "build_verification_templates", ROOT / "testing" / "build_verification_templates.py")
gen = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gen)

ROUTES = {r.path: r for r in router.routes}
CASES = {tid: (case_dir, name) for case_dir, tid, name, _preview, _desc in gen.CASES}


def _run(tid):
    """Run the template's project through its analysis route — the wrapped
    endpoint, so the changeover/off-page pre-passes apply as in the app."""
    route, _checks = gen.EXPECTED[tid]
    case_dir, name = CASES[tid]
    endpoint = ROUTES[f"/analysis/{route}"].endpoint
    body_type = inspect.signature(endpoint).parameters["data"].annotation
    return jsonable_encoder(endpoint(data=body_type(**gen.template_project(case_dir, tid, name))))


def _at(result, path):
    node = result
    for key in path.split("."):
        node = node[int(key)] if isinstance(node, list) else node[key]
    return node


def test_every_template_has_expected_values():
    assert set(gen.EXPECTED) == set(CASES)
    assert set(gen.INSTRUCTIONS) == set(CASES)


@pytest.mark.parametrize("tid", list(CASES))
def test_template_reproduces_expected(tid):
    result = _run(tid)
    for name, spec in gen.EXPECTED[tid][1].items():
        path, expected = spec[0], spec[1]
        actual = _at(result, path)
        if isinstance(expected, float):
            rel = spec[2] if len(spec) > 2 else 1e-3
            assert actual == pytest.approx(expected, rel=rel), f"{tid}.{name} ({path})"
        else:
            assert actual == expected, f"{tid}.{name} ({path})"


def test_templates_file_matches_generator():
    shipped = (ROOT / "frontend" / "js" / "verification-templates.js").read_text()
    assert shipped == gen.render(), (
        "frontend/js/verification-templates.js is stale — run "
        "`python testing/build_verification_templates.py`")


def test_ui_expected_json_matches_generator():
    """testing/ui/verification-expected.json feeds the headless-UI check the
    same EXPECTED values this module asserts."""
    shipped = (ROOT / "testing" / "ui" / "verification-expected.json").read_text()
    assert shipped == gen.render_expected(), (
        "testing/ui/verification-expected.json is stale — run "
        "`python testing/build_verification_templates.py`")
