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
      console.error(`${label} error:`, e);
      document.getElementById('status-info').textContent = `${label} failed.`;
      showValidationModal(`${label} — Error`, [{ msg: e.message || 'Unknown error' }], [], null);
    }
  }

  document.getElementById('btn-run-fault').addEventListener('click', () => runAnalysis('fault'));
  document.getElementById('btn-run-loadflow').addEventListener('click', () => runAnalysis('loadflow'));

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
