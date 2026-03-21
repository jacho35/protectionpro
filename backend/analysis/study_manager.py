"""Study Manager — Batch Run All Analyses.

Runs all enabled analyses (fault, load flow, arc flash, cable sizing,
motor starting, duty check) in a single call and returns a consolidated
report with per-study results, timing, and a summary.
"""

import time
import traceback
from ..models.schemas import ProjectData


# Ordered study definitions: (key, display_name, runner)
# Runners are resolved lazily to avoid circular imports.
STUDY_DEFS = [
    ("loadflow", "Load Flow"),
    ("fault", "Fault Analysis"),
    ("arcflash", "Arc Flash"),
    ("cable_sizing", "Cable Sizing"),
    ("motor_starting", "Motor Starting"),
    ("duty_check", "Equipment Duty Check"),
    ("load_diversity", "Load Diversity"),
]


def _run_single_study(key: str, project: ProjectData):
    """Run a single study by key. Returns the result dict/object."""
    if key == "loadflow":
        from .loadflow import run_load_flow
        method = project.loadFlowMethod or "newton_raphson"
        return run_load_flow(project, method)
    elif key == "fault":
        from .fault import run_fault_analysis
        return run_fault_analysis(project, fault_bus_id=None, fault_type=None)
    elif key == "arcflash":
        from .fault import run_fault_analysis
        from .arcflash import run_arc_flash
        fault_results = run_fault_analysis(project, fault_bus_id=None, fault_type=None)
        return run_arc_flash(project, fault_results)
    elif key == "cable_sizing":
        from .cable_sizing import run_cable_sizing
        return run_cable_sizing(project)
    elif key == "motor_starting":
        from .motor_starting import run_motor_starting
        return run_motor_starting(project)
    elif key == "duty_check":
        from .duty_check import run_duty_check
        return run_duty_check(project)
    elif key == "load_diversity":
        from .load_diversity import run_load_diversity
        return run_load_diversity(project)
    else:
        raise ValueError(f"Unknown study key: {key}")


def run_study_manager(project: ProjectData, enabled_studies: list[str] | None = None):
    """Run all enabled studies and return consolidated results.

    Args:
        project: The project data.
        enabled_studies: List of study keys to run. If None, runs all.
            Valid keys: loadflow, fault, arcflash, cable_sizing,
            motor_starting, duty_check.

    Returns:
        Dict with 'studies' (per-study results), 'summary', and 'total_time_s'.
    """
    all_keys = [d[0] for d in STUDY_DEFS]
    if enabled_studies is None:
        enabled_studies = all_keys
    else:
        # Filter to valid keys, preserve order from STUDY_DEFS
        enabled_studies = [k for k in all_keys if k in enabled_studies]

    studies = {}
    summary_pass = 0
    summary_warn = 0
    summary_fail = 0
    summary_errors = 0
    total_start = time.time()

    for key in enabled_studies:
        display_name = next((d[1] for d in STUDY_DEFS if d[0] == key), key)
        study_start = time.time()
        try:
            result = _run_single_study(key, project)
            elapsed = time.time() - study_start

            # Serialize pydantic models to dict
            if hasattr(result, "model_dump"):
                result_data = result.model_dump()
            elif isinstance(result, dict):
                result_data = result
            else:
                result_data = result

            # Extract summary counts from result
            study_status = _extract_study_status(key, result_data)

            studies[key] = {
                "name": display_name,
                "status": study_status["status"],
                "result": result_data,
                "time_s": round(elapsed, 3),
                "error": None,
                "counts": study_status["counts"],
            }

            if study_status["status"] == "pass":
                summary_pass += 1
            elif study_status["status"] == "warning":
                summary_warn += 1
            elif study_status["status"] == "fail":
                summary_fail += 1

        except Exception as e:
            elapsed = time.time() - study_start
            traceback.print_exc()
            studies[key] = {
                "name": display_name,
                "status": "error",
                "result": None,
                "time_s": round(elapsed, 3),
                "error": str(e),
                "counts": None,
            }
            summary_errors += 1

    total_time = time.time() - total_start

    return {
        "studies": studies,
        "summary": {
            "total": len(enabled_studies),
            "pass": summary_pass,
            "warning": summary_warn,
            "fail": summary_fail,
            "errors": summary_errors,
        },
        "total_time_s": round(total_time, 3),
    }


def _extract_study_status(key: str, result_data) -> dict:
    """Extract pass/warning/fail status and counts from a study result."""
    counts = {}

    if key == "loadflow":
        converged = result_data.get("converged", False)
        n_buses = len(result_data.get("buses", {}))
        n_warnings = len(result_data.get("warnings", []))
        counts = {"buses": n_buses, "warnings": n_warnings}
        if not converged:
            return {"status": "fail", "counts": counts}
        if n_warnings > 0:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    elif key == "fault":
        n_buses = len(result_data.get("buses", {}))
        counts = {"buses": n_buses}
        return {"status": "pass" if n_buses > 0 else "warning", "counts": counts}

    elif key == "arcflash":
        buses = result_data.get("buses", {})
        n_buses = len(buses)
        max_ppe = max((b.get("ppe_category", 0) for b in buses.values()), default=0)
        counts = {"buses": n_buses, "max_ppe_category": max_ppe}
        if max_ppe >= 4:
            return {"status": "fail", "counts": counts}
        if max_ppe >= 3:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    elif key == "cable_sizing":
        cables = result_data.get("cables", [])
        n_pass = sum(1 for c in cables if c.get("status") == "pass")
        n_warn = sum(1 for c in cables if c.get("status") == "warning")
        n_fail = sum(1 for c in cables if c.get("status") == "fail")
        counts = {"total": len(cables), "pass": n_pass, "warning": n_warn, "fail": n_fail}
        if n_fail > 0:
            return {"status": "fail", "counts": counts}
        if n_warn > 0:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    elif key == "motor_starting":
        motors = result_data.get("motors", [])
        n_pass = sum(1 for m in motors if m.get("status") == "pass")
        n_warn = sum(1 for m in motors if m.get("status") == "warning")
        n_fail = sum(1 for m in motors if m.get("status") == "fail")
        counts = {"total": len(motors), "pass": n_pass, "warning": n_warn, "fail": n_fail}
        if n_fail > 0:
            return {"status": "fail", "counts": counts}
        if n_warn > 0:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    elif key == "duty_check":
        devices = result_data.get("devices", [])
        n_pass = sum(1 for d in devices if d.get("status") == "pass")
        n_warn = sum(1 for d in devices if d.get("status") == "warning")
        n_fail = sum(1 for d in devices if d.get("status") == "fail")
        counts = {"total": len(devices), "pass": n_pass, "warning": n_warn, "fail": n_fail}
        if n_fail > 0:
            return {"status": "fail", "counts": counts}
        if n_warn > 0:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    elif key == "load_diversity":
        buses = result_data.get("buses", [])
        xfmrs = result_data.get("transformers", [])
        summary = result_data.get("summary", {})
        n_xfmr_fail = sum(1 for t in xfmrs if t.get("status") == "fail")
        n_xfmr_warn = sum(1 for t in xfmrs if t.get("status") == "warning")
        overall_df = summary.get("overall_demand_factor", 1.0)
        counts = {
            "buses_with_loads": len(buses),
            "transformers": len(xfmrs),
            "overall_demand_factor": overall_df,
        }
        if n_xfmr_fail > 0:
            return {"status": "fail", "counts": counts}
        if n_xfmr_warn > 0:
            return {"status": "warning", "counts": counts}
        return {"status": "pass", "counts": counts}

    return {"status": "pass", "counts": counts}
