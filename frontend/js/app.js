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
        result = await API.runFaultAnalysis();
        AppState.faultResults = result;
      } else {
        result = await API.runLoadFlow();
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

  // TCC add device tab switching
  document.querySelectorAll('.tcc-add-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.tcc-add-tab').forEach(t => t.classList.remove('active'));
      e.target.classList.add('active');
      const which = e.target.dataset.tccAdd;
      document.getElementById('tcc-add-relay').style.display = which === 'relay' ? '' : 'none';
      document.getElementById('tcc-add-fuse').style.display = which === 'fuse' ? '' : 'none';
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

  // TCC grading margin update
  document.getElementById('tcc-grading-margin').addEventListener('change', (e) => {
    TCC.gradingMargin = parseFloat(e.target.value) || 0.3;
    TCC._runCoordinationCheck();
  });

  // Display toggles
  document.getElementById('btn-toggle-labels').addEventListener('click', (e) => {
    AppState.showCableLabels = !AppState.showCableLabels;
    e.currentTarget.classList.toggle('active', AppState.showCableLabels);
    Canvas.render();
  });
  document.getElementById('btn-toggle-warnings').addEventListener('click', (e) => {
    AppState.showWarnings = !AppState.showWarnings;
    e.currentTarget.classList.toggle('active', AppState.showWarnings);
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
