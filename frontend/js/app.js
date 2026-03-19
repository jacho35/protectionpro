/* ProtectionPro — Main Application Entry Point */

document.addEventListener('DOMContentLoaded', () => {
  // Initialize all modules
  Canvas.init();
  Sidebar.init();
  Wiring.init();
  Properties.init();
  Annotations.init();
  Project.init();

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
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          for (const id of AppState.components.keys()) {
            AppState.selectedIds.add(id);
          }
          Canvas.render();
        }
        break;
    }
  });

  // Analysis buttons
  document.getElementById('btn-run-fault').addEventListener('click', async () => {
    const errors = Components.validate();
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.join('\n'));
      return;
    }
    document.getElementById('status-info').textContent = 'Running fault analysis...';
    try {
      const result = await API.runFaultAnalysis();
      AppState.faultResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Fault analysis complete.';
    } catch (e) {
      document.getElementById('status-info').textContent = 'Fault analysis failed: ' + e.message;
    }
  });

  document.getElementById('btn-run-loadflow').addEventListener('click', async () => {
    const errors = Components.validate();
    if (errors.length > 0) {
      alert('Validation errors:\n' + errors.join('\n'));
      return;
    }
    document.getElementById('status-info').textContent = 'Running load flow...';
    try {
      const result = await API.runLoadFlow();
      AppState.loadFlowResults = result;
      Canvas.render();
      document.getElementById('status-info').textContent = 'Load flow complete.';
    } catch (e) {
      document.getElementById('status-info').textContent = 'Load flow failed: ' + e.message;
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
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-modal').style.display = 'none';
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
