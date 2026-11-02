/* ProtectionPro — the Cases manager (Cases menu › Manage cases…).
 *
 * One screen for the one list of cases (cases.js): save the current network as
 * a case, then for each case — Load it (replace the network, or overlay what it
 * applies), Preview it on the diagram, Edit its values in the load-flow grid,
 * Duplicate, Rename, Delete — and Compare any two (what differs in the
 * network, on screen, with a PDF of it).
 */

const CasesManager = {
  _compare: null,    // { a, b } being compared

  _cases() { return AppState.cases; },
  _esc(s) { return escHtml(String(s == null ? '' : s)); },
  _applies(c) { return c.applies || Cases.DEFAULT_APPLIES; },
  _tags(c) {
    const a = this._applies(c);
    return [a.switching && 'switching', a.settings && 'settings', a.layout && 'layout'].filter(Boolean).join(' · ') || 'nothing';
  },

  open(opts = {}) {
    const m = document.getElementById('scenarios-modal');
    if (!m) return;
    document.getElementById('scenario-name').value = '';
    document.getElementById('scenario-desc').value = '';
    this._compare = null;
    this.render();
    m.style.display = '';
    if (opts.compare) {
      if (this._cases().length < 2) UI.toast('Save at least 2 cases before comparing.', 'warning');
      else document.getElementById('cm-compare')?.scrollIntoView({ block: 'center' });
    }
  },
  close() { const m = document.getElementById('scenarios-modal'); if (m) m.style.display = 'none'; },

  render() {
    const list = document.getElementById('scenario-list');
    if (!list) return;
    const cases = this._cases();
    if (!cases.length) {
      list.innerHTML = '<p class="scenario-empty">No cases yet. Save the current network above to make the first.</p>';
    } else {
      list.innerHTML = cases.map(c => {
        const date = c.timestamp ? new Date(c.timestamp).toLocaleString() : '';
        const n = (c.components || []).length;
        return `<div class="scenario-item" data-id="${this._esc(c.id)}">
          <div class="scenario-info">
            <div class="scenario-name">${this._esc(c.name)}</div>
            ${c.description ? `<div class="scenario-desc">${this._esc(c.description)}</div>` : ''}
            <div class="scenario-meta">${this._esc(date)}${date ? ' — ' : ''}${n} component${n === 1 ? '' : 's'} — applies: ${this._esc(this._tags(c))}</div>
          </div>
          <div class="scenario-actions">
            <button data-cm="load" title="Make this the network (device names are kept)">Load</button>
            <button data-cm="preview" title="Show this case on the diagram without changing the network">Preview</button>
            <button data-cm="edit" title="Change values for this case in the load-flow grid">Edit values</button>
            <button data-cm="dup" title="Copy this case">Duplicate</button>
            <button data-cm="rename" title="Rename this case">Rename</button>
            <button data-cm="del" title="Delete this case" class="btn-delete-scenario">&times;</button>
          </div>
        </div>`;
      }).join('');
    }
    this._renderCompare();
  },

  _renderCompare() {
    const host = document.getElementById('cm-compare');
    if (!host) return;
    const cases = this._cases();
    if (cases.length < 2) { host.innerHTML = '<p class="scenario-empty">Compare needs two cases.</p>'; return; }
    const opts = (sel) => cases.map(c => `<option value="${this._esc(c.id)}"${c.id === sel ? ' selected' : ''}>${this._esc(c.name)}</option>`).join('');
    const a = (this._compare && this._compare.a) || cases[0].id, b = (this._compare && this._compare.b) || cases[1].id;
    let table = '';
    if (this._compare && this._compare.shown) {
      const A = cases.find(c => c.id === a), B = cases.find(c => c.id === b);
      const rows = A && B ? Cases.diff(A, B) : [];
      table = rows.length
        ? `<div class="cm-scroll"><table class="cm-diff"><thead><tr><th>Part</th><th>What</th><th>A</th><th>B</th><th>Change</th></tr></thead><tbody>`
          + rows.slice(0, 400).map(r => `<tr><td>${this._esc(r.name)}</td><td>${this._esc(r.what)}</td><td>${this._esc(r.a)}</td><td>${this._esc(r.b)}</td><td>${this._esc(r.delta)}</td></tr>`).join('')
          + `</tbody></table></div>${rows.length > 400 ? `<p class="scenario-empty">First 400 of ${rows.length} differences. The PDF has all of them.</p>` : ''}`
        : '<p class="scenario-empty">No differences between the two cases.</p>';
    }
    host.innerHTML = `<div class="cm-compare-row">
      <label>A <select id="cm-a">${opts(a)}</select></label>
      <label>B <select id="cm-b">${opts(b)}</select></label>
      <button class="btn-small" data-cm="compare">Show differences</button>
      <button class="btn-small" data-cm="pdf" title="The same differences as a PDF">PDF</button>
    </div>${table}`;
  },

  async _load(c) {
    const a = this._applies(c);
    const full = a.switching && a.settings && a.layout;
    const what = full ? 'Current unsaved changes will be replaced (device names are kept).'
      : `Applies ${[a.switching && 'switching states', a.settings && 'electrical settings', a.layout && 'layout'].filter(Boolean).join(' and ') || 'nothing'} to the current network, matched by device.`;
    if (!(await UI.confirm(`Load “${c.name}”? ${what}`))) return;
    if (typeof LFStudy !== 'undefined' && LFStudy.clearPreview) LFStudy.clearPreview();
    if (AppState.loadScenario(c.id)) {
      UndoManager.clear();
      if (typeof renderPageTabs === 'function') renderPageTabs();
      Canvas.render();
      Properties.clear();
      this.close();
      document.getElementById('status-info').textContent = `Loaded case: ${c.name}`;
    }
  },

  _dup(c) {
    const id = 'case_' + Math.max(AppState._scenarioNextId++, Cases.nextNumber(this._cases()));
    const copy = JSON.parse(JSON.stringify(c));
    copy.id = id; copy.name = c.name + ' (copy)'; copy.timestamp = new Date().toISOString();
    this._cases().push(copy);
    AppState.dirty = true;
  },

  async _rename(c) {
    const name = ((await UI.prompt('Rename case:', c.name)) || '').trim();
    if (name) { c.name = name; AppState.dirty = true; }
  },

  init() {
    const m = document.getElementById('scenarios-modal');
    if (!m) return;
    document.getElementById('btn-scenarios')?.addEventListener('click', () => this.open());
    document.getElementById('btn-close-scenarios')?.addEventListener('click', () => this.close());
    m.addEventListener('click', (e) => { if (e.target === m) this.close(); });
    document.getElementById('btn-save-scenario')?.addEventListener('click', () => {
      const nameEl = document.getElementById('scenario-name');
      const name = nameEl.value.trim();
      if (!name) { nameEl.focus(); return; }
      const applies = {
        switching: document.getElementById('scenario-apply-switching').checked,
        settings: document.getElementById('scenario-apply-settings').checked,
        layout: document.getElementById('scenario-apply-layout').checked,
      };
      if (!applies.switching && !applies.settings && !applies.layout) {
        document.getElementById('status-info').textContent = 'Tick at least one thing for the case to apply.';
        return;
      }
      AppState.saveScenario(name, document.getElementById('scenario-desc').value.trim(), applies);
      nameEl.value = ''; document.getElementById('scenario-desc').value = '';
      this.render();
      document.getElementById('status-info').textContent = `Case “${name}” saved.`;
    });
    m.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-cm]');
      if (!btn) return;
      const act = btn.dataset.cm;
      const row = btn.closest('.scenario-item');
      const c = row ? this._cases().find(x => x.id === row.dataset.id) : null;
      if (act === 'compare' || act === 'pdf') {
        this._compare = { a: document.getElementById('cm-a').value, b: document.getElementById('cm-b').value, shown: act === 'compare' };
        if (this._compare.a === this._compare.b) { UI.toast('Pick two different cases.', 'warning'); return; }
        if (act === 'pdf') { if (typeof Reports !== 'undefined') Reports.exportComparisonPDF(this._compare.a, this._compare.b); return; }
        this._renderCompare();
        return;
      }
      if (!c) return;
      if (act === 'load') await this._load(c);
      else if (act === 'preview') { this.close(); LFStudy.previewCase(c.id); }
      else if (act === 'edit') { this.close(); LFStudy._activeCaseId = c.id; LFStudy.openManager(); }
      else if (act === 'dup') { this._dup(c); this.render(); }
      else if (act === 'rename') { await this._rename(c); this.render(); }
      else if (act === 'del') {
        if (!(await UI.confirm(`Delete “${c.name}” permanently?`, { danger: true, okText: 'Delete' }))) return;
        AppState.deleteScenario(c.id);
        if (typeof LFStudy !== 'undefined' && AppState.lfPreviewCaseId === c.id) LFStudy.clearPreview();
        this.render();
      }
    });
  },
};
