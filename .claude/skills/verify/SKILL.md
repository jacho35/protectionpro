---
name: verify
description: How to launch and drive ProtectionPro headlessly to verify frontend changes end-to-end.
---

# Verifying ProtectionPro changes

## Launch

Frontend-only changes need no backend — the whole editor (canvas, properties,
voltage propagation, libraries) is client-side. Serve statically:

```bash
cd frontend && python3 -m http.server 8901 &   # pick a free port; 8899 may be taken
```

Backend/analysis changes need FastAPI (`pip install -r backend/requirements.txt`,
`python -m uvicorn backend.main:app --port 8000`) — system python here lacks fastapi;
use the `protectionpro-backend` Docker image. Full-stack (backend serves frontend too):

```bash
docker run -d --rm --name pp-verify -p 8902:8000 -v "$PWD":/work -w /work \
  protectionpro-backend python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

## Drive (headless browser)

Install Playwright + chromium in the scratchpad (`npm install playwright &&
npx playwright install chromium --with-deps`). Globals available on `window`:
`AppState`, `Canvas`, `Properties`, `Components`, `VoltagePropagation`, `Wiring`.

Gotchas that cost time — do it this way:

- **Placement**: sidebar uses HTML5 drag-drop (hard to synthesize). Call
  `Canvas.placeComponent(type, screenX, screenY)` in `page.evaluate`; it returns via
  `[...AppState.components.values()].pop().id`. Placement auto-selects the new component.
- **Wiring is a drag, not two clicks**: mousedown on port A, mouse.move, mouseup on
  port B. A single click starts and immediately cancels the wire.
- **Port selectors** (non-bus components): each port renders twice — visual
  `.conn-port` circle and a transparent hit circle. Use
  `.sld-component[data-id="X"] [data-port="P"]:not(.conn-port)`. Transformer:
  `primary`/`secondary`. Cable: `from`/`to`. Sources (utility/gen/solar/wind): `out`.
  Loads: `in`. CB/switch/fuse: `top`/`bottom`.
- **Buses have NO port elements** (free-position attachments): a wire endpoint
  dropped within 30 px of the bar attaches at the nearest grid-snapped point as
  port id `at_<x>` (x = local offset from centre). To wire device→bus, drag from
  the device port to any point on the bar. To wire FROM a bus, press W first and
  drag from the bar. Legacy `top_i/bottom_i` ids still resolve and are migrated
  to `at_<x>` on project load.
- **Running analyses**: the buttons (`#btn-run-fault`, `#btn-run-loadflow`, …) are
  `.dropdown-item`s inside toolbar menus — click the `.toolbar-menu-btn` with the
  right text ("Analysis", "Studies") first, then the button. Pre-run validation may
  open a modal: click `#validation-proceed` ("Continue Anyway") when warnings exist.
- **Selecting a component**: `page.mouse.click` at
  `Canvas.worldToScreen(comp.x, comp.y)` — this now works for buses too (the bar
  has a fat hit-line and no port circles). Verify via `[...AppState.selectedIds][0]`.
- **Committing a property edit**: Playwright `fill()` + `blur()` does NOT fire the
  panel's commit path. Click the input (`clickCount: 3`), `pressSequentially(value)`,
  `press('Enter')` — the 'change' event is the commit; 'input' is a debounced
  non-committing live update.
- **Properties panel**: content lives in `#properties-content`; fields carry
  `data-field`; library selects carry `data-library` (transformer/CB use a native
  `<select data-field="standard_type">`, cables use `.searchable-select` with
  `.searchable-select-input`, `.searchable-select-hint`, `.searchable-select-option`).
  Non-General sections start **collapsed** — click `.prop-section-header.collapsed`
  to expand before interacting with fields inside (state persists across re-renders).
- **Calc modal**: "View Calculations" is `#btn-show-calc`; the rendered text goes in
  `#calc-modal-body` (NOT `#calc-info`, which is just the button's container).
- **Context menu**: right-click (`page.mouse.click(x, y, {button: 'right'})`) on a
  component/wire/canvas opens `#context-menu` with `.dropdown-item` buttons. The
  handler is on the SVG only — clicks on the sheet-tab strip, status bar, minimap,
  or properties panel do NOT open it (a "menu didn't open" check there is vacuous;
  probe within `#sld-canvas`'s bounding rect).
- **Fresh state per scenario**: use a new browser context (auto-save backup lives in
  localStorage and can restore on load).
- `node --check frontend/js/*.js` for quick syntax sanity; there are no frontend
  automated tests.
