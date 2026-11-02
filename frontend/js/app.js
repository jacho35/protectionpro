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
    // Keep menu open when clicking inside it (e.g. selects, View toggles).
    // Analyse items run a study, so they close it — left open, the panel sat
    // over the pre-run validation dialog and hid its Continue Anyway button.
    menu.querySelector('.toolbar-menu-panel').addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.id === 'menu-analyse' && e.target.closest('button.dropdown-item')) window.closeAllToolbarMenus();
    });
  });
  document.addEventListener('click', () => window.closeAllToolbarMenus());

  // Initialize all modules
  Canvas.init();
  if (typeof SldShapes !== 'undefined') SldShapes.init();
  Sidebar.init();
  Wiring.init();
  Properties.init();
  Annotations.init();
  Project.init();
  if (typeof ProjectSettings !== 'undefined') ProjectSettings.init();
  updateProjectNameDisplay();
  StandardData.init();
  TCC.init();
  UndoManager.init();
  Arrange.init();
  RevisionTimeline.init();
  MiniMap.init();
  ContextMenu.init();
  ControlSim.init();
  Retic.init();
  if (typeof PlanMarkup !== 'undefined') PlanMarkup.init();
  if (typeof Interlocking !== 'undefined') Interlocking.init();
  if (typeof Schedules !== 'undefined') Schedules.init();
  if (typeof Quantities !== 'undefined') Quantities.init();
  if (typeof Sync !== 'undefined') Sync.init();
  if (typeof StreetLight !== 'undefined') StreetLight.init();
  if (typeof Sharing !== 'undefined') Sharing.init();
  // Auth last: shows the login gate (a blocking modal) over the initialized —
  // but not-yet-interactable-behind-the-overlay — app until a session exists.
  if (typeof Auth !== 'undefined') Auth.init();

  // File-menu "Share…" → share the currently-open owned project.
  document.getElementById('btn-share')?.addEventListener('click', () => {
    window.closeAllToolbarMenus?.();
    if (!AppState.projectId) {
      UI.toast?.('Save the project first, then share it.', 'info');
      return;
    }
    if (Project._currentAccess && Project._currentAccess !== 'owner') {
      UI.toast?.('Only the project owner can share it.', 'warning');
      return;
    }
    Sharing.open(AppState.projectId, AppState.projectName);
  });

  // ─── Workspace switching (SLD / Reticulation / Plan) ───
  // Single authority for the three-way tab switch. Each secondary workspace
  // (Retic, Plan) keeps its own activate/deactivate body; this coordinator
  // guarantees mutual exclusion and owns the tab-button state so a third
  // workspace can't be left half-shown.
  function switchWorkspace(name) {
    const appc = document.getElementById('app-container');
    const reticWs = document.getElementById('retic-workspace');
    const planWs = document.getElementById('plan-workspace');
    const interlockWs = document.getElementById('interlock-workspace');
    const schedWs = document.getElementById('schedules-workspace');
    const slWs = document.getElementById('streetlight-workspace');
    const qWs = document.getElementById('quantities-workspace');
    const lWs = document.getElementById('lighting-workspace');
    const loWs = document.getElementById('lightov-workspace');
    const ovWs = document.getElementById('overview-workspace');
    // Rooms ('lighting') and Sports fields ('sports') share the Lighting pane.
    const lightPane = name === 'lighting' || name === 'sports';
    // Stand down whichever secondary workspace we're leaving.
    if (typeof Retic !== 'undefined' && Retic._active && name !== 'retic') Retic.deactivate();
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup._active && name !== 'plan') PlanMarkup.deactivate();
    if (typeof Interlocking !== 'undefined' && Interlocking._active && name !== 'interlock') Interlocking.deactivate();
    if (typeof Schedules !== 'undefined' && Schedules._active && name !== 'schedules') Schedules.deactivate();
    if (typeof StreetLight !== 'undefined' && StreetLight._active && name !== 'streetlight') StreetLight.deactivate();
    if (typeof Quantities !== 'undefined' && Quantities._active && name !== 'quantities') Quantities.deactivate();
    if (typeof LightingWS !== 'undefined' && LightingWS._active && !lightPane) LightingWS.deactivate();
    if (typeof LightOverview !== 'undefined' && LightOverview._active && name !== 'lightov') LightOverview.deactivate();
    if (typeof Overview !== 'undefined' && Overview._active && name !== 'overview') Overview.deactivate();

    appc.style.display = (name === 'sld') ? '' : 'none';
    if (reticWs) reticWs.style.display = (name === 'retic') ? 'flex' : 'none';
    if (planWs) planWs.style.display = (name === 'plan') ? 'flex' : 'none';
    if (interlockWs) interlockWs.style.display = (name === 'interlock') ? 'flex' : 'none';
    if (schedWs) schedWs.style.display = (name === 'schedules') ? 'flex' : 'none';
    if (slWs) slWs.style.display = (name === 'streetlight') ? 'flex' : 'none';
    if (qWs) qWs.style.display = (name === 'quantities') ? 'flex' : 'none';
    if (lWs) lWs.style.display = lightPane ? 'flex' : 'none';
    if (loWs) loWs.style.display = (name === 'lightov') ? 'flex' : 'none';
    if (ovWs) ovWs.style.display = (name === 'overview') ? 'flex' : 'none';
    window.activeWorkspace = name;
    // Mobile: flag secondary workspaces so the phone CSS hides SLD-only chrome
    // (FABs, selection bar, Components/Analysis nav) and fits the workspace
    // between the mobile header and bottom nav.
    document.body.classList.toggle('mobile-ws-secondary', name !== 'sld');
    // Desktop: row 2 of the header is the single-line toolbar; the other
    // workspaces bring their own, so the header drops to one row there.
    document.body.classList.toggle('ws-secondary-active', name !== 'sld');
    if (typeof window.closeAllToolbarMenus === 'function') window.closeAllToolbarMenus();

    for (const [key, id] of Object.entries(Workspaces.TAB_IDS)) {
      const b = document.getElementById(id);
      if (!b) continue;
      b.classList.toggle('active', key === name);
      b.setAttribute('aria-selected', key === name ? 'true' : 'false');
    }

    if (name === 'sld') { if (typeof Canvas !== 'undefined') Canvas.render(); }
    else if (name === 'retic') { Retic.activate(); }
    else if (name === 'plan' && typeof PlanMarkup !== 'undefined') { PlanMarkup.activate(); }
    else if (name === 'interlock' && typeof Interlocking !== 'undefined') { Interlocking.activate(); }
    else if (name === 'schedules' && typeof Schedules !== 'undefined') { Schedules.activate(); }
    else if (name === 'streetlight' && typeof StreetLight !== 'undefined') { StreetLight.activate(); }
    else if (name === 'quantities' && typeof Quantities !== 'undefined') { Quantities.activate(); }
    else if (lightPane && typeof LightingWS !== 'undefined') { LightingWS.activate(name === 'sports' ? 'sports' : null); }
    else if (name === 'lightov' && typeof LightOverview !== 'undefined') { LightOverview.activate(); }
    else if (name === 'overview' && typeof Overview !== 'undefined') { Overview.activate(); }
    // The results panel: docked on the single line, only Issues elsewhere.
    if (typeof ResultsPanel !== 'undefined' && ResultsPanel.render) ResultsPanel.render(true);
  }
  window.switchWorkspace = switchWorkspace;
  for (const [name, id] of [
    ['sld', 'btn-workspace-sld'],
    ['retic', 'btn-workspace-retic'],
    ['plan', 'btn-workspace-plan'],
    ['interlock', 'btn-workspace-interlock'],
    ['schedules', 'btn-workspace-schedules'],
    ['streetlight', 'btn-workspace-streetlight'],
    ['quantities', 'btn-workspace-quantities'],
    ['lighting', 'btn-workspace-lighting'],
    ['sports', 'btn-workspace-sports'],
    ['lightov', 'btn-workspace-lightov'],
    ['overview', 'btn-workspace-overview'],
  ]) {
    document.getElementById(id)?.addEventListener('click', () => switchWorkspace(name));
  }
  // Numbers change only by typing or pasting: no wheel / arrow-key stepping.
  if (typeof GridTable !== 'undefined') GridTable.initGlobal();
  // Workspace tabs follow the project type (after switchWorkspace exists).
  if (typeof Workspaces !== 'undefined') Workspaces.init();
  // Results menu contents + Ctrl K command search.
  if (typeof Header !== 'undefined') Header.init();

  // Templates button
  document.getElementById('btn-templates').addEventListener('click', () => NetworkTemplates.show());

  // Toolbar mode buttons
  const btnSelect = document.getElementById('btn-select');
  const btnWire = document.getElementById('btn-wire');
  const btnDelete = document.getElementById('btn-delete');

  function setMode(mode) {
    AppState.mode = mode;
    if (typeof SldShapes !== 'undefined' && SldShapes.tool) SldShapes.setTool(SldShapes.tool);
    const isWire = mode === MODE.WIRE;
    btnSelect.classList.toggle('active', mode === MODE.SELECT);
    btnWire.classList.toggle('active', isWire);
    Canvas.svg.classList.toggle('wiring', isWire);
    document.getElementById('status-mode').textContent = isWire ? 'Wire Mode' : 'Select Mode';
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

  // Edit menu items that previously existed only as shortcuts. Each replays
  // its key through the one keydown handler below, so menu and keyboard can
  // never drift apart (same guards, same status messages, same undo).
  for (const [id, key, ctrl] of [
    ['btn-edit-cut', 'x', true], ['btn-edit-copy', 'c', true], ['btn-edit-paste', 'v', true],
    ['btn-edit-duplicate', 'd', true], ['btn-edit-select-all', 'a', true], ['btn-edit-rotate', 'r', false],
  ]) {
    document.getElementById(id)?.addEventListener('click', () => {
      window.closeAllToolbarMenus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: ctrl, bubbles: true, cancelable: true }));
    });
  }
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

  // The save chip + autosave (savestate.js); the choice is in Settings › Preferences
  SaveState.init();
  AnalyseMenu.init();
  CaseRuns.init();
  WsHead.init();
  ProjectHistory.init();
  Project.startLocalBackup();
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

    // The Lighting tab's and the Road plan's 3D views: Ctrl+Z/Y drive the
    // plan's undo stack, the view's own keys (Delete, R, Ctrl+D) are handled
    // on its canvas, and the hidden SLD's shortcuts are suspended.
    if (typeof Light3D !== 'undefined' && Light3D._active && !modalIsOpen) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if (e.shiftKey || e.key === 'y' || e.key === 'Y') PlanMarkup.redo(); else PlanMarkup.undo();
        Light3D.render();
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

    // Street lighting › Road plan: its own undo stack and drawing keys; the
    // hidden SLD's shortcuts are suspended (Escape / Ctrl+S stay live).
    if (typeof RoadPlan !== 'undefined' && RoadPlan._active && !modalIsOpen) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) RoadPlan.redo(); else RoadPlan.undo();
        return;
      }
      if (ctrl && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        RoadPlan.redo();
        return;
      }
      if (!ctrl && RoadPlan.onKeydown(e)) { e.preventDefault(); return; }
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
        if (typeof SldShapes !== 'undefined' && SldShapes.deleteSelected()) break;
        AppState.deleteSelected();
        Canvas.render();
        Properties.clear();
        break;
      case 'Escape': {
        window.closeAllToolbarMenus?.();
        if (typeof ContextMenu !== 'undefined') ContextMenu.close();
        // Close the topmost open modal first, before touching the selection.
        // The login gate (#auth-modal) is non-dismissable — never close it.
        const openModal = [...document.querySelectorAll('.modal')].reverse()
          .find(m => m.style.display !== 'none' && m.id !== 'auth-modal');
        if (openModal) {
          if (openModal.id === 'tcc-modal' && typeof TCC !== 'undefined') {
            TCC.close();
          } else if (openModal.id === 'ds-modal' && typeof DrawingSet !== 'undefined') {
            DrawingSet.close();
          } else if (openModal.id === 'earth-grid-modal' && typeof EarthGridEditor !== 'undefined') {
            EarthGridEditor.close(); // asks before discarding unsaved grid edits
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
        if (typeof CableFocus !== 'undefined') CableFocus.disable();
        if (typeof SldShapes !== 'undefined') SldShapes.escape();
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
          if (!ResultView.available().length) break;
          const shown = ResultView.toggleAll();
          document.getElementById('status-info').textContent = shown ? 'Result boxes shown.' : 'Result boxes hidden.';
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
    // Re-draw the results view switch after visibility changed elsewhere
    // (the result-box right-click menu).
    refreshResultToggles() {
      if (typeof ResultView !== 'undefined') ResultView.render();
    },
    // Open the results panel on the study a result box belongs to (from its
    // stored results, no re-run).
    openResultBox(key) {
      const tab = { af: 'arcflash', dcaf: 'arcflash', cs: 'cable', dc: 'duty', ms: 'motor', dynms: 'dynMotor',
        ld: 'loadDiversity', gr: 'grounding', dclf: 'dcLoadflow', dcsc: 'dcShortCircuit', lf: 'loadflow', warn: 'loadflow',
        ulf: 'unbalancedLF', 'ulf-warn': 'unbalancedLF', fault: 'fault', vdep: 'fault' }[String(key).split(':')[0]];
      if (tab && ResultsPanel.has(tab)) ResultsPanel.open(tab, tab === 'arcflash' && String(key).startsWith('dcaf') ? { section: 'dc' } : {});
      else document.getElementById('btn-show-calc')?.click();   // the detailed calculations report
    },
  };

  // The series-fault and backup studies draw their own view in the results panel.
  Object.assign(ResultsPanel.VIEWS, {
    openConductor: (el, r) => renderOpenConductorResults(r, el),
    twoConductorOpen: (el, r) => renderTwoConductorOpenResults(r, el),
    simultaneousFault: (el, r) => renderSimultaneousFaultResults(r, el),
    backup: (el, r) => renderBackupResults(r, el),
  });

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
        if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('faultResults', { busId: faultBusId, type: faultType });
        // [PS-3] Companion minimum-current study (c_min = 0.95, [CT2]
        // conductors at their end-of-fault temperature) so the compliance disconnection check uses the current
        // that may actually flow. Non-fatal: compliance falls back (with a
        // warning) to the maximum-current figures if this fails.
        try {
          AppState.faultResultsMin = await API.runFaultAnalysisMin(faultBusId, faultType);
        } catch (minErr) {
          AppState.faultResultsMin = null;
          console.warn('Minimum-current fault study failed:', minErr);
        }
        document.getElementById('status-info').textContent = `Fault analysis complete on ${scopeInfo}.`;
        Canvas.render();
        return;
      } else {
        document.getElementById('status-info').textContent = 'Running load flow...';
        const lfMethod = document.getElementById('loadflow-method').value;
        result = await API.runLoadFlow(lfMethod);
        AppState.loadFlowResults = result;
        if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('loadFlowResults', { method: lfMethod });
      }
      Canvas.render();
      if (type === 'loadflow') {
        const deadBuses = Object.values(result.buses || {}).filter(b => b.energized === false);
        const islands = new Set((result.dispatch || []).map(d => d.island).filter(i => i > 0));
        let status = !result.converged
          ? 'Load flow did NOT converge — results are unreliable.'
          : result.solution_quality === 'low_voltage_root'
            ? `Load flow converged (${result.iterations} iter) to an implausibly low-voltage solution — likely a collapse root, not valid.`
            : `Load flow converged in ${result.iterations} iteration${result.iterations === 1 ? '' : 's'}.`;
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
        if (noteworthy) ResultsPanel.open('loadflow');
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
      ResultsPanel.open('loadflow', { section: 'dispatch' });
    } else {
      document.getElementById('status-info').textContent =
        'No load flow results yet — run a load flow first.';
    }
  });

  // Flow arrow toggle checkboxes
  document.getElementById('chk-fault-arrows').addEventListener('change', (e) => {
    AppState.showFlowArrows.fault = e.target.checked;
    AppState.dirty = true;
    Canvas.render();
  });
  document.getElementById('chk-loadflow-arrows').addEventListener('change', (e) => {
    AppState.showFlowArrows.loadflow = e.target.checked;
    AppState.dirty = true;
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
      if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('unbalancedLoadFlowResults', { method: lfMethod });
      Canvas.render();
      const vufMax = Math.max(...Object.values(result.buses).map(b => b.vuf_pct));
      const warnCount = result.warnings ? result.warnings.length : 0;
      statusEl.textContent = `Unbalanced load flow complete. Max VUF: ${vufMax.toFixed(2)}%` +
        (warnCount > 0 ? ` (${warnCount} warning${warnCount > 1 ? 's' : ''})` : '');
      // The count alone was a dead end — VUF exceedances, PV-bus Q caveats and
      // the zero-sequence coupling disclosure had no readable surface.
      if (warnCount > 0 || !result.converged) ResultsPanel.open('unbalancedLF');
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
    document.getElementById('status-info').textContent = 'Running arc flash analysis (IEEE 1584)...';
    _setBusy('btn-arcflash', true);
    try {
      const result = await API.runArcFlash();
      AppState.arcFlashResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Arc flash analysis complete.';
      ResultsPanel.open('arcflash');
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
      ResultsPanel.open('arcflash', { section: 'dc' });
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
        : (nBus > 0 ? 'DC load flow: an island cannot be supplied — see the warnings.'
                    : 'DC load flow: no DC buses found.');
      ResultsPanel.open('dcLoadflow');
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
      if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('dcShortCircuitResults', { busId: faultBusId });
      Canvas.render();
      const nBus = Object.keys(result.buses || {}).length;
      document.getElementById('status-info').textContent = result.converged
        ? `DC short circuit complete — ${nBus} DC bus${nBus === 1 ? '' : 'es'}.`
        : 'DC short circuit: no DC buses found.';
      ResultsPanel.open('dcShortCircuit');
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
      ResultsPanel.open('cable');
    } catch (e) {
      console.error('Cable sizing error:', e);
      document.getElementById('status-info').textContent = 'Cable sizing analysis failed.';
      showValidationModal('Cable Sizing — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-cable-sizing', false);
    }
  });

  // Bus the results table is filtered to (null = all cables). Follows the
  // diagram's cable focus when that is on.
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
      ResultsPanel.open('motor');
    } catch (e) {
      console.error('Motor starting error:', e);
      document.getElementById('status-info').textContent = 'Motor starting analysis failed.';
      showValidationModal('Motor Starting — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-motor-starting', false);
    }
  });


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

  // ── Frequency Scan (impedance vs frequency) ──
  document.getElementById('btn-frequency-scan').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running a frequency scan.';
      return;
    }
    FrequencyScan.openConfig();
  });
  document.getElementById('btn-fscan-run').addEventListener('click', () => FrequencyScan.runConfigured());
  document.getElementById('btn-fscan-cancel').addEventListener('click', () => {
    document.getElementById('fscan-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-fscan-config').addEventListener('click', () => {
    document.getElementById('fscan-config-modal').style.display = 'none';
  });

  // ── Optimal Capacitor Placement ──
  document.getElementById('btn-cap-placement').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running capacitor placement.';
      return;
    }
    CapPlacement.openConfig();
  });
  document.getElementById('btn-cpl-run').addEventListener('click', () => CapPlacement.runConfigured());
  document.getElementById('btn-cpl-cancel').addEventListener('click', () => {
    document.getElementById('cpl-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-cpl-config').addEventListener('click', () => {
    document.getElementById('cpl-config-modal').style.display = 'none';
  });

  // ── Passive Filter Sizing ──
  document.getElementById('btn-filter-sizing').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running filter sizing.';
      return;
    }
    FilterSizing.openConfig();
  });
  document.getElementById('btn-flt-run').addEventListener('click', () => FilterSizing.runConfigured());
  document.getElementById('btn-flt-cancel').addEventListener('click', () => {
    document.getElementById('flt-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-flt-config').addEventListener('click', () => {
    document.getElementById('flt-config-modal').style.display = 'none';
  });

  // ── Voltage Flicker (IEC 61000-3-3) ──
  document.getElementById('btn-flicker').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running the voltage flicker screening.';
      return;
    }
    Flicker.openConfig();
  });
  document.getElementById('btn-flk-run').addEventListener('click', () => Flicker.runConfigured());
  document.getElementById('btn-flk-cancel').addEventListener('click', () => {
    document.getElementById('flk-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-flk-config').addEventListener('click', () => {
    document.getElementById('flk-config-modal').style.display = 'none';
  });

  // ── Nodal Hosting Capacity ──
  document.getElementById('btn-hosting-capacity').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running the hosting capacity screening.';
      return;
    }
    HostingCapacity.openConfig();
  });
  document.getElementById('btn-hc-run').addEventListener('click', () => HostingCapacity.runConfigured());
  document.getElementById('btn-hc-cancel').addEventListener('click', () => {
    document.getElementById('hc-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-hc-config').addEventListener('click', () => {
    document.getElementById('hc-config-modal').style.display = 'none';
  });

  // ── Reliability Assessment ──
  document.getElementById('btn-reliability').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running the reliability assessment.';
      return;
    }
    Reliability.run();
  });

  // ── Optimal Power Flow ──
  document.getElementById('btn-opf').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running OPF.';
      return;
    }
    OPF.openConfig();
  });
  document.getElementById('btn-opf-run').addEventListener('click', () => OPF.runConfigured());
  document.getElementById('btn-opf-cancel').addEventListener('click', () => {
    document.getElementById('opf-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-opf-config').addEventListener('click', () => {
    document.getElementById('opf-config-modal').style.display = 'none';
  });

  // ── Battery Sizing & Discharge ──
  document.getElementById('btn-battery-sizing').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running battery sizing.';
      return;
    }
    BatterySizing.openConfig();
  });
  document.getElementById('btn-bsz-run').addEventListener('click', () => BatterySizing.runConfigured());
  document.getElementById('btn-bsz-cancel').addEventListener('click', () => {
    document.getElementById('bsz-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-bsz-config').addEventListener('click', () => {
    document.getElementById('bsz-config-modal').style.display = 'none';
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

  // ── Time-Series / Quasi-Dynamic Load Flow ──
  document.getElementById('btn-timeseries').addEventListener('click', () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add a network before running the time-series load flow.';
      return;
    }
    TimeSeries.openConfig();
  });
  document.getElementById('btn-tsl-run').addEventListener('click', () => TimeSeries.runConfigured());
  document.getElementById('btn-tsl-cancel').addEventListener('click', () => {
    document.getElementById('tsl-config-modal').style.display = 'none';
  });
  document.getElementById('btn-close-tsl-config').addEventListener('click', () => {
    document.getElementById('tsl-config-modal').style.display = 'none';
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
      ResultsPanel.open('duty');
    } catch (e) {
      console.error('Duty check error:', e);
      document.getElementById('status-info').textContent = 'Duty check failed.';
      showValidationModal('Duty Check — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-duty-check', false);
    }
  });

  // ── ANSI/IEEE C37.010 Fault Duty ──
  document.getElementById('btn-fault-ansi').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running fault duty analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running ANSI/IEEE C37.010 fault duty analysis...';
    _setBusy('btn-fault-ansi', true);
    try {
      const result = await API.runAnsiFaultAnalysis();
      AppState.ansiFaultResults = result;
      document.getElementById('status-info').textContent = 'ANSI fault duty analysis complete.';
      ResultsPanel.open('ansi');
    } catch (e) {
      console.error('ANSI fault duty error:', e);
      document.getElementById('status-info').textContent = 'ANSI fault duty analysis failed.';
      showValidationModal('Fault Duty (ANSI) — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-fault-ansi', false);
    }
  });

  // ── Open Conductor (Single-Phasing) Analysis ──
  document.getElementById('btn-open-conductor').addEventListener('click', async () => {
    const sel = [...AppState.selectedIds];
    const selComp = sel.length === 1 ? AppState.components.get(sel[0]) : null;
    if (!selComp || selComp.type !== 'cable') {
      document.getElementById('status-info').textContent =
        'Select a single cable/feeder (both ends on a bus) before running open-conductor analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running open-conductor analysis...';
    _setBusy('btn-open-conductor', true);
    try {
      const result = await API.runOpenConductorAnalysis(selComp.id);
      document.getElementById('status-info').textContent = 'Open-conductor analysis complete.';
      ResultsPanel.show('openConductor', result);
    } catch (e) {
      console.error('Open-conductor analysis error:', e);
      document.getElementById('status-info').textContent = 'Open-conductor analysis failed.';
      showValidationModal('Open Conductor — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-open-conductor', false);
    }
  });

  // Drawn into its tab of the results panel.
  function renderOpenConductorResults(result, body) {

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    html += `<p style="margin:4px 0 10px;font-size:12px;opacity:0.85">
      One conductor open on <strong>${escHtml(result.branch_name)}</strong>, between
      <strong>${escHtml(result.source_bus_name)}</strong> (source side) and
      <strong>${escHtml(result.load_bus_name)}</strong> (load side) — ${result.voltage_kv.toFixed(2)} kV,
      prefault current ${result.prefault_current_a.toFixed(1)} A. ${result.method}.
    </p>`;

    const npsClass = result.negative_seq_pct >= 40 ? 'af-danger' : result.negative_seq_pct >= 15 ? 'af-medium' : 'af-low';

    html += `<h4 style="margin:8px 0 4px">Sequence &amp; Phase Currents at the Break</h4>
    <table class="af-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Positive-sequence I₁</td><td>${result.ia1_ka.toFixed(3)} kA</td></tr>
        <tr class="${npsClass}"><td>Negative-sequence I₂ (motor single-phasing stress)</td><td>${result.ia2_ka.toFixed(3)} kA — ${result.negative_seq_pct.toFixed(1)}% of I₁</td></tr>
        <tr><td>Zero-sequence I₀</td><td>${result.ia0_ka.toFixed(3)} kA</td></tr>
        <tr><td>Healthy phase B current</td><td>${result.ib_ka.toFixed(3)} kA</td></tr>
        <tr><td>Healthy phase C current</td><td>${result.ic_ka.toFixed(3)} kA</td></tr>
        <tr><td>Residual/ground current (3·I₀)</td><td>${result.ig_ka.toFixed(3)} kA</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Downstream Bus Voltage (${escHtml(result.load_bus_name)})</h4>
    <table class="af-table">
      <thead><tr><th>Phase</th><th>Voltage (p.u.)</th></tr></thead>
      <tbody>
        <tr><td>Va</td><td>${result.downstream_va_pu.toFixed(3)}</td></tr>
        <tr><td>Vb</td><td>${result.downstream_vb_pu.toFixed(3)}</td></tr>
        <tr><td>Vc</td><td>${result.downstream_vc_pu.toFixed(3)}</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Sequence Impedances (p.u., total source+load side)</h4>
    <table class="af-table">
      <thead><tr><th>Network</th><th>R</th><th>X</th></tr></thead>
      <tbody>
        <tr><td>Z1</td><td>${result.z1_pu[0].toFixed(4)}</td><td>${result.z1_pu[1].toFixed(4)}</td></tr>
        <tr><td>Z2</td><td>${result.z2_pu[0].toFixed(4)}</td><td>${result.z2_pu[1].toFixed(4)}</td></tr>
        <tr><td>Z0</td><td>${result.z0_pu[0].toFixed(4)}</td><td>${result.z0_pu[1].toFixed(4)}</td></tr>
      </tbody>
    </table>`;

    body.innerHTML = html;
  }

  // ── Two-Conductor Open (Series-Fault Dual of SLG) Analysis ──
  document.getElementById('btn-two-conductor-open').addEventListener('click', async () => {
    const sel = [...AppState.selectedIds];
    const selComp = sel.length === 1 ? AppState.components.get(sel[0]) : null;
    if (!selComp || selComp.type !== 'cable') {
      document.getElementById('status-info').textContent =
        'Select a single cable/feeder (both ends on a bus) before running two-conductor-open analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running two-conductor-open analysis...';
    _setBusy('btn-two-conductor-open', true);
    try {
      const result = await API.runTwoConductorOpenAnalysis(selComp.id);
      document.getElementById('status-info').textContent = 'Two-conductor-open analysis complete.';
      ResultsPanel.show('twoConductorOpen', result);
    } catch (e) {
      console.error('Two-conductor-open analysis error:', e);
      document.getElementById('status-info').textContent = 'Two-conductor-open analysis failed.';
      showValidationModal('Two-Conductor Open — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-two-conductor-open', false);
    }
  });

  // Drawn into its tab of the results panel.
  function renderTwoConductorOpenResults(result, body) {

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    html += `<p style="margin:4px 0 10px;font-size:12px;opacity:0.85">
      Two conductors open on <strong>${escHtml(result.branch_name)}</strong> — only one phase survives —
      between <strong>${escHtml(result.source_bus_name)}</strong> (source side) and
      <strong>${escHtml(result.load_bus_name)}</strong> (load side) — ${result.voltage_kv.toFixed(2)} kV,
      prefault current ${result.prefault_current_a.toFixed(1)} A. ${result.method}.
    </p>`;

    html += `<h4 style="margin:8px 0 4px">Sequence &amp; Phase Currents at the Break</h4>
    <table class="af-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Positive-sequence I₁</td><td>${result.ia1_ka.toFixed(3)} kA</td></tr>
        <tr class="af-danger"><td>Negative-sequence I₂ (motor single-phasing stress)</td><td>${result.ia2_ka.toFixed(3)} kA — ${result.negative_seq_pct.toFixed(1)}% of I₁</td></tr>
        <tr><td>Zero-sequence I₀</td><td>${result.ia0_ka.toFixed(3)} kA</td></tr>
        <tr><td>Surviving phase current</td><td>${result.ia_ka.toFixed(3)} kA</td></tr>
        <tr><td>Residual/ground current (3·I₀)</td><td>${result.ig_ka.toFixed(3)} kA</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Downstream Bus Voltage (${escHtml(result.load_bus_name)})</h4>
    <table class="af-table">
      <thead><tr><th>Phase</th><th>Voltage (p.u.)</th></tr></thead>
      <tbody>
        <tr><td>Va (surviving)</td><td>${result.downstream_va_pu.toFixed(3)}</td></tr>
        <tr><td>Vb</td><td>${result.downstream_vb_pu.toFixed(3)}</td></tr>
        <tr><td>Vc</td><td>${result.downstream_vc_pu.toFixed(3)}</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Sequence Impedances (p.u., total source+load side)</h4>
    <table class="af-table">
      <thead><tr><th>Network</th><th>R</th><th>X</th></tr></thead>
      <tbody>
        <tr><td>Z1</td><td>${result.z1_pu[0].toFixed(4)}</td><td>${result.z1_pu[1].toFixed(4)}</td></tr>
        <tr><td>Z2</td><td>${result.z2_pu[0].toFixed(4)}</td><td>${result.z2_pu[1].toFixed(4)}</td></tr>
        <tr><td>Z0</td><td>${result.z0_pu[0].toFixed(4)}</td><td>${result.z0_pu[1].toFixed(4)}</td></tr>
      </tbody>
    </table>`;

    body.innerHTML = html;
  }

  // ── Simultaneous Series + Shunt Fault Analysis ──
  document.getElementById('btn-simultaneous-fault').addEventListener('click', async () => {
    const sel = [...AppState.selectedIds];
    const selComps = sel.map(id => AppState.components.get(id)).filter(Boolean);
    const branchComp = selComps.find(c => c.type === 'cable');
    const busComp = selComps.find(c => c.type === 'bus' || c.type === 'distribution_board');
    if (selComps.length !== 2 || !branchComp || !busComp) {
      document.getElementById('status-info').textContent =
        'Select exactly one cable/feeder (the series-fault branch) and one bus/board (the shunt-fault location) before running simultaneous fault analysis.';
      return;
    }
    const seriesType = document.getElementById('simultaneous-fault-series-type').value;
    const shuntType = document.getElementById('simultaneous-fault-shunt-type').value;
    document.getElementById('status-info').textContent = 'Running simultaneous fault analysis...';
    _setBusy('btn-simultaneous-fault', true);
    try {
      const result = await API.runSimultaneousFaultAnalysis(branchComp.id, seriesType, busComp.id, shuntType);
      document.getElementById('status-info').textContent = 'Simultaneous fault analysis complete.';
      ResultsPanel.show('simultaneousFault', result);
    } catch (e) {
      console.error('Simultaneous fault analysis error:', e);
      document.getElementById('status-info').textContent = 'Simultaneous fault analysis failed.';
      showValidationModal('Simultaneous Series + Shunt Fault — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-simultaneous-fault', false);
    }
  });

  // Drawn into its tab of the results panel.
  function renderSimultaneousFaultResults(result, body) {

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${escHtml(w)}</div>`;
      html += '</div>';
    }

    const seriesLabel = result.series_type === 'two_conductor_open' ? 'Two conductors open' : 'One conductor open';
    const shuntLabel = { '3phase': 'Three-phase', slg: 'Single line-ground', ll: 'Line-to-line', llg: 'Double line-ground' }[result.shunt_type] || result.shunt_type;

    html += `<p style="margin:4px 0 10px;font-size:12px;opacity:0.85">
      ${seriesLabel} on <strong>${escHtml(result.branch_name)}</strong>, between
      <strong>${escHtml(result.source_bus_name)}</strong> (source side) and
      <strong>${escHtml(result.load_bus_name)}</strong> (load side) — ${result.voltage_kv.toFixed(2)} kV,
      prefault current ${result.prefault_current_a.toFixed(1)} A —
      SIMULTANEOUS with a ${shuntLabel} fault at <strong>${escHtml(result.shunt_bus_name)}</strong>
      (${result.shunt_voltage_kv.toFixed(2)} kV). ${result.method}.
    </p>`;

    const npsClass = result.negative_seq_pct >= 40 ? 'af-danger' : result.negative_seq_pct >= 15 ? 'af-medium' : 'af-low';

    html += `<h4 style="margin:8px 0 4px">Series Fault — Sequence &amp; Phase Currents at the Break</h4>
    <table class="af-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Positive-sequence I₁</td><td>${result.ia1_ka.toFixed(3)} kA</td></tr>
        <tr class="${npsClass}"><td>Negative-sequence I₂</td><td>${result.ia2_ka.toFixed(3)} kA — ${result.negative_seq_pct.toFixed(1)}% of I₁</td></tr>
        <tr><td>Zero-sequence I₀</td><td>${result.ia0_ka.toFixed(3)} kA</td></tr>
        ${result.series_type === 'two_conductor_open'
          ? `<tr><td>Surviving phase current</td><td>${result.ia_ka.toFixed(3)} kA</td></tr>`
          : `<tr><td>Healthy phase B current</td><td>${result.ib_ka.toFixed(3)} kA</td></tr>
             <tr><td>Healthy phase C current</td><td>${result.ic_ka.toFixed(3)} kA</td></tr>`}
        <tr><td>Residual/ground current (3·I₀)</td><td>${result.ig_ka.toFixed(3)} kA</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Shunt Fault — Sequence &amp; Phase Currents at ${escHtml(result.shunt_bus_name)}</h4>
    <table class="af-table">
      <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Positive-sequence I₁</td><td>${result.ip1_ka.toFixed(3)} kA</td></tr>
        <tr><td>Negative-sequence I₂</td><td>${result.ip2_ka.toFixed(3)} kA</td></tr>
        <tr><td>Zero-sequence I₀</td><td>${result.ip0_ka.toFixed(3)} kA</td></tr>
        <tr><td>Phase A</td><td>${result.ipa_ka.toFixed(3)} kA</td></tr>
        <tr><td>Phase B</td><td>${result.ipb_ka.toFixed(3)} kA</td></tr>
        <tr><td>Phase C</td><td>${result.ipc_ka.toFixed(3)} kA</td></tr>
        <tr><td>Residual/ground current (3·I₀)</td><td>${result.ig_shunt_ka.toFixed(3)} kA</td></tr>
      </tbody>
    </table>

    <h4 style="margin:12px 0 4px">Coupling Impedances (p.u.)</h4>
    <table class="af-table">
      <thead><tr><th>Network</th><th>Za (break, R/X)</th><th>Zp (shunt, R/X)</th><th>Z transfer (R/X)</th></tr></thead>
      <tbody>
        <tr><td>Seq 1</td><td>${result.za1_pu[0].toFixed(4)} / ${result.za1_pu[1].toFixed(4)}</td><td>${result.zp1_pu[0].toFixed(4)} / ${result.zp1_pu[1].toFixed(4)}</td><td>${result.zfp1_pu[0].toFixed(4)} / ${result.zfp1_pu[1].toFixed(4)}</td></tr>
        <tr><td>Seq 2</td><td>${result.za2_pu[0].toFixed(4)} / ${result.za2_pu[1].toFixed(4)}</td><td>${result.zp2_pu[0].toFixed(4)} / ${result.zp2_pu[1].toFixed(4)}</td><td>${result.zfp2_pu[0].toFixed(4)} / ${result.zfp2_pu[1].toFixed(4)}</td></tr>
        <tr><td>Seq 0</td><td>${result.za0_pu[0].toFixed(4)} / ${result.za0_pu[1].toFixed(4)}</td><td>${result.zp0_pu[0].toFixed(4)} / ${result.zp0_pu[1].toFixed(4)}</td><td>${result.zfp0_pu[0].toFixed(4)} / ${result.zfp0_pu[1].toFixed(4)}</td></tr>
      </tbody>
    </table>`;

    body.innerHTML = html;
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
      document.getElementById('status-info').textContent = 'Backup autonomy study complete.';
      ResultsPanel.show('backup', result);
    } catch (e) {
      console.error('Backup study error:', e);
      document.getElementById('status-info').textContent = 'Backup autonomy study failed.';
      showValidationModal('Backup Autonomy — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-backup-study', false);
    }
  });

  // Drawn into its tab of the results panel.
  function renderBackupResults(result, body) {
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
          html += `<tr><td>${escHtml(s.name)}</td><td>${s.type === 'hybrid_pv' ? 'Hybrid PV' : s.type === 'generator' ? 'Generator' : 'BESS'}</td>
            <td>${s.inverter_kva.toFixed(1)}</td><td>${s.max_discharge_kw.toFixed(1)}</td>
            <td>${s.available_kwh == null ? 'fuel' : s.available_kwh.toFixed(1)}</td><td>${s.soc_pct == null ? '—' : s.soc_pct.toFixed(0) + '%'}</td>
            <td>${s.pv_kw_now.toFixed(1)}</td></tr>`;
        }
        html += '</tbody></table>';
      }
      for (const n of (isl.notes || [])) {
        html += `<p style="font-size:12px;color:#f57c00;margin:4px 0">⚠ ${escHtml(n)}</p>`;
      }
    }
    body.innerHTML = html;
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
      ResultsPanel.open('loadDiversity');
    } catch (e) {
      console.error('Load diversity error:', e);
      document.getElementById('status-info').textContent = 'Load diversity analysis failed.';
      showValidationModal('Load Diversity — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-load-diversity', false);
    }
  });


  // ── Grounding System Analysis (IEEE 80) ──
  document.getElementById('btn-grounding').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running grounding analysis.';
      return;
    }
    // Scope: with AC buses selected, offer to evaluate only those (as the
    // fault study does). Asked before the busy state so the dialog is in front.
    let busIds = null;
    const selBuses = [...AppState.selectedIds].map(id => AppState.components.get(id))
      .filter(c => c && c.type === 'bus' && String(c.props.system || 'ac').toLowerCase() !== 'dc');
    if (selBuses.length) {
      const names = selBuses.map(c => `"${c.props?.name || c.id}"`).join(', ');
      const one = selBuses.length === 1;
      if (await UI.confirm(`Run the grounding study on the selected bus${one ? '' : 'es'} ${names} ONLY?\n\n` +
          `OK = selected bus${one ? '' : 'es'} only — Cancel = all buses`,
          { title: 'Grounding Study Scope', okText: one ? 'Selected bus only' : 'Selected buses only', cancelText: 'All buses' })) {
        busIds = selBuses.map(c => c.id);
      }
    }
    const scopeInfo = busIds ? (busIds.length === 1 ? `bus ${selBuses[0].props?.name || busIds[0]}` : `${busIds.length} selected buses`) : 'all buses';
    document.getElementById('status-info').textContent = `Running grounding study on ${scopeInfo}...`;
    _setBusy('btn-grounding', true);
    try {
      const result = await API.runGroundingAnalysis(busIds);
      AppState.groundingResults = result;
      if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('groundingResults', { busIds });
      Canvas.render();
      document.getElementById('status-info').textContent = `Grounding study complete (${scopeInfo}).`;
      ResultsPanel.open('grounding');
    } catch (e) {
      console.error('Grounding analysis error:', e);
      document.getElementById('status-info').textContent = 'Grounding analysis failed.';
      showValidationModal('Grounding — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-grounding', false);
    }
  });

  // ── Harmonic Analysis (IEEE 519-2014 or IEC 61000) ──
  const _harmStdName = (std) => std === 'iec' ? 'IEC 61000-3-6 / 61000-2-4' : 'IEEE 519-2014';

  async function runHarmonicsStudy() {
    const std = AppState.harmonicsLimits === 'iec' ? 'iec' : 'ieee519';
    document.getElementById('status-info').textContent = `Running harmonic analysis (${_harmStdName(std)})...`;
    _setBusy('btn-harmonics', true);
    try {
      const result = await API.runHarmonics(document.getElementById('loadflow-method')?.value || 'newton_raphson');
      document.getElementById('status-info').textContent =
        `Harmonic analysis complete — ${_harmStdName(result.limits_standard)} `
        + (result.compliant ? 'compliant.' : 'limits exceeded.');
      ResultsPanel.show('harmonics', result);
    } catch (e) {
      console.error('Harmonic analysis error:', e);
      document.getElementById('status-info').textContent = 'Harmonic analysis failed.';
      showValidationModal('Harmonics — Error', [{ msg: e.message || 'Unknown error' }], [], null);
    } finally {
      _setBusy('btn-harmonics', false);
    }
  }

  document.getElementById('btn-harmonics').addEventListener('click', async () => {
    window.closeAllToolbarMenus?.();
    const hasVfd = [...AppState.components.values()].some(c => c.type === 'vfd');
    if (!hasVfd) {
      showValidationModal('Harmonic Analysis',
        [], [{ msg: 'Add a Variable Frequency Drive (VFD) — the harmonic study needs at least one harmonic current source.' }], null);
      return;
    }
    await runHarmonicsStudy();
  });



  // ── Wenner Four-Pin Test Interpreter (two-layer soil ρ1/ρ2/h1 fit) ──
  let wennerReadings = [
    { a: 1, rhoa: '' }, { a: 2, rhoa: '' }, { a: 4, rhoa: '' }, { a: 8, rhoa: '' }, { a: 16, rhoa: '' },
  ];
  let wennerFit = null;

  function renderWennerTable() {
    const tbody = document.getElementById('wenner-rows');
    if (!tbody) return;
    tbody.innerHTML = wennerReadings.map((r, i) => `
      <tr>
        <td><input type="number" step="0.1" min="0" value="${escHtml(r.a)}" data-wenner-field="a" data-wenner-idx="${i}" style="width:90px"></td>
        <td><input type="number" step="0.1" min="0" value="${escHtml(r.rhoa)}" data-wenner-field="rhoa" data-wenner-idx="${i}" style="width:110px"></td>
        <td><button class="modal-close" style="font-size:14px" data-wenner-remove="${i}" title="Remove reading">&times;</button></td>
      </tr>`).join('');
  }

  document.getElementById('btn-wenner').addEventListener('click', () => {
    window.closeAllToolbarMenus?.();
    document.getElementById('wenner-results').innerHTML = '';
    renderWennerTable();
    document.getElementById('wenner-modal').style.display = '';
  });

  GridTable.attach(document.getElementById('wenner-rows'));   // Excel-style readings grid
  document.getElementById('wenner-rows').addEventListener('input', (e) => {
    const idx = e.target.getAttribute('data-wenner-idx');
    const field = e.target.getAttribute('data-wenner-field');
    if (idx === null || !field) return;
    wennerReadings[+idx][field] = e.target.value;
  });

  document.getElementById('wenner-rows').addEventListener('click', (e) => {
    const idx = e.target.getAttribute('data-wenner-remove');
    if (idx === null) return;
    wennerReadings.splice(+idx, 1);
    renderWennerTable();
  });

  document.getElementById('btn-wenner-add-row').addEventListener('click', () => {
    wennerReadings.push({ a: '', rhoa: '' });
    renderWennerTable();
  });

  document.getElementById('btn-wenner-run').addEventListener('click', async () => {
    const readings = wennerReadings
      .map(r => ({ spacing_m: parseFloat(r.a), apparent_resistivity_ohm_m: parseFloat(r.rhoa) }))
      .filter(r => r.spacing_m > 0 && r.apparent_resistivity_ohm_m > 0);
    const resultsDiv = document.getElementById('wenner-results');
    if (readings.length < 3) {
      resultsDiv.innerHTML = '<div class="af-warning-item">⚠ Need at least 3 valid spacing/resistivity readings at distinct spacings.</div>';
      return;
    }
    resultsDiv.innerHTML = '<p style="font-size:12px;color:var(--text-secondary)">Interpreting…</p>';
    try {
      const fit = await API.runWennerInterpret(readings);
      wennerFit = fit;
      let html = `<div style="background:var(--bg-secondary);border-radius:6px;padding:10px 14px;margin-bottom:10px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px 16px;font-size:12px">
          <div>ρ₁ (upper): <strong>${fit.rho1_ohm_m} Ω·m</strong></div>
          <div>ρ₂ (lower): <strong>${fit.rho2_ohm_m} Ω·m</strong></div>
          <div>h₁ (thickness): <strong>${fit.upper_layer_thickness_m} m</strong></div>
          <div>Fit RMSE: <strong>${fit.rmse_pct}%</strong></div>
        </div>
      </div>`;
      html += `<table class="data-table" style="width:100%;font-size:11px;margin-bottom:10px"><thead><tr>
        <th>a (m)</th><th>Measured (Ω·m)</th><th>Fitted (Ω·m)</th><th>Error %</th></tr></thead><tbody>`;
      for (const p of fit.points) {
        html += `<tr><td style="text-align:center">${p.spacing_m}</td><td style="text-align:center">${p.measured_ohm_m.toFixed(1)}</td>
          <td style="text-align:center">${p.fitted_ohm_m.toFixed(1)}</td><td style="text-align:center">${p.error_pct}</td></tr>`;
      }
      html += '</tbody></table>';

      const selectedBuses = [...AppState.selectedIds].map(id => AppState.components.get(id)).filter(c => c && c.type === 'bus');
      const label = selectedBuses.length ? `${selectedBuses.length} Selected Bus${selectedBuses.length === 1 ? '' : 'es'}` : 'Selected Bus';
      html += `<button id="btn-wenner-apply" class="btn btn-primary" style="font-size:12px" ${selectedBuses.length ? '' : 'disabled'}>Apply to ${label}</button>`;
      if (!selectedBuses.length) html += `<span style="margin-left:10px;font-size:11px;color:var(--text-secondary)">Select one or more buses on the canvas first, then click Apply.</span>`;

      resultsDiv.innerHTML = html;

      const applyBtn = document.getElementById('btn-wenner-apply');
      if (applyBtn && selectedBuses.length) {
        applyBtn.addEventListener('click', () => {
          if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
          for (const bus of selectedBuses) {
            bus.props.two_layer_soil = 'on';
            bus.props.soil_type = 'custom';
            bus.props.soil_resistivity = wennerFit.rho1_ohm_m;
            bus.props.soil_resistivity_lower = wennerFit.rho2_ohm_m;
            bus.props.upper_layer_thickness = wennerFit.upper_layer_thickness_m;
          }
          document.getElementById('status-info').textContent =
            `Applied two-layer soil model (ρ1=${wennerFit.rho1_ohm_m}, ρ2=${wennerFit.rho2_ohm_m}, h1=${wennerFit.upper_layer_thickness_m} m) to ${selectedBuses.length} bus${selectedBuses.length === 1 ? '' : 'es'}.`;
          if (typeof Properties !== 'undefined' && Properties.currentId) Properties.show(Properties.currentId);
          document.getElementById('wenner-modal').style.display = 'none';
        });
      }
    } catch (e) {
      console.error('Wenner interpretation error:', e);
      resultsDiv.innerHTML = `<div class="af-warning-item">⚠ ${escHtml(e.message || 'Interpretation failed')}</div>`;
    }
  });

  document.getElementById('btn-close-wenner').addEventListener('click', () => {
    document.getElementById('wenner-modal').style.display = 'none';
  });
  document.getElementById('wenner-modal').addEventListener('click', (e) => {
    if (e.target.id === 'wenner-modal') e.target.style.display = 'none';
  });

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
    edition: ['lr-edition', 'str'], tolerable_risk: ['lr-rt', 'num'],
  };
  // 2024-only form fields, saved raw in `ui24` and turned into the request's
  // `v2024` block by lightning2024Input().
  const LR24_FIELDS = {
    dens: ['lr24-dens', 'str'], k: ['lr24-k', 'num'], constr: ['lr24-constr', 'str'],
    loss: ['lr24-loss', 'str'], life: ['lr24-life', 'bool'], expl: ['lr24-expl', 'str'],
    touch: ['lr24-touch', 'str'], liion: ['lr24-liion', 'bool'],
    expEn: ['lr24-exp-en', 'bool'], expHours: ['lr24-exp-hours', 'num'], expFloor: ['lr24-exp-floor', 'str'],
    expTouch: ['lr24-exp-touch', 'str'], expDirect: ['lr24-exp-direct', 'bool'],
    l1Hv: ['lr24-l1-hv', 'bool'], l1HvLen: ['lr24-l1-hvlen', 'num'], l2Kind: ['lr24-l2-kind', 'str'],
    uwp: ['lr24-uwp', 'num'], ks3p: ['lr24-ks3p', 'str'], uwt: ['lr24-uwt', 'num'], ks3t: ['lr24-ks3t', 'str'],
    eb: ['lr24-eb', 'str'], ft: ['lr24-ft', 'num'],
  };
  const _lrRead = (fields) => {
    const o = {};
    for (const [key, [id, kind]] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (!el) continue;
      o[key] = kind === 'num' ? parseFloat(el.value) || 0 : kind === 'bool' ? el.checked : el.value;
    }
    return o;
  };
  const _lrWrite = (fields, o) => {
    for (const [key, [id, kind]] of Object.entries(fields)) {
      const el = document.getElementById(id);
      if (!el || o[key] === undefined) continue;
      if (kind === 'bool') el.checked = !!o[key];
      else el.value = o[key];
    }
  };

  // IEC 62305-2:2024 request block from the form: one inside zone (plus an
  // optional exposed zone), the power line (LV section, optional HV section)
  // and the telecom line, and one internal system per connected service.
  function lightning2024Input(p, u) {
    const k = u.k > 0 ? u.k : 2;
    const lines = [], systems = [];
    const power = p.lines.find(l => l.type === 'power');
    const tel = p.lines.find(l => l.type === 'telecom');
    if (power) {
      const sections = [{ length_m: power.length_m, installation: power.installation, line_type: 'lv', environment: power.environment }];
      if (u.l1Hv) sections.push({ length_m: u.l1HvLen || 1000, installation: power.installation, line_type: 'hv', environment: power.environment });
      lines.push({ name: 'Power supply', type: 'power', shield: power.screen || 'unshielded', sections });
      systems.push({ type: 'power', line: 'Power supply', uw_kv: u.uwp || 2.5, wiring: u.ks3p || 'different_routing', spd_level: p.spd_level });
    }
    if (tel && u.l2Kind !== 'fibre') {
      if (u.l2Kind !== 'fibre_copper') {
        lines.push({ name: 'Telecom', type: 'telecom', shield: tel.screen || 'unshielded',
          sections: [{ length_m: tel.length_m, installation: tel.installation, line_type: 'lv', environment: tel.environment }] });
      }
      systems.push({ type: 'telecom', line: u.l2Kind === 'fibre_copper' ? null : 'Telecom', uw_kv: u.uwt || 1.5,
        wiring: u.ks3t || 'different_routing', spd_level: p.spd_level });
    }
    const zones = [{
      name: 'Inside the building', kind: 'inside', hours_present: p.hours_per_year, equipment_hours: 8760,
      floor: p.floor_type, touch_measure: u.touch || 'none',
      fire_risk: u.expl && u.expl !== 'none' ? u.expl : p.fire_risk, fire_protection: p.fire_protection,
      lithium_ion: !!u.liion, loss_class: u.loss || 'normal', life_critical: !!u.life,
      systems, tolerable_frequency: u.ft || 0.1,
    }];
    if (u.expEn) {
      zones.push({ name: 'Roof / outside', kind: 'exposed', hours_present: u.expHours || 0, floor: u.expFloor,
        touch_measure: u.expTouch || 'none', persons_exposed: !!u.expDirect, fire_risk: 'none', loss_class: 'low' });
    }
    const nsg = u.dens === 'nsg' ? p.ground_flash_density : k * p.ground_flash_density;
    return { strike_density: nsg, k, construction: u.constr || 'masonry', lps_class: p.lps_class,
      eb_level: u.eb || 'none', lines, zones };
  }

  function collectLightningParams() {
    const p = _lrRead(LR_FIELDS);
    p.persons_total = p.persons_in_zone;  // single-zone assessment
    p.lines = [];
    if (document.getElementById('lr-line1-en').checked) {
      p.lines.push({
        name: 'Power supply', type: 'power',
        length_m: parseFloat(document.getElementById('lr-line1-len').value) || 1000,
        installation: document.getElementById('lr-line1-inst').value,
        environment: document.getElementById('lr-line1-env').value,
        has_transformer: document.getElementById('lr-line1-tx').checked,
        screen: document.getElementById('lr-line1-screen').value || 'unshielded',
      });
    }
    if (document.getElementById('lr-line2-en').checked) {
      p.lines.push({
        name: 'Telecom', type: 'telecom',
        length_m: parseFloat(document.getElementById('lr-line2-len').value) || 1000,
        installation: document.getElementById('lr-line2-inst').value,
        environment: document.getElementById('lr-line2-env').value,
        has_transformer: false,
        screen: document.getElementById('lr-line2-screen').value || 'unshielded',
      });
    }
    p.ui24 = _lrRead(LR24_FIELDS);
    if (p.edition === '2024') p.v2024 = lightning2024Input(p, p.ui24);
    return p;
  }

  function restoreLightningParams(p) {
    if (!p) return;
    // A saved assessment from before editions existed is a 2010 one [E1];
    // the old combined hospital/hotel/school card reads as a hospital [LR1].
    const q = Object.assign({ edition: '2010' }, p);
    if (q.structure_use === 'hospital_hotel_school') q.structure_use = 'hospital';
    _lrWrite(LR_FIELDS, q);
    if (q.ui24) _lrWrite(LR24_FIELDS, q.ui24);
    const power = (q.lines || []).find(l => l.type === 'power');
    const telecom = (q.lines || []).find(l => l.type === 'telecom');
    // [LR5] saved lines carry only `shielded` (read as bonded, R_S <= 1 ohm/km)
    const screen = (l) => l.screen || (l.shielded ? 'bonded_rs_le1' : 'unshielded');
    document.getElementById('lr-line1-en').checked = !!power;
    if (power) {
      document.getElementById('lr-line1-len').value = power.length_m;
      document.getElementById('lr-line1-inst').value = power.installation;
      document.getElementById('lr-line1-env').value = power.environment;
      document.getElementById('lr-line1-tx').checked = !!power.has_transformer;
      document.getElementById('lr-line1-screen').value = screen(power);
    }
    document.getElementById('lr-line2-en').checked = !!telecom;
    if (telecom) {
      document.getElementById('lr-line2-len').value = telecom.length_m;
      document.getElementById('lr-line2-inst').value = telecom.installation;
      document.getElementById('lr-line2-env').value = telecom.environment;
      document.getElementById('lr-line2-screen').value = screen(telecom);
    }
  }

  // The dialog, its named assessments and the PDF report live in lightning.js;
  // it reads and writes the form through these two functions.
  LightningUI.collect = collectLightningParams;
  LightningUI.restore = restoreLightningParams;
  LightningUI.init();
  document.getElementById('btn-lightning').addEventListener('click', () => LightningUI.openModal());
  document.getElementById('btn-earth-grids').addEventListener('click', () => {
    window.closeAllToolbarMenus?.();
    EarthGridEditor.open({ busId: [...AppState.selectedIds].find(id => (AppState.components.get(id) || {}).type === 'bus') || null });
  });

  document.getElementById('btn-run-lightning').addEventListener('click', async () => {
    const params = collectLightningParams();
    LightningUI.saveInputs();   // the assessment keeps what was entered, run or not
    _setBusy('btn-run-lightning', true);
    try {
      const res = await API.runLightningRisk(params);
      LightningUI.storeResult(params, res);
      LightningUI.showResults(res);
      document.getElementById('status-info').textContent = 'Lightning risk assessment complete.';
    } catch (e) {
      console.error('Lightning risk error:', e);
      LightningUI.showError(e.message || 'Assessment failed');
    } finally {
      _setBusy('btn-run-lightning', false);
    }
  });

  // ── Raceway / Conduit Fill ──
  const CONDUIT_SIZES = [20, 25, 32, 40, 50, 63, 75, 90, 110, 125, 160];
  let _racewaySeq = 1;
  // grouping tables that describe cables in a conduit/duct (not trays or direct burial)
  const RACEWAY_GROUPINGS = ['bunched', 'ducts_mc_touching', 'ducts_mc_025m', 'ducts_mc_05m',
    'ducts_mc_1m', 'ducts_sc_touching', 'ducts_sc_025m', 'ducts_sc_05m', 'ducts_sc_1m'];

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
            <input type="number" data-rw-id-mm="${rw.id}" value="${escHtml(rw.custom_id_mm || '')}" placeholder="auto" style="width:70px" min="0" step="0.1"></label>
          <label title="IEC 60364-5-52 grouping table for the factor applied to every cable's rating">Grouping
            <select data-rw-grouping="${rw.id}">${RACEWAY_GROUPINGS.map(k =>
              `<option value="${k}" ${(rw.grouping || 'bunched') === k ? 'selected' : ''}>${escHtml(IEC_GROUPING_LABELS[k] || k)}</option>`).join('')}</select></label>
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
    list.querySelectorAll('[data-rw-grouping]').forEach(el => el.addEventListener('change', () => {
      const rw = AppState.raceways.find(r => r.id === el.dataset.rwGrouping);
      if (rw) rw.grouping = el.value;
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
      grouping: rw.grouping || 'bunched',
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
          // a rating locked from the ampacity calculator already carries its
          // own grouping factor — the raceway must not apply it twice
          included_grouping_factor: (comp.props.ampacity && comp.props.ampacity.applied)
            ? (IecAmpacity.groupFactor(comp.props.ampacity.grouping,
                 comp.props.ampacity.circuits || 1).factor || 1)
            : 1,
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
      html += `<div style="border:1px solid var(--border-color);border-left:4px solid ${escHtml(color)};border-radius:6px;padding:10px 12px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px">
          <strong>${escHtml(rw.name)} — ${rw.conduit_nominal_mm} mm conduit (ID ${rw.conduit_id_mm} mm)</strong>
          <span style="color:${escHtml(color)};font-weight:600">${rw.status.toUpperCase()}</span>
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
      const runCurrent = CaseRuns.currentOn();
      const others = CaseRuns.selectedCases();
      if (others.length) await CaseRuns.runCases(others, enabled, statusEl);
      if (!runCurrent) {
        statusEl.textContent = `Ran ${enabled.length} studies on ${others.length} case${others.length === 1 ? '' : 's'}.`;
        document.getElementById('status-info').textContent = 'Batch run complete.';
        btn.disabled = false;
        CaseRuns.render();
        AnalyseMenu.syncManager();
        return;
      }
      statusEl.textContent = `Running ${enabled.length} studies on the current network…`;
      const result = await API.runStudyManager(enabled);
      AppState.studyManagerResults = result;

      // Distribute individual study results to their AppState slots
      const studies = result.studies || {};
      if (studies.fault && studies.fault.result) {
        AppState.faultResults = studies.fault.result;
        if (typeof StaleResults !== 'undefined') StaleResults.noteArgs('faultResults', { busId: null, type: null });
      }
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
      CaseRuns.render();
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
      return `${counts.buses} buses, max PPE category ${counts.max_ppe_category}`
        + (counts.danger > 0 ? `, ${counts.danger} above 40 cal/cm² (DANGER)` : '');
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






  document.getElementById('dynamic-motor-config-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dynamic-motor-config-modal') e.target.style.display = 'none';
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

  // Close through LightningUI so a pending autosave of the inputs lands first.
  document.getElementById('btn-close-lightning').addEventListener('click', () => LightningUI.close());
  document.getElementById('lightning-modal').addEventListener('click', (e) => {
    if (e.target.id === 'lightning-modal') LightningUI.close();
  });

  document.getElementById('btn-close-study-manager').addEventListener('click', () => {
    document.getElementById('study-manager-modal').style.display = 'none';
  });
  document.getElementById('study-manager-modal').addEventListener('click', (e) => {
    if (e.target.id === 'study-manager-modal') e.target.style.display = 'none';
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
    e.currentTarget.classList.toggle('active', TCC.showFaultMarkers);
    e.currentTarget.setAttribute('aria-pressed', TCC.showFaultMarkers);
    TCC.render();
  });

  // TCC compare mode toggle
  document.getElementById('btn-tcc-compare').addEventListener('click', (e) => {
    TCC.compareMode = !TCC.compareMode;
    e.currentTarget.classList.toggle('active', TCC.compareMode);
    e.currentTarget.setAttribute('aria-pressed', TCC.compareMode);
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
    TCC.setGradingMargin(parseFloat(e.target.value) || 0.3);
    TCC._runCoordinationCheck();
  });

  // Auto-coordination, miscoordination detection & sequence verification buttons
  document.getElementById('btn-tcc-auto-coord').addEventListener('click', () => TCC.autoCoordinate());
  document.getElementById('btn-tcc-detect-miscord').addEventListener('click', () => TCC.detectMiscoordination());
  document.getElementById('btn-tcc-verify-seq').addEventListener('click', () => TCC.verifySequenceOfOperation());
  document.getElementById('btn-tcc-grade-distance').addEventListener('click', () => TCC.gradeDistanceZones());

  // ─── Cases (the Cases manager: casesmanager.js) ───
  CasesManager.init();

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

    // Embed diagram as SVG → PNG, fit to the available area preserving aspect
    // ratio. Project._prepareExportSVG gives a tight bounding box of the
    // WHOLE diagram, independent of the editor's current pan/zoom — the same
    // path the Diagram SVG/PNG/PDF exports already use — instead of a raw
    // clone of the live, possibly-panned/zoomed #sld-canvas with no
    // viewBox/intrinsic size. _rasterizeSVG then rasterizes it at a fixed
    // pixel scale (independent of the page's physical size) and the fit
    // below scales THAT into the page slot without stretching/distorting it.
    const { clone, svgW, svgH } = Project._prepareExportSVG();
    Project._rasterizeSVG(clone, svgW, svgH, 3, (canvas) => {
      const diagramArea = { w: pw - 2 * margin - 10, h: ph - 2 * margin - (showTitleBlock ? 40 : 10) };
      const fitScale = Math.min(diagramArea.w / svgW, diagramArea.h / svgH);
      const imgW = svgW * fitScale;
      const imgH = svgH * fitScale;
      const imgX = margin + 5 + (diagramArea.w - imgW) / 2;
      const imgY = margin + 5 + (diagramArea.h - imgH) / 2;
      const imgData = canvas.toDataURL('image/png');
      doc.addImage(imgData, 'PNG', imgX, imgY, imgW, imgH);

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
    });
  }

  // Physical page dimensions (mm) matching the #print-page-size options.
  const _PRINT_PAGE_MM = { a4: [210, 297], a3: [297, 420], letter: [215.9, 279.4], tabloid: [279.4, 431.8] };

  function _printPreview() {
    // Use browser print with a styled window. Reuse the same tight,
    // pan/zoom-independent bounding box as the other diagram exports (see
    // _exportPrintPDF above) so the preview always shows — and prints — the
    // whole diagram at its correct aspect ratio, not whatever happens to be
    // panned/zoomed into view with no defined print size.
    const pageSize = document.getElementById('print-page-size').value;
    const orientation = document.getElementById('print-orientation').value;
    const { clone, svgW, svgH } = Project._prepareExportSVG();
    clone.setAttribute('width', svgW);
    clone.setAttribute('height', svgH);
    const svgData = new XMLSerializer().serializeToString(clone);
    const printWin = window.open('', '_blank', 'width=900,height=650');
    if (!printWin) {
      UI.toast('Print preview was blocked by the browser popup blocker. Please allow popups for this site and try again, or use "Export PDF" instead.', 'error', 6000);
      return;
    }
    const [mmA, mmB] = _PRINT_PAGE_MM[pageSize] || _PRINT_PAGE_MM.a4;
    const [pageW, pageH] = orientation === 'landscape' ? [Math.max(mmA, mmB), Math.min(mmA, mmB)] : [Math.min(mmA, mmB), Math.max(mmA, mmB)];
    printWin.document.write(`<!DOCTYPE html><html><head><title>Print Preview</title>
      <style>
        @page { size: ${pageW}mm ${pageH}mm; margin: 10mm; }
        body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;background:#fff;}
        svg{max-width:100%;max-height:100%;}
      </style></head>
      <body>${svgData}</body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => printWin.print(), 500);
  }

  // Display toggles
  document.getElementById('btn-toggle-labels').addEventListener('click', (e) => {
    AppState.showCableLabels = !AppState.showCableLabels;
    AppState.dirty = true;
    e.currentTarget.classList.toggle('active', AppState.showCableLabels);
    Canvas.render();
  });
  document.getElementById('btn-toggle-devices').addEventListener('click', (e) => {
    AppState.showDeviceLabels = !AppState.showDeviceLabels;
    AppState.dirty = true;
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
    AppState.dirty = true;
    e.currentTarget.classList.toggle('active', AppState.showWarnings);
    Canvas.render();
  });
  document.getElementById('btn-toggle-angles').addEventListener('click', (e) => {
    AppState.showFaultAngles = !AppState.showFaultAngles;
    AppState.dirty = true;
    e.currentTarget.classList.toggle('active', AppState.showFaultAngles);
    Canvas.render();
  });
  document.getElementById('btn-toggle-branch-detail').addEventListener('click', (e) => {
    AppState.branchFlowDetailed = !AppState.branchFlowDetailed;
    AppState.dirty = true;
    e.currentTarget.classList.toggle('active', AppState.branchFlowDetailed);
    Canvas.render();
  });

  // Put the toolbar toggles in step with AppState (after a project loads or resets).
  function syncViewToggles() {
    const on = (id, v) => { const el = document.getElementById(id); if (el) el.classList.toggle('active', !!v); };
    on('btn-toggle-labels', AppState.showCableLabels);
    on('btn-toggle-devices', AppState.showDeviceLabels);
    on('btn-toggle-warnings', AppState.showWarnings);
    on('btn-toggle-angles', AppState.showFaultAngles);
    on('btn-toggle-branch-detail', AppState.branchFlowDetailed);
    on('btn-toggle-rating-flags', AppState.showRatingFlags);
    const fa = document.getElementById('chk-fault-arrows'); if (fa) fa.checked = !!AppState.showFlowArrows.fault;
    const la = document.getElementById('chk-loadflow-arrows'); if (la) la.checked = !!AppState.showFlowArrows.loadflow;
    if (typeof ResultView !== 'undefined') ResultView.render();
  }
  window.syncViewToggles = syncViewToggles;

  // Cable sizing bus focus — the properties-panel button (and the results
  // view's Values popover, which redraws with the canvas)
  function syncCableFocusButtons() {
    const on = typeof CableFocus !== 'undefined' && CableFocus.active;
    if (typeof ResultView !== 'undefined') ResultView.render();
    const pb = document.getElementById('btn-bus-cable-focus');
    if (pb) {
      const mine = on && CableFocus.busId === pb.dataset.busId;
      pb.classList.toggle('active', mine);
      pb.setAttribute('aria-pressed', mine ? 'true' : 'false');
      pb.lastChild.textContent = mine ? ' Showing only these cables' : ' Show only these cables on the diagram';
    }
  }
  window.syncCableFocusButtons = syncCableFocusButtons;
  // Under-rated device flags toggle (on-diagram warning markers)
  const _ratingFlagsBtn = document.getElementById('btn-toggle-rating-flags');
  if (_ratingFlagsBtn) {
    _ratingFlagsBtn.addEventListener('click', () => {
      AppState.showRatingFlags = !AppState.showRatingFlags;
      AppState.dirty = true;
      _ratingFlagsBtn.classList.toggle('active', AppState.showRatingFlags);
      Canvas.render();
      document.getElementById('status-info').textContent =
        AppState.showRatingFlags ? 'Under-rated device flags shown.' : 'Under-rated device flags hidden.';
    });
  }

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
  // Personal preferences (the project's own values are in Project settings)
  document.getElementById('pref-dark').addEventListener('change', (e) => {
    if (document.body.classList.contains('dark-mode') !== e.target.checked) document.getElementById('btn-dark-mode').click();
  });
  document.getElementById('pref-autosave').addEventListener('change', (e) => SaveState.setAuto(e.target.checked));
  document.getElementById('pref-open-last').addEventListener('change', (e) => {
    if (typeof StartScreen !== 'undefined') StartScreen.setOpenLast(e.target.checked);
  });
  document.getElementById('btn-settings-to-project').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
    ProjectSettings.open();
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
    { id: 'timeseries', label: 'Time-Series Load Flow', category: 'Studies', btnId: 'btn-timeseries',
      icon: '<path d="M2 9c1.5-4 3-6 5-6s2 5 4 5 2-3 3-3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>' },
    { id: 'sequence-op', label: 'Sequence of Operation', category: 'Studies', btnId: 'btn-sequence-op',
      icon: '<path d="M2 13h12" stroke="currentColor" stroke-width="1.1" opacity="0.5"/><circle cx="4" cy="9" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="8" cy="6" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.3 8.3L6.7 6.7M9.3 5.4l1.4-0.8" stroke="currentColor" stroke-width="1.1"/>' },
    { id: 'duty-check', label: 'Duty Check', category: 'Studies', btnId: 'btn-duty-check',
      icon: '<path d="M8 1L2 4v4c0 3.5 2.5 6.5 6 7.5 3.5-1 6-4 6-7.5V4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.5 8l2 2 3.5-4" fill="none" stroke="currentColor" stroke-width="1.5"/>' },
    { id: 'fault-ansi', label: 'Fault Duty (ANSI C37.010)', category: 'Studies', btnId: 'btn-fault-ansi',
      icon: '<rect x="2" y="2" width="12" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>' },
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
