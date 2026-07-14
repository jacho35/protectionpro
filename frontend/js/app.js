/* ProtectionPro — Main Application Entry Point */

document.addEventListener('DOMContentLoaded', () => {
  // ─── App title (desktop + mobile header): version badge + hard refresh ───
  // A cache-busted replace forces the browser to re-fetch the app; the
  // beforeunload guard in project.js still prompts on unsaved changes.
  const hardRefresh = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('v', String(Date.now()));
    window.location.replace(url.toString());
  };
  for (const id of ['app-version', 'mobile-app-version']) {
    const el = document.getElementById(id);
    if (el) el.textContent = APP_VERSION;
  }
  for (const id of ['app-title-block', 'mobile-title-block']) {
    document.getElementById(id)?.addEventListener('click', hardRefresh);
  }

  // ─── Toolbar menu bar open/close ───
  const toolbarMenus = document.querySelectorAll('.toolbar-menu');
  window.closeAllToolbarMenus = () => toolbarMenus.forEach(m => m.classList.remove('open'));

  toolbarMenus.forEach(menu => {
    const btn = menu.querySelector('.toolbar-menu-btn');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = menu.classList.contains('open');
      window.closeAllToolbarMenus();
      if (!isOpen) menu.classList.add('open');
    });
    // Keep menu open when clicking inside it (e.g. selects)
    menu.querySelector('.toolbar-menu-panel').addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('click', () => window.closeAllToolbarMenus());

  // Initialize all modules
  Canvas.init();
  Sidebar.init();
  Wiring.init();
  Properties.init();
  Annotations.init();
  Project.init();
  updateProjectNameDisplay();
  StandardData.init();
  TCC.init();
  UndoManager.init();
  RevisionTimeline.init();
  MiniMap.init();
  ContextMenu.init();
  DBSchedule.init();
  ControlSim.init();
  Retic.init();
  if (typeof PlanMarkup !== 'undefined') PlanMarkup.init();

  // ─── Workspace switching (SLD / Reticulation / Plan) ───
  // Single authority for the three-way tab switch. Each secondary workspace
  // (Retic, Plan) keeps its own activate/deactivate body; this coordinator
  // guarantees mutual exclusion and owns the tab-button state so a third
  // workspace can't be left half-shown.
  function switchWorkspace(name) {
    const appc = document.getElementById('app-container');
    const reticWs = document.getElementById('retic-workspace');
    const planWs = document.getElementById('plan-workspace');
    // Stand down whichever secondary workspace we're leaving.
    if (typeof Retic !== 'undefined' && Retic._active && name !== 'retic') Retic.deactivate();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && name !== 'plan') PlanMarkup.deactivate();

    appc.style.display = (name === 'sld') ? '' : 'none';
    if (reticWs) reticWs.style.display = (name === 'retic') ? 'flex' : 'none';
    if (planWs) planWs.style.display = (name === 'plan') ? 'flex' : 'none';
    // Mobile: flag secondary workspaces so the phone CSS hides SLD-only chrome
    // (FABs, selection bar, Components/Analysis nav) and fits the workspace
    // between the mobile header and bottom nav.
    document.body.classList.toggle('mobile-ws-secondary', name !== 'sld');

    const tabs = { sld: 'btn-workspace-sld', retic: 'btn-workspace-retic', plan: 'btn-workspace-plan' };
    for (const [key, id] of Object.entries(tabs)) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.classList.toggle('active', key === name);
      b.setAttribute('aria-selected', key === name ? 'true' : 'false');
    }

    if (name === 'sld') { if (typeof Canvas !== 'undefined') Canvas.render(); }
    else if (name === 'retic') { Retic.activate(); }
    else if (name === 'plan' && typeof PlanMarkup !== 'undefined') { PlanMarkup.activate(); }
  }
  window.switchWorkspace = switchWorkspace;
  for (const [name, id] of [
    ['sld', 'btn-workspace-sld'],
    ['retic', 'btn-workspace-retic'],
    ['plan', 'btn-workspace-plan'],
  ]) {
    document.getElementById(id)?.addEventListener('click', () => switchWorkspace(name));
  }

  // Templates button
  document.getElementById('btn-templates').addEventListener('click', () => NetworkTemplates.show());

  // Toolbar mode buttons
  const btnSelect = document.getElementById('btn-select');
  const btnWire = document.getElementById('btn-wire');
  const btnDelete = document.getElementById('btn-delete');

  function setMode(mode) {
    AppState.mode = mode;
    btnSelect.classList.toggle('active', mode === MODE.SELECT);
    btnWire.classList.toggle('active', mode === MODE.WIRE);
    Canvas.svg.classList.toggle('wiring', mode === MODE.WIRE);
    document.getElementById('status-mode').textContent =
      mode === MODE.WIRE ? 'Wire Mode' : 'Select Mode';
  }

  // Keyboard navigation across components (used when the canvas has keyboard
  // focus). With no selection, picks the component nearest the viewport centre
  // as an entry point; with a selection, moves to the nearest component in the
  // pressed direction. Selecting also scrolls it into view and shows its props.
  function _keyboardNavigate(key) {
    const comps = [...AppState.getActivePageComponents().values()];
    if (comps.length === 0) return;
    const dirs = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const dir = dirs[key];
    const curId = [...AppState.selectedIds][0];
    const cur = curId ? AppState.components.get(curId) : null;

    let best = null;
    if (!cur) {
      // Entry point: nearest component to the visible viewport centre
      const rect = Canvas.svg.getBoundingClientRect();
      const cx = (rect.width / 2 - AppState.panX) / AppState.zoom;
      const cy = (rect.height / 2 - AppState.panY) / AppState.zoom;
      let bestDist = Infinity;
      for (const c of comps) {
        const d = (c.x - cx) ** 2 + (c.y - cy) ** 2;
        if (d < bestDist) { bestDist = d; best = c; }
      }
    } else {
      // Nearest component in the pressed direction from the current one
      let bestScore = Infinity;
      for (const c of comps) {
        if (c.id === cur.id) continue;
        const dx = c.x - cur.x, dy = c.y - cur.y;
        const along = dx * dir[0] + dy * dir[1];
        if (along <= 0) continue; // must lie in the pressed direction
        const perp = Math.abs(dx * dir[1] - dy * dir[0]);
        const score = along + perp * 2; // prefer aligned and close
        if (score < bestScore) { bestScore = score; best = c; }
      }
    }
    if (!best) return;

    AppState.selectedIds.clear();
    AppState.selectedIds.add(best.id);
    // Scroll into view if off-screen, keeping the keyboard focus on the canvas
    if (typeof Canvas.centerOnComponent === 'function') {
      Canvas.centerOnComponent(best.id, { onlyIfOffscreen: true });
    }
    Canvas.render();
    if (typeof Properties !== 'undefined') Properties.show(best.id);
    const name = best.props?.name || best.type;
    document.getElementById('status-info').textContent = `Selected ${name}.`;
  }

  btnSelect.addEventListener('click', () => setMode(MODE.SELECT));
  btnWire.addEventListener('click', () => setMode(MODE.WIRE));
  btnDelete.addEventListener('click', () => {
    AppState.deleteSelected();
    Canvas.render();
    Properties.clear();
  });

  // Undo/Redo buttons
  document.getElementById('btn-undo').addEventListener('click', () => UndoManager.undo());
  document.getElementById('btn-redo').addEventListener('click', () => UndoManager.redo());

  // Dark mode toggle
  document.getElementById('btn-dark-mode').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('protectionpro-dark-mode', isDark ? '1' : '0');
    document.getElementById('btn-dark-mode').classList.toggle('active', isDark);
    MiniMap.render();
    // Plan canvas colours come from CSS custom props — repaint on theme flip.
    if (typeof PlanEngine !== 'undefined' && PlanEngine.requestDraw) PlanEngine.requestDraw({ all: true });
  });
  // Restore dark mode preference
  if (localStorage.getItem('protectionpro-dark-mode') === '1') {
    document.body.classList.add('dark-mode');
    document.getElementById('btn-dark-mode').classList.add('active');
  }

  // Auto-save toggle
  document.getElementById('btn-auto-save').addEventListener('click', () => {
    Project.toggleAutoSave();
  });
  // Restore auto-save preference and check for local backup
  Project.restoreAutoSave();
  Project.restoreLocalBackup();

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    // While any modal is open, suspend the canvas shortcuts (Delete/Backspace,
    // arrow nudge, R rotate, V/W mode switch, Ctrl+A/C/V/X/D, Ctrl+Z/Y, zoom,
    // grouping, H). Result-modal row clicks select components on the SLD, so
    // e.g. Delete would silently remove the component behind the modal.
    // Exceptions kept live: Escape (must still close the modal, handled in the
    // switch below) and Ctrl+S (harmless save). Same open-modal probe as the
    // Escape handler.
    const modalIsOpen = [...document.querySelectorAll('.modal')]
      .some(m => m.style.display !== 'none');
    if (modalIsOpen && e.key !== 'Escape' &&
        !((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S'))) {
      return;
    }

    // While the Reticulation workspace is active the SLD canvas is hidden —
    // suspend its shortcuts so Delete/Ctrl+A/arrows can't silently edit the
    // hidden diagram. Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y map to the reticulation
    // module's own undo stack; Escape (modal close) and Ctrl+S (save, which
    // includes the reticulation data) stay live.
    if (typeof Retic !== 'undefined' && Retic._active && !modalIsOpen) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) Retic.redo(); else Retic.undo();
        return;
      }
      if (ctrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        Retic.redo();
        return;
      }
      if (e.key !== 'Escape' && !(ctrl && (e.key === 's' || e.key === 'S'))) return;
    }

    // Same treatment for the Plan Markup workspace: Ctrl+Z/Y drive its local
    // undo stack, other editing keys are handed to it, and the SLD shortcuts
    // are suspended (Escape / Ctrl+S stay live).
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && !modalIsOpen) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) PlanMarkup.redo(); else PlanMarkup.undo();
        return;
      }
      if (ctrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        PlanMarkup.redo();
        return;
      }
      if (PlanMarkup.onKeydown && PlanMarkup.onKeydown(e)) { e.preventDefault(); return; }
      if (e.key !== 'Escape' && !(ctrl && (e.key === 's' || e.key === 'S'))) return;
    }

    switch (e.key) {
      case 'v':
      case 'V':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          AppState.pasteClipboard();
          Canvas.render();
          document.getElementById('status-info').textContent =
            `Pasted ${AppState.selectedIds.size} component(s).`;
        } else {
          setMode(MODE.SELECT);
        }
        break;
      case 'w':
      case 'W':
        setMode(MODE.WIRE);
        break;
      case 'r':
      case 'R':
        if (!e.ctrlKey && !e.metaKey) {
          // Rotate selected component(s) 90° (same rotation prop the
          // properties panel edits: 0/90/180/270)
          let rotated = 0;
          for (const id of AppState.selectedIds) {
            const comp = AppState.components.get(id);
            if (comp) {
              comp.rotation = ((comp.rotation || 0) + 90) % 360;
              rotated++;
            }
          }
          if (rotated > 0) {
            AppState.dirty = true;
            UndoManager.snapshot();
            Canvas.render();
            if (Properties.currentId && AppState.selectedIds.has(Properties.currentId)) {
              Properties.show(Properties.currentId);
            }
            document.getElementById('status-info').textContent =
              `Rotated ${rotated} component(s) 90°.`;
          }
        }
        break;
      case '=':
      case '+':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          Canvas.zoomIn();
        }
        break;
      case '-':
      case '_':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          Canvas.zoomOut();
        }
        break;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight': {
        // When the SVG canvas holds keyboard focus (reached via Tab, i.e.
        // :focus-visible), arrows navigate the selection between components
        // for keyboard/screen-reader users. When focus is elsewhere (normal
        // mouse editing), arrows keep nudging the selected component(s).
        const svg = Canvas.svg;
        const kbNav = svg && typeof svg.matches === 'function' && svg.matches(':focus-visible');
        if (kbNav) {
          e.preventDefault();
          _keyboardNavigate(e.key);
          break;
        }
        if (AppState.selectedIds.size === 0) break;
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 1) * SNAP_SIZE; // 1 grid unit, Shift = 5
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        let moved = false;
        for (const id of AppState.selectedIds) {
          const comp = AppState.components.get(id);
          if (comp) {
            comp.x += dx;
            comp.y += dy;
            moved = true;
          }
        }
        if (moved) {
          AppState.dirty = true;
          UndoManager.snapshot();
          Canvas.render();
        }
        break;
      }
      case 'Delete':
      case 'Backspace':
        AppState.deleteSelected();
        Canvas.render();
        Properties.clear();
        break;
      case 'Escape': {
        window.closeAllToolbarMenus?.();
        if (typeof ContextMenu !== 'undefined') ContextMenu.close();
        // Close the topmost open modal first, before touching the selection
        const openModal = [...document.querySelectorAll('.modal')].reverse()
          .find(m => m.style.display !== 'none');
        if (openModal) {
          if (openModal.id === 'tcc-modal' && typeof TCC !== 'undefined') {
            TCC.close();
          } else if (openModal.id === 'db-modal' && typeof DBSchedule !== 'undefined') {
            DBSchedule.close(); // commits circuit edits + undo snapshot (only if changed)
          } else {
            openModal.style.display = 'none';
            // Drop the File Manager's widening class so the next use of the
            // shared calc modal doesn't render wide (it leaked via Escape)
            openModal.querySelector('.modal-content')?.classList.remove('modal-wide');
          }
          break;
        }
        if (AppState.wireStart) {
          Wiring.cancelWire();
        }
        AppState.clearSelection();
        setMode(MODE.SELECT);
        Canvas.render();
        Properties.clear();
        break;
      }
      case 's':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          Project.saveProject();
        }
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          // Only select components on the visible sheet
          for (const id of AppState.getActivePageComponents().keys()) {
            AppState.selectedIds.add(id);
          }
          Canvas.render();
        }
        break;
      case 'c':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          AppState.copySelected();
          document.getElementById('status-info').textContent =
            `Copied ${AppState.clipboard?.components.length || 0} component(s).`;
        }
        break;
      case 'x':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          AppState.copySelected();
          AppState.deleteSelected();
          Canvas.render();
          Properties.clear();
          document.getElementById('status-info').textContent = 'Cut to clipboard.';
        }
        break;
      case 'g':
      case 'G':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) {
            AppState.ungroupSelected();
            Canvas.render();
            document.getElementById('status-info').textContent = 'Ungrouped selected components.';
          } else {
            const group = AppState.createGroup();
            if (group) {
              Canvas.render();
              document.getElementById('status-info').textContent = `Created group: ${group.name}`;
            }
          }
        }
        break;
      case 'd':
        if (e.ctrlKey || e.metaKey) {
          // Duplicate selected
          e.preventDefault();
          AppState.copySelected();
          AppState.pasteClipboard();
          Canvas.render();
        }
        break;
      case 'z':
      case 'Z':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) {
            UndoManager.redo();
          } else {
            UndoManager.undo();
          }
        }
        break;
      case 'y':
      case 'Y':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          UndoManager.redo();
        }
        break;
      case 'h':
      case 'H':
        if (!e.ctrlKey && !e.metaKey) {
          const allOn = Object.values(AppState.showResultBoxes).every(Boolean);
          const newVal = !allOn;
          for (const k of Object.keys(AppState.showResultBoxes)) AppState.showResultBoxes[k] = newVal;
          if (typeof _syncResultToggleButtons === 'function') _syncResultToggleButtons();
          Canvas.render();
          document.getElementById('status-info').textContent = newVal ? 'Result boxes shown.' : 'Result boxes hidden.';
        }
        break;
    }
  });

  // ─── Analysis with validation ───
  function showValidationModal(title, errors, warnings, onProceed) {
    const modal = document.getElementById('calc-modal');
    const hasErrors = errors.length > 0;

    let html = '';
    if (errors.length > 0) {
      html += '<div class="validation-section"><div class="validation-section-title error-title">Errors (must fix)</div>';
      for (const e of errors) {
        html += `<div class="validation-item validation-error">${escHtml(e.msg)}</div>`;
      }
      html += '</div>';
    }
    if (warnings.length > 0) {
      html += '<div class="validation-section"><div class="validation-section-title warning-title">Warnings</div>';
      for (const w of warnings) {
        html += `<div class="validation-item validation-warning">${escHtml(w.msg)}</div>`;
      }
      html += '</div>';
    }

    if (!hasErrors && warnings.length > 0) {
      html += `<div style="margin-top:16px;display:flex;gap:8px;">
        <button id="validation-proceed" class="btn-primary">Continue Anyway</button>
        <button id="validation-cancel" class="btn-small">Cancel</button>
      </div>`;
    } else if (hasErrors) {
      html += `<div style="margin-top:16px;">
        <button id="validation-cancel" class="btn-small">Close</button>
      </div>`;
    }

    modal.querySelector('#calc-modal-title').textContent = title;
    modal.querySelector('#calc-modal-body').innerHTML = html;
    modal.style.display = '';

    const cancelBtn = document.getElementById('validation-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { modal.style.display = 'none'; });

    const proceedBtn = document.getElementById('validation-proceed');
    if (proceedBtn) {
      proceedBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        onProceed();
      });
    }
  }

  // Post-run load flow summary: generation dispatch table + solver warnings.
  // Shown automatically when the run is noteworthy (islanding, curtailment,
  // de-energized buses, non-convergence); reuses the calc modal shell.
  function showDispatchSummary(result) {
    const modal = document.getElementById('calc-modal');
    const dispatch = result.dispatch || [];
    const warnings = result.warnings || [];
    const roleLabel = {
      balancer: 'Balancer (slack)', dispatched: 'Dispatched',
      curtailed: 'Curtailed', offline: 'Disconnected', standby: 'Standby (idle)',
      off: 'Off (sequence)',
    };
    // Adaptive units: a 200 kW PV plant should read in kW, not 0.200 MW
    const fmtPower = (mw) => Math.abs(mw) >= 1
      ? `${mw.toFixed(2)} MW`
      : `${(mw * 1000).toFixed(0)} kW`;

    let html = '';
    if (!result.converged) {
      html += '<div class="validation-item validation-error">Load flow did NOT converge — results are unreliable.</div>';
    }
    if (warnings.length > 0) {
      html += '<div class="validation-section"><div class="validation-section-title warning-title">Warnings</div>';
      for (const w of warnings) {
        html += `<div class="validation-item validation-warning">${escHtml(w.message)}</div>`;
      }
      html += '</div>';
    }
    if (dispatch.length > 0) {
      html += `<div class="validation-section"><div class="validation-section-title">Generation Dispatch</div>
        <div style="overflow-x:auto;"><table class="library-table" style="width:100%;font-size:12px;">
        <thead><tr><th>Source</th><th>Island</th><th>Priority</th><th>Mode</th><th>Role</th>
        <th>Available</th><th>Dispatched</th><th>Curtailed</th></tr></thead><tbody>`;
      const sorted = [...dispatch].sort((a, b) => (a.island - b.island) || (a.priority - b.priority));
      for (const d of sorted) {
        const cur = d.curtailed_mw > 0
          ? `<span style="color:#f57c00;">${fmtPower(d.curtailed_mw)}</span>` : '—';
        html += `<tr>
          <td>${escHtml(d.source_name || d.source_id)}</td>
          <td>${d.island > 0 ? d.island : '—'}</td>
          <td>${d.priority}</td>
          <td>${d.role === 'balancer' ? '—' : escHtml(d.mode.replace('_', ' '))}</td>
          <td>${roleLabel[d.role] || escHtml(d.role)}</td>
          <td>${d.source_type === 'utility' && d.available_mw === 0 ? '∞' : fmtPower(d.available_mw)}</td>
          <td>${['offline', 'standby', 'off'].includes(d.role) ? '—' : fmtPower(d.dispatched_mw)}</td>
          <td>${cur}</td></tr>`;
      }
      html += '</tbody></table></div></div>';
    }
    html += `<div style="margin-top:16px;"><button id="dispatch-close" class="btn-small">Close</button></div>`;

    modal.querySelector('#calc-modal-title').textContent = 'Load Flow — Generation Dispatch';
    modal.querySelector('#calc-modal-body').innerHTML = html;
    modal.style.display = '';
    document.getElementById('dispatch-close').addEventListener('click', () => {
      modal.style.display = 'none';
    });
  }

  async function runAnalysis(type) {
    const { errors, warnings } = Components.validate();

    if (errors.length > 0 || warnings.length > 0) {
      showValidationModal(
        type === 'fault' ? 'Fault Analysis — Validation' : 'Load Flow — Validation',
        errors,
        warnings,
        () => executeAnalysis(type),
      );
      if (errors.length > 0) return; // Block if there are hard errors
      return; // Let the modal handle proceed/cancel for warnings
    }

    executeAnalysis(type);
  }

  // Hooks for UI outside this module (context menu): reuse the full
  // validation + single-bus-confirm fault flow with the bus preselected
  window.AppActions = {
    runFaultAtBus(busId) {
      AppState.select(busId);
      runAnalysis('fault');
    },
    // Reopen the full results view for the study a result box belongs to,
    // from its already-stored results (no re-run). Studies with a dedicated
    // modal reopen it; those without (fault, unbalanced LF) fall back to the
    // full detailed-calculations report, which covers every study.
    openResultBox(key) {
      const prefix = String(key).split(':')[0];
      switch (prefix) {
        case 'af':   if (AppState.arcFlashResults) showArcFlashResults(AppState.arcFlashResults); break;
        case 'cs':   if (AppState.cableSizingResults) showCableSizingResults(AppState.cableSizingResults); break;
        case 'ms':   if (AppState.motorStartingResults) showMotorStartingResults(AppState.motorStartingResults); break;
        case 'dynms': if (AppState.dynamicMotorResults && typeof DynMotor !== 'undefined') DynMotor.show(AppState.dynamicMotorResults); break;
        case 'dc':   if (AppState.dutyCheckResults) showDutyCheckResults(AppState.dutyCheckResults); break;
        case 'ld':   if (AppState.loadDiversityResults) showLoadDiversityResults(AppState.loadDiversityResults); break;
        case 'gr':   if (AppState.groundingResults) showGroundingResults(AppState.groundingResults); break;
        case 'dclf': if (AppState.dcLoadFlowResults) showDCLoadFlowResults(AppState.dcLoadFlowResults); break;
        case 'dcsc': if (AppState.dcShortCircuitResults) showDCShortCircuitResults(AppState.dcShortCircuitResults); break;
        case 'lf': case 'warn': if (AppState.loadFlowResults) showDispatchSummary(AppState.loadFlowResults); break;
        default:
          // fault, vdep, ulf, ulf-warn — no dedicated modal; open the detailed
          // calculations report (has a full worked section per study).
          document.getElementById('btn-show-calc')?.click();
      }
    },
  };

  // Disable/enable a toolbar control while its request is in flight, and drive
  // the global busy overlay so the whole canvas is locked (not just the button)
  // — prevents the user editing the network mid-request.
  function _setBusy(btnId, busy) {
    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = busy;
    let label = 'Running analysis…';
    if (busy && btn) {
      const t = (btn.getAttribute('title') || btn.getAttribute('aria-label') || btn.textContent || '').trim();
      if (t) label = `Running ${t}…`;
    }
    if (typeof UI !== 'undefined' && UI.setBusy) UI.setBusy(busy, label);
  }

  async function executeAnalysis(type) {
    const label = type === 'fault' ? 'Fault analysis' : 'Load flow';
    const triggerBtnId = type === 'fault' ? 'btn-run-fault' : 'btn-run-loadflow';

    // Resolve the fault scope BEFORE showing the busy overlay, so the spinner
    // doesn't sit behind the scope-choice dialog while we wait on the user.
    let faultBusId = null;
    if (type === 'fault' && AppState.selectedIds.size === 1) {
      const selId = [...AppState.selectedIds][0];
      const selComp = AppState.components.get(selId);
      if (selComp && selComp.type === 'bus') {
        const busName = selComp.props?.name || selId;
        if (await UI.confirm(`Run fault analysis on selected bus "${busName}" ONLY?\n\nOK = selected bus only — Cancel = all buses`,
            { title: 'Fault Analysis Scope', okText: 'Selected bus only', cancelText: 'All buses' })) {
          faultBusId = selId;
        }
      }
    }

    _setBusy(triggerBtnId, true);
    try {
      let result;
      if (type === 'fault') {
        const scopeInfo = faultBusId
          ? `bus ${AppState.components.get(faultBusId)?.props?.name || faultBusId}`
          : 'all buses';
        document.getElementById('status-info').textContent = `Running fault analysis on ${scopeInfo}...`;
        const faultType = document.getElementById('fault-type').value || null;
        result = await API.runFaultAnalysis(faultBusId, faultType);
        AppState.faultResults = result;
        AppState.faultedBusId = faultBusId;
        document.getElementById('status-info').textContent = `Fault analysis complete on ${scopeInfo}.`;
        Canvas.render();
        return;
      } else {
        document.getElementById('status-info').textContent = 'Running load flow...';
        const lfMethod = document.getElementById('loadflow-method').value;
        result = await API.runLoadFlow(lfMethod);
        AppState.loadFlowResults = result;
      }
      Canvas.render();
      if (type === 'loadflow') {
        const deadBuses = Object.values(result.buses || {}).filter(b => b.energized === false);
        const islands = new Set((result.dispatch || []).map(d => d.island).filter(i => i > 0));
        let status = result.converged
          ? `Load flow converged in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}.`
          : 'Load flow did NOT converge — results are unreliable.';
        if (islands.size > 1 || deadBuses.length > 0) {
          status += ` ${islands.size} island${islands.size === 1 ? '' : 's'}` +
            (deadBuses.length ? `, ${deadBuses.length} bus${deadBuses.length === 1 ? '' : 'es'} de-energized.` : '.');
        }
        document.getElementById('status-info').textContent = status;
        // Pop the dispatch summary when there is something worth flagging:
        // islanded operation, curtailment, de-energized buses, or warnings.
        const noteworthy = !result.converged || deadBuses.length > 0 ||
          (result.warnings || []).length > 0 ||
          (result.dispatch || []).some(d =>
            d.curtailed_mw > 0 || d.role === 'offline' ||
            (d.role === 'balancer' && d.source_type !== 'utility'));
        if (noteworthy) showDispatchSummary(result);
      } else {
        document.getElementById('status-info').textContent = `${label} complete.`;
      }
    } catch (e) {
      console.error(`${label} error:`, e);
      document.getElementById('status-info').textContent = `${label} failed.`;
      showValidationModal(`${label} — Error`, [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy(triggerBtnId, false);
    }
  }

  document.getElementById('btn-run-fault').addEventListener('click', () => runAnalysis('fault'));
  document.getElementById('btn-run-loadflow').addEventListener('click', () => runAnalysis('loadflow'));

  // Re-open the Generation Dispatch summary from the last load flow run
  document.getElementById('btn-show-dispatch').addEventListener('click', () => {
    window.closeAllToolbarMenus?.();
    if (AppState.loadFlowResults) {
      showDispatchSummary(AppState.loadFlowResults);
    } else {
      document.getElementById('status-info').textContent =
        'No load flow results yet — run a load flow first.';
    }
  });

  // Flow arrow toggle checkboxes
  document.getElementById('chk-fault-arrows').addEventListener('change', (e) => {
    AppState.showFlowArrows.fault = e.target.checked;
    Canvas.render();
  });
  document.getElementById('chk-loadflow-arrows').addEventListener('change', (e) => {
    AppState.showFlowArrows.loadflow = e.target.checked;
    Canvas.render();
  });

  // Unbalanced Load Flow
  document.getElementById('btn-run-unbalanced-loadflow').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running unbalanced load flow.';
      return;
    }
    const { errors, warnings } = Components.validate();
    if (errors.length > 0 || warnings.length > 0) {
      showValidationModal('Unbalanced Load Flow — Validation', errors, warnings, async () => {
        await _runUnbalancedLoadFlow();
      });
    } else {
      await _runUnbalancedLoadFlow();
    }
  });

  async function _runUnbalancedLoadFlow() {
    const statusEl = document.getElementById('status-info');
    statusEl.textContent = 'Running unbalanced load flow...';
    _setBusy('btn-run-unbalanced-loadflow', true);
    try {
      const lfMethod = document.getElementById('loadflow-method').value;
      const result = await API.runUnbalancedLoadFlow(lfMethod);
      AppState.unbalancedLoadFlowResults = result;
      Canvas.render();
      const vufMax = Math.max(...Object.values(result.buses).map(b => b.vuf_pct));
      const warnCount = result.warnings ? result.warnings.length : 0;
      statusEl.textContent = `Unbalanced load flow complete. Max VUF: ${vufMax.toFixed(2)}%` +
        (warnCount > 0 ? ` (${warnCount} warning${warnCount > 1 ? 's' : ''})` : '');
    } catch (e) {
      statusEl.textContent = 'Unbalanced load flow failed.';
      showValidationModal('Unbalanced Load Flow — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-run-unbalanced-loadflow', false);
    }
  }

  // Arc Flash Analysis
  document.getElementById('btn-arcflash').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running arc flash analysis.';
      return;
    }
    const { errors, warnings } = Components.validate();
    if (errors.length > 0) {
      showValidationModal('Arc Flash — Validation', errors, warnings, null);
      return;
    }
    if (warnings.length > 0) {
      showValidationModal('Arc Flash — Validation', errors, warnings, () => executeArcFlash());
      return;
    }
    executeArcFlash();
  });

  async function executeArcFlash() {
    document.getElementById('status-info').textContent = 'Running arc flash analysis (IEEE 1584-2002)...';
    _setBusy('btn-arcflash', true);
    try {
      const result = await API.runArcFlash();
      AppState.arcFlashResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Arc flash analysis complete.';
      showArcFlashResults(result);
    } catch (e) {
      console.error('Arc flash analysis error:', e);
      document.getElementById('status-info').textContent = 'Arc flash analysis failed.';
      showValidationModal('Arc Flash — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-arcflash', false);
    }
  }

  // ── DC Arc Flash Analysis ──
  document.getElementById('btn-dc-arcflash').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running DC arc flash analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running DC arc flash analysis (Stokes & Oppenlander)...';
    _setBusy('btn-dc-arcflash', true);
    try {
      const result = await API.runDCArcFlash();
      AppState.dcArcFlashResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'DC arc flash analysis complete.';
      showDCArcFlashResults(result);
    } catch (e) {
      console.error('DC arc flash analysis error:', e);
      document.getElementById('status-info').textContent = 'DC arc flash analysis failed.';
      showValidationModal('DC Arc Flash — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-dc-arcflash', false);
    }
  });

  // ── DC Load Flow ──
  document.getElementById('btn-dc-loadflow').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running DC load flow.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running DC load flow...';
    _setBusy('btn-dc-loadflow', true);
    try {
      const result = await API.runDCLoadFlow();
      AppState.dcLoadFlowResults = result;
      Canvas.render();
      const nBus = Object.keys(result.buses || {}).length;
      document.getElementById('status-info').textContent = result.converged
        ? `DC load flow complete — ${nBus} DC bus${nBus === 1 ? '' : 'es'}.`
        : 'DC load flow: no DC buses found.';
      showDCLoadFlowResults(result);
    } catch (e) {
      console.error('DC load flow error:', e);
      document.getElementById('status-info').textContent = 'DC load flow failed.';
      showValidationModal('DC Load Flow — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-dc-loadflow', false);
    }
  });

  // ── DC Short Circuit (IEC 61660-1) ──
  document.getElementById('btn-dc-shortcircuit').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running DC short circuit.';
      return;
    }
    // A single selected DC bus scopes the analysis to that bus.
    let faultBusId = null;
    const sel = [...AppState.selectedIds];
    if (sel.length === 1) {
      const c = AppState.components.get(sel[0]);
      if (c && c.type === 'bus' && String(c.props.system) === 'dc') faultBusId = sel[0];
    }
    document.getElementById('status-info').textContent = 'Running DC short circuit (IEC 61660)...';
    _setBusy('btn-dc-shortcircuit', true);
    try {
      const result = await API.runDCShortCircuit(faultBusId);
      AppState.dcShortCircuitResults = result;
      Canvas.render();
      const nBus = Object.keys(result.buses || {}).length;
      document.getElementById('status-info').textContent = result.converged
        ? `DC short circuit complete — ${nBus} DC bus${nBus === 1 ? '' : 'es'}.`
        : 'DC short circuit: no DC buses found.';
      showDCShortCircuitResults(result);
    } catch (e) {
      console.error('DC short circuit error:', e);
      document.getElementById('status-info').textContent = 'DC short circuit failed.';
      showValidationModal('DC Short Circuit — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-dc-shortcircuit', false);
    }
  });

  // ── Cable Sizing Analysis ──
  document.getElementById('btn-cable-sizing').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running cable sizing.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running cable sizing analysis...';
    _setBusy('btn-cable-sizing', true);
    try {
      const result = await API.runCableSizing();
      AppState.cableSizingResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Cable sizing analysis complete.';
      showCableSizingResults(result);
    } catch (e) {
      console.error('Cable sizing error:', e);
      document.getElementById('status-info').textContent = 'Cable sizing analysis failed.';
      showValidationModal('Cable Sizing — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-cable-sizing', false);
    }
  });

  function showCableSizingResults(result) {
    const modal = document.getElementById('cable-sizing-modal');
    const body = document.getElementById('cable-sizing-body');
    if (!modal || !body) return;

    const cables = result.cables || [];
    if (cables.length === 0) {
      body.innerHTML = '<p>No cables found in the project.</p>';
      modal.style.display = '';
      return;
    }

    const failCount = cables.filter(c => c.status === 'fail').length;
    const warnCount = cables.filter(c => c.status === 'warning').length;
    const passCount = cables.filter(c => c.status === 'pass').length;

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    if (failCount > 0) {
      html += `<div class="af-warning-item" style="color:#d32f2f;font-weight:600;margin-bottom:8px">${failCount} cable(s) FAIL sizing checks</div>`;
    }

    html += `<table class="af-table">
      <thead><tr>
        <th>Cable</th><th>From → To</th><th>Load (A)</th><th>Thermal</th>
        <th>VDrop%</th><th>Withstand</th><th>Status</th><th>Recommended</th>
      </tr></thead><tbody>`;

    for (const c of cables) {
      const rowClass = c.status === 'fail' ? 'af-danger'
        : c.status === 'warning' ? 'af-medium'
        : c.status === 'unknown' ? 'af-unknown' : 'af-low';
      const thermalIcon = c.thermal_ok ? '✓' : '✗';
      const vdropIcon = c.voltage_drop_ok ? '✓' : '✗';
      const withstandIcon = c.fault_withstand_ok ? '✓' : '✗';
      const statusBadge = c.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
        : c.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
        : c.status === 'unknown' ? '<span style="color:#9e9e9e;font-weight:600">UNKNOWN</span>'
        : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';
      html += `<tr class="${rowClass}" data-cable-id="${c.cable_id}" style="cursor:pointer">
        <td>${escHtml(c.cable_name)}</td>
        <td>${escHtml(c.from_bus)} → ${escHtml(c.to_bus)}</td>
        <td>${c.load_current_a.toFixed(1)}</td>
        <td>${thermalIcon} ${c.thermal_loading_pct.toFixed(0)}%</td>
        <td>${vdropIcon} ${c.voltage_drop_pct.toFixed(2)}%</td>
        <td>${withstandIcon}</td>
        <td>${statusBadge}</td>
        <td>${(c.status === 'warning' || c.status === 'unknown') && c.warning_reasons && c.warning_reasons.length > 0
          ? `<span style="cursor:help;border-bottom:1px dotted ${c.status === 'unknown' ? '#9e9e9e' : '#f57c00'};color:${c.status === 'unknown' ? '#9e9e9e' : '#f57c00'}" title="${c.warning_reasons.join('; ').replace(/"/g, '&quot;')}">ⓘ ${c.status === 'unknown' ? 'Needs load flow' : 'Near limits'}</span>`
          : (c.recommended_cable || '—')}</td>
      </tr>`;
      if (c.issues.length > 0) {
        html += `<tr class="${rowClass}"><td colspan="8" style="padding-left:24px;font-size:11px;color:#b71c1c">
          ${c.issues.join('<br>')}
        </td></tr>`;
      }
    }
    html += '</tbody></table>';

    body.innerHTML = html;
    modal.style.display = '';

    // Click-to-highlight cable on SLD
    body.querySelectorAll('tr[data-cable-id]').forEach(row => {
      row.addEventListener('click', () => {
        const cid = row.dataset.cableId;
        AppState.selectedIds.clear();
        AppState.selectedIds.add(cid);
        Canvas.render();
      });
    });
  }

  // ── Motor Starting Analysis ──
  document.getElementById('btn-motor-starting').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running motor starting analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running motor starting voltage dip analysis...';
    _setBusy('btn-motor-starting', true);
    try {
      const result = await API.runMotorStarting();
      AppState.motorStartingResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Motor starting analysis complete.';
      showMotorStartingResults(result);
    } catch (e) {
      console.error('Motor starting error:', e);
      document.getElementById('status-info').textContent = 'Motor starting analysis failed.';
      showValidationModal('Motor Starting — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-motor-starting', false);
    }
  });

  function showMotorStartingResults(result) {
    const modal = document.getElementById('motor-starting-modal');
    const body = document.getElementById('motor-starting-body');
    if (!modal || !body) return;

    const motors = result.motors || [];
    if (motors.length === 0) {
      body.innerHTML = '<p>No induction motors found in the project.</p>';
      if (result.warnings && result.warnings.length > 0) {
        body.innerHTML += '<div class="af-warnings">' + result.warnings.map(w => `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`).join('') + '</div>';
      }
      modal.style.display = '';
      return;
    }

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    for (const m of motors) {
      const statusClass = m.status === 'fail' ? 'af-danger' : m.status === 'warning' ? 'af-medium' : 'af-low';
      const willStartIcon = m.motor_will_start ? '<span style="color:#4caf50;font-weight:600">YES</span>' : '<span style="color:#d32f2f;font-weight:600">NO</span>';
      const statusBadge = m.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
        : m.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
        : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';

      html += `<div class="${statusClass}" style="border:1px solid #ddd;border-radius:6px;padding:12px;margin-bottom:12px">`;
      html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong>${escHtml(m.motor_name)}</strong> ${statusBadge}
      </div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px;margin-bottom:8px">
        <div>Rated: <strong>${m.rated_kw} kW</strong>${m.motor_type ? ` (${m.motor_type})` : ''}</div>
        <div>Start Current: <strong>${m.start_current_a.toFixed(0)} A</strong>${m.starting_method ? ` (${m.starting_method})` : ''}</div>
        <div>Terminal Bus: <strong>${escHtml(m.terminal_bus)}</strong></div>
        <div>Terminal V: <strong>${m.motor_terminal_voltage_pu.toFixed(3)} p.u.</strong></div>
        <div>Will Start: ${willStartIcon}</div>
        <div>Max Dip: <strong>${m.max_system_dip_pct.toFixed(1)}%</strong> at ${m.max_dip_bus}</div>
      </div>`;

      if (m.issues.length > 0) {
        html += '<div style="color:#b71c1c;font-size:11px;margin-bottom:8px">' + m.issues.join('<br>') + '</div>';
      }

      // Bus dips table (top 5 worst)
      const sortedDips = Object.entries(m.bus_dips).sort((a, b) => b[1] - a[1]).slice(0, 5);
      if (sortedDips.length > 0) {
        html += `<table class="af-table" style="font-size:11px"><thead><tr><th>Bus</th><th>Voltage Dip (%)</th></tr></thead><tbody>`;
        for (const [bus, dip] of sortedDips) {
          const dipColor = dip > 15 ? '#d32f2f' : dip > 10 ? '#f57c00' : dip > 5 ? '#fbc02d' : '#4caf50';
          html += `<tr><td>${bus}</td><td style="color:${dipColor};font-weight:600">${dip.toFixed(2)}%</td></tr>`;
        }
        html += '</tbody></table>';
      }
      html += '</div>';
    }

    body.innerHTML = html;
    modal.style.display = '';
  }

  // ── Dynamic Motor Starting (time-domain acceleration) ──
  // The button opens the start-timeline setup modal; the modal's Run button
  // triggers the simulation with the configured schedule.
  document.getElementById('btn-dynamic-motor').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running dynamic motor starting.';
      return;
    }
    DynMotor.openConfig();
  });
  document.getElementById('btn-dynmot-run').addEventListener('click', () => DynMotor.runConfigured());
  document.getElementById('btn-dynmot-cancel').addEventListener('click', () => {
    document.getElementById('dynamic-motor-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-dynmot-config').addEventListener('click', () => {
    document.getElementById('dynamic-motor-config-modal').style.display = 'none';
  });

  // ── Load Flow Study Manager ──
  document.getElementById('btn-lf-study').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running a load flow study.';
      return;
    }
    LFStudy.openManager();
  });
  document.getElementById('btn-close-lf-study').addEventListener('click', () => {
    document.getElementById('lf-study-modal').style.display = 'none';
  });
  document.getElementById('lf-study-modal').addEventListener('click', (e) => {
    if (e.target.id === 'lf-study-modal') e.target.style.display = 'none';
  });
  // Persistent case-view bar below the toolbar (shows/hides itself on cases).
  if (typeof LFStudy !== 'undefined' && LFStudy.initBar) LFStudy.initBar();

  // ── Transient Stability ──
  document.getElementById('btn-transient-stability').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running transient stability.';
      return;
    }
    Transient.openConfig();
  });
  document.getElementById('btn-stability-run').addEventListener('click', () => Transient.runConfigured());
  document.getElementById('btn-stability-cancel').addEventListener('click', () => {
    document.getElementById('stability-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-stability-config').addEventListener('click', () => {
    document.getElementById('stability-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-stability').addEventListener('click', () => {
    document.getElementById('stability-modal').style.display = 'none';
  });
  document.getElementById('stability-modal').addEventListener('click', (e) => {
    if (e.target.id === 'stability-modal') e.target.style.display = 'none';
  });
  // The setup modal deliberately does NOT close on an outside click — that would
  // discard the disturbance configuration. Use Cancel or the ✕ button.

  // ── Voltage Stability (P-V / Q-V) ──
  document.getElementById('btn-voltage-stability').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running voltage stability.';
      return;
    }
    VoltageStability.openConfig();
  });
  document.getElementById('btn-vstab-run').addEventListener('click', () => VoltageStability.runConfigured());
  document.getElementById('btn-vstab-cancel').addEventListener('click', () => {
    document.getElementById('vstab-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-vstab-config').addEventListener('click', () => {
    document.getElementById('vstab-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-vstab').addEventListener('click', () => {
    document.getElementById('vstab-modal').style.display = 'none';
  });
  document.getElementById('vstab-modal').addEventListener('click', (e) => {
    if (e.target.id === 'vstab-modal') e.target.style.display = 'none';
  });

  // ── Contingency Analysis (N-1 / N-2) ──
  document.getElementById('btn-contingency').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running contingency analysis.';
      return;
    }
    Contingency.openConfig();
  });
  document.getElementById('btn-contingency-run').addEventListener('click', () => Contingency.runConfigured());
  document.getElementById('btn-contingency-cancel').addEventListener('click', () => {
    document.getElementById('contingency-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-contingency-config').addEventListener('click', () => {
    document.getElementById('contingency-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-contingency').addEventListener('click', () => {
    document.getElementById('contingency-modal').style.display = 'none';
  });
  document.getElementById('contingency-modal').addEventListener('click', (e) => {
    if (e.target.id === 'contingency-modal') e.target.style.display = 'none';
  });

  // ── Protective Device Sequence of Operation ──
  document.getElementById('btn-sequence-op').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running a sequence-of-operation study.';
      return;
    }
    SOO.openConfig();
  });
  document.getElementById('btn-sequence-run').addEventListener('click', () => SOO.run());
  document.getElementById('btn-sequence-cancel').addEventListener('click', () => {
    document.getElementById('sequence-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-sequence-config').addEventListener('click', () => {
    document.getElementById('sequence-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-sequence').addEventListener('click', () => {
    document.getElementById('sequence-modal').style.display = 'none';
  });
  document.getElementById('sequence-modal').addEventListener('click', (e) => {
    if (e.target.id === 'sequence-modal') e.target.style.display = 'none';
  });
  // Copy-report button lives inside the (re-rendered) results body
  document.getElementById('sequence-body').addEventListener('click', (e) => {
    if (e.target.id === 'soo-copy-btn') SOO._copyReport();
  });

  // ── Equipment Duty Check ──
  document.getElementById('btn-duty-check').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running duty check.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running equipment duty check...';
    _setBusy('btn-duty-check', true);
    try {
      const result = await API.runDutyCheck();
      AppState.dutyCheckResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Equipment duty check complete.';
      showDutyCheckResults(result);
    } catch (e) {
      console.error('Duty check error:', e);
      document.getElementById('status-info').textContent = 'Duty check failed.';
      showValidationModal('Duty Check — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-duty-check', false);
    }
  });

  function showDutyCheckResults(result) {
    const modal = document.getElementById('duty-check-modal');
    const body = document.getElementById('duty-check-body');
    if (!modal || !body) return;

    const devices = result.devices || [];
    const transformers = result.transformers || [];

    if (devices.length === 0 && transformers.length === 0) {
      body.innerHTML = '<p>No circuit breakers, fuses, or transformers found in the project.</p>';
      modal.style.display = '';
      return;
    }

    const failCount = devices.filter(d => d.status === 'fail').length;
    const xfmrFailCount = transformers.filter(t => t.status === 'fail').length;
    const totalFails = failCount + xfmrFailCount;

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    if (totalFails > 0) {
      html += `<div class="af-warning-item" style="color:#d32f2f;font-weight:600;margin-bottom:8px">${totalFails} item(s) FAIL duty check — system is not adequately protected</div>`;
    }

    // ── Transformer overload table ──
    if (transformers.length > 0) {
      html += `<h4 style="margin:8px 0 4px">Transformer Loading</h4>
      <table class="af-table">
        <thead><tr>
          <th>Transformer</th><th>Bus</th><th>Rated (MVA)</th>
          <th>Load (MVA)</th><th>Loading</th><th>Status</th>
        </tr></thead><tbody>`;
      for (const t of transformers) {
        const rowClass = t.status === 'fail' ? 'af-danger' : t.status === 'warning' ? 'af-medium' : 'af-low';
        const statusBadge = t.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
          : t.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
          : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';
        html += `<tr class="${rowClass}" data-device-id="${t.device_id}" style="cursor:pointer">
          <td>${escHtml(t.device_name)}</td>
          <td>${escHtml(t.location_bus)}</td>
          <td>${t.rated_mva.toFixed(3)}</td>
          <td>${t.load_mva.toFixed(3)}</td>
          <td>${t.loading_pct.toFixed(1)}%</td>
          <td>${statusBadge}</td>
        </tr>`;
        if (t.issues.length > 0) {
          html += `<tr class="${rowClass}"><td colspan="6" style="padding-left:24px;font-size:11px;color:#b71c1c">
            ${t.issues.join('<br>')}
          </td></tr>`;
        }
      }
      html += '</tbody></table>';
    }

    // ── CB / Fuse duty table ──
    if (devices.length > 0) {
      html += `<h4 style="margin:12px 0 4px">Protective Device Duty</h4>
      <table class="af-table">
        <thead><tr>
          <th>Device</th><th>Type</th><th>Bus</th><th>Fault (kA)</th>
          <th>Rating (kA)</th><th>Utilisation</th><th>Continuous</th><th>Status</th>
        </tr></thead><tbody>`;

      for (const d of devices) {
        const rowClass = d.status === 'fail' ? 'af-danger' : d.status === 'warning' ? 'af-medium' : 'af-low';
        const statusBadge = d.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
          : d.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
          : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';
        const contIcon = d.continuous_ok ? '✓' : '✗';
        html += `<tr class="${rowClass}" data-device-id="${d.device_id}" style="cursor:pointer">
          <td>${escHtml(d.device_name)}</td>
          <td>${d.device_type.toUpperCase()}</td>
          <td>${escHtml(d.location_bus)}</td>
          <td>${d.prospective_fault_ka.toFixed(2)}</td>
          <td>${d.breaking_capacity_ka.toFixed(2)}</td>
          <td>${d.utilisation_pct.toFixed(0)}%</td>
          <td>${contIcon}</td>
          <td>${statusBadge}</td>
        </tr>`;
        if (d.issues.length > 0) {
          html += `<tr class="${rowClass}"><td colspan="8" style="padding-left:24px;font-size:11px;color:#b71c1c">
            ${d.issues.join('<br>')}
          </td></tr>`;
        }
      }
      html += '</tbody></table>';
    }

    body.innerHTML = html;
    modal.style.display = '';

    // Click-to-highlight device on SLD
    body.querySelectorAll('tr[data-device-id]').forEach(row => {
      row.addEventListener('click', () => {
        const did = row.dataset.deviceId;
        AppState.selectedIds.clear();
        AppState.selectedIds.add(did);
        Canvas.render();
      });
    });
  }

  // ── Backup Autonomy (grid outage) ──
  document.getElementById('btn-backup-study').addEventListener('click', async () => {
    const hasBackup = [...AppState.components.values()].some(c =>
      c.type === 'battery' ||
      (c.type === 'solar_pv' && c.props.inverter_type === 'hybrid'));
    if (!hasBackup) {
      document.getElementById('status-info').textContent =
        'Add a BESS or a hybrid Solar PV inverter before running the backup study.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running backup autonomy study...';
    _setBusy('btn-backup-study', true);
    try {
      const result = await API.runBackupAutonomy();
      AppState.backupResults = result;
      document.getElementById('status-info').textContent = 'Backup autonomy study complete.';
      showBackupResults(result);
    } catch (e) {
      console.error('Backup study error:', e);
      document.getElementById('status-info').textContent = 'Backup autonomy study failed.';
      showValidationModal('Backup Autonomy — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-backup-study', false);
    }
  });

  function showBackupResults(result) {
    const modal = document.getElementById('backup-modal');
    const body = document.getElementById('backup-body');
    if (!modal || !body) return;
    const islands = result.islands || [];
    const summary = result.summary || {};

    let html = `<div style="background:#7b1fa211;border:1px solid #7b1fa2;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div style="font-size:12px">Islands (utility removed): <strong>${summary.islands_total ?? islands.length}</strong></div>
      <div style="font-size:12px">Battery-backed: <strong>${summary.islands_backed ?? 0}</strong></div>
      <div style="font-size:12px">Adequate at night: <strong>${summary.islands_adequate ?? 0}</strong></div>
    </div>`;

    if (islands.length === 0) {
      html += '<p style="opacity:0.7">No islands with load or backup sources found.</p>';
    }

    const fmtH = (h) => h === null || h === undefined ? '—'
      : h >= 48 ? `${(h / 24).toFixed(1)} d` : `${h.toFixed(1)} h`;
    const badge = (ok) => ok
      ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
      : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';

    for (const isl of islands) {
      const title = isl.bus_names && isl.bus_names.length
        ? isl.bus_names.join(', ') : `Island ${isl.island}`;
      html += `<h4 style="margin:14px 0 6px;font-size:13px">Island ${isl.island} — ${escHtml(title)}</h4>`;
      if (!isl.backed_up) {
        html += `<p style="font-size:12px;color:#d32f2f;margin:4px 0">⚠ ${escHtml(isl.notes?.[0] || 'Not backed up.')} (essential load ${isl.load_kw.toFixed(1)} kW)</p>`;
        for (const n of (isl.notes || []).slice(1)) {
          html += `<p style="font-size:12px;color:#f57c00;margin:4px 0">⚠ ${escHtml(n)}</p>`;
        }
        continue;
      }
      html += `<table class="af-table"><thead><tr>
        <th>Essential Load</th><th>Inverter Cap.</th><th>Discharge Limit</th><th>PV Available</th>
        <th>Usable Energy</th><th>Autonomy (night)</th><th>Autonomy (with PV)</th>
        <th>Inverter</th><th>Power (night)</th>
      </tr></thead><tbody><tr>
        <td>${isl.load_kw.toFixed(1)} kW (${isl.load_kva.toFixed(1)} kVA)</td>
        <td>${isl.inverter_kva.toFixed(1)} kVA</td>
        <td>${isl.discharge_kw.toFixed(1)} kW</td>
        <td>${isl.pv_kw_available.toFixed(1)} kW</td>
        <td>${isl.usable_kwh.toFixed(1)} kWh</td>
        <td><strong>${fmtH(isl.autonomy_night_h)}</strong></td>
        <td><strong>${isl.autonomy_pv_h === null && isl.power_ok_pv ? '∞ (PV covers load)' : fmtH(isl.autonomy_pv_h)}</strong></td>
        <td>${badge(isl.inverter_ok)}</td>
        <td>${badge(isl.power_ok_night)}</td>
      </tr></tbody></table>`;
      if (isl.sources?.length) {
        html += `<table class="af-table" style="margin-top:6px"><thead><tr>
          <th>Backup Source</th><th>Type</th><th>Inverter (kVA)</th>
          <th>Discharge (kW)</th><th>Available (kWh)</th><th>SoC</th><th>PV Now (kW)</th>
        </tr></thead><tbody>`;
        for (const s of isl.sources) {
          html += `<tr><td>${escHtml(s.name)}</td><td>${s.type === 'hybrid_pv' ? 'Hybrid PV' : 'BESS'}</td>
            <td>${s.inverter_kva.toFixed(1)}</td><td>${s.max_discharge_kw.toFixed(1)}</td>
            <td>${s.available_kwh.toFixed(1)}</td><td>${s.soc_pct.toFixed(0)}%</td>
            <td>${s.pv_kw_now.toFixed(1)}</td></tr>`;
        }
        html += '</tbody></table>';
      }
      for (const n of (isl.notes || [])) {
        html += `<p style="font-size:12px;color:#f57c00;margin:4px 0">⚠ ${escHtml(n)}</p>`;
      }
    }
    body.innerHTML = html;
    modal.style.display = '';
  }

  function showDCLoadFlowResults(result) {
    const modal = document.getElementById('dc-loadflow-modal');
    const body = document.getElementById('dc-loadflow-body');
    if (!modal || !body) return;
    const buses = Object.values(result.buses || {});
    const branches = result.branches || [];
    const sources = result.sources || [];
    const warnings = result.warnings || [];

    let html = `<div style="background:#e6510011;border:1px solid #e65100;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div style="font-size:12px">Method: <strong>${escHtml(result.method || 'DC Nodal')}</strong></div>
      <div style="font-size:12px">DC buses: <strong>${buses.length}</strong></div>
      <div style="font-size:12px">Iterations: <strong>${result.iterations ?? 0}</strong></div>
    </div>`;

    if (buses.length === 0) {
      html += '<p style="opacity:0.7">No DC buses. Set a bus\'s <strong>System</strong> property to <strong>DC</strong> to model a DC network.</p>';
      body.innerHTML = html; modal.style.display = ''; return;
    }

    html += `<h4 style="margin:12px 0 6px;font-size:13px">Bus Voltages</h4>
      <table class="af-table"><thead><tr>
      <th>Bus</th><th>Voltage (V)</th><th>Nominal (V)</th><th>% Nominal</th><th>Deviation</th><th>Load (kW)</th><th>Status</th>
      </tr></thead><tbody>`;
    for (const b of buses) {
      const de = b.energized === false;
      const dropColor = Math.abs(b.drop_pct) > 5 ? '#d32f2f' : Math.abs(b.drop_pct) > 2 ? '#f57c00' : '#2e7d32';
      html += `<tr>
        <td>${escHtml(b.bus_name)}</td>
        <td>${de ? '—' : b.voltage_v.toFixed(1)}</td>
        <td>${b.nominal_v.toFixed(0)}</td>
        <td>${de ? '—' : (b.voltage_pu * 100).toFixed(1) + '%'}</td>
        <td style="color:${dropColor}">${de ? '—' : b.drop_pct.toFixed(2) + '%'}</td>
        <td>${b.load_kw.toFixed(2)}</td>
        <td>${de ? '<span style="color:#d32f2f;font-weight:600">DE-ENERGIZED</span>' : '<span style="color:#4caf50">OK</span>'}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    if (sources.length) {
      html += `<h4 style="margin:14px 0 6px;font-size:13px">Sources</h4>
        <table class="af-table"><thead><tr>
        <th>Source</th><th>Type</th><th>Bus</th><th>Voltage (V)</th><th>Current (A)</th><th>Power (kW)</th><th>Loading</th>
        </tr></thead><tbody>`;
      for (const s of sources) {
        const lc = s.current_limited ? '#d32f2f' : s.loading_pct > 80 ? '#f57c00' : '#2e7d32';
        html += `<tr>
          <td>${escHtml(s.source_name)}</td><td>${escHtml(s.source_type)}</td>
          <td>${escHtml((result.buses[s.bus_id] || {}).bus_name || s.bus_id)}</td>
          <td>${s.voltage_v.toFixed(1)}</td><td>${s.current_a.toFixed(1)}</td><td>${s.power_kw.toFixed(2)}</td>
          <td style="color:${lc}">${s.loading_pct.toFixed(0)}%${s.current_limited ? ' (limited)' : ''}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    if (branches.length) {
      html += `<h4 style="margin:14px 0 6px;font-size:13px">Cable Flows</h4>
        <table class="af-table"><thead><tr>
        <th>Cable</th><th>Current (A)</th><th>V-drop (V)</th><th>R loop (Ω)</th><th>Loss (kW)</th><th>Loading</th>
        </tr></thead><tbody>`;
      for (const br of branches) {
        const lc = br.loading_pct > 100 ? '#d32f2f' : br.loading_pct > 80 ? '#f57c00' : '#2e7d32';
        html += `<tr>
          <td>${escHtml(br.element_name)}</td><td>${br.current_a.toFixed(1)}</td>
          <td>${br.voltage_drop_v.toFixed(2)}</td><td>${br.resistance_ohm.toFixed(4)}</td>
          <td>${br.loss_kw.toFixed(3)}</td><td style="color:${lc}">${br.loading_pct.toFixed(0)}%</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    for (const w of warnings) {
      html += `<p style="font-size:12px;color:#f57c00;margin:4px 0">⚠ ${escHtml(w.message)}</p>`;
    }
    body.innerHTML = html;
    modal.style.display = '';
  }

  function showDCShortCircuitResults(result) {
    const modal = document.getElementById('dc-shortcircuit-modal');
    const body = document.getElementById('dc-shortcircuit-body');
    if (!modal || !body) return;
    const buses = Object.values(result.buses || {});
    const warnings = result.warnings || [];

    let html = `<div style="background:#e6510011;border:1px solid #e65100;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div style="font-size:12px">Standard: <strong>${escHtml(result.standard || 'IEC 61660-1')}</strong></div>
      <div style="font-size:12px">DC buses: <strong>${buses.length}</strong></div>
    </div>`;

    if (buses.length === 0) {
      html += '<p style="opacity:0.7">No DC buses. Set a bus\'s <strong>System</strong> property to <strong>DC</strong> to model a DC network.</p>';
      body.innerHTML = html; modal.style.display = ''; return;
    }

    html += `<table class="af-table"><thead><tr>
      <th>Bus</th><th>Nom. (V)</th><th>I<sub>k</sub> (kA)</th><th>i<sub>p</sub> (kA)</th><th>t<sub>p</sub> (ms)</th><th>τ (ms)</th><th>Sources</th>
      </tr></thead><tbody>`;
    for (const b of buses) {
      const none = !b.contributions || b.contributions.length === 0;
      html += `<tr>
        <td>${escHtml(b.bus_name)}</td><td>${b.nominal_v.toFixed(0)}</td>
        <td><strong>${b.ik_ka.toFixed(2)}</strong></td><td><strong>${b.ip_ka.toFixed(2)}</strong></td>
        <td>${b.tp_ms.toFixed(1)}</td><td>${b.time_constant_ms.toFixed(1)}</td>
        <td>${none ? '<span style="color:#d32f2f">none</span>' : b.contributions.length}</td>
      </tr>`;
    }
    html += '</tbody></table>';

    // Per-source contribution breakdown for buses that have sources.
    for (const b of buses) {
      if (!b.contributions || b.contributions.length === 0) continue;
      html += `<h4 style="margin:14px 0 6px;font-size:13px">${escHtml(b.bus_name)} — source contributions</h4>
        <table class="af-table"><thead><tr>
        <th>Source</th><th>Type</th><th>I<sub>k</sub> (kA)</th><th>i<sub>p</sub> (kA)</th><th>t<sub>p</sub> (ms)</th><th>R branch (mΩ)</th>
        </tr></thead><tbody>`;
      for (const c of b.contributions) {
        html += `<tr>
          <td>${escHtml(c.source_name)}</td><td>${escHtml(c.source_type)}</td>
          <td>${c.ik_ka.toFixed(3)}</td><td>${c.ip_ka.toFixed(3)}</td>
          <td>${c.tp_ms.toFixed(1)}</td><td>${c.r_mohm.toFixed(1)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    }

    html += `<p style="font-size:11px;opacity:0.7;margin-top:12px">IEC 61660-1 superposition. Battery: I<sub>k</sub> = 0.95·E<sub>B</sub>/R<sub>BBr</sub>, i<sub>p</sub> = E<sub>B</sub>/R<sub>BBr</sub>. Converters (rectifier / charger) treated as current-limited per IEC TR 60909-4. Capacitor and DC-motor sources are not yet modelled.</p>`;
    for (const w of warnings) {
      html += `<p style="font-size:12px;color:#f57c00;margin:4px 0">⚠ ${escHtml(w.message)}</p>`;
    }
    body.innerHTML = html;
    modal.style.display = '';
  }

  // ── Load Diversity & Demand Factor ──
  document.getElementById('btn-load-diversity').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running load diversity analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running load diversity analysis...';
    _setBusy('btn-load-diversity', true);
    try {
      const result = await API.runLoadDiversity();
      AppState.loadDiversityResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Load diversity analysis complete.';
      showLoadDiversityResults(result);
    } catch (e) {
      console.error('Load diversity error:', e);
      document.getElementById('status-info').textContent = 'Load diversity analysis failed.';
      showValidationModal('Load Diversity — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-load-diversity', false);
    }
  });

  function showLoadDiversityResults(result) {
    const modal = document.getElementById('load-diversity-modal');
    const body = document.getElementById('load-diversity-body');
    if (!modal || !body) return;

    const buses = result.buses || [];
    const xfmrs = result.transformers || [];
    const summary = result.summary || {};
    const iecFactors = result.iec_demand_factors || {};

    let html = '';

    // Summary banner
    const overallDf = summary.overall_demand_factor || 1;
    const savings = summary.total_installed_kva > 0
      ? ((1 - overallDf) * 100).toFixed(0) : 0;
    html += `<div style="background:#1565c011;border:1px solid #1565c0;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div><strong style="font-size:13px">Overall Demand Factor:</strong> <span style="font-size:16px;font-weight:700;color:#1565c0">${overallDf.toFixed(3)}</span></div>
      <div style="font-size:12px">Installed: <strong>${summary.total_installed_kva?.toFixed(0) || 0} kVA</strong> (${summary.total_installed_kw?.toFixed(0) || 0} kW)</div>
      <div style="font-size:12px">Max Demand: <strong>${summary.total_demand_kva?.toFixed(0) || 0} kVA</strong> (${summary.total_demand_kw?.toFixed(0) || 0} kW)</div>
      ${savings > 0 ? `<div style="font-size:12px;color:#4caf50">Diversity saving: <strong>${savings}%</strong></div>` : ''}
    </div>`;

    // Transformer loading section
    if (xfmrs.length > 0) {
      html += '<h4 style="margin:12px 0 8px;font-size:13px">Transformer Loading</h4>';
      html += `<table class="af-table"><thead><tr>
        <th>Transformer</th><th>Rating (kVA)</th><th>Fed Buses</th>
        <th>Installed (kVA)</th><th>Demand (kVA)</th>
        <th>Installed %</th><th>Demand %</th><th>Status</th>
      </tr></thead><tbody>`;
      for (const t of xfmrs) {
        const rowClass = t.status === 'fail' ? 'af-danger' : t.status === 'warning' ? 'af-medium' : 'af-low';
        const statusBadge = t.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
          : t.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
          : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';
        html += `<tr class="${rowClass}">
          <td>${escHtml(t.transformer_name)}</td>
          <td>${t.rated_kva.toFixed(0)}</td>
          <td>${t.fed_buses.join(', ') || '—'}</td>
          <td>${t.installed_kva.toFixed(0)}</td>
          <td>${t.demand_kva.toFixed(0)}</td>
          <td>${t.installed_loading_pct.toFixed(1)}%</td>
          <td><strong>${t.demand_loading_pct.toFixed(1)}%</strong></td>
          <td>${statusBadge}</td>
        </tr>`;
        if (t.issues.length > 0) {
          html += `<tr class="${rowClass}"><td colspan="8" style="padding-left:24px;font-size:11px;color:#b71c1c">${t.issues.join('<br>')}</td></tr>`;
        }
      }
      html += '</tbody></table>';
    }

    // Per-bus breakdown
    if (buses.length > 0) {
      html += '<h4 style="margin:16px 0 8px;font-size:13px">Bus Load Summary</h4>';
      html += `<table class="af-table"><thead><tr>
        <th>Bus</th><th>Loads</th><th>Installed (kVA)</th><th>Demand (kVA)</th>
        <th>Diversity</th><th>Diversified (kVA)</th><th>Eff. DF</th><th>Current (A)</th>
      </tr></thead><tbody>`;
      for (const b of buses) {
        html += `<tr>
          <td>${escHtml(b.bus_name)}</td>
          <td>${b.num_loads}</td>
          <td>${b.installed_kva.toFixed(0)}</td>
          <td>${b.demand_kva.toFixed(0)}</td>
          <td>${b.diversity_factor.toFixed(3)}</td>
          <td><strong>${b.diversified_demand_kva.toFixed(0)}</strong></td>
          <td>${b.effective_demand_factor.toFixed(3)}</td>
          <td>${b.demand_current_a.toFixed(1)}</td>
        </tr>`;

        // Expandable per-load detail
        if (b.loads && b.loads.length > 0) {
          html += `<tr><td colspan="8" style="padding:0 0 0 20px">
            <details style="font-size:11px"><summary style="cursor:pointer;color:var(--text-secondary)">Show ${b.loads.length} loads</summary>
            <table style="width:100%;font-size:11px;margin:4px 0"><thead><tr>
              <th style="text-align:left">Load</th><th>Type</th><th>Installed kVA</th><th>DF</th><th>Demand kVA</th><th>PF</th>
            </tr></thead><tbody>`;
          for (const l of b.loads) {
            const typeLabel = l.load_type === 'motor_induction' ? 'IM'
              : l.load_type === 'motor_synchronous' ? 'SM' : 'Load';
            html += `<tr>
              <td style="text-align:left">${escHtml(l.load_name)}</td><td>${typeLabel}</td>
              <td>${l.installed_kva.toFixed(1)}</td><td>${l.demand_factor.toFixed(2)}</td>
              <td>${l.demand_kva.toFixed(1)}</td><td>${l.power_factor.toFixed(2)}</td>
            </tr>`;
          }
          html += '</tbody></table></details></td></tr>';
        }
      }
      html += '</tbody></table>';
    }

    // IEC reference demand factors
    const iecEntries = Object.entries(iecFactors);
    if (iecEntries.length > 0) {
      html += '<h4 style="margin:16px 0 8px;font-size:13px">IEC Reference Demand Factors</h4>';
      html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px 16px;font-size:11px">';
      for (const [, info] of iecEntries) {
        html += `<div><strong>${info.factor.toFixed(1)}</strong> — ${info.description}</div>`;
      }
      html += '</div>';
    }

    body.innerHTML = html;
    modal.style.display = '';
  }

  // ── Grounding System Analysis (IEEE 80) ──
  document.getElementById('btn-grounding').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running grounding analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running grounding system analysis (IEEE 80)...';
    _setBusy('btn-grounding', true);
    try {
      const result = await API.runGroundingAnalysis();
      AppState.groundingResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Grounding analysis complete.';
      showGroundingResults(result);
    } catch (e) {
      console.error('Grounding analysis error:', e);
      document.getElementById('status-info').textContent = 'Grounding analysis failed.';
      showValidationModal('Grounding — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-grounding', false);
    }
  });

  // ── Harmonic Analysis (IEEE 519) ──
  document.getElementById('btn-harmonics').addEventListener('click', async () => {
    window.closeAllToolbarMenus?.();
    const hasVfd = [...AppState.components.values()].some(c => c.type === 'vfd');
    if (!hasVfd) {
      showValidationModal('Harmonic Analysis',
        [], [{ msg: 'Add a Variable Frequency Drive (VFD) — the harmonic study needs at least one harmonic current source.' }], null);
      return;
    }
    document.getElementById('status-info').textContent = 'Running harmonic analysis (IEEE 519)...';
    _setBusy('btn-harmonics', true);
    try {
      const result = await API.runHarmonics(document.getElementById('loadflow-method')?.value || 'newton_raphson');
      AppState.harmonicsResults = result;
      document.getElementById('status-info').textContent =
        result.compliant ? 'Harmonic analysis complete — IEEE 519 compliant.'
                          : 'Harmonic analysis complete — IEEE 519 limits exceeded.';
      showHarmonicsResults(result);
    } catch (e) {
      console.error('Harmonic analysis error:', e);
      document.getElementById('status-info').textContent = 'Harmonic analysis failed.';
      showValidationModal('Harmonics — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-harmonics', false);
    }
  });

  function showHarmonicsResults(result) {
    const modal = document.getElementById('harmonics-modal');
    const body = document.getElementById('harmonics-body');
    if (!modal || !body) return;
    const ok = (v) => v ? '<span style="color:#4caf50">✓ PASS</span>' : '<span style="color:#d32f2f">✗ FAIL</span>';
    let html = '';

    if (result.note) { body.innerHTML = `<p>${escHtml(result.note)}</p>`; modal.style.display = ''; return; }

    // Banner
    const bColor = result.compliant ? '#4caf50' : '#d32f2f';
    html += `<div style="background:${bColor}11;border:1px solid ${bColor};border-radius:6px;padding:10px 14px;margin-bottom:14px">
      <strong style="color:${bColor}">${result.compliant ? 'IEEE 519-2014 compliant' : 'IEEE 519-2014 limits exceeded'}</strong>
      <span style="margin-left:12px">Worst bus THD<sub>V</sub>: <strong>${result.worst_thd_pct}%</strong> at ${escHtml(result.worst_bus_name || '—')}</span>
      <span style="margin-left:12px;color:var(--text-secondary)">Orders analysed: ${(result.orders || []).join(', ')}</span>
    </div>`;

    if (result.warnings && result.warnings.length) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    // PCC current TDD
    const pcc = result.pcc;
    if (pcc) {
      html += `<h4 style="margin:14px 0 6px">Point of Common Coupling — Current Distortion</h4>
        <div style="border:1px solid var(--border-color);border-radius:6px;padding:12px 14px;margin-bottom:6px;border-left:4px solid ${pcc.compliant ? '#4caf50' : '#d32f2f'}">
          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px 16px;font-size:12px">
            <div>PCC bus: <strong>${escHtml(pcc.name)} (${pcc.voltage_kv} kV)</strong></div>
            <div>I<sub>SC</sub>/I<sub>L</sub>: <strong>${pcc.isc_il}</strong></div>
            <div>Current TDD: <strong>${pcc.i_tdd_pct}%</strong></div>
            <div>Limit / verdict: <strong>${pcc.tdd_limit_pct}%</strong> ${ok(pcc.compliant)}</div>
          </div>
        </div>`;
    }

    // Per-bus voltage THD table
    html += `<h4 style="margin:14px 0 6px">Bus Voltage Distortion</h4>
      <table class="data-table" style="width:100%;font-size:12px"><thead><tr>
      <th style="text-align:left">Bus</th><th>kV</th><th>THD<sub>V</sub> %</th><th>Limit %</th>
      <th>Max IHD %</th><th>IHD limit %</th><th>Verdict</th></tr></thead><tbody>`;
    for (const b of (result.buses || [])) {
      const c = b.compliant ? '' : 'background:#d32f2f11';
      html += `<tr style="${c}"><td style="text-align:left">${escHtml(b.name)}</td>
        <td style="text-align:center">${b.voltage_kv}</td>
        <td style="text-align:center"><strong>${b.thd_v_pct}</strong></td>
        <td style="text-align:center">${b.thd_limit_pct}</td>
        <td style="text-align:center">${b.max_ihd_pct}</td>
        <td style="text-align:center">${b.ihd_limit_pct}</td>
        <td style="text-align:center">${ok(b.compliant)}</td></tr>`;
    }
    html += '</tbody></table>';

    // VFD sources
    if ((result.vfd_sources || []).length) {
      html += `<h4 style="margin:16px 0 6px">Harmonic Sources (VFDs)</h4>`;
      for (const v of result.vfd_sources) {
        const spec = Object.entries(v.spectrum).map(([h, r]) => `h${h}: ${(r * 100).toFixed(1)}%`).join('  ');
        html += `<div style="border:1px solid var(--border-color);border-radius:6px;padding:10px 14px;margin-bottom:8px">
          <strong>${escHtml(v.name)}</strong> — ${v.pulse_number}-pulse ${escHtml(v.front_end)}, ${v.p_mw} MW, current THD ${v.current_thd_pct}%
          <div style="font-size:11px;color:var(--text-secondary);margin-top:4px">I<sub>h</sub>/I<sub>1</sub>: ${spec}</div>
        </div>`;
      }
    }

    html += `<p style="font-size:11px;color:var(--text-secondary);margin-top:12px">${escHtml(result.method)}. `
      + `Multiple sources of the same order summed in phase (conservative). Transformer/line tap ratios not applied at harmonic frequencies.</p>`;

    body.innerHTML = html;
    modal.style.display = '';
  }

  function showGroundingResults(result) {
    const modal = document.getElementById('grounding-modal');
    const body = document.getElementById('grounding-body');
    if (!modal || !body) return;

    const buses = result.buses || [];
    const summary = result.summary || {};

    let html = '';

    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    if (buses.length === 0) {
      body.innerHTML = html + '<p>No buses with fault data available for grounding analysis.</p>';
      modal.style.display = '';
      return;
    }

    // Summary banner
    const failCount = summary.fail || 0;
    const warnCount = summary.warning || 0;
    const bannerColor = failCount > 0 ? '#d32f2f' : warnCount > 0 ? '#f57c00' : '#4caf50';
    html += `<div style="background:${bannerColor}11;border:1px solid ${bannerColor};border-radius:6px;padding:10px 14px;margin-bottom:14px">
      <strong style="color:${bannerColor}">${summary.total} buses analysed:</strong>
      <span style="color:#4caf50;margin-left:8px">${summary.pass} Pass</span>
      <span style="color:#f57c00;margin-left:8px">${warnCount} Warn</span>
      <span style="color:#d32f2f;margin-left:8px">${failCount} Fail</span>
      ${failCount > 0 ? '<span style="color:#d32f2f;margin-left:16px;font-weight:600">— Touch/step voltage limits exceeded</span>' : ''}
    </div>`;

    // Per-bus results
    for (const b of buses) {
      const statusColor = b.status === 'fail' ? '#d32f2f' : b.status === 'warning' ? '#f57c00' : '#4caf50';
      const statusLabel = b.status.toUpperCase();
      const touchIcon = b.touch_ok ? '<span style="color:#4caf50">✓</span>' : '<span style="color:#d32f2f">✗</span>';
      const stepIcon = b.step_ok ? '<span style="color:#4caf50">✓</span>' : '<span style="color:#d32f2f">✗</span>';

      html += `<div style="border:1px solid var(--border-color);border-radius:6px;padding:12px 14px;margin-bottom:10px;border-left:4px solid ${statusColor}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <strong style="font-size:13px">${escHtml(b.bus_name)} (${b.voltage_kv} kV)</strong>
          <span style="color:${statusColor};font-weight:600;font-size:12px">${statusLabel}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px 16px;font-size:12px">
          <div>Grid: <strong>${b.grid_dimensions}</strong></div>
          <div>Soil: <strong>${b.soil_resistivity} Ω·m</strong></div>
          <div>Fault: <strong>${b.fault_current_ka} kA</strong></div>
          <div>R<sub>grid</sub>: <strong>${b.grid_resistance_ohm.toFixed(3)} Ω</strong></div>
          <div>GPR: <strong>${b.gpr_v.toFixed(0)} V</strong></div>
          <div>Conductor: <strong>${b.recommended_conductor_mm2} mm²</strong></div>
          <div>Rods: <strong>${b.num_ground_rods}</strong></div>
          <div>L<sub>total</sub>: <strong>${b.total_conductor_length_m} m</strong></div>
        </div>
        <div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="background:var(--bg-secondary);border-radius:4px;padding:8px;font-size:12px">
            <div style="margin-bottom:4px"><strong>Touch Voltage</strong> ${touchIcon}</div>
            <div>Actual: <strong>${b.mesh_voltage_v.toFixed(0)} V</strong></div>
            <div>Limit: <strong>${b.tolerable_touch_v.toFixed(0)} V</strong></div>
          </div>
          <div style="background:var(--bg-secondary);border-radius:4px;padding:8px;font-size:12px">
            <div style="margin-bottom:4px"><strong>Step Voltage</strong> ${stepIcon}</div>
            <div>Actual: <strong>${b.step_voltage_v.toFixed(0)} V</strong></div>
            <div>Limit: <strong>${b.tolerable_step_v.toFixed(0)} V</strong></div>
          </div>
        </div>`;

      if (b.issues.length > 0) {
        html += `<div style="margin-top:6px;font-size:11px;color:#b71c1c">${b.issues.join('<br>')}</div>`;
      }
      html += '</div>';
    }

    body.innerHTML = html;
    modal.style.display = '';
  }

  // ── Lightning Risk Assessment (IEC 62305-2) ──
  const LR_FIELDS = {
    length_m: ['lr-length', 'num'], width_m: ['lr-width', 'num'],
    height_m: ['lr-height', 'num'], ground_flash_density: ['lr-ng', 'num'],
    location: ['lr-location', 'str'], structure_use: ['lr-use', 'str'],
    hazard_level: ['lr-hazard', 'str'], floor_type: ['lr-floor', 'str'],
    fire_risk: ['lr-fire-risk', 'str'], fire_protection: ['lr-fire-prot', 'str'],
    lps_class: ['lr-lps', 'str'], spd_level: ['lr-spd', 'str'],
    persons_in_zone: ['lr-persons', 'num'], hours_per_year: ['lr-hours', 'num'],
    equipment_withstand_kv: ['lr-uw', 'num'], explosion_risk: ['lr-explosion', 'bool'],
  };

  function collectLightningParams() {
    const p = {};
    for (const [key, [id, kind]] of Object.entries(LR_FIELDS)) {
      const el = document.getElementById(id);
      p[key] = kind === 'num' ? parseFloat(el.value) || 0
             : kind === 'bool' ? el.checked : el.value;
    }
    p.persons_total = p.persons_in_zone;  // single-zone assessment
    p.lines = [];
    if (document.getElementById('lr-line1-en').checked) {
      p.lines.push({
        name: 'Power supply', type: 'power',
        length_m: parseFloat(document.getElementById('lr-line1-len').value) || 1000,
        installation: document.getElementById('lr-line1-inst').value,
        environment: document.getElementById('lr-line1-env').value,
        has_transformer: document.getElementById('lr-line1-tx').checked,
        shielded: false,
      });
    }
    if (document.getElementById('lr-line2-en').checked) {
      p.lines.push({
        name: 'Telecom', type: 'telecom',
        length_m: parseFloat(document.getElementById('lr-line2-len').value) || 1000,
        installation: document.getElementById('lr-line2-inst').value,
        environment: document.getElementById('lr-line2-env').value,
        has_transformer: false,
        shielded: document.getElementById('lr-line2-shield').checked,
      });
    }
    return p;
  }

  function restoreLightningParams(p) {
    if (!p) return;
    for (const [key, [id, kind]] of Object.entries(LR_FIELDS)) {
      const el = document.getElementById(id);
      if (p[key] === undefined) continue;
      if (kind === 'bool') el.checked = !!p[key];
      else el.value = p[key];
    }
    const power = (p.lines || []).find(l => l.type === 'power');
    const telecom = (p.lines || []).find(l => l.type === 'telecom');
    document.getElementById('lr-line1-en').checked = !!power;
    if (power) {
      document.getElementById('lr-line1-len').value = power.length_m;
      document.getElementById('lr-line1-inst').value = power.installation;
      document.getElementById('lr-line1-env').value = power.environment;
      document.getElementById('lr-line1-tx').checked = !!power.has_transformer;
    }
    document.getElementById('lr-line2-en').checked = !!telecom;
    if (telecom) {
      document.getElementById('lr-line2-len').value = telecom.length_m;
      document.getElementById('lr-line2-inst').value = telecom.installation;
      document.getElementById('lr-line2-env').value = telecom.environment;
      document.getElementById('lr-line2-shield').checked = !!telecom.shielded;
    }
  }

  document.getElementById('btn-lightning').addEventListener('click', () => {
    restoreLightningParams(AppState.lightningRisk);
    document.getElementById('lightning-results').innerHTML = '';
    document.getElementById('lightning-modal').style.display = '';
  });

  document.getElementById('btn-run-lightning').addEventListener('click', async () => {
    const params = collectLightningParams();
    AppState.lightningRisk = params;  // persist inputs with the project
    const out = document.getElementById('lightning-results');
    out.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Assessing…</p>';
    _setBusy('btn-run-lightning', true);
    try {
      const res = await API.runLightningRisk(params);
      renderLightningResults(res, out);
      document.getElementById('status-info').textContent = 'Lightning risk assessment complete.';
    } catch (e) {
      console.error('Lightning risk error:', e);
      out.innerHTML = `<div class="af-warning-item">⚠ ${escHtml(e.message || 'Assessment failed')}</div>`;
    } finally {
      _setBusy('btn-run-lightning', false);
    }
  });

  function renderLightningResults(res, out) {
    const fmtR = v => v === 0 ? '0' : (v * 1e5).toFixed(3);  // in units of 1e-5/yr
    const color = res.compliant ? '#4caf50' : '#d32f2f';
    let html = '';
    for (const w of res.warnings || []) {
      html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
    }
    html += `<div style="background:${color}11;border:1px solid ${color};border-radius:6px;padding:10px 14px;margin:10px 0">
      <strong style="color:${color}">R1 = ${fmtR(res.r1)} ×10⁻⁵ /yr — ${res.compliant ? 'TOLERABLE' : 'EXCEEDS'} R_T = 1.0 ×10⁻⁵ /yr</strong>
      <div style="font-size:12px;margin-top:4px">${escHtml(res.recommendation)}</div>
    </div>`;
    html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px 16px;font-size:12px;margin-bottom:12px">
      <div>A<sub>D</sub>: <strong>${res.collection_area_m2.toLocaleString()} m²</strong></div>
      <div>A<sub>M</sub>: <strong>${Math.round(res.collection_area_near_m2).toLocaleString()} m²</strong></div>
      <div>N<sub>D</sub>: <strong>${res.flashes_to_structure_per_year.toExponential(2)} /yr</strong></div>
      <div>N<sub>M</sub>: <strong>${res.flashes_near_structure_per_year.toFixed(3)} /yr</strong></div>
    </div>`;
    // Component breakdown
    html += '<table class="result-table" style="width:100%;font-size:12px;margin-bottom:12px"><thead><tr><th>Component</th><th>Description</th><th style="text-align:right">×10⁻⁵ /yr</th><th style="width:30%">Share</th></tr></thead><tbody>';
    for (const c of res.components) {
      if (c.value === 0 && !res.systems_life_risk && ['RC', 'RM', 'RW', 'RZ'].includes(c.code)) continue;
      html += `<tr><td><strong>${c.code}</strong></td><td>${escHtml(c.description)}</td>
        <td style="text-align:right">${fmtR(c.value)}</td>
        <td><div style="background:var(--accent);height:8px;border-radius:4px;width:${Math.max(1, c.share_pct).toFixed(1)}%;opacity:0.7"></div></td></tr>`;
    }
    html += '</tbody></table>';
    // Protection ladder
    html += '<table class="result-table" style="width:100%;font-size:12px"><thead><tr><th>Protection measures</th><th style="text-align:right">R1 (×10⁻⁵ /yr)</th><th>Meets R_T</th></tr></thead><tbody>';
    for (const o of res.options) {
      html += `<tr><td>${escHtml(o.label)}</td><td style="text-align:right">${fmtR(o.r1)}</td>
        <td>${o.compliant ? '<span style="color:#4caf50">✓</span>' : '<span style="color:#d32f2f">✗</span>'}</td></tr>`;
    }
    html += '</tbody></table>';
    html += '<p style="font-size:11px;color:var(--text-secondary);margin-top:8px">Single-zone assessment per IEC 62305-2 Ed. 2. R_C/R_M/R_W/R_Z included only where internal-system failure endangers life (hospitals, explosion risk). No spatial-shielding credit (K_S1 = K_S2 = 1).</p>';
    out.innerHTML = html;
  }

  // ── Raceway / Conduit Fill ──
  const CONDUIT_SIZES = [20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160];
  let _racewaySeq = 1;

  function projectCables() {
    return [...AppState.components.values()].filter(c => c.type === 'cable');
  }

  function renderRacewayEditor() {
    const list = document.getElementById('raceway-list');
    const cables = projectCables();
    if (AppState.raceways.length === 0) {
      list.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">No raceways defined — add one below.</p>';
      return;
    }
    let html = '';
    for (const rw of AppState.raceways) {
      const opts = CONDUIT_SIZES.map(s =>
        `<option value="${s}" ${rw.nominal_mm === s ? 'selected' : ''}>${s} mm</option>`).join('');
      const cableChecks = cables.length === 0
        ? '<span style="color:var(--text-secondary)">No cables in project</span>'
        : cables.map(c => `
          <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
            <input type="checkbox" data-rw="${rw.id}" data-cable="${c.id}"
              ${rw.cableIds.includes(c.id) ? 'checked' : ''} style="width:auto">
            ${escHtml(c.props.name || c.id)}${c.props.num_parallel > 1 ? ` (×${c.props.num_parallel})` : ''}
          </label>`).join('');
      html += `<div style="border:1px solid var(--border-color);border-radius:6px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;gap:12px;align-items:center;margin-bottom:8px;font-size:12px">
          <input type="text" data-rw-name="${rw.id}" value="${escHtml(rw.name)}" style="width:140px">
          <label>Conduit <select data-rw-nominal="${rw.id}">${opts}</select></label>
          <label title="Override internal diameter (0 = typical for nominal size)">ID (mm)
            <input type="number" data-rw-id-mm="${rw.id}" value="${rw.custom_id_mm || ''}" placeholder="auto" style="width:70px" min="0" step="0.1"></label>
          <button class="btn" data-rw-del="${rw.id}" style="margin-left:auto;color:#d32f2f">Delete</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:4px 12px">${cableChecks}</div>
      </div>`;
    }
    list.innerHTML = html;

    list.querySelectorAll('[data-rw-name]').forEach(el => el.addEventListener('change', () => {
      const rw = AppState.raceways.find(r => r.id === el.dataset.rwName);
      if (rw) rw.name = el.value;
    }));
    list.querySelectorAll('[data-rw-nominal]').forEach(el => el.addEventListener('change', () => {
      const rw = AppState.raceways.find(r => r.id === el.dataset.rwNominal);
      if (rw) rw.nominal_mm = parseFloat(el.value);
    }));
    list.querySelectorAll('[data-rw-id-mm]').forEach(el => el.addEventListener('change', () => {
      const rw = AppState.raceways.find(r => r.id === el.dataset.rwIdMm);
      if (rw) rw.custom_id_mm = parseFloat(el.value) || 0;
    }));
    list.querySelectorAll('[data-rw-del]').forEach(el => el.addEventListener('click', () => {
      AppState.raceways = AppState.raceways.filter(r => r.id !== el.dataset.rwDel);
      renderRacewayEditor();
    }));
    list.querySelectorAll('input[data-cable]').forEach(el => el.addEventListener('change', () => {
      const rw = AppState.raceways.find(r => r.id === el.dataset.rw);
      if (!rw) return;
      if (el.checked) {
        if (!rw.cableIds.includes(el.dataset.cable)) rw.cableIds.push(el.dataset.cable);
      } else {
        rw.cableIds = rw.cableIds.filter(id => id !== el.dataset.cable);
      }
    }));
  }

  document.getElementById('btn-raceway').addEventListener('click', () => {
    // Rebase the id sequence past any loaded raceways
    _racewaySeq = Math.max(_racewaySeq,
      ...AppState.raceways.map(r => (parseInt(String(r.id).replace('rw_', '')) || 0) + 1), 1);
    document.getElementById('raceway-results').innerHTML = '';
    renderRacewayEditor();
    document.getElementById('raceway-modal').style.display = '';
  });

  document.getElementById('btn-add-raceway').addEventListener('click', () => {
    AppState.raceways.push({
      id: `rw_${_racewaySeq++}`, name: `Raceway ${AppState.raceways.length + 1}`,
      nominal_mm: 110, custom_id_mm: 0, cableIds: [],
    });
    renderRacewayEditor();
  });

  document.getElementById('btn-run-raceway').addEventListener('click', async () => {
    const out = document.getElementById('raceway-results');
    if (AppState.raceways.length === 0) {
      out.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Define at least one raceway first.</p>';
      return;
    }
    // Operating currents from the latest load flow, if available
    const branchAmps = {};
    for (const br of (AppState.loadFlowResults?.branches || [])) {
      if (br.i_amps > 0) branchAmps[br.elementId] = br.i_amps;
    }
    const payload = AppState.raceways.map(rw => ({
      name: rw.name,
      conduit_nominal_mm: rw.nominal_mm,
      conduit_id_mm: rw.custom_id_mm || 0,
      cables: rw.cableIds.flatMap(cid => {
        const comp = AppState.components.get(cid);
        if (!comp) return [];
        const lib = comp.props.standard_type
          ? STANDARD_CABLES.find(c => c.id === comp.props.standard_type) : null;
        const runs = Math.max(1, parseInt(comp.props.num_parallel) || 1);
        // Total current splits across parallel runs; each run is one
        // physical cable in the conduit.
        const perRun = (branchAmps[cid] || 0) / runs;
        return Array.from({ length: runs }, (_, i) => ({
          cable_id: runs > 1 ? `${cid}#${i + 1}` : cid,
          name: (comp.props.name || cid) + (runs > 1 ? ` (run ${i + 1})` : ''),
          size_mm2: lib?.size_mm2 || 0,
          od_mm: parseFloat(comp.props.od_mm) || 0,
          rated_amps: parseFloat(comp.props.rated_amps) || 0,
          load_amps: perRun,
        }));
      }),
    }));
    out.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Analysing…</p>';
    _setBusy('btn-run-raceway', true);
    try {
      const res = await API.runRacewayAnalysis(payload);
      renderRacewayResults(res, out);
      document.getElementById('status-info').textContent = 'Raceway analysis complete.';
    } catch (e) {
      console.error('Raceway analysis error:', e);
      out.innerHTML = `<div class="af-warning-item">⚠ ${escHtml(e.message || 'Analysis failed')}</div>`;
    } finally {
      _setBusy('btn-run-raceway', false);
    }
  });

  function renderRacewayResults(res, out) {
    const s = res.summary || {};
    const bannerColor = s.fail > 0 ? '#d32f2f' : s.warning > 0 ? '#f57c00' : '#4caf50';
    let html = `<div style="background:${bannerColor}11;border:1px solid ${bannerColor};border-radius:6px;padding:8px 14px;margin-bottom:10px;font-size:13px">
      <strong style="color:${bannerColor}">${s.total} raceways:</strong>
      <span style="color:#4caf50;margin-left:8px">${s.pass || 0} Pass</span>
      <span style="color:#f57c00;margin-left:8px">${s.warning || 0} Warn</span>
      <span style="color:#d32f2f;margin-left:8px">${s.fail || 0} Fail</span>
    </div>`;
    for (const rw of res.raceways) {
      const color = rw.status === 'fail' ? '#d32f2f' : rw.status === 'warning' ? '#f57c00'
                  : rw.status === 'empty' ? '#888' : '#4caf50';
      html += `<div style="border:1px solid var(--border-color);border-left:4px solid ${color};border-radius:6px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <strong>${escHtml(rw.name)} — ${rw.conduit_nominal_mm} mm conduit (ID ${rw.conduit_id_mm} mm)</strong>
          <span style="color:${color};font-weight:600">${rw.status.toUpperCase()}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px 16px;font-size:12px">
          <div>Fill: <strong style="color:${rw.fill_ok ? 'inherit' : '#d32f2f'}">${rw.fill_pct}%</strong> (limit ${rw.fill_limit_pct}%)</div>
          <div>Cables: <strong>${rw.num_cables}</strong></div>
          <div>Grouping factor: <strong>${rw.grouping_factor.toFixed(2)}</strong></div>
          <div>Jam ratio: <strong style="color:${rw.jam_warning ? '#f57c00' : 'inherit'}">${rw.jam_ratio ?? '—'}</strong></div>
        </div>`;
      if (rw.cables.length) {
        html += `<table class="result-table" style="width:100%;font-size:12px;margin-top:6px"><thead>
          <tr><th>Cable</th><th style="text-align:right">OD (mm)</th><th style="text-align:right">Rated (A)</th><th style="text-align:right">Derated (A)</th><th style="text-align:right">Load (A)</th><th>OK</th></tr></thead><tbody>`;
        for (const c of rw.cables) {
          html += `<tr><td>${escHtml(c.name)}</td>
            <td style="text-align:right">${c.od_mm}${c.od_estimated ? ' <span title="Estimated from conductor size — verify against manufacturer data" style="color:var(--text-secondary)">≈</span>' : ''}</td>
            <td style="text-align:right">${c.rated_amps}</td>
            <td style="text-align:right">${c.derated_amps}</td>
            <td style="text-align:right">${c.load_amps ? c.load_amps.toFixed(1) : '—'}</td>
            <td>${c.adequate ? '<span style="color:#4caf50">✓</span>' : '<span style="color:#d32f2f">✗</span>'}</td></tr>`;
        }
        html += '</tbody></table>';
      }
      for (const w of rw.warnings || []) {
        html += `<div style="font-size:11px;color:#b26a00;margin-top:4px">⚠ ${escHtml(w)}</div>`;
      }
      html += '</div>';
    }
    html += '<p style="font-size:11px;color:var(--text-secondary);margin-top:6px">Run Load Flow first to populate operating currents. ODs marked ≈ are catalogue-typical estimates.</p>';
    out.innerHTML = html;
  }

  // ── Study Manager — Batch Run ──
  document.getElementById('btn-study-manager').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running studies.';
      return;
    }
    // Show config modal
    const modal = document.getElementById('study-manager-modal');
    document.getElementById('study-manager-body').innerHTML = '';
    document.getElementById('study-manager-status').textContent = '';
    document.getElementById('btn-study-run').disabled = false;
    modal.style.display = '';
  });

  document.getElementById('btn-study-run').addEventListener('click', async () => {
    const checks = document.querySelectorAll('#study-manager-checks input[data-study]');
    const enabled = [];
    checks.forEach(cb => { if (cb.checked) enabled.push(cb.dataset.study); });
    if (enabled.length === 0) {
      document.getElementById('study-manager-status').textContent = 'Select at least one study.';
      return;
    }

    const btn = document.getElementById('btn-study-run');
    const statusEl = document.getElementById('study-manager-status');
    btn.disabled = true;
    statusEl.textContent = `Running ${enabled.length} studies...`;
    document.getElementById('status-info').textContent = 'Running batch studies...';
    document.getElementById('study-manager-body').innerHTML = '';

    try {
      const result = await API.runStudyManager(enabled);
      AppState.studyManagerResults = result;

      // Distribute individual study results to their AppState slots
      const studies = result.studies || {};
      if (studies.fault && studies.fault.result) AppState.faultResults = studies.fault.result;
      if (studies.loadflow && studies.loadflow.result) AppState.loadFlowResults = studies.loadflow.result;
      if (studies.arcflash && studies.arcflash.result) AppState.arcFlashResults = studies.arcflash.result;
      if (studies.dc_arcflash && studies.dc_arcflash.result) AppState.dcArcFlashResults = studies.dc_arcflash.result;
      if (studies.cable_sizing && studies.cable_sizing.result) AppState.cableSizingResults = studies.cable_sizing.result;
      if (studies.motor_starting && studies.motor_starting.result) AppState.motorStartingResults = studies.motor_starting.result;
      if (studies.dynamic_motor_starting && studies.dynamic_motor_starting.result) AppState.dynamicMotorResults = studies.dynamic_motor_starting.result;
      if (studies.transient_stability && studies.transient_stability.result) AppState.stabilityResults = studies.transient_stability.result;
      if (studies.duty_check && studies.duty_check.result) AppState.dutyCheckResults = studies.duty_check.result;
      if (studies.load_diversity && studies.load_diversity.result) AppState.loadDiversityResults = studies.load_diversity.result;
      if (studies.grounding && studies.grounding.result) AppState.groundingResults = studies.grounding.result;

      Canvas.render();
      document.getElementById('status-info').textContent = `Batch run complete (${result.total_time_s}s).`;
      statusEl.textContent = `Completed in ${result.total_time_s}s`;
      btn.disabled = false;
      showStudyManagerResults(result);
    } catch (e) {
      console.error('Study manager error:', e);
      document.getElementById('status-info').textContent = 'Batch run failed.';
      statusEl.textContent = 'Failed — see console for details.';
      btn.disabled = false;
      showValidationModal('Study Manager — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    }
  });

  function showStudyManagerResults(result) {
    const body = document.getElementById('study-manager-body');
    const summary = result.summary || {};
    const studies = result.studies || {};

    let html = '';

    // Summary banner
    const totalStudies = summary.total || 0;
    const bannerColor = summary.fail > 0 || summary.errors > 0 ? '#d32f2f'
      : summary.warning > 0 ? '#f57c00' : '#4caf50';
    html += `<div style="background:${bannerColor}11;border:1px solid ${bannerColor};border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;align-items:center;gap:16px">
      <strong style="color:${bannerColor};font-size:14px">${totalStudies} Studies</strong>
      <span style="font-size:12px">
        <span style="color:#4caf50">${summary.pass || 0} Pass</span> &middot;
        <span style="color:#f57c00">${summary.warning || 0} Warn</span> &middot;
        <span style="color:#d32f2f">${summary.fail || 0} Fail</span>
        ${summary.errors > 0 ? ` &middot; <span style="color:#d32f2f">${summary.errors} Error</span>` : ''}
      </span>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">Total: ${result.total_time_s}s</span>
    </div>`;

    // Per-study cards
    const studyOrder = ['loadflow', 'fault', 'arcflash', 'cable_sizing', 'motor_starting', 'dynamic_motor_starting', 'transient_stability', 'duty_check', 'load_diversity', 'grounding'];
    for (const key of studyOrder) {
      const s = studies[key];
      if (!s) continue;

      const statusColor = s.status === 'pass' ? '#4caf50'
        : s.status === 'warning' ? '#f57c00'
        : s.status === 'error' ? '#9e9e9e'
        : '#d32f2f';
      const statusLabel = s.status.toUpperCase();
      const icon = s.status === 'pass' ? '✓' : s.status === 'warning' ? '!' : s.status === 'error' ? '✗' : '✗';

      html += `<div style="border:1px solid var(--border-color);border-radius:6px;padding:10px 14px;margin-bottom:8px;border-left:4px solid ${statusColor}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
          <strong style="font-size:13px">${s.name}</strong>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:11px;color:var(--text-muted)">${s.time_s}s</span>
            <span style="color:${statusColor};font-weight:600;font-size:12px">${icon} ${statusLabel}</span>
          </div>
        </div>`;

      if (s.error) {
        html += `<div style="font-size:11px;color:#d32f2f">${escHtml(s.error)}</div>`;
      } else if (s.counts) {
        html += '<div style="font-size:11px;color:var(--text-secondary)">';
        html += _formatStudyCounts(key, s.counts);
        html += '</div>';
      }

      html += '</div>';
    }

    body.innerHTML = html;
  }

  function _formatStudyCounts(key, counts) {
    if (key === 'loadflow') {
      return `${counts.buses} buses analysed` + (counts.warnings > 0 ? `, ${counts.warnings} warnings` : '');
    } else if (key === 'fault') {
      return `${counts.buses} buses analysed`;
    } else if (key === 'arcflash') {
      return `${counts.buses} buses, max PPE category ${counts.max_ppe_category}`;
    } else if (key === 'cable_sizing') {
      return `${counts.total} cables: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail`;
    } else if (key === 'motor_starting') {
      return `${counts.total} motors: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail`;
    } else if (key === 'dynamic_motor_starting') {
      return `${counts.total} motors: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail`
        + (counts.not_simulated > 0 ? `, ${counts.not_simulated} not simulated (VFD)` : '');
    } else if (key === 'transient_stability') {
      return `${counts.machines} machines: ${counts.stable === false ? 'UNSTABLE' : counts.stable === null ? 'no machines' : 'stable'}`
        + (counts.cct_ms != null ? `, CCT ${counts.cct_ms} ms` : '');
    } else if (key === 'duty_check') {
      return `${counts.total} devices: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail`;
    } else if (key === 'load_diversity') {
      return `${counts.buses_with_loads} buses, ${counts.transformers} transformers, overall DF ${counts.overall_demand_factor?.toFixed(3) || '—'}`;
    } else if (key === 'grounding') {
      return `${counts.total} buses: ${counts.pass} pass, ${counts.warning} warn, ${counts.fail} fail`;
    }
    return '';
  }

  function showArcFlashResults(result) {
    const modal = document.getElementById('arcflash-modal');
    const body = document.getElementById('arcflash-body');
    if (!modal || !body) return;

    const buses = result.buses || {};
    const entries = Object.values(buses).sort((a, b) => b.incident_energy_cal - a.incident_energy_cal);

    if (entries.length === 0) {
      body.innerHTML = '<p>No buses found for arc flash analysis.</p>';
      modal.style.display = '';
      return;
    }

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) {
        html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      }
      html += '</div>';
    }

    html += `<table class="af-table">
      <thead><tr>
        <th>Bus</th><th>Voltage</th><th>Bolted Fault</th><th>Arcing Current</th>
        <th>Incident Energy</th><th>AFB</th><th>Clearing Time</th>
        <th>PPE Cat.</th><th>PPE</th>
      </tr></thead><tbody>`;

    for (const b of entries) {
      const ppeClass = b.ppe_category >= 4 ? 'af-danger' : b.ppe_category >= 3 ? 'af-high' : b.ppe_category >= 2 ? 'af-medium' : 'af-low';
      const hasRecs = b.recommendations && b.recommendations.length > 0;
      html += `<tr class="${ppeClass}">
        <td>${escHtml(b.bus_name || b.bus_id)}</td>
        <td>${b.voltage_kv.toFixed(3)} kV</td>
        <td>${b.bolted_fault_ka.toFixed(2)} kA</td>
        <td>${b.arcing_current_ka.toFixed(2)} kA</td>
        <td><strong>${b.incident_energy_cal.toFixed(2)}</strong> cal/cm²</td>
        <td>${(b.arc_flash_boundary_mm / 1000).toFixed(2)} m</td>
        <td>${(b.clearing_time_s * 1000).toFixed(0)} ms</td>
        <td><span class="af-ppe-badge">${b.ppe_category}</span></td>
        <td>${b.ppe_name}</td>
      </tr>`;
      if (hasRecs) {
        html += `<tr class="${ppeClass} af-rec-row">
          <td colspan="9">
            <details class="af-rec-details">
              <summary>Recommendations to reduce PPE category (${b.recommendations.length})</summary>
              <ul class="af-rec-list">
                ${b.recommendations.map(r => `<li>${r}</li>`).join('')}
              </ul>
            </details>
          </td>
        </tr>`;
      }
    }
    html += '</tbody></table>';

    body.innerHTML = html;
    modal.style.display = '';
  }

  function showDCArcFlashResults(result) {
    const modal = document.getElementById('dc-arcflash-modal');
    const body = document.getElementById('dc-arcflash-body');
    if (!modal || !body) return;

    const buses = result.buses || {};
    const entries = Object.values(buses).sort((a, b) => b.incident_energy_cal - a.incident_energy_cal);

    if (entries.length === 0) {
      body.innerHTML = '<p>No buses found for DC arc flash analysis.</p>';
      modal.style.display = '';
      return;
    }

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) {
        html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      }
      html += '</div>';
    }

    html += `<table class="af-table">
      <thead><tr>
        <th>Bus</th><th>DC Voltage</th><th>Bolted Fault</th><th>DC Arc Current</th>
        <th>Arc Voltage</th><th>Incident Energy</th><th>AFB</th><th>Clearing Time</th>
        <th>PPE Cat.</th><th>PPE</th>
      </tr></thead><tbody>`;

    for (const b of entries) {
      const ppeClass = b.ppe_category >= 4 ? 'af-danger' : b.ppe_category >= 3 ? 'af-high' : b.ppe_category >= 2 ? 'af-medium' : 'af-low';
      const hasRecs = b.recommendations && b.recommendations.length > 0;
      html += `<tr class="${ppeClass}">
        <td>${escHtml(b.bus_name || b.bus_id)}</td>
        <td>${b.system_voltage_v.toFixed(0)} V</td>
        <td>${b.bolted_fault_ka.toFixed(2)} kA</td>
        <td>${b.dc_arcing_current_a.toFixed(1)} A</td>
        <td>${b.arc_voltage_v.toFixed(1)} V</td>
        <td><strong>${b.incident_energy_cal.toFixed(2)}</strong> cal/cm²</td>
        <td>${(b.arc_flash_boundary_mm / 1000).toFixed(2)} m</td>
        <td>${(b.clearing_time_s * 1000).toFixed(0)} ms</td>
        <td><span class="af-ppe-badge">${b.ppe_category}</span></td>
        <td>${b.ppe_name}</td>
      </tr>`;
      if (hasRecs) {
        html += `<tr class="${ppeClass} af-rec-row">
          <td colspan="10">
            <details class="af-rec-details">
              <summary>Recommendations (${b.recommendations.length})</summary>
              <ul class="af-rec-list">
                ${b.recommendations.map(r => `<li>${r}</li>`).join('')}
              </ul>
            </details>
          </td>
        </tr>`;
      }
    }
    html += '</tbody></table>';

    body.innerHTML = html;
    modal.style.display = '';
  }

  function showVoltageDepression(faultBusId, faultResult) {
    const modal = document.getElementById('vdep-modal');
    const body = document.getElementById('vdep-body');
    if (!modal || !body) return;

    const dep = faultResult.voltage_depression || {};
    const faultBusName = faultResult.bus_name || faultBusId;
    const entries = Object.entries(dep)
      .filter(([id]) => id !== faultBusId)
      .map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => (a.subtransient_pu || 1) - (b.subtransient_pu || 1));

    if (entries.length === 0) {
      body.innerHTML = '<p>No voltage depression data available.</p>';
      modal.style.display = '';
      return;
    }

    let html = `<p>Fault at <strong>${escHtml(faultBusName)}</strong> (${faultResult.voltage_kv} kV) — Retained voltage at other buses:</p>`;
    html += `<table class="af-table vdep-table">
      <thead><tr>
        <th>Bus</th><th>Rated kV</th>
        <th>Sub-transient</th><th>Transient</th><th>Steady-state</th>
        <th>Retained kV</th><th>Status</th>
      </tr></thead><tbody>`;

    for (const d of entries) {
      const vSub = d.subtransient_pu != null ? d.subtransient_pu : 1;
      const vTr = d.transient_pu != null ? d.transient_pu : vSub;
      const vSS = d.steadystate_pu != null ? d.steadystate_pu : vTr;
      const worst = Math.min(vSub, vTr, vSS);
      const rowClass = worst >= 0.8 ? 'af-low' : worst >= 0.5 ? 'af-medium' : worst >= 0.3 ? 'af-high' : 'af-danger';
      const status = worst >= 0.8 ? 'Normal' : worst >= 0.5 ? 'Moderate Sag' : worst >= 0.3 ? 'Severe Sag' : 'Near Collapse';
      html += `<tr class="${rowClass}">
        <td>${escHtml(d.bus_name || d.id)}</td>
        <td>${(d.voltage_kv || 0).toFixed(1)}</td>
        <td>${(vSub * 100).toFixed(1)}%</td>
        <td>${(vTr * 100).toFixed(1)}%</td>
        <td>${(vSS * 100).toFixed(1)}%</td>
        <td>${(d.retained_kv || 0).toFixed(2)} kV</td>
        <td><span class="af-ppe-badge">${status}</span></td>
      </tr>`;
    }
    html += '</tbody></table>';

    // Motor recovery chart
    if (faultResult.motor_recovery && faultResult.motor_recovery.length > 0) {
      html += '<h4 style="margin-top:16px;">Motor Reacceleration Voltage Recovery</h4>';
      html += _renderRecoveryChart(faultResult.motor_recovery);
    }

    body.innerHTML = html;
    modal.style.display = '';
  }

  function _renderRecoveryChart(profile) {
    // Simple SVG line chart
    const w = 500, h = 150, pad = 40;
    const maxT = profile[profile.length - 1].t_ms;
    const scaleX = (t) => pad + (t / maxT) * (w - pad * 2);
    const scaleY = (v) => h - pad - (v * (h - pad * 2));

    let pathD = profile.map((p, i) => {
      const x = scaleX(p.t_ms);
      const y = scaleY(p.v_pu);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');

    // Reference lines
    const y100 = scaleY(1.0);
    const y95 = scaleY(0.95);
    const y80 = scaleY(0.8);

    return `<svg width="${w}" height="${h}" style="border:1px solid var(--border,#ddd);border-radius:4px;margin-top:8px;">
      <line x1="${pad}" y1="${y100}" x2="${w - pad}" y2="${y100}" stroke="#4caf50" stroke-width="0.5" stroke-dasharray="4,4"/>
      <text x="${pad - 4}" y="${y100 + 3}" text-anchor="end" font-size="9" fill="#666">100%</text>
      <line x1="${pad}" y1="${y95}" x2="${w - pad}" y2="${y95}" stroke="#f9a825" stroke-width="0.5" stroke-dasharray="4,4"/>
      <text x="${pad - 4}" y="${y95 + 3}" text-anchor="end" font-size="9" fill="#666">95%</text>
      <line x1="${pad}" y1="${y80}" x2="${w - pad}" y2="${y80}" stroke="#d32f2f" stroke-width="0.5" stroke-dasharray="4,4"/>
      <text x="${pad - 4}" y="${y80 + 3}" text-anchor="end" font-size="9" fill="#666">80%</text>
      <path d="${pathD}" fill="none" stroke="#1976d2" stroke-width="2"/>
      <text x="${w / 2}" y="${h - 5}" text-anchor="middle" font-size="10" fill="#666">Time after clearing (ms)</text>
      <text x="${pad}" y="${h - 5}" font-size="9" fill="#666">0</text>
      <text x="${w - pad}" y="${h - 5}" text-anchor="end" font-size="9" fill="#666">${maxT}</text>
    </svg>`;
  }

  // Compliance report
  document.getElementById('btn-compliance').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before generating a compliance report.';
      return;
    }
    const report = Compliance.generate();
    const modal = document.getElementById('compliance-modal');
    document.getElementById('compliance-body').innerHTML = Compliance.renderHTML(report);

    // Summary badge
    const t = report.totals;
    const badge = document.getElementById('compliance-summary');
    if (t.fail > 0) {
      badge.textContent = `${t.pass} Pass, ${t.fail} Fail, ${t.warn} Warn`;
      badge.className = 'compliance-summary-badge summary-has-fail';
    } else if (t.warn > 0) {
      badge.textContent = `${t.pass} Pass, ${t.warn} Warn`;
      badge.className = 'compliance-summary-badge summary-has-warn';
    } else {
      badge.textContent = `${t.pass} Pass — All Clear`;
      badge.className = 'compliance-summary-badge summary-all-pass';
    }

    modal.style.display = '';
    document.getElementById('status-info').textContent = 'Compliance report generated.';

    // Store report for PDF export
    modal._complianceReport = report;
  });

  document.getElementById('btn-close-compliance').addEventListener('click', () => {
    document.getElementById('compliance-modal').style.display = 'none';
  });

  document.getElementById('btn-close-arcflash').addEventListener('click', () => {
    document.getElementById('arcflash-modal').style.display = 'none';
  });
  document.getElementById('arcflash-modal').addEventListener('click', (e) => {
    if (e.target.id === 'arcflash-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-dc-arcflash').addEventListener('click', () => {
    document.getElementById('dc-arcflash-modal').style.display = 'none';
  });
  document.getElementById('dc-arcflash-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dc-arcflash-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-dc-loadflow').addEventListener('click', () => {
    document.getElementById('dc-loadflow-modal').style.display = 'none';
  });
  document.getElementById('dc-loadflow-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dc-loadflow-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-dc-shortcircuit').addEventListener('click', () => {
    document.getElementById('dc-shortcircuit-modal').style.display = 'none';
  });
  document.getElementById('dc-shortcircuit-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dc-shortcircuit-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-cable-sizing').addEventListener('click', () => {
    document.getElementById('cable-sizing-modal').style.display = 'none';
  });
  document.getElementById('cable-sizing-modal').addEventListener('click', (e) => {
    if (e.target.id === 'cable-sizing-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-motor-starting').addEventListener('click', () => {
    document.getElementById('motor-starting-modal').style.display = 'none';
  });
  document.getElementById('btn-close-dynamic-motor').addEventListener('click', () => {
    document.getElementById('dynamic-motor-modal').style.display = 'none';
  });
  document.getElementById('dynamic-motor-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dynamic-motor-modal') e.target.style.display = 'none';
  });
  document.getElementById('dynamic-motor-config-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dynamic-motor-config-modal') e.target.style.display = 'none';
  });
  document.getElementById('motor-starting-modal').addEventListener('click', (e) => {
    if (e.target.id === 'motor-starting-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-duty-check').addEventListener('click', () => {
    document.getElementById('duty-check-modal').style.display = 'none';
  });
  document.getElementById('duty-check-modal').addEventListener('click', (e) => {
    if (e.target.id === 'duty-check-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-load-diversity').addEventListener('click', () => {
    document.getElementById('load-diversity-modal').style.display = 'none';
  });
  document.getElementById('load-diversity-modal').addEventListener('click', (e) => {
    if (e.target.id === 'load-diversity-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-backup').addEventListener('click', () => {
    document.getElementById('backup-modal').style.display = 'none';
  });
  document.getElementById('backup-modal').addEventListener('click', (e) => {
    if (e.target.id === 'backup-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-grounding').addEventListener('click', () => {
    document.getElementById('grounding-modal').style.display = 'none';
  });
  document.getElementById('grounding-modal').addEventListener('click', (e) => {
    if (e.target.id === 'grounding-modal') e.target.style.display = 'none';
  });
  document.getElementById('btn-close-harmonics').addEventListener('click', () => {
    document.getElementById('harmonics-modal').style.display = 'none';
  });
  document.getElementById('harmonics-modal').addEventListener('click', (e) => {
    if (e.target.id === 'harmonics-modal') e.target.style.display = 'none';
  });

  // ── Control circuit simulation toggle ──
  document.getElementById('btn-control-sim').addEventListener('click', () => {
    ControlSim.toggle();
  });

  document.getElementById('btn-close-raceway').addEventListener('click', () => {
    document.getElementById('raceway-modal').style.display = 'none';
  });
  document.getElementById('raceway-modal').addEventListener('click', (e) => {
    if (e.target.id === 'raceway-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-lightning').addEventListener('click', () => {
    document.getElementById('lightning-modal').style.display = 'none';
  });
  document.getElementById('lightning-modal').addEventListener('click', (e) => {
    if (e.target.id === 'lightning-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-study-manager').addEventListener('click', () => {
    document.getElementById('study-manager-modal').style.display = 'none';
  });
  document.getElementById('study-manager-modal').addEventListener('click', (e) => {
    if (e.target.id === 'study-manager-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-close-vdep').addEventListener('click', () => {
    document.getElementById('vdep-modal').style.display = 'none';
  });
  document.getElementById('vdep-modal').addEventListener('click', (e) => {
    if (e.target.id === 'vdep-modal') e.target.style.display = 'none';
  });

  // Help modal
  document.getElementById('btn-help').addEventListener('click', () => {
    document.getElementById('help-modal').style.display = '';
  });
  document.getElementById('btn-close-help').addEventListener('click', () => {
    document.getElementById('help-modal').style.display = 'none';
  });
  document.getElementById('help-modal').addEventListener('click', (e) => {
    if (e.target.id === 'help-modal') e.target.style.display = 'none';
  });
  // Help tab switching
  document.querySelectorAll('.help-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.help-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.help-content').forEach(c => c.style.display = 'none');
      tab.classList.add('active');
      document.getElementById(`help-tab-${tab.dataset.tab}`).style.display = '';
    });
  });
  document.getElementById('compliance-modal').addEventListener('click', (e) => {
    if (e.target.id === 'compliance-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-compliance-pdf').addEventListener('click', () => {
    const modal = document.getElementById('compliance-modal');
    if (modal._complianceReport) {
      Compliance.exportPDF(modal._complianceReport);
    }
  });

  // TCC Chart
  document.getElementById('btn-tcc').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before opening TCC chart.';
      return;
    }
    TCC.open();
    document.getElementById('status-info').textContent = 'TCC chart opened.';
  });
  document.getElementById('btn-close-tcc').addEventListener('click', () => TCC.close());
  document.getElementById('tcc-modal').addEventListener('click', (e) => {
    if (e.target.id === 'tcc-modal') TCC.close();
  });
  document.getElementById('btn-tcc-export-png').addEventListener('click', () => TCC.exportPNG());
  document.getElementById('btn-tcc-export-pdf').addEventListener('click', () => TCC.exportPDF());
  document.getElementById('btn-tcc-export-csv').addEventListener('click', () => TCC.exportCSV());

  // TCC fault markers toggle
  document.getElementById('btn-tcc-fault-markers').addEventListener('click', (e) => {
    TCC.showFaultMarkers = !TCC.showFaultMarkers;
    e.target.classList.toggle('active', TCC.showFaultMarkers);
    TCC.render();
  });

  // TCC compare mode toggle
  document.getElementById('btn-tcc-compare').addEventListener('click', (e) => {
    TCC.compareMode = !TCC.compareMode;
    e.target.classList.toggle('active', TCC.compareMode);
    const section = document.getElementById('tcc-compare-section');
    section.style.display = TCC.compareMode ? '' : 'none';
    if (TCC.compareMode) {
      TCC._renderCompareSelector();
      // Default to second tab if available
      if (TCC.tabs.length > 1 && !TCC.compareTabId) {
        TCC.compareTabId = TCC.tabs[1].id;
      }
    } else {
      TCC.compareTabId = null;
    }
    TCC.render();
  });

  // TCC compare tab selector
  document.getElementById('tcc-compare-tab').addEventListener('change', (e) => {
    TCC.compareTabId = e.target.value;
    TCC.render();
  });

  // TCC add device tab switching
  document.querySelectorAll('.tcc-add-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.tcc-add-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      const which = e.target.dataset.tccAdd;
      document.getElementById('tcc-add-relay').style.display = which === 'relay' ? '' : 'none';
      document.getElementById('tcc-add-fuse').style.display = which === 'fuse' ? '' : 'none';
      document.getElementById('tcc-add-cb').style.display = which === 'cb' ? '' : 'none';
      document.getElementById('tcc-add-custom').style.display = which === 'custom' ? '' : 'none';
    });
  });

  // TCC add relay
  document.getElementById('btn-tcc-add-relay').addEventListener('click', () => {
    const name = document.getElementById('tcc-relay-name').value;
    const pickup = parseFloat(document.getElementById('tcc-relay-pickup').value) || 100;
    const tds = parseFloat(document.getElementById('tcc-relay-tds').value) || 1.0;
    const curve = document.getElementById('tcc-relay-curve').value;
    TCC.addCustomRelay(name, pickup, tds, curve);
    document.getElementById('tcc-relay-name').value = '';
  });

  // TCC add fuse
  document.getElementById('btn-tcc-add-fuse').addEventListener('click', () => {
    const name = document.getElementById('tcc-fuse-name').value;
    const rating = parseInt(document.getElementById('tcc-fuse-rating').value) || 100;
    TCC.addCustomFuse(name, rating);
    document.getElementById('tcc-fuse-name').value = '';
  });

  // TCC add CB
  document.getElementById('tcc-cb-type').addEventListener('change', (e) => {
    document.getElementById('tcc-cb-acb-fields').style.display = e.target.value === 'acb' ? '' : 'none';
  });
  document.getElementById('btn-tcc-add-cb').addEventListener('click', () => {
    const name = document.getElementById('tcc-cb-name').value;
    const cbType = document.getElementById('tcc-cb-type').value;
    const cbParams = {
      cb_type: cbType,
      trip_rating_a: parseFloat(document.getElementById('tcc-cb-rating').value) || 630,
      thermal_pickup: parseFloat(document.getElementById('tcc-cb-thermal').value) || 1.0,
      magnetic_pickup: parseFloat(document.getElementById('tcc-cb-magnetic').value) || 10,
      long_time_delay: parseInt(document.getElementById('tcc-cb-ltdelay').value) || 10,
      short_time_pickup: cbType === 'acb' ? parseFloat(document.getElementById('tcc-cb-st-pickup').value) || 0 : 0,
      short_time_delay: cbType === 'acb' ? parseFloat(document.getElementById('tcc-cb-st-delay').value) || 0 : 0,
      instantaneous_pickup: cbType === 'acb' ? parseFloat(document.getElementById('tcc-cb-inst').value) || 0 : 0,
    };
    TCC.addCustomCB(name, cbParams);
    document.getElementById('tcc-cb-name').value = '';
  });

  // Custom curve CSV import
  let _tccCsvContent = '';
  document.getElementById('btn-tcc-csv-browse').addEventListener('click', () => {
    document.getElementById('tcc-csv-file').click();
  });
  document.getElementById('tcc-csv-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('tcc-csv-filename').textContent = file.name;
    const reader = new FileReader();
    reader.onload = (ev) => {
      _tccCsvContent = ev.target.result;
      document.getElementById('tcc-csv-paste').value = _tccCsvContent;
    };
    reader.readAsText(file);
  });
  document.getElementById('btn-tcc-add-custom').addEventListener('click', () => {
    const name = document.getElementById('tcc-custom-name').value;
    const csvText = document.getElementById('tcc-csv-paste').value || _tccCsvContent;
    if (!csvText.trim()) {
      UI.toast('Please import a CSV file or paste curve data.', 'warning');
      return;
    }
    if (TCC.addCustomCurveFromCSV(name, csvText)) {
      document.getElementById('tcc-custom-name').value = '';
      document.getElementById('tcc-csv-paste').value = '';
      document.getElementById('tcc-csv-filename').textContent = 'No file selected';
      document.getElementById('tcc-csv-file').value = '';
      _tccCsvContent = '';
    }
  });

  // TCC grading margin update
  document.getElementById('tcc-grading-margin').addEventListener('change', (e) => {
    TCC.gradingMargin = parseFloat(e.target.value) || 0.3;
    TCC._runCoordinationCheck();
  });

  // Auto-coordination, miscoordination detection & sequence verification buttons
  document.getElementById('btn-tcc-auto-coord').addEventListener('click', () => TCC.autoCoordinate());
  document.getElementById('btn-tcc-detect-miscord').addEventListener('click', () => TCC.detectMiscoordination());
  document.getElementById('btn-tcc-verify-seq').addEventListener('click', () => TCC.verifySequenceOfOperation());

  // ─── Scenarios ───
  const scenariosModal = document.getElementById('scenarios-modal');

  function renderScenarioList() {
    const list = document.getElementById('scenario-list');
    if (AppState.scenarios.length === 0) {
      list.innerHTML = '<p class="scenario-empty">No scenarios saved yet.</p>';
      return;
    }
    list.innerHTML = AppState.scenarios.map(s => {
      const date = new Date(s.timestamp).toLocaleString();
      const compCount = s.components.length;
      const descHtml = s.description ? `<div class="scenario-desc">${escapeHtml(s.description)}</div>` : '';
      const a = s.applies || { switching: true, settings: true, layout: true };
      const tags = [a.switching && 'switching', a.settings && 'settings', a.layout && 'layout']
        .filter(Boolean).join(' · ');
      return `
        <div class="scenario-item" data-id="${s.id}">
          <div class="scenario-info">
            <div class="scenario-name">${escapeHtml(s.name)}</div>
            ${descHtml}
            <div class="scenario-meta">${date} &mdash; ${compCount} component${compCount !== 1 ? 's' : ''} &mdash; applies: ${tags}</div>
          </div>
          <div class="scenario-actions">
            <button class="btn-load-scenario" data-id="${s.id}" title="Load this scenario">Load</button>
            <button class="btn-delete-scenario" data-id="${s.id}" title="Delete this scenario">&times;</button>
          </div>
        </div>`;
    }).join('');

    // Bind load buttons
    list.querySelectorAll('.btn-load-scenario').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sc = AppState.scenarios.find(s => s.id === btn.dataset.id);
        const a = sc?.applies || { switching: true, settings: true, layout: true };
        const full = a.switching && a.settings && a.layout;
        const what = full
          ? 'Current unsaved changes will be replaced (device names are kept).'
          : `Applies ${[a.switching && 'switching states', a.settings && 'electrical settings', a.layout && 'layout'].filter(Boolean).join(' and ')} to the current network.`;
        if (!(await UI.confirm(`Load this scenario? ${what}`))) return;
        const loaded = AppState.loadScenario(btn.dataset.id);
        if (loaded) {
          UndoManager.clear();
          renderPageTabs();
          Canvas.render();
          Properties.clear();
          scenariosModal.style.display = 'none';
          const scenario = AppState.scenarios.find(s => s.id === btn.dataset.id);
          document.getElementById('status-info').textContent = `Loaded scenario: ${scenario.name}`;
        }
      });
    });

    // Bind delete buttons
    list.querySelectorAll('.btn-delete-scenario').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!(await UI.confirm('Delete this scenario permanently?', { danger: true, okText: 'Delete' }))) return;
        AppState.deleteScenario(btn.dataset.id);
        renderScenarioList();
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.getElementById('btn-scenarios').addEventListener('click', () => {
    document.getElementById('scenario-name').value = '';
    document.getElementById('scenario-desc').value = '';
    renderScenarioList();
    scenariosModal.style.display = '';
  });

  document.getElementById('btn-close-scenarios').addEventListener('click', () => {
    scenariosModal.style.display = 'none';
  });
  scenariosModal.addEventListener('click', (e) => {
    if (e.target === scenariosModal) scenariosModal.style.display = 'none';
  });

  document.getElementById('btn-save-scenario').addEventListener('click', () => {
    const name = document.getElementById('scenario-name').value.trim();
    if (!name) {
      document.getElementById('scenario-name').focus();
      return;
    }
    const desc = document.getElementById('scenario-desc').value.trim();
    const applies = {
      switching: document.getElementById('scenario-apply-switching').checked,
      settings: document.getElementById('scenario-apply-settings').checked,
      layout: document.getElementById('scenario-apply-layout').checked,
    };
    if (!applies.switching && !applies.settings && !applies.layout) {
      document.getElementById('status-info').textContent =
        'Tick at least one category for the scenario to apply.';
      return;
    }
    AppState.saveScenario(name, desc, applies);
    document.getElementById('scenario-name').value = '';
    document.getElementById('scenario-desc').value = '';
    renderScenarioList();
    document.getElementById('status-info').textContent = `Scenario "${name}" saved.`;
  });

  // ─── Group / Ungroup ───
  document.getElementById('btn-group').addEventListener('click', () => {
    const group = AppState.createGroup();
    if (group) {
      Canvas.render();
      document.getElementById('status-info').textContent = `Created group: ${group.name}`;
    } else {
      document.getElementById('status-info').textContent = 'Select at least 2 components to group.';
    }
  });
  document.getElementById('btn-ungroup').addEventListener('click', () => {
    AppState.ungroupSelected();
    Canvas.render();
    document.getElementById('status-info').textContent = 'Ungrouped selected components.';
  });

  // ─── Wire Routing Mode ───
  document.getElementById('wire-route-mode').addEventListener('change', (e) => {
    AppState.wireRouteMode = e.target.value;
    Canvas.render();
    document.getElementById('status-info').textContent = `Wire routing: ${e.target.value}`;
  });

  // ─── Page Tabs ───
  // Expose for other modules (project load, template load)
  window.renderPageTabs = renderPageTabs;
  function renderPageTabs() {
    const container = document.getElementById('page-tabs');
    container.innerHTML = '';
    for (const page of AppState.pages) {
      const btn = document.createElement('button');
      btn.className = 'page-tab' + (page.id === AppState.activePageId ? ' active' : '');
      btn.dataset.pageId = page.id;
      btn.innerHTML = `<span class="page-tab-name">${escHtml(page.name)}</span>` +
        (AppState.pages.length > 1 ? `<span class="page-tab-close" title="Delete sheet">&times;</span>` : '');
      btn.addEventListener('click', async (e) => {
        if (e.target.classList.contains('page-tab-close')) {
          if (await UI.confirm(`Delete "${page.name}"? Components on this page will be removed.`, { danger: true, okText: 'Delete' })) {
            AppState.deletePage(page.id);
            renderPageTabs();
            Canvas.render();
          }
          return;
        }
        AppState.activePageId = page.id;
        AppState.clearSelection();
        renderPageTabs();
        Canvas.render();
        Properties.clear();
      });
      btn.addEventListener('dblclick', async () => {
        const newName = await UI.prompt('Rename sheet:', page.name);
        if (newName && newName.trim()) {
          AppState.renamePage(page.id, newName.trim());
          renderPageTabs();
        }
      });
      container.appendChild(btn);
    }
  }

  document.getElementById('btn-add-page').addEventListener('click', () => {
    const id = AppState.addPage();
    AppState.activePageId = id;
    renderPageTabs();
    Canvas.render();
    document.getElementById('status-info').textContent = `Added new sheet.`;
  });

  renderPageTabs();

  // ─── Print / Page Layout ───
  document.getElementById('btn-print').addEventListener('click', () => {
    document.getElementById('print-title').value = AppState.projectName || 'Single Line Diagram';
    document.getElementById('print-modal').style.display = '';
  });
  document.getElementById('btn-close-print').addEventListener('click', () => {
    document.getElementById('print-modal').style.display = 'none';
  });
  document.getElementById('print-modal').addEventListener('click', (e) => {
    if (e.target.id === 'print-modal') e.target.style.display = 'none';
  });

  document.getElementById('btn-print-pdf').addEventListener('click', () => {
    _exportPrintPDF();
  });
  document.getElementById('btn-print-preview').addEventListener('click', () => {
    _printPreview();
  });

  function _exportPrintPDF() {
    if (!window.jspdf) {
      UI.toast('PDF library (jsPDF) is not available. Please reload the page and try again.', 'error', 5000);
      return;
    }
    const { jsPDF } = window.jspdf;
    const pageSize = document.getElementById('print-page-size').value;
    const orientation = document.getElementById('print-orientation').value;
    const title = document.getElementById('print-title').value || 'Single Line Diagram';
    const drawingNo = document.getElementById('print-drawing-no').value || '';
    const revision = document.getElementById('print-revision').value || '';
    const drawnBy = document.getElementById('print-drawn-by').value || '';
    const showTitleBlock = document.getElementById('print-show-title-block').checked;
    const showLegend = document.getElementById('print-show-legend').checked;
    const showBorder = document.getElementById('print-show-border').checked;

    const doc = new jsPDF({ orientation, format: pageSize });
    const pw = doc.internal.pageSize.getWidth();
    const ph = doc.internal.pageSize.getHeight();
    const margin = 10;

    // Border
    if (showBorder) {
      doc.setDrawColor(0);
      doc.setLineWidth(0.5);
      doc.rect(margin, margin, pw - 2 * margin, ph - 2 * margin);
      doc.setLineWidth(0.3);
      doc.rect(margin + 2, margin + 2, pw - 2 * margin - 4, ph - 2 * margin - 4);
    }

    // Title block
    if (showTitleBlock) {
      const tbW = 120, tbH = 28;
      const tbX = pw - margin - tbW - 2;
      const tbY = ph - margin - tbH - 2;
      doc.setLineWidth(0.4);
      doc.rect(tbX, tbY, tbW, tbH);
      doc.line(tbX, tbY + 10, tbX + tbW, tbY + 10);
      doc.line(tbX, tbY + 20, tbX + tbW, tbY + 20);
      doc.line(tbX + 60, tbY, tbX + 60, tbY + tbH);

      doc.setFontSize(7);
      doc.setTextColor(100);
      doc.text('TITLE', tbX + 2, tbY + 4);
      doc.text('DRAWING NO.', tbX + 2, tbY + 14);
      doc.text('DRAWN BY', tbX + 2, tbY + 24);
      doc.text('REVISION', tbX + 62, tbY + 14);
      doc.text('DATE', tbX + 62, tbY + 24);

      doc.setFontSize(10);
      doc.setTextColor(0);
      doc.text(title, tbX + 2, tbY + 9);
      doc.setFontSize(8);
      doc.text(drawingNo, tbX + 2, tbY + 19);
      doc.text(drawnBy, tbX + 2, tbY + 28);
      doc.text(revision, tbX + 62, tbY + 19);
      doc.text(new Date().toLocaleDateString(), tbX + 62, tbY + 28);
    }

    // Embed diagram as SVG → PNG
    const svgEl = document.getElementById('sld-canvas');
    const svgClone = svgEl.cloneNode(true);
    // Remove grid for print
    const gridBg = svgClone.querySelector('#grid-bg');
    if (gridBg) gridBg.remove();
    const svgData = new XMLSerializer().serializeToString(svgClone);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const diagramArea = { w: pw - 2 * margin - 10, h: ph - 2 * margin - (showTitleBlock ? 40 : 10) };
      canvas.width = diagramArea.w * 4;
      canvas.height = diagramArea.h * 4;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imgData = canvas.toDataURL('image/png');
      doc.addImage(imgData, 'PNG', margin + 5, margin + 5, diagramArea.w, diagramArea.h);
      URL.revokeObjectURL(url);

      // Legend
      if (showLegend) {
        const types = new Set([...AppState.components.values()].map(c => c.type));
        const legendX = margin + 5;
        let legendY = ph - margin - (showTitleBlock ? 34 : 8);
        doc.setFontSize(7);
        doc.setTextColor(80);
        const legendItems = [...types].slice(0, 8);
        doc.text('Legend: ' + legendItems.map(t => {
          const def = COMPONENT_DEFS[t];
          return def ? def.label : t;
        }).join(' | '), legendX, legendY);
      }

      doc.save(`${title.replace(/\s+/g, '_')}_print.pdf`);
      document.getElementById('print-modal').style.display = 'none';
      document.getElementById('status-info').textContent = 'Print PDF exported.';
    };
    img.src = url;
  }

  function _printPreview() {
    // Use browser print with a styled iframe
    const svgEl = document.getElementById('sld-canvas');
    const svgClone = svgEl.cloneNode(true);
    const gridBg = svgClone.querySelector('#grid-bg');
    if (gridBg) gridBg.setAttribute('fill', 'white');
    const svgData = new XMLSerializer().serializeToString(svgClone);
    const printWin = window.open('', '_blank', 'width=900,height=650');
    if (!printWin) {
      UI.toast('Print preview was blocked by the browser popup blocker. Please allow popups for this site and try again, or use "Export PDF" instead.', 'error', 6000);
      return;
    }
    printWin.document.write(`<!DOCTYPE html><html><head><title>Print Preview</title>
      <style>body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;}
      svg{max-width:100%;max-height:100%;}</style></head>
      <body>${svgData}</body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => printWin.print(), 500);
  }

  // Display toggles
  document.getElementById('btn-toggle-labels').addEventListener('click', (e) => {
    AppState.showCableLabels = !AppState.showCableLabels;
    e.currentTarget.classList.toggle('active', AppState.showCableLabels);
    Canvas.render();
  });
  document.getElementById('btn-toggle-devices').addEventListener('click', (e) => {
    AppState.showDeviceLabels = !AppState.showDeviceLabels;
    e.currentTarget.classList.toggle('active', AppState.showDeviceLabels);
    Canvas.render();
  });

  // ── Layout: collapsible side panels + component ribbon ──
  const LAYOUT_KEY = 'protectionpro-layout';
  const layout = (() => {
    try { return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; }
    catch (_) { return {}; }
  })();
  function applyLayout() {
    document.body.classList.toggle('sidebar-collapsed', !!layout.sidebarCollapsed);
    document.body.classList.toggle('properties-collapsed', !!layout.propertiesCollapsed);
    document.body.classList.toggle('ribbon-mode', !!layout.ribbon);
    document.getElementById('component-ribbon').style.display = layout.ribbon ? '' : 'none';
    document.getElementById('btn-toggle-ribbon').classList.toggle('active', !!layout.ribbon);
  }
  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch (_) { /* full */ }
    applyLayout();
  }
  applyLayout();
  document.getElementById('btn-collapse-sidebar').addEventListener('click', () => {
    layout.sidebarCollapsed = true;
    saveLayout();
  });
  document.getElementById('sidebar-expand-tab').addEventListener('click', () => {
    layout.sidebarCollapsed = false;
    saveLayout();
  });
  document.getElementById('btn-collapse-properties').addEventListener('click', () => {
    layout.propertiesCollapsed = true;
    saveLayout();
  });
  document.getElementById('properties-expand-tab').addEventListener('click', () => {
    layout.propertiesCollapsed = false;
    saveLayout();
  });
  document.getElementById('btn-toggle-ribbon').addEventListener('click', () => {
    window.closeAllToolbarMenus?.();
    layout.ribbon = !layout.ribbon;
    saveLayout();
  });
  document.getElementById('btn-toggle-warnings').addEventListener('click', (e) => {
    AppState.showWarnings = !AppState.showWarnings;
    e.currentTarget.classList.toggle('active', AppState.showWarnings);
    Canvas.render();
  });
  document.getElementById('btn-toggle-angles').addEventListener('click', (e) => {
    AppState.showFaultAngles = !AppState.showFaultAngles;
    e.currentTarget.classList.toggle('active', AppState.showFaultAngles);
    Canvas.render();
  });

  // Result box visibility toggles
  function _toggleResultBoxes(types, forceValue) {
    const rb = AppState.showResultBoxes;
    for (const t of types) {
      rb[t] = forceValue !== undefined ? forceValue : !rb[t];
    }
    Canvas.render();
  }

  function _syncResultToggleButtons() {
    const rb = AppState.showResultBoxes;
    const allOn = Object.values(rb).every(Boolean);
    document.getElementById('btn-toggle-results-all').classList.toggle('active', allOn);
    document.getElementById('btn-toggle-results-fault').classList.toggle('active', rb.fault);
    document.getElementById('btn-toggle-results-loadflow').classList.toggle('active', rb.loadflow);
    document.getElementById('btn-toggle-results-unbalanced').classList.toggle('active', rb.unbalancedLF);
    document.getElementById('btn-toggle-results-arcflash').classList.toggle('active', rb.arcflash);
    document.getElementById('btn-toggle-results-cable').classList.toggle('active', rb.cable);
    document.getElementById('btn-toggle-results-motor').classList.toggle('active', rb.motor);
    document.getElementById('btn-toggle-results-dynmotor').classList.toggle('active', rb.dynMotor);
    document.getElementById('btn-toggle-results-duty').classList.toggle('active', rb.duty);
    document.getElementById('btn-toggle-results-loaddiversity').classList.toggle('active', rb.loadDiversity);
    document.getElementById('btn-toggle-results-grounding').classList.toggle('active', rb.grounding);
  }

  document.getElementById('btn-toggle-results-all').addEventListener('click', () => {
    const allOn = Object.values(AppState.showResultBoxes).every(Boolean);
    const newVal = !allOn;
    _toggleResultBoxes(Object.keys(AppState.showResultBoxes), newVal);
    _syncResultToggleButtons();
  });

  const _resultToggleMap = [
    ['btn-toggle-results-fault', 'fault'],
    ['btn-toggle-results-loadflow', 'loadflow'],
    ['btn-toggle-results-unbalanced', 'unbalancedLF'],
    ['btn-toggle-results-arcflash', 'arcflash'],
    ['btn-toggle-results-cable', 'cable'],
    ['btn-toggle-results-motor', 'motor'],
    ['btn-toggle-results-dynmotor', 'dynMotor'],
    ['btn-toggle-results-duty', 'duty'],
    ['btn-toggle-results-loaddiversity', 'loadDiversity'],
    ['btn-toggle-results-grounding', 'grounding'],
  ];
  for (const [btnId, key] of _resultToggleMap) {
    document.getElementById(btnId).addEventListener('click', () => {
      _toggleResultBoxes([key]);
      _syncResultToggleButtons();
    });
  }

  // Under-rated device flags toggle (on-diagram warning markers)
  const _ratingFlagsBtn = document.getElementById('btn-toggle-rating-flags');
  if (_ratingFlagsBtn) {
    _ratingFlagsBtn.addEventListener('click', () => {
      AppState.showRatingFlags = !AppState.showRatingFlags;
      _ratingFlagsBtn.classList.toggle('active', AppState.showRatingFlags);
      Canvas.render();
      document.getElementById('status-info').textContent =
        AppState.showRatingFlags ? 'Under-rated device flags shown.' : 'Under-rated device flags hidden.';
    });
  }

  // Reset annotation positions
  document.getElementById('btn-reset-annotation-positions').addEventListener('click', () => {
    Annotations.offsets.clear();
    Canvas.render();
    AppState.dirty = true;
  });

  // Restore result boxes hidden via the right-click menu (top-bar button,
  // shown only while something is hidden — visibility synced in render()).
  document.getElementById('btn-restore-results').addEventListener('click', () => {
    const n = Annotations.hiddenResultBoxes.size;
    Annotations.restoreAllResultBoxes();
    if (typeof UI !== 'undefined' && UI.toast && n > 0) {
      UI.toast(`Restored ${n} result box${n === 1 ? '' : 'es'}`, 'success');
    }
  });

  // Zoom controls
  document.getElementById('btn-zoom-fit').addEventListener('click', () => Canvas.zoomToFit());
  document.getElementById('btn-zoom-reset').addEventListener('click', () => {
    AppState.zoom = 1;
    AppState.panX = 0;
    AppState.panY = 0;
    Canvas.updateTransform();
  });

  // Settings modal
  document.getElementById('btn-settings').addEventListener('click', () => StandardData.open());
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
  });
  document.getElementById('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') {
      document.getElementById('settings-modal').style.display = 'none';
    }
  });
  document.getElementById('btn-save-settings').addEventListener('click', () => {
    AppState.baseMVA = parseFloat(document.getElementById('base-mva').value) || DEFAULT_BASE_MVA;
    AppState.frequency = parseInt(document.getElementById('base-freq').value) || DEFAULT_FREQUENCY;
    AppState.voltageFactor = parseFloat(document.getElementById('voltage-factor').value) || DEFAULT_VOLTAGE_FACTOR;
    AppState.defaultLengthUnit = document.getElementById('default-length-unit').value || 'm';
    AppState.clearResults();
    Canvas.render();
    document.getElementById('settings-modal').style.display = 'none';
    // Refresh properties if showing
    if (Properties.currentId) Properties.show(Properties.currentId);
  });

  // Properties panel resize
  const propResize = document.getElementById('properties-resize');
  let propResizing = false;
  propResize.addEventListener('mousedown', (e) => {
    propResizing = true;
    propResize.classList.add('active');
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!propResizing) return;
    const panel = document.getElementById('properties-panel');
    const newWidth = Math.max(240, Math.min(450, window.innerWidth - e.clientX));
    panel.style.width = newWidth + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (propResizing) {
      propResizing = false;
      propResize.classList.remove('active');
    }
  });

  // ─── Quick Access Bar ───
  const QUICK_ACCESS_ACTIONS = [
    // Analysis
    { id: 'fault', label: 'Fault Analysis', category: 'Analysis', btnId: 'btn-run-fault',
      icon: '<path d="M9 1L4 9h4l-1 6 7-8H9z" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'loadflow', label: 'Load Flow', category: 'Analysis', btnId: 'btn-run-loadflow',
      icon: '<path d="M2 8h12M10 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'unbalanced-lf', label: 'Unbalanced LF', category: 'Analysis', btnId: 'btn-run-unbalanced-loadflow',
      icon: '<path d="M2 5h12M2 8h9M2 11h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' },
    // Studies
    { id: 'cable-sizing', label: 'Cable Sizing', category: 'Studies', btnId: 'btn-cable-sizing',
      icon: '<path d="M2 8h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><path d="M5 5v6M11 5v6" stroke="currentColor" stroke-width="1.3"/>' },
    { id: 'motor-starting', label: 'Motor Starting', category: 'Studies', btnId: 'btn-motor-starting',
      icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><text x="5" y="11" font-size="8" fill="currentColor" font-weight="bold">M</text>' },
    { id: 'dynamic-motor', label: 'Dynamic Motor Starting', category: 'Studies', btnId: 'btn-dynamic-motor',
      icon: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 10.5c1.5 0 1.5-5 3-5s1.5 3.5 3 3.5 1.5-1.5 2-1.5" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
    { id: 'transient-stability', label: 'Transient Stability', category: 'Studies', btnId: 'btn-transient-stability',
      icon: '<path d="M2 12c1.5 0 2-8 4-8s2 10 4 10 2-6 4-6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' },
    { id: 'voltage-stability', label: 'Voltage Stability (P-V / Q-V)', category: 'Studies', btnId: 'btn-voltage-stability',
      icon: '<path d="M2 3c3 0 4.5 4 6 6s2.2 3 3 3c1.5 0 2-2 3-4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="11" cy="12" r="1.1" fill="currentColor"/>' },
    { id: 'contingency', label: 'Contingency (N-1 / N-2)', category: 'Studies', btnId: 'btn-contingency',
      icon: '<path d="M8 2l6 11H2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.4" r="0.8" fill="currentColor"/>' },
    { id: 'sequence-op', label: 'Sequence of Operation', category: 'Studies', btnId: 'btn-sequence-op',
      icon: '<path d="M2 13h12" stroke="currentColor" stroke-width="1.1" opacity="0.5"/><circle cx="4" cy="9" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="6" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.3 8.3L6.7 6.7M9.3 5.4l1.4-0.8" stroke="currentColor" stroke-width="1.1"/>' },
    { id: 'duty-check', label: 'Duty Check', category: 'Studies', btnId: 'btn-duty-check',
      icon: '<path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8l2 2 3.5-4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'load-diversity', label: 'Load Diversity', category: 'Studies', btnId: 'btn-load-diversity',
      icon: '<rect x="2" y="10" width="3" height="4" fill="currentColor" opacity="0.4"/><rect x="6.5" y="6" width="3" height="8" fill="currentColor" opacity="0.6"/><rect x="11" y="2" width="3" height="12" fill="currentColor" opacity="0.8"/>' },
    { id: 'grounding', label: 'Grounding', category: 'Studies', btnId: 'btn-grounding',
      icon: '<path d="M8 2v6" stroke="currentColor" stroke-width="1.5"/><path d="M4 8h8M5.5 10.5h5M7 13h2" stroke="currentColor" stroke-width="1.3"/>' },
    { id: 'study-manager', label: 'Run All Studies', category: 'Studies', btnId: 'btn-study-manager',
      icon: '<path d="M2 3h12M2 7h12M2 11h12" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M11 2l3 1.5L11 5M11 6l3 1.5L11 9M11 10l3 1.5L11 13" fill="currentColor" stroke="none"/>' },
    // Safety
    { id: 'arcflash', label: 'Arc Flash', category: 'Safety', btnId: 'btn-arcflash',
      icon: '<path d="M9 1L4 9h4l-1 6 7-8H9z" fill="#f57c00" stroke="#e65100" stroke-width="0.8"/><circle cx="7" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/>' },
    { id: 'dc-arcflash', label: 'DC Arc Flash', category: 'Safety', btnId: 'btn-dc-arcflash',
      icon: '<path d="M9 1L4 9h4l-1 6 7-8H9z" fill="#1976d2" stroke="#0d47a1" stroke-width="0.8"/><text x="1" y="14" font-size="6" font-weight="bold" fill="currentColor">DC</text>' },
    { id: 'tcc', label: 'TCC', category: 'Safety', btnId: 'btn-tcc',
      icon: '<rect x="2" y="2" width="12" height="12" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4 12 C5 10, 6 6, 7 4" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 12 C8.5 9, 10 5, 12 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="3 2"/>' },
    { id: 'compliance', label: 'Compliance', category: 'Safety', btnId: 'btn-compliance',
      icon: '<path d="M3 1h7l3 3v10a1 1 0 01-1 1H3a1 1 0 01-1-1V2a1 1 0 011-1z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5 8l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    // File
    { id: 'save', label: 'Save', category: 'File', btnId: 'btn-save',
      icon: '<path d="M2 1h9l3 3v9a2 2 0 01-2 2H2a2 2 0 01-2-2V3a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="4" y="1" width="6" height="4" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3" y="9" width="8" height="4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'export-pdf', label: 'Export PDF', category: 'File', btnId: 'btn-export-pdf',
      icon: '<path d="M3 1h7l3 3v9a2 2 0 01-2 2H3a2 2 0 01-2-2V3a2 2 0 012-2z" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 1v3h3" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    // Edit
    { id: 'undo', label: 'Undo', category: 'Edit', btnId: 'btn-undo',
      icon: '<path d="M4 7l-3-3 3-3M1 4h9a4 4 0 010 8H6" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'redo', label: 'Redo', category: 'Edit', btnId: 'btn-redo',
      icon: '<path d="M12 7l3-3-3-3M15 4H6a4 4 0 000 8h4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
  ];

  const QA_STORAGE_KEY = 'protectionpro-quick-access';
  const QA_DEFAULT_IDS = ['fault', 'loadflow', 'arcflash', 'save'];

  function qaLoadFavourites() {
    try {
      const stored = localStorage.getItem(QA_STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch (e) { /* ignore */ }
    return [...QA_DEFAULT_IDS];
  }

  function qaSaveFavourites(ids) {
    localStorage.setItem(QA_STORAGE_KEY, JSON.stringify(ids));
  }

  let qaFavourites = qaLoadFavourites();

  function qaRenderBar() {
    const container = document.getElementById('quick-access-items');
    container.innerHTML = '';
    if (qaFavourites.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'quick-access-empty';
      empty.textContent = 'Click + to add tools';
      container.appendChild(empty);
      return;
    }
    for (const actionId of qaFavourites) {
      const action = QUICK_ACCESS_ACTIONS.find(a => a.id === actionId);
      if (!action) continue;
      const btn = document.createElement('button');
      btn.className = 'quick-access-btn';
      btn.title = action.label;
      btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16">${action.icon}</svg><span>${action.label}</span>`;
      btn.addEventListener('click', () => {
        const target = document.getElementById(action.btnId);
        if (target) target.click();
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        qaFavourites = qaFavourites.filter(id => id !== actionId);
        qaSaveFavourites(qaFavourites);
        qaRenderBar();
      });
      container.appendChild(btn);
    }
  }

  // Quick Access editor modal
  const qaModal = document.getElementById('quick-access-modal');
  document.getElementById('btn-quick-access-edit').addEventListener('click', () => {
    qaRenderChecklist();
    qaModal.style.display = 'flex';
  });
  document.getElementById('btn-close-quick-access').addEventListener('click', () => {
    qaModal.style.display = 'none';
  });
  qaModal.addEventListener('click', (e) => {
    if (e.target === qaModal) qaModal.style.display = 'none';
  });

  function qaRenderChecklist() {
    const container = document.getElementById('quick-access-checklist');
    container.innerHTML = '';
    const categories = [...new Set(QUICK_ACCESS_ACTIONS.map(a => a.category))];
    for (const cat of categories) {
      const catLabel = document.createElement('div');
      catLabel.className = 'qa-category-label';
      catLabel.textContent = cat;
      container.appendChild(catLabel);
      for (const action of QUICK_ACCESS_ACTIONS.filter(a => a.category === cat)) {
        const item = document.createElement('label');
        item.className = 'qa-check-item';
        const checked = qaFavourites.includes(action.id) ? 'checked' : '';
        item.innerHTML = `<input type="checkbox" value="${action.id}" ${checked}><svg width="14" height="14" viewBox="0 0 16 16">${action.icon}</svg>${action.label}`;
        const checkbox = item.querySelector('input');
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) {
            if (!qaFavourites.includes(action.id)) qaFavourites.push(action.id);
          } else {
            qaFavourites = qaFavourites.filter(id => id !== action.id);
          }
          qaSaveFavourites(qaFavourites);
          qaRenderBar();
        });
        container.appendChild(item);
      }
    }
  }

  qaRenderBar();

  // Initial render
  Canvas.render();

  console.log('ProtectionPro initialized.');
});
