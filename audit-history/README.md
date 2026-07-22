# Audit History

Historical engineering/UX/calculation audit and review documents, archived here
to keep the repo root clean. **All findings in this folder are closed** — every
item that warranted a fix was implemented and is recorded in `BACKLOG.md`'s
`## Completed` section (search there for the finding ID, e.g. `EE-9`, `PS-1`,
`R3-3`). Nothing here should be treated as an open task list; check BACKLOG.md
for what's still outstanding.

## Reading order / authority chain

Several of these documents review and re-review the same calculation engines
in sequence. Later rounds supersede earlier ones — if a finding conflicts
between documents, **the latest round is authoritative**:

1. **`AUDIT_REPORT.md`** (2026-06-11) — first consolidated engineering/UX audit,
   three-agent review of the full application. Responses in `audit-responses.md`;
   a follow-up pass is `audit-2026-06-21.md` / `audit-2026-07-09.md`.
2. **`EE_REVIEW_FAULT_LOADFLOW.md`**, **`EE_REVIEW_ARCFLASH_CABLE_GROUNDING.md`**
   (2026-07-09) — domain-specific electrical-engineering reviews, adjudicated in
   **`EE_REVIEW_PRINCIPAL_ADJUDICATION.md`**.
3. **`EE_REVIEW_INVERTER_REACTIVE_JACOBIAN.md`** (2026-07-19) — three-stage review
   (two independent engineers + principal adjudication) of the PV-bus reactive-
   limit / Jacobian-conditioning branch.
4. **`CALC_VERIFICATION_2026-07-19.md`** — independent calculation-verification
   pass (P1/P2/P3 findings); anchored by `backend/tests/test_verification_fixes.py`
   (P1/P2) and `backend/tests/test_p3_fixes.py` (P3).
5. **Round 2 / Round 3** (2026-07-20) — the most recent and most authoritative
   review chain: `CALC_REVIEW_ROUND2_EE.md`, `CALC_REVIEW_ROUND2_PS.md`, and
   `CALC_REVIEW_ROUND2_PRINCIPAL.md` (three independent round-2 passes), settled
   by **`CALC_REVIEW_ROUND3_PRINCIPAL.md` — the final word** on every finding
   from every round above it. Anchored by `backend/tests/test_r3_fixes.py`.
6. **`REVIEW-FINDINGS-PLAN-MARKUP.md`** (2026-07-12) — separate three-pass review
   scoped specifically to the Plan Markup module (UI/UX + EE + adversarial
   dev verification), independent of the calculation-engine chain above.
7. **`auditverify.md`** — "Open Items Fix Worklist" derived from verifying `BACKLOG.md` against the source tree (2026-07-09); a 9-item confirmation list, not a fresh findings doc.

Do not act on a raw EE/PS finding without checking whether Round 3 Principal
revised or closed it.
