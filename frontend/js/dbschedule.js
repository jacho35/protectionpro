/* ProtectionPro — Distribution Board circuit schedule editor.
 *
 * A distribution board's ways live in comp.props.circuits:
 *   { way, description, poles ('1P'|'3P'), phase ('R'|'W'|'B'|'RWB'),
 *     breaker_a, curve ('B'|'C'|'D'), el_group, load_va, demand_factor,
 *     cable_mm2, cable_m }
 *
 * The board is analysed as a LUMPED load: on every save (and on
 * board_diversity edits) recompute() writes static-load-equivalent props
 * (rated_kva, demand_factor, phase_a/b/c_pct) that the load flow, unbalanced
 * load flow and diversity engines read exactly like a static load's.
 * SA phase convention: R→A, W→B, B→C.
 */

const DBSchedule = {
  modal: null,
  body: null,
  currentId: null,

  init() {
    this.modal = document.getElementById('db-modal');
    this.body = document.getElementById('db-modal-body');
    document.getElementById('db-modal-close').addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
  },

  open(compId) {
    const comp = AppState.components.get(compId);
    if (!comp || comp.type !== 'distribution_board') return;
    this.currentId = compId;
    if (!Array.isArray(comp.props.circuits)) comp.props.circuits = [];
    document.getElementById('db-modal-title').textContent =
      `Circuit Schedule — ${comp.props.name || compId}`;
    this.render();
    this.modal.style.display = '';
  },

  close(commit = true) {
    if (this.modal) this.modal.style.display = 'none';
    if (commit && this.currentId) {
      const comp = AppState.components.get(this.currentId);
      if (comp) {
        this.recompute(comp);
        AppState.dirty = true;
        if (typeof Properties !== 'undefined') {
          Properties._notifyResultsCleared();
        }
        AppState.clearResults();
        if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
        Canvas.render();
        if (typeof Properties !== 'undefined' && Properties.currentId === comp.id) {
          Properties.show(comp.id);
        }
      }
    }
    this.currentId = null;
  },

  // ── Derived lumped-load equivalents ────────────────────────────────
  // rated_kva  = total connected load
  // demand_factor = (Σ way VA × way DF × board diversity) / connected
  // phase_a/b/c_pct = share of DIVERSIFIED demand per phase (3P ways split /3)
  recompute(comp) {
    const circuits = comp.props.circuits || [];
    const boardDf = comp.props.board_diversity || 1.0;
    let connectedVa = 0;
    const phaseVa = { R: 0, W: 0, B: 0 };
    let demandVa = 0;
    for (const c of circuits) {
      const va = Number(c.load_va) || 0;
      const df = Number(c.demand_factor) || 1;
      connectedVa += va;
      const d = va * df;
      demandVa += d;
      if (c.poles === '3P' || c.phase === 'RWB') {
        phaseVa.R += d / 3; phaseVa.W += d / 3; phaseVa.B += d / 3;
      } else {
        phaseVa[c.phase || 'R'] = (phaseVa[c.phase || 'R'] || 0) + d;
      }
    }
    demandVa *= boardDf;

    comp.props.rated_kva = Math.round(connectedVa / 10) / 100;   // kVA, 2dp
    comp.props.demand_factor = connectedVa > 0
      ? Math.round((demandVa / connectedVa) * 10000) / 10000 : 1.0;
    const phTotal = phaseVa.R + phaseVa.W + phaseVa.B;
    if (phTotal > 0) {
      comp.props.phase_a_pct = Math.round(phaseVa.R / phTotal * 10000) / 100;
      comp.props.phase_b_pct = Math.round(phaseVa.W / phTotal * 10000) / 100;
      comp.props.phase_c_pct = Math.round(phaseVa.B / phTotal * 10000) / 100;
    } else {
      comp.props.phase_a_pct = 33.33;
      comp.props.phase_b_pct = 33.33;
      comp.props.phase_c_pct = 33.34;
    }
    comp.props.phase_connection = '3P';
    // Exact figures for display (props round for the analyses)
    return { connectedKva: connectedVa / 1000, demandKva: demandVa / 1000, phaseVa };
  },

  // Reassign 1P ways across R/W/B for best balance (largest-first greedy).
  // 3P ways are inherently balanced and left untouched.
  autoBalance(comp) {
    const circuits = comp.props.circuits || [];
    const singles = circuits
      .filter(c => (c.poles || '1P') !== '3P')
      .map(c => ({ c, va: (Number(c.load_va) || 0) * (Number(c.demand_factor) || 1) }))
      .sort((a, b) => b.va - a.va);
    const totals = { R: 0, W: 0, B: 0 };
    for (const s of singles) {
      const phase = Object.keys(totals).reduce((min, p) => totals[p] < totals[min] ? p : min, 'R');
      s.c.phase = phase;
      totals[phase] += s.va;
    }
    return singles.length;
  },

  // ── Rendering ───────────────────────────────────────────────────────
  render() {
    const comp = AppState.components.get(this.currentId);
    if (!comp) return;
    const circuits = comp.props.circuits;

    const opt = (v, cur, label) =>
      `<option value="${v}"${v === cur ? ' selected' : ''}>${label ?? v}</option>`;

    const rows = circuits.map((c, i) => `
      <tr data-idx="${i}">
        <td><input type="text" data-k="way" value="${escHtml(c.way ?? String(i + 1))}" style="width:44px"></td>
        <td><input type="text" data-k="description" value="${escHtml(c.description || '')}" style="width:100%;min-width:220px"></td>
        <td><select data-k="poles">${opt('1P', c.poles || '1P')}${opt('3P', c.poles || '1P')}</select></td>
        <td><select data-k="phase" ${((c.poles || '1P') === '3P') ? 'disabled' : ''}>
          ${opt('R', c.phase || 'R')}${opt('W', c.phase || 'R')}${opt('B', c.phase || 'R')}</select></td>
        <td><input type="number" data-k="breaker_a" value="${escHtml(c.breaker_a ?? 20)}" min="1" step="1" style="width:68px"></td>
        <td><select data-k="curve">${opt('B', c.curve || 'C')}${opt('C', c.curve || 'C')}${opt('D', c.curve || 'C')}</select></td>
        <td><input type="text" data-k="el_group" value="${escHtml(c.el_group || '')}" style="width:70px" placeholder="—"></td>
        <td><input type="number" data-k="cable_mm2" value="${escHtml(c.cable_mm2 ?? 2.5)}" min="0.5" step="0.5" style="width:68px"></td>
        <td><input type="number" data-k="cable_m" value="${escHtml(c.cable_m ?? 10)}" min="0" step="1" style="width:68px"></td>
        <td><input type="number" data-k="load_va" value="${escHtml(c.load_va ?? 0)}" min="0" step="50" style="width:88px"></td>
        <td><input type="number" data-k="demand_factor" value="${escHtml(c.demand_factor ?? 1)}" min="0" max="1" step="0.05" style="width:64px"></td>
        <td><button class="btn-small db-del-row" data-idx="${i}" title="Remove way">&times;</button></td>
      </tr>`).join('');

    // Live totals (exact, not via the rounded aggregate demand factor)
    const totals = this.recompute(comp);
    const connected = totals.connectedKva;
    const demand = totals.demandKva;
    const vkv = comp.props.voltage_kv || 0.4;
    const amps = vkv > 0 ? demand / (Math.sqrt(3) * vkv) : 0;

    // Phase balance bars (SA colours: Red / White / Blue), widths relative
    // to the heaviest phase so imbalance reads at a glance
    const ph = totals.phaseVa;
    const phTotal = ph.R + ph.W + ph.B;
    const phMax = Math.max(ph.R, ph.W, ph.B, 1);
    const PHASE_STYLES = {
      R: { color: '#d32f2f', text: '#fff' },
      W: { color: '#b0b0b8', text: '#222' },
      B: { color: '#1976d2', text: '#fff' },
    };
    const barsHtml = ['R', 'W', 'B'].map(p => {
      const kva = ph[p] / 1000;
      const pct = phTotal > 0 ? (ph[p] / phTotal * 100) : 0;
      const width = phTotal > 0 ? Math.max(2, ph[p] / phMax * 100) : 2;
      const st = PHASE_STYLES[p];
      return `
        <div class="db-phase-row">
          <span class="db-phase-tag" style="background:${st.color};color:${st.text}">${p}</span>
          <div class="db-phase-track">
            <div class="db-phase-fill" style="width:${width}%;background:${st.color}"></div>
          </div>
          <span class="db-phase-val">${kva.toFixed(2)} kVA (${pct.toFixed(0)}%)</span>
        </div>`;
    }).join('');

    this.body.innerHTML = `
      <div class="db-phase-bars">${barsHtml}</div>
      <div class="library-table-wrap" style="max-height:62vh;overflow:auto;">
        <table class="library-table" style="width:100%;font-size:13px;">
          <thead><tr>
            <th>Way</th><th>Description</th><th>Poles</th><th>Ph</th>
            <th>Breaker (A)</th><th>Curve</th><th>EL Grp</th>
            <th>Cable mm²</th><th>Len (m)</th><th>Load (VA)</th><th>DF</th><th></th>
          </tr></thead>
          <tbody id="db-rows">${rows ||
            '<tr><td colspan="12" style="text-align:center;opacity:0.6;padding:16px;">No ways yet — add the first circuit below.</td></tr>'}</tbody>
        </table>
      </div>
      <div style="display:flex;align-items:center;gap:16px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn-small" id="db-add-row">+ Add Way</button>
        <button class="btn-small" id="db-auto-balance" title="Reassign single-phase ways across R/W/B for best balance (3-phase ways untouched)">Auto Balance</button>
        <button class="btn-small" id="db-export-xlsx" title="Export the schedule as an Excel workbook">Export Excel</button>
        <button class="btn-small" id="db-import-xlsx" title="Import ways from an Excel/CSV file (replaces the current schedule)">Import Excel</button>
        <input type="file" id="db-import-file" accept=".xlsx,.xls,.csv" style="display:none">
        <span id="db-totals-strip" style="font-size:12px;">Connected: <strong>${connected.toFixed(2)} kVA</strong>
          &nbsp; Demand (× diversity ${comp.props.board_diversity || 1}): <strong>${demand.toFixed(2)} kVA</strong> (${amps.toFixed(1)} A)
          &nbsp; Phase R/W/B: <strong>${comp.props.phase_a_pct.toFixed(0)}/${comp.props.phase_b_pct.toFixed(0)}/${comp.props.phase_c_pct.toFixed(0)} %</strong></span>
        <button class="btn-primary" id="db-done" style="margin-left:auto;">Done</button>
      </div>`;

    // Bind
    this.body.querySelector('#db-auto-balance').addEventListener('click', () => {
      const n = this.autoBalance(comp);
      this.render();
      document.getElementById('status-info').textContent =
        n > 0 ? `Auto-balanced ${n} single-phase way(s) across R/W/B.`
              : 'No single-phase ways to balance.';
    });
    this.body.querySelector('#db-export-xlsx').addEventListener('click', () => this.exportXlsx(comp));
    const fileInput = this.body.querySelector('#db-import-file');
    this.body.querySelector('#db-import-xlsx').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) this.importXlsx(comp, file);
      e.target.value = '';
    });
    this.body.querySelector('#db-add-row').addEventListener('click', () => {
      circuits.push({
        way: String(circuits.length + 1), description: '', poles: '1P',
        phase: ['R', 'W', 'B'][circuits.length % 3], breaker_a: 20, curve: 'C',
        el_group: '', cable_mm2: 2.5, cable_m: 10, load_va: 0, demand_factor: 1,
      });
      this.render();
    });
    this.body.querySelector('#db-done').addEventListener('click', () => this.close());
    this.body.querySelectorAll('.db-del-row').forEach(btn => {
      btn.addEventListener('click', () => {
        circuits.splice(parseInt(btn.dataset.idx), 1);
        this.render();
      });
    });
    // ── Spreadsheet-style editing ──
    // change: write through to the model. Full re-render ONLY when poles
    // changes (it toggles the phase select); otherwise refresh just the
    // bars/totals so focus and cursor position survive rapid entry.
    this.body.querySelectorAll('#db-rows input, #db-rows select').forEach(inp => {
      inp.addEventListener('change', (e) => {
        const tr = e.target.closest('tr');
        const c = circuits[parseInt(tr.dataset.idx)];
        if (!c) return;
        const k = e.target.dataset.k;
        const v = e.target.value;
        c[k] = e.target.type === 'number' ? (parseFloat(v) || 0) : v;
        if (k === 'poles') {
          if (c.poles === '3P') c.phase = 'RWB';
          else if (c.phase === 'RWB') c.phase = 'R';
          this.render();
        } else {
          this.refreshTotals(comp);
        }
      });
      // select all on focus — typing immediately replaces, like a spreadsheet
      if (inp.tagName === 'INPUT') {
        inp.addEventListener('focus', () => inp.select());
      }
    });

    // Keyboard navigation: Enter/↓ = same column next row (Enter on the last
    // row adds a way), ↑ = previous row, Tab keeps its native left/right.
    const NAV_COLS = ['way', 'description', 'poles', 'phase', 'breaker_a', 'curve',
      'el_group', 'cable_mm2', 'cable_m', 'load_va', 'demand_factor'];
    this._focusCell = (row, k) => {
      const el = this.body.querySelector(`#db-rows tr[data-idx="${row}"] [data-k="${k}"]`);
      if (el) { el.focus(); if (el.select) el.select(); }
    };
    this.body.querySelector('#db-rows').addEventListener('keydown', (e) => {
      const cell = e.target.closest('[data-k]');
      if (!cell) return;
      const tr = cell.closest('tr');
      const row = parseInt(tr.dataset.idx);
      const k = cell.dataset.k;
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        cell.dispatchEvent(new Event('change', { bubbles: true }));
        if (row + 1 >= circuits.length && e.key === 'Enter') {
          // Enter on the last row: append a new way and land in it
          circuits.push({
            way: String(circuits.length + 1), description: '', poles: '1P',
            phase: ['R', 'W', 'B'][circuits.length % 3], breaker_a: 20, curve: 'C',
            el_group: '', cable_mm2: 2.5, cable_m: 10, load_va: 0, demand_factor: 1,
          });
          this.render();
          this._focusCell(circuits.length - 1, k);
        } else if (row + 1 < circuits.length) {
          this._focusCell(row + 1, k);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cell.dispatchEvent(new Event('change', { bubbles: true }));
        if (row > 0) this._focusCell(row - 1, k);
      }
    });

    // Multi-cell paste from Excel/Sheets: TSV starting at the focused cell.
    // Extra rows are appended automatically.
    this.body.querySelector('#db-rows').addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // single value → default paste
      const cell = e.target.closest('[data-k]');
      if (!cell) return;
      e.preventDefault();
      const startRow = parseInt(cell.closest('tr').dataset.idx);
      const startCol = NAV_COLS.indexOf(cell.dataset.k);
      const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
      for (let li = 0; li < lines.length; li++) {
        const rowIdx = startRow + li;
        while (rowIdx >= circuits.length) {
          circuits.push({
            way: String(circuits.length + 1), description: '', poles: '1P',
            phase: 'R', breaker_a: 20, curve: 'C', el_group: '',
            cable_mm2: 2.5, cable_m: 10, load_va: 0, demand_factor: 1,
          });
        }
        const c = circuits[rowIdx];
        const vals = lines[li].split('\t');
        for (let vi = 0; vi < vals.length && startCol + vi < NAV_COLS.length; vi++) {
          const key = NAV_COLS[startCol + vi];
          const raw = String(vals[vi]).trim();
          if (raw === '') continue;
          if (['breaker_a', 'cable_mm2', 'cable_m', 'load_va', 'demand_factor'].includes(key)) {
            const n = parseFloat(raw);
            if (!isNaN(n)) c[key] = key === 'demand_factor' ? Math.min(1, Math.max(0, n)) : n;
          } else if (key === 'poles') {
            c.poles = raw.toUpperCase().includes('3') ? '3P' : '1P';
            if (c.poles === '3P') c.phase = 'RWB';
          } else if (key === 'phase') {
            const p = raw.toUpperCase();
            if (p === 'RWB') { c.poles = '3P'; c.phase = 'RWB'; }
            else if (['R', 'W', 'B'].includes(p[0])) c.phase = p[0];
          } else if (key === 'curve') {
            if (['B', 'C', 'D'].includes(raw.toUpperCase())) c.curve = raw.toUpperCase();
          } else {
            c[key] = raw;
          }
        }
      }
      this.render();
      document.getElementById('status-info').textContent =
        `Pasted ${lines.length} row(s) into the schedule.`;
    });
  },

  // Refresh the phase bars and totals strip in place (no table re-render,
  // so the focused cell keeps focus during rapid spreadsheet-style entry)
  refreshTotals(comp) {
    const totals = this.recompute(comp);
    const ph = totals.phaseVa;
    const phTotal = ph.R + ph.W + ph.B;
    const phMax = Math.max(ph.R, ph.W, ph.B, 1);
    this.body.querySelectorAll('.db-phase-row').forEach((row, i) => {
      const p = ['R', 'W', 'B'][i];
      const pct = phTotal > 0 ? (ph[p] / phTotal * 100) : 0;
      row.querySelector('.db-phase-fill').style.width =
        `${phTotal > 0 ? Math.max(2, ph[p] / phMax * 100) : 2}%`;
      row.querySelector('.db-phase-val').textContent =
        `${(ph[p] / 1000).toFixed(2)} kVA (${pct.toFixed(0)}%)`;
    });
    const vkv = comp.props.voltage_kv || 0.4;
    const amps = vkv > 0 ? totals.demandKva / (Math.sqrt(3) * vkv) : 0;
    const strip = this.body.querySelector('#db-totals-strip');
    if (strip) {
      strip.innerHTML = `Connected: <strong>${totals.connectedKva.toFixed(2)} kVA</strong>
        &nbsp; Demand (× diversity ${comp.props.board_diversity || 1}):
        <strong>${totals.demandKva.toFixed(2)} kVA</strong> (${amps.toFixed(1)} A)
        &nbsp; Phase R/W/B: <strong>${comp.props.phase_a_pct.toFixed(0)}/${comp.props.phase_b_pct.toFixed(0)}/${comp.props.phase_c_pct.toFixed(0)} %</strong>`;
    }
  },

  // ── Excel export / import ───────────────────────────────────────────

  XLSX_HEADERS: ['Way', 'Description', 'Poles', 'Phase', 'Breaker (A)', 'Curve',
    'EL Group', 'Cable (mm2)', 'Length (m)', 'Load (VA)', 'Demand Factor'],

  exportXlsx(comp) {
    if (typeof XLSX === 'undefined') return;
    const rows = (comp.props.circuits || []).map(c => [
      c.way ?? '', c.description ?? '', c.poles ?? '1P',
      (c.poles === '3P') ? 'RWB' : (c.phase ?? 'R'),
      c.breaker_a ?? '', c.curve ?? 'C', c.el_group ?? '',
      c.cable_mm2 ?? '', c.cable_m ?? '', c.load_va ?? '', c.demand_factor ?? 1,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([this.XLSX_HEADERS, ...rows]);
    ws['!cols'] = [{ wch: 5 }, { wch: 28 }, { wch: 6 }, { wch: 6 }, { wch: 11 },
      { wch: 6 }, { wch: 9 }, { wch: 11 }, { wch: 10 }, { wch: 10 }, { wch: 13 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Circuit Schedule');
    const name = (comp.props.name || 'DB').replace(/[^\w-]+/g, '_');
    XLSX.writeFile(wb, `${name}_circuit_schedule.xlsx`);
  },

  importXlsx(comp, file) {
    if (typeof XLSX === 'undefined') return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      let rows;
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      } catch (err) {
        alert(`Could not read the file: ${err.message}`);
        return;
      }
      if (!rows || rows.length < 2) {
        alert('No data rows found — expected a header row followed by circuit rows.');
        return;
      }
      // Fuzzy header mapping: find each column by keyword
      const heads = rows[0].map(h => String(h).toLowerCase());
      const col = (...keys) => heads.findIndex(h => keys.some(k => h.includes(k)));
      const idx = {
        way: col('way', 'no'), description: col('desc'), poles: col('pole'),
        phase: col('phase', 'ph'), breaker_a: col('breaker', 'mcb', 'rating'),
        curve: col('curve'), el_group: col('el', 'rcd', 'leakage'),
        cable_mm2: col('cable', 'mm'), cable_m: col('length', 'len'),
        load_va: col('load', 'va'), demand_factor: col('demand', 'df'),
      };
      if (idx.load_va === -1 && idx.description === -1) {
        alert('Could not recognise the columns — export a schedule first to get the expected template.');
        return;
      }
      const circuits = [];
      for (const r of rows.slice(1)) {
        if (r.every(v => String(v).trim() === '')) continue;   // skip blanks
        const get = (k) => idx[k] >= 0 ? r[idx[k]] : '';
        const num = (k, d) => { const v = parseFloat(get(k)); return isNaN(v) ? d : v; };
        const polesRaw = String(get('poles')).toUpperCase();
        const phaseRaw = String(get('phase')).trim().toUpperCase();
        const poles = polesRaw.includes('3') || phaseRaw === 'RWB' ? '3P' : '1P';
        circuits.push({
          way: String(get('way') || circuits.length + 1),
          description: String(get('description') || ''),
          poles,
          phase: poles === '3P' ? 'RWB' : (['R', 'W', 'B'].includes(phaseRaw[0]) ? phaseRaw[0] : 'R'),
          breaker_a: num('breaker_a', 20),
          curve: ['B', 'C', 'D'].includes(String(get('curve')).toUpperCase()) ? String(get('curve')).toUpperCase() : 'C',
          el_group: String(get('el_group') || ''),
          cable_mm2: num('cable_mm2', 2.5),
          cable_m: num('cable_m', 10),
          load_va: num('load_va', 0),
          demand_factor: Math.min(1, Math.max(0, num('demand_factor', 1))),
        });
      }
      if (circuits.length === 0) {
        alert('No circuit rows could be read from the file.');
        return;
      }
      if ((comp.props.circuits || []).length > 0 &&
          !confirm(`Replace the current ${comp.props.circuits.length} way(s) with ${circuits.length} imported way(s)?`)) {
        return;
      }
      comp.props.circuits = circuits;
      this.render();
      document.getElementById('status-info').textContent =
        `Imported ${circuits.length} circuit(s) from ${file.name}.`;
    };
    reader.readAsArrayBuffer(file);
  },
};
