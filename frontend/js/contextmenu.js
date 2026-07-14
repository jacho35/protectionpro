/* ProtectionPro — Right-click context menu for the SLD canvas.
 *
 * One reusable floating menu, context-sensitive by hit target (component /
 * wire / empty canvas). Items reuse the toolbar's .dropdown-item styling so
 * hover, disabled and dark-mode looks are inherited.
 */

const ContextMenu = {
  el: null,

  init() {
    this.el = document.getElementById('context-menu');
    // Dismiss on any outside mousedown (menu itself stops propagation)
    document.addEventListener('mousedown', (e) => {
      if (this.el && this.el.style.display !== 'none' && !this.el.contains(e.target)) {
        this.close();
      }
    });
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    // Never show the browser menu on our menu
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  close() {
    if (this.el) {
      this.el.style.display = 'none';
      this.el.innerHTML = '';
    }
  },

  /** items: array of {label, shortcut?, disabled?, checked?, danger?, action} or '---' */
  open(items, clientX, clientY) {
    if (!this.el) return;
    this.el.innerHTML = '';
    for (const item of items) {
      if (item === '---') {
        const div = document.createElement('div');
        div.className = 'dropdown-divider';
        this.el.appendChild(div);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'dropdown-item' + (item.checked ? ' active' : '');
      btn.disabled = !!item.disabled;
      if (item.danger) btn.classList.add('context-danger');
      const labelSpan = document.createElement('span');
      labelSpan.textContent = item.label;
      btn.appendChild(labelSpan);
      if (item.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'dropdown-shortcut';
        sc.textContent = item.shortcut;
        btn.appendChild(sc);
      }
      btn.addEventListener('click', () => {
        this.close();
        item.action();
      });
      this.el.appendChild(btn);
    }

    // Show off-screen first to measure, then clamp into the viewport
    this.el.style.visibility = 'hidden';
    this.el.style.display = '';
    const rect = this.el.getBoundingClientRect();
    const x = Math.min(clientX, window.innerWidth - rect.width - 4);
    const y = Math.min(clientY, window.innerHeight - rect.height - 4);
    this.el.style.left = `${Math.max(4, x)}px`;
    this.el.style.top = `${Math.max(4, y)}px`;
    this.el.style.visibility = '';
  },

  // ── Context builders ─────────────────────────────────────────────

  openForComponent(comp, clientX, clientY) {
    const items = [];
    const selCount = AppState.selectedIds.size;
    const many = selCount > 1;
    const status = (msg) => { document.getElementById('status-info').textContent = msg; };

    // CB / switch: open-close toggle — the headline action
    if (comp.type === 'cb' || comp.type === 'switch') {
      const isOpen = comp.props.state === 'open';
      items.push({
        label: isOpen ? 'Close' : 'Open',
        action: () => this._toggleSwitchgear(comp),
      });
      items.push('---');
    }

    if (comp.type === 'bus') {
      items.push({
        label: 'Run Fault Analysis Here',
        action: () => {
          AppState.select(comp.id);
          Canvas.render();
          window.AppActions?.runFaultAtBus?.(comp.id);
        },
      });
      items.push('---');
    }

    // Loads/motors: fault at the component's terminal (end-of-feeder fault)
    if (['motor_induction', 'motor_synchronous', 'static_load'].includes(comp.type)
        && typeof Properties !== 'undefined' && Properties.faultAtTerminal) {
      items.push({
        label: 'Fault at Terminal',
        action: () => Properties.faultAtTerminal(comp.id),
      });
      items.push('---');
    }

    if (['cb', 'fuse', 'relay'].includes(comp.type) && typeof TCC !== 'undefined') {
      items.push({
        label: 'View TCC Grading',
        action: () => TCC.openForDevice(comp.id),
      });
    }

    if (comp.type === 'distribution_board' && typeof DBSchedule !== 'undefined') {
      items.push({
        label: 'Edit Circuit Schedule',
        action: () => DBSchedule.open(comp.id),
      });
    }

    items.push({
      label: 'Properties',
      action: () => Properties.show(comp.id),
    });
    items.push({
      label: many ? `Rotate ${selCount} Components 90°` : 'Rotate 90°',
      shortcut: 'R',
      action: () => {
        let rotated = 0;
        for (const id of AppState.selectedIds) {
          const c = AppState.components.get(id);
          if (c) { c.rotation = ((c.rotation || 0) + 90) % 360; rotated++; }
        }
        if (rotated > 0) {
          AppState.dirty = true;
          UndoManager.snapshot();
          Canvas.render();
          if (Properties.currentId && AppState.selectedIds.has(Properties.currentId)) {
            Properties.show(Properties.currentId);
          }
          status(`Rotated ${rotated} component(s) 90°.`);
        }
      },
    });

    items.push('---');
    items.push({
      label: many ? `Copy (${selCount})` : 'Copy',
      shortcut: 'Ctrl+C',
      action: () => {
        AppState.copySelected();
        status(`Copied ${AppState.clipboard?.components.length || 0} component(s).`);
      },
    });
    items.push({
      label: many ? `Cut (${selCount})` : 'Cut',
      shortcut: 'Ctrl+X',
      action: () => {
        AppState.copySelected();
        AppState.deleteSelected();
        Canvas.render();
        Properties.clear();
        status('Cut to clipboard.');
      },
    });
    items.push({
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      action: () => {
        AppState.copySelected();
        AppState.pasteClipboard();
        Canvas.render();
      },
    });
    items.push({
      label: many ? `Delete (${selCount})` : 'Delete',
      shortcut: 'Del',
      danger: true,
      action: () => {
        AppState.deleteSelected();
        Canvas.render();
        Properties.clear();
      },
    });

    // Group / ungroup
    const anyGrouped = [...AppState.selectedIds]
      .some(id => AppState.components.get(id)?.groupId);
    if (selCount >= 2 || anyGrouped) {
      items.push('---');
      if (selCount >= 2) {
        items.push({
          label: 'Group',
          shortcut: 'Ctrl+G',
          action: () => {
            const group = AppState.createGroup();
            if (group) {
              Canvas.render();
              status(`Created group: ${group.name}`);
            }
          },
        });
      }
      if (anyGrouped) {
        items.push({
          label: 'Ungroup',
          shortcut: 'Ctrl+Shift+G',
          action: () => {
            AppState.ungroupSelected();
            Canvas.render();
            status('Ungrouped selected components.');
          },
        });
      }
    }

    this.open(items, clientX, clientY);
  },

  openForWire(wire, worldPt, clientX, clientY) {
    const activeMode = wire.routeMode || AppState.wireRouteMode || 'orthogonal';
    const routeItem = (mode, label) => ({
      label,
      checked: activeMode === mode,
      action: () => {
        wire.routeMode = mode;
        AppState.dirty = true;
        UndoManager.snapshot();
        Canvas.render();
      },
    });
    const items = [
      {
        label: 'Add Bend Point',
        shortcut: 'Dbl-click',
        action: () => Canvas.addWireBendPoint(wire.id, worldPt),
      },
      {
        label: 'Reset Route',
        disabled: typeof wire.midY !== 'number' && !(wire.bendPoints && wire.bendPoints.length),
        action: () => {
          delete wire.midY;
          wire.bendPoints = [];
          AppState.dirty = true;
          UndoManager.snapshot();
          Canvas.render();
        },
      },
      '---',
      routeItem('orthogonal', 'Route: Orthogonal'),
      routeItem('diagonal', 'Route: Diagonal'),
      routeItem('spline', 'Route: Spline'),
      '---',
      {
        label: 'Delete Wire',
        shortcut: 'Del',
        danger: true,
        action: () => {
          AppState.removeWire(wire.id);
          AppState.selectedIds.delete(wire.id);
          AppState.dirty = true;
          UndoManager.snapshot();
          Canvas.render();
        },
      },
    ];
    this.open(items, clientX, clientY);
  },

  openForCanvas(worldPt, clientX, clientY) {
    const hasClipboard = !!(AppState.clipboard && AppState.clipboard.components
      && AppState.clipboard.components.length > 0);
    const items = [
      {
        label: 'Paste Here',
        shortcut: 'Ctrl+V',
        disabled: !hasClipboard,
        action: () => {
          // Target point makes pasteClipboard() position the components at
          // the cursor BEFORE its undo snapshot, so undo/redo keep the spot.
          AppState.pasteClipboard(worldPt);
          Canvas.render();
          document.getElementById('status-info').textContent =
            `Pasted ${AppState.selectedIds.size} component(s).`;
        },
      },
      '---',
      {
        label: 'Select All',
        shortcut: 'Ctrl+A',
        action: () => {
          for (const id of AppState.getActivePageComponents().keys()) {
            AppState.selectedIds.add(id);
          }
          Canvas.render();
        },
      },
      {
        label: 'Zoom to Fit',
        action: () => Canvas.zoomToFit(),
      },
    ];
    this.open(items, clientX, clientY);
  },

  // Open/close a CB or switch with the same commit ritual as a
  // properties-panel edit (results cleared, undo snapshot, re-render)
  _toggleSwitchgear(comp) {
    // Editing the live network while a load-flow case is previewed would be
    // masked: the diagram draws the case's breaker state, so a live toggle
    // looks stuck. Return to the live view first so the edit is visible.
    if (typeof LFStudy !== 'undefined' && LFStudy.clearPreview &&
        typeof AppState !== 'undefined' && AppState.lfPreviewCaseId) {
      LFStudy.clearPreview();
    }
    const opening = comp.props.state !== 'open';
    comp.props.state = opening ? 'open' : 'closed';
    AppState.dirty = true;
    if (typeof Properties !== 'undefined' && Properties._notifyResultsCleared) {
      Properties._notifyResultsCleared();
    }
    AppState.clearResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    Canvas.render();
    if (typeof Properties !== 'undefined' && Properties.currentId === comp.id) {
      Properties.show(comp.id);
    }
    document.getElementById('status-info').textContent =
      `${comp.props.name || comp.type} ${opening ? 'opened' : 'closed'} — re-run studies to update results.`;
  },
};
