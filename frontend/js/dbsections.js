/* ProtectionPro — DB sections (compartments).
 *
 * A board is often one enclosure divided into physically separate sections —
 * Normal, Essential (generator-backed), UPS — each with its own supply, incomer
 * device, busbar and N/PE bars. They live in `comp.props.sections`:
 *
 *   { id, name, kind ('normal'|'essential'|'ups'|'other'), prefix,
 *     feed ('own' | 'board' | 'section' | 'changeover'), feed_from (section id),
 *     source_label, source_kva, zs_ohm, feed_mm2, feed_m,
 *     feed_conductor ('Cu'|'Al'), feed_pe_mm2 (blank = line size),
 *     incomer_a, incomer_poles ('3P'|'4P'), incomer_ka, bus_a }
 *
 * A way (and an accessory) carries `section` = a section id. A board with no
 * `sections` is the legacy single-section board and every consumer behaves
 * exactly as it did before — nothing is written until the first section is
 * added, so a read-only visit stays diff-clean.
 *
 * Consumers: the schedule grid (section column, tabs, this panel), DBDrawing
 * (one busbar + N/PE per section), GA (one compartment per section), the
 * circuit check (a section's declared source Zs / feed cable) and BOQ.
 */

const DBSections = {
  _seq: 0,
  _active: {},              // board id → section id shown in the grid ('' = all)
  _open: false,             // remembered <details> state of the panel

  KINDS: [
    { key: 'normal',    label: 'Normal',            color: '#1976d2', prefix: 'N' },
    { key: 'essential', label: 'Essential (gen)',   color: '#ef6c00', prefix: 'E' },
    { key: 'ups',       label: 'UPS',               color: '#2e7d32', prefix: 'U' },
    { key: 'other',     label: 'Other',             color: '#6a1b9a', prefix: 'X' },
  ],
  FEEDS: [
    { key: 'own',        label: 'Own supply' },
    { key: 'board',      label: 'From the board incomer' },
    { key: 'section',    label: 'From another section' },
    { key: 'changeover', label: 'Changeover (own / other section)' },
  ],
  FORMS: ['1', '2a', '2b', '3a', '3b', '4a', '4b'],

  kind(key) { return this.KINDS.find(k => k.key === key) || this.KINDS[3]; },

  // ── Model ───────────────────────────────────────────────────────────
  has(comp) {
    return !!(comp && comp.props && Array.isArray(comp.props.sections) && comp.props.sections.length);
  },

  // Ids are minted lazily, like DBAccessories.list().
  list(comp) {
    if (!this.has(comp)) return [];
    for (const s of comp.props.sections) {
      if (!s.id) s.id = 'sec' + (++this._seq) + '-' + Math.random().toString(36).slice(2, 6);
    }
    return comp.props.sections;
  },

  get(comp, id) {
    return this.list(comp).find(s => s.id === id) || null;
  },

  // The section a way/accessory belongs to; unassigned ⇒ the first section.
  of(comp, item) {
    const l = this.list(comp);
    if (!l.length) return null;
    return l.find(s => s.id === (item && item.section)) || l[0];
  },

  // Always a plain hex colour: section data comes from the project file and
  // the value is interpolated into style / SVG attributes.
  color(sec) {
    if (!sec) return '#555';
    const c = sec.color;
    return (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c)) ? c : this.kind(sec.kind).color;
  },

  _blank(kind, n) {
    const k = this.kind(kind);
    return {
      id: 'sec' + (++this._seq) + '-' + Math.random().toString(36).slice(2, 6),
      name: k.label.replace(/ \(gen\)/, ''), kind: k.key, prefix: k.prefix,
      feed: 'own', feed_from: '', source_label: '', source_kva: null,
      zs_ohm: null, feed_mm2: null, feed_m: null,
      incomer_a: null, incomer_poles: '4P', incomer_ka: null, bus_a: null,
    };
  },

  // Add a section. The first call turns a legacy board into a sectioned one:
  // a "Normal" section is created first and takes every existing way/accessory.
  create(comp, kind) {
    if (!Array.isArray(comp.props.sections)) comp.props.sections = [];
    if (!comp.props.sections.length) {
      const first = this._blank('normal');
      comp.props.sections.push(first);
      for (const c of (comp.props.circuits || [])) c.section = first.id;
      for (const a of (comp.props.accessories || [])) a.section = first.id;
      if (kind === 'normal') return first;
    }
    const s = this._blank(kind || 'essential');
    // A second section of the same kind gets a numeric suffix.
    const same = comp.props.sections.filter(x => x.kind === s.kind).length;
    // The prefix ends in a separator so 'N2-1' never reads as Normal way 21.
    if (same) { s.name += ' ' + (same + 1); s.prefix += (same + 1) + '-'; }
    comp.props.sections.push(s);
    return s;
  },

  remove(comp, id) {
    const l = comp.props.sections || [];
    const i = l.findIndex(s => s.id === id);
    if (i < 0) return;
    l.splice(i, 1);
    if (!l.length) {
      delete comp.props.sections;
      for (const c of (comp.props.circuits || [])) delete c.section;
      for (const a of (comp.props.accessories || [])) delete a.section;
      return;
    }
    // Orphaned ways/accessories fall to the first remaining section.
    const to = l[0].id;
    for (const c of (comp.props.circuits || [])) if (c.section === id) c.section = to;
    for (const a of (comp.props.accessories || [])) if (a.section === id) a.section = to;
    for (const s of l) if (s.feed_from === id) s.feed_from = '';
  },

  // Next free way number in a section: its prefix + the next integer.
  nextWayNumber(comp, sec) {
    const circuits = comp.props.circuits || [];
    const used = new Set(circuits.map(c => String(c.way)));
    const pre = sec ? (sec.prefix || '') : '';
    let n = 1;
    for (const c of circuits) {
      if (sec && this.of(comp, c) !== sec) continue;
      // The number after the section's own prefix: 'N2' + '13' → 13, not 213.
      let w = String(c.way ?? '');
      if (pre && w.toLowerCase().startsWith(pre.toLowerCase())) w = w.slice(pre.length);
      const m = w.match(/^\D*(\d+)$/);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    while (used.has(pre + n)) n++;
    return pre + n;
  },

  // Section (id) that new ways are added to: the grid's active tab, else the first.
  target(comp) {
    if (!this.has(comp)) return null;
    const id = this._active[comp.id];
    return this.get(comp, id) || this.list(comp)[0];
  },

  // ── Totals ──────────────────────────────────────────────────────────
  totals(comp) {
    const vll = DBSchedule._boardVll(comp);
    const out = new Map();
    for (const s of this.list(comp)) {
      out.set(s.id, { sec: s, ways: 0, connectedVa: 0, demandVa: 0, phaseVa: { R: 0, W: 0, B: 0 }, demandA: 0 });
    }
    const first = this.list(comp)[0];
    const boardDf = Number(comp.props.board_diversity) || 1;
    for (const c of (comp.props.circuits || [])) {
      const t = out.get((this.of(comp, c) || first || {}).id);
      if (!t) continue;
      const va = Number(c.load_va) || 0;
      const d = va * demandFactorOr1(c.demand_factor) * boardDf;
      t.ways++; t.connectedVa += va; t.demandVa += d;
      if (wayIs3(c)) {
        t.phaseVa.R += d / 3; t.phaseVa.W += d / 3; t.phaseVa.B += d / 3;
      } else if (wayIsLL(c)) {
        t.phaseVa[c.phase[0]] += d / Math.sqrt(3); t.phaseVa[c.phase[1]] += d / Math.sqrt(3);
      } else {
        t.phaseVa[c.phase || 'R'] = (t.phaseVa[c.phase || 'R'] || 0) + d;
      }
    }
    for (const t of out.values()) {
      t.demandA = vll > 0 ? t.demandVa / (Math.sqrt(3) * vll) : 0;
    }
    return out;
  },

  // Advisory: a section whose demand exceeds its own incomer / busbar rating.
  warnings(comp, t) {
    const w = [];
    const s = t.sec;
    if (Number(s.incomer_a) > 0 && t.demandA > Number(s.incomer_a)) {
      w.push(`Demand ${t.demandA.toFixed(0)} A exceeds the ${s.incomer_a} A incomer.`);
    }
    if (Number(s.bus_a) > 0 && Number(s.incomer_a) > Number(s.bus_a)) {
      w.push(`Incomer ${s.incomer_a} A exceeds the ${s.bus_a} A busbar.`);
    }
    if (Number(s.source_kva) > 0) {
      const kva = t.demandVa / 1000;
      if (kva > Number(s.source_kva)) w.push(`Demand ${kva.toFixed(1)} kVA exceeds the ${s.source_kva} kVA source.`);
    }
    if ((s.feed === 'section' || s.feed === 'changeover') && !this.get(comp, s.feed_from)) {
      w.push('Fed from another section but none is selected.');
    }
    return w;
  },

  // ── UI ──────────────────────────────────────────────────────────────
  _e(v) { return escHtml(v == null ? '' : String(v)); },

  // Tab strip above the grid: All | one per section, with counts.
  tabsHTML(comp) {
    if (!this.has(comp)) return '';
    const act = this._active[comp.id] || '';
    const tot = this.totals(comp);
    const n = (comp.props.circuits || []).length;
    const tab = (id, label, count, color) =>
      `<button type="button" class="dbs-tab${act === id ? ' active' : ''}" data-dbs-tab="${this._e(id)}"` +
      `${color ? ` style="--dbs-c:${this._e(color)}"` : ''}>${color ? '<span class="dbs-dot"></span>' : ''}${this._e(label)}` +
      `<span class="dbs-n">${count}</span></button>`;
    return `<div class="dbs-tabs" role="tablist" aria-label="Board sections">`
      + tab('', 'All sections', n, '')
      + [...tot.values()].map(t => tab(t.sec.id, t.sec.name, t.ways, this.color(t.sec))).join('')
      + `</div>`;
  },

  panelHTML(comp) {
    const secs = this.list(comp);
    const tot = this.has(comp) ? this.totals(comp) : new Map();
    const inp = (s, k, type, w, extra) =>
      `<input type="${escHtml(type)}" data-dbs-k="${k}" data-dbs-id="${this._e(s.id)}" value="${this._e(s[k])}" style="width:${w}px"${extra || ''}>`;
    const sel = (s, k, opts) =>
      `<select data-dbs-k="${k}" data-dbs-id="${this._e(s.id)}">${opts.map(o =>
        `<option value="${this._e(o.key)}"${String(s[k] ?? '') === String(o.key) ? ' selected' : ''}>${this._e(o.label)}</option>`).join('')}</select>`;
    const cards = secs.map(s => {
      const t = tot.get(s.id);
      const warns = t ? this.warnings(comp, t) : [];
      const others = secs.filter(o => o.id !== s.id).map(o => ({ key: o.id, label: o.name }));
      const feedFromOpts = [{ key: '', label: '— choose —' }, ...others];
      const showFrom = s.feed === 'section' || s.feed === 'changeover';
      return `
        <div class="dbs-card" style="--dbs-c:${this._e(this.color(s))}">
          <div class="dbs-card-h">
            <span class="dbs-dot"></span>
            ${inp(s, 'name', 'text', 130)}
            ${sel(s, 'kind', this.KINDS.map(k => ({ key: k.key, label: k.label })))}
            <label title="Way-number prefix for this section">Prefix ${inp(s, 'prefix', 'text', 44, ' maxlength="4"')}</label>
            <span class="dbs-sum">${t ? `${t.ways} ways · ${(t.connectedVa / 1000).toFixed(1)} kVA · ${(t.demandVa / 1000).toFixed(1)} kVA demand · ${t.demandA.toFixed(0)} A` : ''}</span>
            <button type="button" class="btn-small dbs-del" data-dbs-del="${this._e(s.id)}" title="Remove this section — its ways move to the first remaining section">&times;</button>
          </div>
          <div class="dbs-card-b">
            <label>Fed ${sel(s, 'feed', this.FEEDS)}</label>
            ${showFrom ? `<label>From ${sel(s, 'feed_from', feedFromOpts)}</label>` : ''}
            <label>Source ${inp(s, 'source_label', 'text', 120, ' placeholder="e.g. Generator"')}</label>
            <label>kVA ${inp(s, 'source_kva', 'number', 64, ' min="0" step="1"')}</label>
            <label title="Declared earth-fault loop impedance of this section's supply at its incomer (generator / UPS). Blank = the board's own supply impedance.">Zs Ω ${inp(s, 'zs_ohm', 'number', 64, ' min="0" step="0.001"')}</label>
            <label>Incomer A ${inp(s, 'incomer_a', 'number', 64, ' min="0" step="1"')}</label>
            <label>${sel(s, 'incomer_poles', [{ key: '3P', label: '3P' }, { key: '4P', label: '4P' }])}</label>
            <label>kA ${inp(s, 'incomer_ka', 'number', 56, ' min="0" step="1"')}</label>
            <label>Bus A ${inp(s, 'bus_a', 'number', 64, ' min="0" step="1"')}</label>
            <label title="Cable from the board incomer / source to this section">Feed mm² ${inp(s, 'feed_mm2', 'number', 60, ' min="0"')}</label>
            <label>${sel(s, 'feed_conductor', [{ key: 'Cu', label: 'Cu' }, { key: 'Al', label: 'Al' }])}</label>
            <label title="Protective conductor of the feed cable. Blank = same size as the line conductors; a reduced PE raises the earth-fault loop.">PE mm² ${inp(s, 'feed_pe_mm2', 'number', 56, ' min="0" placeholder="= line"')}</label>
            <label>m ${inp(s, 'feed_m', 'number', 52, ' min="0"')}</label>
          </div>
          ${warns.length ? `<div class="dbs-warn">${warns.map(w => this._e(w)).join(' · ')}</div>` : ''}
        </div>`;
    }).join('');
    const form = comp.props.segregation || '2b';
    return `
      <details class="dbs-panel" id="dbs-panel"${this._open || !secs.length ? ' open' : ''}>
        <summary>Sections / compartments <span class="dbs-count">${secs.length ? secs.length : 'none — single section'}</span></summary>
        <div class="dbs-body">
          <p class="dbs-note">Split the board into physically separate compartments (Normal, Essential, UPS …). Each section gets its own incomer, busbar and N/PE bars on the single line, and its own compartment in the GA.</p>
          ${cards}
          <div class="dbs-actions">
            <span>Add section:</span>
            ${this.KINDS.map(k => `<button type="button" class="btn-small" data-dbs-add="${escHtml(k.key)}" style="--dbs-c:${escHtml(k.color)}"><span class="dbs-dot"></span>${this._e(k.label)}</button>`).join('')}
            <span class="dbs-sep"></span>
            <label title="IEC 61439-2 form of internal separation between compartments — sets the partition allowance in the GA">Form of separation
              <select id="dbs-form">${this.FORMS.map(f => `<option value="${f}"${f === form ? ' selected' : ''}>Form ${f}</option>`).join('')}</select></label>
          </div>
        </div>
      </details>`;
  },

  // Wire the tabs + panel inside `host`. `after` runs after a model edit,
  // `view` after a view-only change (a tab switch).
  bind(host, comp, after, view) {
    const done = (rerender) => { if (after) after(rerender); };
    const det = host.querySelector('#dbs-panel');
    if (det) det.addEventListener('toggle', () => { this._open = det.open; });

    // A tab only changes the view — re-render without announcing an edit.
    host.querySelectorAll('[data-dbs-tab]').forEach(b => b.addEventListener('click', () => {
      this._active[comp.id] = b.dataset.dbsTab;
      if (view) view();
    }));
    host.querySelectorAll('[data-dbs-add]').forEach(b => b.addEventListener('click', () => {
      const s = this.create(comp, b.dataset.dbsAdd);
      this._active[comp.id] = s.id;
      this._open = true;
      done(true);
    }));
    host.querySelectorAll('[data-dbs-del]').forEach(b => b.addEventListener('click', () => {
      this.remove(comp, b.dataset.dbsDel);
      this._active[comp.id] = '';
      done(true);
    }));
    host.querySelectorAll('[data-dbs-k]').forEach(el => el.addEventListener('change', () => {
      const s = this.get(comp, el.dataset.dbsId);
      if (!s) return;
      const k = el.dataset.dbsK;
      let v = el.value;
      if (el.type === 'number') v = v === '' ? null : Number(v);
      s[k] = v;
      if (k === 'kind') { s.color = undefined; delete s.color; }
      if (k === 'feed' && (v === 'own' || v === 'board')) s.feed_from = '';
      done(true);
    }));
    const form = host.querySelector('#dbs-form');
    if (form) form.addEventListener('change', () => {
      if (form.value === '2b') delete comp.props.segregation; else comp.props.segregation = form.value;
      done(false);
    });
  },
};
