/* ProtectionPro — shared photometry library.
 *
 * One project-wide set of luminaire distributions (IES / LDT files and generic
 * optics) used by road lighting, rooms and outdoor areas. The entries live
 * where road lighting has always kept them (reticulation.streetLighting
 * .photometry, id → canonical Type C web), so nothing is copied or migrated:
 * a luminaire imported for a road is available to a room and the other way
 * round. The web is the shape backend/analysis/photometry.py produces:
 * { c:[azimuth planes], g:[gamma from nadir], cd:[c][g], lumens, watts, … }.
 */

const PhotoLib = {
  get _d() {
    const d = StreetLight.data;
    if (!d.photometry || typeof d.photometry !== 'object') d.photometry = {};
    if (!d._phSeq) d._phSeq = 1;
    return d;
  },
  get library() { return this._d.photometry; },
  get(id) { return id ? (this.library[id] || null) : null; },
  list() { return Object.values(this.library).sort((a, b) => String(a.name).localeCompare(String(b.name))); },
  label(p) { return p ? `${p.name} · ${Math.round(p.lumens)} lm · ${Math.round(p.watts || 0)} W` : '(missing luminaire)'; },

  // Where an entry is used, so a delete can say no.
  usedBy(id) {
    const out = [];
    for (const el of (AppState.planMarkup.elements || [])) if (el.props && el.props.photoId === id) out.push(el.name || el.type);
    const rd = (this._d.roadDesigns || []);
    for (const d of rd) if ((d.rows || []).some(r => r.photometryId === id)) out.push('road design ' + d.name);
    for (const r of (AppState.planMarkup.rooms || [])) {
      if (r.kind === 'sports' && r.lighting && (r.lighting.masts || []).some(m => (m.floods || []).some(fl => fl.photoId === id))) out.push('sports field ' + (r.name || ''));
    }
    return out;
  },

  async importFiles(files) {
    const added = [], failed = [];
    for (const f of Array.from(files || [])) {
      try {
        const text = await f.text();
        const prof = await API.request('/analysis/road-lighting/photometry', 'POST', { text, filename: f.name });
        const id = 'ph_' + (this._d._phSeq++);
        this.library[id] = Object.assign(prof, { id, rotate: 0, fileName: f.name });
        added.push(id);
      } catch (e) {
        failed.push(`${f.name}: ${e && e.message ? e.message : e}`);
      }
    }
    if (added.length) AppState.dirty = true;
    if (failed.length) await UI.alert('Some files could not be read:\n\n' + failed.join('\n'));
    return added;
  },

  async addGeneric(kind, lumens, watts) {
    const prof = await API.request('/analysis/road-lighting/generic', 'POST', { kind, lumens, watts });
    const id = 'ph_' + (this._d._phSeq++);
    this.library[id] = Object.assign(prof, { id, rotate: 0 });
    AppState.dirty = true;
    return id;
  },

  remove(id) {
    const used = this.usedBy(id);
    if (used.length) return used;
    delete this.library[id];
    AppState.dirty = true;
    return null;
  },

  // ─── Manager dialog ───
  _kinds: null,
  _sel: null,           // luminaire shown in the detail pane
  _viewH: 2.5,          // mounting height (m) of the one-fitting isolux and nothing else

  // The detail pane: polar curve, floor isolux of one fitting, cone diagram, key figures.
  detailHtml(p) {
    if (!p) return '<p class="pv-none">Import an IES / LDT file or add a generic optic to see its light distribution.</p>';
    const h = this._viewH;
    const iso = PhotoView.isoluxSvg(p, h);
    const cone = PhotoView.symmetric(p) ? PhotoView.cone(p) : null;
    const coneBody = cone ? `<p>Beam ${Math.round(cone.angle)}° (50 % of the peak) · Emax on the axis</p>${PhotoView.coneSvg(cone)}
        <table class="pl-cone-t"><thead><tr><th scope="col">Height</th><th scope="col">Spot Ø</th><th scope="col">Emax</th></tr></thead>
        <tbody>${cone.rows.map(r => `<tr><td>${r.h.toFixed(1)} m</td><td>${r.d.toFixed(2)} m</td><td>${PhotoView._num(r.e)} lx</td></tr>`).join('')}</tbody></table>`
      : '<p class="pv-none">A cone diagram needs a downlight that throws the same way in every plane. This one doesn\'t — the isolux plot shows how far it reaches in each direction.</p>';
    const where = this.usedBy(p.id);
    return `<div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;margin-bottom:8px">
        <div><b>${escHtml(p.name)}</b>${p.manufacturer ? ` <span style="color:var(--text-secondary)">· ${escHtml(p.manufacturer)}</span>` : ''}
          <div style="font-size:11px;color:var(--text-muted)">${escHtml(p.generic ? 'Generic optic — feasibility only' : [p.format, p.fileName].filter(Boolean).join(' · '))}${where.length ? ` · used by ${where.length} item${where.length === 1 ? '' : 's'}` : ''}</div></div>
      </div>
      <div class="pl-cards">
        <section class="pl-card" aria-label="Polar curve"><h4>Polar curve</h4><p>Luminous intensity in the two main planes</p>
          ${PhotoView.polarSvg(p)}${PhotoView.polarLegend()}</section>
        <section class="pl-card" aria-label="Isolux of one fitting"><h4>Isolux on the floor — one fitting</h4>
          <p><label class="pl-h">Mounting height <input type="number" data-pl-h value="${h}" min="0.5" max="40" step="0.1"> m</label>
            ${iso.none ? '' : ` · ${Math.round(p.lumens)} lm · ${iso.grid} m grid · lux`}</p>${iso.svg}</section>
        <section class="pl-card" aria-label="Cone diagram"><h4>Cone diagram</h4>${coneBody}</section>
        <section class="pl-card" aria-label="Key figures"><h4>Key figures</h4>
          <dl class="pl-facts">${PhotoView.facts(p).map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join('')}</dl></section>
      </div>`;
  },
  async _genericKinds() {
    if (!this._kinds) {
      try { this._kinds = await API.request('/analysis/road-lighting/generic', 'GET'); } catch (_) { this._kinds = []; }
    }
    return this._kinds;
  },

  async open() {
    const kinds = (await this._genericKinds()).filter(k => k.group !== 'road');
    const ov = document.createElement('div');
    ov.className = 'modal plan-floor-modal';
    ov.style.display = 'flex'; ov.style.zIndex = '3000';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Luminaire photometry');
    const render = () => {
      const list = this.list();
      if (!this.get(this._sel)) this._sel = list[0] ? list[0].id : null;
      const rows = list.map(p => `<div class="pl-item">
        <button type="button" class="pl-pick" data-pick="${escHtml(p.id)}" aria-pressed="${p.id === this._sel}">${escHtml(p.name)}${p.generic ? ' <small style="display:inline">(generic)</small>' : ''}
          <small>${Math.round(p.lumens)} lm · ${Math.round(p.watts || 0)} W</small></button>
        <button class="btn-small" data-rm="${escHtml(p.id)}" title="Remove from the library" aria-label="Remove ${escHtml(p.name)}">Remove</button></div>`).join('');
      ov.innerHTML = `<div class="modal-content plan-floor-content pl-content">
        <div class="modal-header"><h3>Luminaire photometry</h3></div>
        <div class="modal-body">
          <p style="margin:0 0 8px;color:var(--text-muted);font-size:12px">One library for road, room and outdoor lighting. Import the manufacturer's IES / LDT for a compliance design; a generic optic is for feasibility only.</p>
          <div class="pl-body">
            <div class="pl-list" role="group" aria-label="Luminaires">${rows || '<p style="color:var(--text-muted);font-size:13px">No luminaires yet.</p>'}</div>
            <div class="pl-detail" data-pl-detail>${this.detailHtml(this.get(this._sel))}</div>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin-top:12px">
            <button class="btn-small" data-act="import">Import IES / LDT…</button>
            <label style="font-size:12px">Generic<br><select data-g="kind">${kinds.map(k => `<option value="${escHtml(k.kind)}">${escHtml(k.name)}</option>`).join('')}</select></label>
            <label style="font-size:12px">lm<br><input type="number" data-g="lumens" value="4000" step="100" style="width:80px"></label>
            <label style="font-size:12px">W<br><input type="number" data-g="watts" value="36" step="1" style="width:64px"></label>
            <button class="btn-small" data-act="generic">Add generic</button>
          </div>
          <input type="file" data-act="file" accept=".ies,.IES,.ldt,.LDT,.eul" multiple hidden>
          <div class="ui-dialog-actions"><button class="btn-primary" data-act="close">Done</button></div>
        </div></div>`;
    };
    render();
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); this.onChanged(); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]');
      const pick = e.target.closest('[data-pick]');
      const act = e.target.dataset && e.target.dataset.act;
      if (pick) {
        this._sel = pick.dataset.pick;
        ov.querySelectorAll('[data-pick]').forEach(b => b.setAttribute('aria-pressed', String(b === pick)));
        ov.querySelector('[data-pl-detail]').innerHTML = this.detailHtml(this.get(this._sel));
      } else if (rm) {
        const used = this.remove(rm.dataset.rm);
        if (used) UI.toast('In use by ' + used.slice(0, 4).join(', ') + (used.length > 4 ? '…' : '') + ' — reassign it first.', 'warn', 5000);
        render();
      } else if (act === 'import') ov.querySelector('[data-act="file"]').click();
      else if (act === 'generic') {
        const v = (k) => ov.querySelector(`[data-g="${k}"]`).value;
        try { this._sel = await this.addGeneric(v('kind'), Math.max(1, +v('lumens') || 4000), Math.max(0, +v('watts') || 0)); } catch (err) { UI.alert('Could not add the optic: ' + (err.message || err)); }
        render();
      } else if (act === 'close' || e.target === ov) close();
    });
    ov.addEventListener('change', async (e) => {
      if (e.target.dataset && e.target.dataset.act === 'file') {
        const added = await this.importFiles(e.target.files);
        if (added.length) this._sel = added[0];
        render();
      } else if (e.target.matches('[data-pl-h]')) {
        const h = +e.target.value;
        if (h > 0) this._viewH = Math.min(Math.max(h, 0.5), 40);
        ov.querySelector('[data-pl-detail]').innerHTML = this.detailHtml(this.get(this._sel));
        const inp = ov.querySelector('[data-pl-h]'); if (inp) inp.focus();
      }
    });
    document.body.appendChild(ov);
  },

  onChanged() {
    if (typeof PlanMarkup !== 'undefined' && PlanMarkup.markDirty) PlanMarkup.markDirty();
    if (typeof RoadLight !== 'undefined' && RoadLight._active) RoadLight.render();
  },
};
