# ProtectionPro — Open Items Fix Worklist

Source: `auditverify.md` verification of `BACKLOG.md`, 2026-07-09.
All 9 items below are confirmed present in the current source tree (`d7e095b` + fix batches). Backend tests: 62 pass. Frontend: `node --check` clean.

| # | ID | Issue | Location | Fix direction |
|---|---|---|---|---|
| 1 | C2 | ~43 native `alert()`/`confirm()`/`prompt()` sites instead of styled modals | `project.js`(16), `app.js`(8), `dbschedule.js`(5), `standard-data.js`(4), `reports.js`(4), `tcc.js`(2), `templates.js`(1), `properties.js`(1) | Replace each with the app's modal system; worst offender is `app.js:467` single-bus fault-scope chooser |
| 2 | C4 | Port click silently starts a wire in Select mode, no cursor/status feedback | `canvas.js:367-374` | Add cursor change + status-bar message when a port click begins wiring outside Wire mode (or gate it behind Wire mode) |
| 3 | C3 | No focus trap/restore on modal close; `#sld-canvas` has no `tabindex`/keyboard nav | `app.js:100-212`, `index.html:362` | Add focus trap while modal open, restore focus to trigger on close; add `tabindex` + arrow-key navigation to the SVG canvas |
| 4 | H14 | `--text-muted: #888` fails AA contrast (~3.5:1 on white) | `app.css:19` | Darken to >= `#767676` (4.54:1) or darker for AA compliance; dark-theme `#666680` is fine |
| 5 | H15 | No global analysis-busy indicator - only trigger button disables, user can keep editing mid-request | `app.js:448` (`_setBusy`) | Add a global overlay/spinner or canvas lock while any analysis is in flight |
| 6 | H16 | No desktop toast system - desktop reuses single `#status-info` line for info/success/error | `mobile.js` has `showToast`, desktop has none | Extract the toast system from `mobile.js` into a shared module and use it on desktop |
| 7 | H21 | Non-General property sections collapsed by default | `properties.js:96` | Flip the default to expanded, or expand-on-first-use; currently `: true` for all non-General collapsible sections |
| 8 | H23 | Dark-mode result-table rows unstyled - `.af-danger`/`.af-high`/etc. have no dark-theme override | `symbols.css:225-243` | Add a `.dark-mode` (or `body.dark`) override block with dark-appropriate backgrounds/badges |
| 9 | PROT-21 | Some gG fuse curve rows violate IEC 60269-1 0.1 s gates by ~2x (100 A row interpolates ~0.17 s at the 820 A gate; backend `_FUSE_CURVES_GG` is a verbatim copy) | `frontend/js/constants.js:494-512`, `backend/analysis/arcflash.py:292` | Re-fit the generic gG family to the published IEC 60269-1 0.1 s gate table (requires verified standard gate data); update both frontend and backend copies |

## Not verified this pass (deprioritized in backlog)
- H17 - toolbar IA
- H20 - branch-flow label overlap
- H22 - export entry points scattered

Flag if these should be added to the fix scope.