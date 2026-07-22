# ProtectionPro — Responses to Audit 2026-06-21

**Re:** `audit-2026-06-21.md` (multi-agent UX / EE / senior-dev review)
**Method:** Each Critical and High finding was re-verified against current source by three independent reviewers. Verdicts below are grounded in the actual code, not the audit text. Where the audit and the code disagree, the code wins and the discrepancy is noted.

**Verdict legend:**
- **CONFIRMED** — finding is accurate as written; fix it.
- **CONFIRMED (revised)** — real issue, but the audit's severity, count, or detail is off; corrected here.
- **NUANCED** — partially correct; the underlying behaviour is intentional or the impact is narrower than stated.
- **WONTFIX/DEFER** — accept the risk for now with rationale.

---

## Critical findings

### C1 — IEEE 1584 mislabelled (2002 engine, "2018" labels) → **CONFIRMED**
Verified: `arcflash.py` header explicitly says "implements the 2002 edition, NOT IEEE 1584-2018"; the 2018 machinery (5 electrode configs, enclosure-size correction, intermediate-voltage interpolation) is absent. Meanwhile `pdf_reports.py:536`, `:703`, and `:1270` all print "IEEE 1584-2018".
**Response:** Accept. This is an engineering-integrity defect — results could be presented as 2018-compliant when they are not. **Immediate action: relabel every "2018" string to "2002"** (one-line-per-site, ~3 sites). Implementing the full 2018 model is a separate, larger piece of work to schedule, not block on. This was also raised in the 2026-06-11 audit (H1) and remains open.

### C2 — Native `alert()`/`confirm()`/`prompt()` for core flows → **CONFIRMED (revised)**
Verified, and **worse than reported: ~38 call sites, not ~13.** `app.js:377` confirmed (the OK/Cancel fault-scope chooser). Spread across `project.js` (rename/new/save-as/backup-restore/error alerts), `properties.js`, `templates.js`, `standard-data.js`.
**Response:** Accept. The blocking fault-scope `confirm()` at `app.js:377` is the worst offender (fragile semantics mid-analysis) — fix that one first. Replace the rest with the existing styled modal system as a batch. Note the higher count when scoping the work.

### C3 — No canvas keyboard nav; modals don't trap focus → **CONFIRMED (revised)**
Verified with one correction: **modals already carry `role="dialog"` + `aria-modal="true"`** (17 instances in `index.html`). What's actually missing is the *behaviour*: no focus trap, no Escape-to-close, no focus restoration on close (close handlers only set `display:none`). The SVG canvas genuinely has no `tabindex`/`role` and no keyboard operation.
**Response:** Accept, but re-scope: the cheap, high-value win is **Escape-to-close + initial-focus + focus-restore for modals** (the ARIA scaffolding is already there). Full keyboard operation of the SVG canvas is a much larger effort — treat as a separate accessibility track.

### C4 — Port-click in SELECT mode silently starts a wire → **CONFIRMED**
Verified at `canvas.js:338-346`: clicking a `[data-port]` element while `mode === SELECT` calls `Wiring.startWire()` immediately, with the status bar still reading "Select Mode" and no cursor/banner change.
**Response:** Accept. Low-effort fix with real UX payoff: on entering this implicit wire-draw, update the status bar/cursor (or require an explicit affordance). Make Escape's exit obvious.

### C5 — Revision restore doesn't clear the undo stack → **CONFIRMED (severity debated)**
Verified: `revisions.js` restore calls `AppState.fromJSON(revData)` but **not** `UndoManager.clear()`, whereas **5 other load paths do** (`project.js` new/backup-restore/import/recent/file-manager). So the inconsistency and the missing call are real — this is the same class as the previously-fixed C7, missed on the revisions path.
**Caveat from re-review:** `fromJSON()` resets state and undo apply is `_paused`-guarded, so the audit's "silent corruption" framing may overstate the immediate blast radius. But the core hazard stands: **Ctrl+Z right after a restore can walk back into the pre-restore diagram, and a save then persists the wrong state.**
**Response:** Accept — it's a genuine one-line fix (`UndoManager.clear()` in the restore path) that simply restores consistency with every other load path. No reason to leave it inconsistent. Fix it.

---

## High findings — Electrical / standards

| ID | Finding | Verdict | Response |
|---|---|---|---|
| **H1** | Single c-factor 1.10 for all voltages (`fault.py:82`); 1.05 LV data exists in `constants.js:314-318` but isn't passed through | **CONFIRMED** | Accept. Pass per-bus voltage class to the engine and select c-max per IEC 60909 Table 1 (1.05 LV +6%). ~4.8% LV overstatement today. Note: code comment already acknowledges the simplification. |
| **H2** | Reduced arcing factor 0.90 for MV (`arcflash.py:161-164`); IEEE 1584-2002 §5.5 = 0.85 all voltages | **CONFIRMED** | Accept — change MV branch to 0.85. Trivial. |
| **H3** | No PV-bus Q-limits / PV→PQ conversion (`loadflow.py:478-502`) | **CONFIRMED** | Accept, medium effort. Enforce Qmin/Qmax with PV→PQ switching. Real for over-capability machines; lower priority than the safety-side bugs. |
| **H4** | Ungrounded generator `x0=0` falls back to Z1 instead of ∞ for SLG (`fault.py:789-803`) | **CONFIRMED** | Accept. Treat `x0=0`/missing as ungrounded (Z0→∞) rather than Z0=Z1. Affects SLG magnitude. |
| **H5** | SANS max-demand misses `static_load` via `rated_mva` vs `rated_kva` key mismatch (`compliance.js:662-665`) | **CONFIRMED** | Accept — small key fix. Same class as the 2026-06-11 compliance key-mismatch bugs. |
| **H6** | Missing regression tests (LLG, motor contribution, cable sizing, grounding, duty, diversity, AFB) | **CONFIRMED** | Accept. Core suite exists and passes; extend it. Highest-leverage process item — do alongside any engine edits above. |
| **H7** | Two cable tables on different temperature bases (`cable_sizing.py` 20°C DC vs `constants.js` 90°C AC) | **NUANCED** | The two bases are **intentional and documented** (backend corrects at point of use; frontend ships hot values). Not a present bug. Keep the warning comments; add a guard/test so a future "merge" can't silently break voltage-drop. Low priority. |

---

## High findings — Software / data integrity

| ID | Finding | Verdict | Response |
|---|---|---|---|
| **H8** | `ProjectData` lacks `extra="allow"` and omits `groups`/`pages`/`activePageId`/results fields → stripped on DB save (`schemas.py:87-99`) | **CONFIRMED (revised)** | Accept. Both true: missing config *and* missing fields. The frontend `toJSON` is richer than the schema, and the DB write path round-trips through `model_dump()`. **Add `extra="allow"` (or explicitly model the fields) + a save→reload round-trip test.** JSON-export path is unaffected. |
| **H9** | Content-Disposition filename injection — `projectName` only `.replace(' ','_')` (`reports.py:71,100,120`) | **CONFIRMED** | Accept. Sanitize to a safe charset and RFC 5987-quote the filename. Practical exploit is browser-limited, but it's cheap to harden and it's pre-auth. |
| **H10** | No payload cap, no auth, no rate limit (`analysis.py`, `main.py`); `components` list uncapped | **CONFIRMED** | Accept. Add a body-size limit + `max_items` on lists now (DoS surface); auth/rate-limit tracked with the broader auth backlog item. |
| **H11** | CORS `allow_origins=["*"]` + `allow_credentials=True` (`main.py:18-24`) | **CONFIRMED** | Accept. Spec-illegal combo. Fix before auth ships — restrict origins or drop credentials. Cheap. |
| **H12** | SQLite no WAL, no `busy_timeout` (`database.py:10`) | **CONFIRMED** | Accept. Two-pragma fix; prevents `database is locked` 500s under auto-save + multi-tab. |
| **H13** | Stored project JSON returned unvalidated (`projects.py:109,171`); asymmetric with validated write path | **CONFIRMED** | Accept. Validate/normalize on read (or harden `AppState.fromJSON` against missing `type`). Pair with H8. |

> Group H9–H13 into one **deployment-hardening batch** — all small, all pre-auth defense-in-depth, as the audit recommends (action #4).

---

## High findings — UX

| ID | Finding | Verdict | Response |
|---|---|---|---|
| **H14** | `--text-muted:#888` ≈ 3.55:1 on white, below AA 4.5:1 (`app.css:19`); dark override `#666680` also weak | **CONFIRMED** | Accept. Darken the token to meet AA in both themes. One-variable fix, broad reach. |
| **H15** | No global busy indicator; only trigger button disabled (`app.js:358-361`) | **CONFIRMED** | Accept. Add a lightweight global busy state/spinner; prevent editing invalidating in-flight results. |
| **H16** | No toast system; single `#status-info` line, identical styling for info/success/error | **CONFIRMED** | Accept. Add a minimal toast with success/error styling. Pairs naturally with the C2 modal work. |
| **H17–H22** | Toolbar IA, mobile gaps, badge stacking/overlap, collapsed property sections, scattered export, etc. | **PLAUSIBLE (not individually re-verified)** | Accept in principle; these are consistent with the codebase but were not line-verified this pass. Treat as a UX-polish backlog tranche, prioritized after the Critical/High functional fixes. |
| **H23** | Dark-mode result rows `.af-danger/.af-high/...` have no dark overrides (`symbols.css:204-208`) | **CONFIRMED** | Accept. Add dark-mode row backgrounds. Same family as the 2026-06-11 dark-mode badge issue. |
| **H24** | No first-run/onboarding; blank canvas | **CONFIRMED (low)** | Accept as enhancement — empty-state hint is cheap; full tour is optional/later. |

---

## Medium / Low findings — grouped response

Spot-checked subset (all **CONFIRMED**): **M1** (κ without 1.15 meshed factor, `fault.py:1037`), **M5** (buried-cable derating uses 30°C not 20°C ref, `cable_sizing.py:554`), **M7** (arc-flash K2 hardcoded 0 → overstates energy on grounded systems, `arcflash.py:203`).

These are genuine accuracy refinements, mostly non-safety-critical or conservative-direction. **Response:** accept onto the backlog, address opportunistically when touching the relevant engine, and **cover each with a regression test at the time of fix** (ties into H6). Many overlap with the larger 2026-06-11 Medium list (M1–M43) and should be de-duplicated against it before scheduling.

---

## Recommended sequencing (our triage)

Re-ordered from the audit's list by risk-per-effort, after verification:

1. **C5** + **C1 relabel** — one-line correctness/integrity fixes. Do first.
2. **Deployment-hardening batch: H9, H10 (caps), H11, H12** — small, pre-auth, defense-in-depth.
3. **H8 + H13** — data-integrity round-trip + read-path validation, with a round-trip test.
4. **EE accuracy: H1, H2, H4, H5** — small standards corrections; **H3** medium, schedule after.
5. **C2 / C4 / H16** — native-dialog replacement, port-click feedback, toast system (one UX push).
6. **H14 / H23 / C3 (modal Escape+focus only)** — accessibility/contrast quick wins.
7. **H6 + Medium backlog** — extend the regression suite; fold in M-level fixes as engines are touched.

## Disagreements / corrections to the audit

- **C2:** ~38 dialog sites, not ~13 — scope accordingly.
- **C3:** modals already have `role="dialog"`/`aria-modal`; the gap is behaviour (Escape/trap/restore), not markup. Canvas a11y is the large piece.
- **C5:** real and worth fixing, but "silent project corruption" overstates it — `fromJSON` resets state and undo-apply is paused; the practical hazard is Ctrl+Z-after-restore + save.
- **H7:** not a bug — the differing temperature bases are intentional and documented; only add a guard against future merges.
