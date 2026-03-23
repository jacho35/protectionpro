/* ProtectionPro — Main Application Entry Point */

document.addEventListener('DOMContentLoaded', () => {
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
  StandardData.init();
  TCC.init();
  UndoManager.init();
  MiniMap.init();

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
        window.closeAllToolbarMenus?.();
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
        AppState.faultedBusId = faultBusId;
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
      console.error(`${label} error:`, e);
      document.getElementById('status-info').textContent = `${label} failed.`;
      showValidationModal(`${label} — Error`, [{ msg: e.message || 'Unknown error' }], [], null);
    }
  }

  document.getElementById('btn-run-fault').addEventListener('click', () => runAnalysis('fault'));
  document.getElementById('btn-run-loadflow').addEventListener('click', () => runAnalysis('loadflow'));

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
    document.getElementById('status-info').textContent = 'Running arc flash analysis (IEEE 1584-2018)...';
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
    }
  }

  // ── DC Arc Flash Analysis ──
  document.getElementById('btn-dc-arcflash').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running DC arc flash analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running DC arc flash analysis (Stokes & Oppenlander)...';
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
    }
  });

  // ── Cable Sizing Analysis ──
  document.getElementById('btn-cable-sizing').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running cable sizing.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running cable sizing analysis...';
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
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
      const rowClass = c.status === 'fail' ? 'af-danger' : c.status === 'warning' ? 'af-medium' : 'af-low';
      const thermalIcon = c.thermal_ok ? '✓' : '✗';
      const vdropIcon = c.voltage_drop_ok ? '✓' : '✗';
      const withstandIcon = c.fault_withstand_ok ? '✓' : '✗';
      const statusBadge = c.status === 'pass' ? '<span style="color:#4caf50;font-weight:600">PASS</span>'
        : c.status === 'warning' ? '<span style="color:#f57c00;font-weight:600">WARN</span>'
        : '<span style="color:#d32f2f;font-weight:600">FAIL</span>';
      html += `<tr class="${rowClass}" data-cable-id="${c.cable_id}" style="cursor:pointer">
        <td>${c.cable_name}</td>
        <td>${c.from_bus} → ${c.to_bus}</td>
        <td>${c.load_current_a.toFixed(1)}</td>
        <td>${thermalIcon} ${c.thermal_loading_pct.toFixed(0)}%</td>
        <td>${vdropIcon} ${c.voltage_drop_pct.toFixed(2)}%</td>
        <td>${withstandIcon}</td>
        <td>${statusBadge}</td>
        <td>${c.status === 'warning' && c.warning_reasons && c.warning_reasons.length > 0
          ? `<span style="cursor:help;border-bottom:1px dotted #f57c00;color:#f57c00" title="${c.warning_reasons.join('; ').replace(/"/g, '&quot;')}">ⓘ Near limits</span>`
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
        body.innerHTML += '<div class="af-warnings">' + result.warnings.map(w => `<div class="af-warning-item">⚠ ${w}</div>`).join('') + '</div>';
      }
      modal.style.display = '';
      return;
    }

    let html = '';
    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
        <strong>${m.motor_name}</strong> ${statusBadge}
      </div>`;
      html += `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-size:12px;margin-bottom:8px">
        <div>Rated: <strong>${m.rated_kw} kW</strong></div>
        <div>Start Current: <strong>${m.start_current_a.toFixed(0)} A</strong></div>
        <div>Terminal Bus: <strong>${m.terminal_bus}</strong></div>
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

  // ── Equipment Duty Check ──
  document.getElementById('btn-duty-check').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running duty check.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running equipment duty check...';
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
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
          <td>${t.device_name}</td>
          <td>${t.location_bus}</td>
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
          <td>${d.device_name}</td>
          <td>${d.device_type.toUpperCase()}</td>
          <td>${d.location_bus}</td>
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

  // ── Load Diversity & Demand Factor ──
  document.getElementById('btn-load-diversity').addEventListener('click', async () => {
    if (AppState.components.size === 0) {
      document.getElementById('status-info').textContent = 'Add components before running load diversity analysis.';
      return;
    }
    document.getElementById('status-info').textContent = 'Running load diversity analysis...';
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
          <td>${t.transformer_name}</td>
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
          <td>${b.bus_name}</td>
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
              <td style="text-align:left">${l.load_name}</td><td>${typeLabel}</td>
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
    }
  });

  function showGroundingResults(result) {
    const modal = document.getElementById('grounding-modal');
    const body = document.getElementById('grounding-body');
    if (!modal || !body) return;

    const buses = result.buses || [];
    const summary = result.summary || {};

    let html = '';

    if (result.warnings && result.warnings.length > 0) {
      html += '<div class="af-warnings">';
      for (const w of result.warnings) html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
          <strong style="font-size:13px">${b.bus_name} (${b.voltage_kv} kV)</strong>
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
    const studyOrder = ['loadflow', 'fault', 'arcflash', 'cable_sizing', 'motor_starting', 'duty_check', 'load_diversity', 'grounding'];
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
        html += `<div style="font-size:11px;color:#d32f2f">${s.error}</div>`;
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
        html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
        <td>${b.bus_name || b.bus_id}</td>
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
        html += `<div class="af-warning-item">⚠ ${w}</div>`;
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
        <td>${b.bus_name || b.bus_id}</td>
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

    let html = `<p>Fault at <strong>${faultBusName}</strong> (${faultResult.voltage_kv} kV) — Retained voltage at other buses:</p>`;
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
        <td>${d.bus_name || d.id}</td>
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

  document.getElementById('btn-close-dc-arcflash').addEventListener('click', () => {
    document.getElementById('dc-arcflash-modal').style.display = 'none';
  });
  document.getElementById('dc-arcflash-modal').addEventListener('click', (e) => {
    if (e.target.id === 'dc-arcflash-modal') e.target.style.display = 'none';
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

  document.getElementById('btn-close-grounding').addEventListener('click', () => {
    document.getElementById('grounding-modal').style.display = 'none';
  });
  document.getElementById('grounding-modal').addEventListener('click', (e) => {
    if (e.target.id === 'grounding-modal') e.target.style.display = 'none';
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
      alert('Please import a CSV file or paste curve data.');
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
      btn.innerHTML = `<span class="page-tab-name">${page.name}</span>` +
        (AppState.pages.length > 1 ? `<span class="page-tab-close" title="Delete sheet">&times;</span>` : '');
      btn.addEventListener('click', (e) => {
        if (e.target.classList.contains('page-tab-close')) {
          if (confirm(`Delete "${page.name}"? Components on this page will be removed.`)) {
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
      btn.addEventListener('dblclick', () => {
        const newName = prompt('Rename sheet:', page.name);
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
      alert('PDF library (jsPDF) is not available. Please reload the page and try again.');
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
