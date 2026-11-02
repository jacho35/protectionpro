"""A saved project carries its Cases as plain dicts under `cases`. The
changeover / off-page expansion that every analysis route runs must leave them
alone (only a Load Flow Study Manager request has typed case snapshots there)."""
from backend.analysis.changeover import expand_changeovers
from backend.analysis.offpage import expand_offpage_links
from backend.models.schemas import ProjectData


def _project(**extra):
    return ProjectData(components=[], wires=[], **extra)


def test_saved_cases_as_dicts_pass_through_the_expansions():
    cases = [{"id": "case_1", "name": "A", "components": [{"id": "x", "type": "bus", "props": {}}], "wires": []}]
    p = _project(cases=cases)
    out = expand_offpage_links(expand_changeovers(p))
    assert out.cases == cases


def test_project_without_cases_is_unchanged():
    p = _project()
    assert expand_offpage_links(expand_changeovers(p)).components == []
