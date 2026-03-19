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
        } else {
          AppState.clearSelection();
          Canvas.render();
          Properties.clear();
        }
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
