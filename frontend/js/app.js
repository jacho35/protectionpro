/* ProtectionPro — Main Application Entry Point */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  Canvas.init();
  Sidebar.init();
  Wiring.init();
  Properties.init();
  Annotations.init();
  Project.init();
  StandardData.init();
  TCC.init();
  UndoManager.init();
  MiniMap.init();

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
  });
  // Restore dark mode preference
  if (localStorage.getItem('protectionpro-dark-mode') === '1') {
    document.body.classList.add('dark-mode');
    document.getElementById('btn-dark-mode').classList.add('active');
  }

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't trigger if typing in an input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

    switch (e.key) {
      case 'v':
      case 'V':
        setMode(MODE.SELECT);
        break;
      case 'w':
      case 'W':
        setMode(MODE.WIRE);
        break;
      case 'Delete':
      case 'Backspace':
        AppState.deleteSelected();
        Canvas.render();
        Properties.clear();
        break;
      case 'Escape':
        if (AppState.wireStart) {
          Wiring.cancelWire();
        }
        AppState.clearSelection();
        setMode(MODE.SELECT);
        Canvas.render();
        Properties.clear();
        break;
      case 's':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          Project.saveProject();
        }
        break;
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          for (const id of AppState.components.keys()) {
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
      case 'v':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          AppState.pasteClipboard();
          Canvas.render();
          document.getElementById('status-info').textContent =
            `Pasted ${AppState.selectedIds.size} component(s).`;
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
        html += `<div class="validation-item validation-error">${e.msg}</div>`;
      }
      html += '</div>';
    }
    if (warnings.length > 0) {
      html += '<div class="validation-section"><div class="validation-section-title warning-title">Warnings</div>';
      for (const w of warnings) {
        html += `<div class="validation-item validation-warning">${w.msg}</div>`;
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

  async function executeAnalysis(type) {
    const label = type === 'fault' ? 'Fault analysis' : 'Load flow';
    document.getElementById('status-info').textContent = `Running ${label.toLowerCase()}...`;
    try {
      let result;
      if (type === 'fault') {
        // Determine if a single bus is selected
        let faultBusId = null;
        if (AppState.selectedIds.size === 1) {
          const selId = [...AppState.selectedIds][0];
          const selComp = AppState.components.get(selId);
          if (selComp && selComp.type === 'bus') {
            faultBusId = selId;
          }
        }
        const faultType = document.getElementById('fault-type').value || null;
        result = await API.runFaultAnalysis(faultBusId, faultType);
        AppState.faultResults = result;
        // Update status with context
        const busInfo = faultBusId ? ` on ${AppState.components.get(faultBusId)?.props?.name || faultBusId}` : ' on all buses';
        document.getElementById('status-info').textContent = `Fault analysis complete${busInfo}.`;
        Canvas.render();
        return;
      } else {
        const lfMethod = document.getElementById('loadflow-method').value;
        result = await API.runLoadFlow(lfMethod);
        AppState.loadFlowResults = result;
      }
      Canvas.render();
      document.getElementById('status-info').textContent = `${label} complete.`;
    } catch (e) {
      const msg = e.message || 'Unknown error';
      document.getElementById('status-info').textContent = `${label} failed.`;
      showValidationModal(`${label} — Error`, [{ msg: `${label} failed: ${msg}` }], [], null);
    }
  }

  document.getElementById('btn-run-fault').addEventListener('click', () => runAnalysis('fault'));
  document.getElementById('btn-run-loadflow').addEventListener('click', () => runAnalysis('loadflow'));

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

  // TCC grading margin update
  document.getElementById('tcc-grading-margin').addEventListener('change', (e) => {
    TCC.gradingMargin = parseFloat(e.target.value) || 0.3;
    TCC._runCoordinationCheck();
  });

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
      return `
        <div class="scenario-item" data-id="${s.id}">
          <div class="scenario-info">
            <div class="scenario-name">${escapeHtml(s.name)}</div>
            ${descHtml}
            <div class="scenario-meta">${date} &mdash; ${compCount} component${compCount !== 1 ? 's' : ''}</div>
          </div>
          <div class="scenario-actions">
            <button class="btn-load-scenario" data-id="${s.id}" title="Load this scenario">Load</button>
            <button class="btn-delete-scenario" data-id="${s.id}" title="Delete this scenario">&times;</button>
          </div>
        </div>`;
    }).join('');

    // Bind load buttons
    list.querySelectorAll('.btn-load-scenario').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!confirm('Load this scenario? Current unsaved changes will be replaced.')) return;
        const loaded = AppState.loadScenario(btn.dataset.id);
        if (loaded) {
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
      btn.addEventListener('click', () => {
        if (!confirm('Delete this scenario permanently?')) return;
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
    AppState.saveScenario(name, desc);
    document.getElementById('scenario-name').value = '';
    document.getElementById('scenario-desc').value = '';
    renderScenarioList();
    document.getElementById('status-info').textContent = `Scenario "${name}" saved.`;
  });

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

  // Initial render
  Canvas.render();

  console.log('ProtectionPro initialized.');
});
