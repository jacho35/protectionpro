/* ProtectionPro — the one cable library.
 *
 * STANDARD_CABLES (constants.js, edited in Settings › Cables) is the only cable
 * library in the app: MV and LV armoured multicore, LV 2-core service cables,
 * and building wiring (T+E, H07V-R singles, Surfix, control). Every picker —
 * Demand, site / floor plans, the single-line diagram, DB schedules — and the
 * rate library read it through this module, so a cable added once is usable
 * everywhere and gets its BOQ and termination items automatically.
 *
 * Each entry carries `construction` and `cores` (defaulted here for entries
 * saved before those fields existed):
 *   armoured  MV (3-core) / LV (4-core, or 2-core single-phase services)
 *   te        twin & earth          surfix   Surfix 2C+E / 3C+E
 *   single    H07V-R single-core    control  DALI / 0-10 V / BMS
 *
 * Projects reference a cable by NAME (Demand, plans, DB ways) or by id (SLD).
 * The former building library's "x4C Cu PVC/SWA" names were the same cables as
 * the main "Cu PVC LV" entries; they resolve here as aliases and are rewritten
 * when a project loads.
 */

const CableLib = {
  CONSTRUCTIONS: [
    { id: 'armoured', label: 'Armoured multicore (SWA)' },
    { id: 'te', label: 'Twin & earth (T+E)' },
    { id: 'surfix', label: 'Surfix' },
    { id: 'single', label: 'Single-core (H07V-R)' },
    { id: 'control', label: 'Control / signal' },
  ],
  // Former building-library names → the same cable in the one library.
  ALIASES: {
    '2.5mm² x4C Cu PVC/SWA': '2.5mm² Cu PVC LV',
    '4mm² x4C Cu PVC/SWA': '4mm² Cu PVC LV',
    '6mm² x4C Cu PVC/SWA': '6mm² Cu PVC LV',
    '10mm² x4C Cu PVC/SWA': '10mm² Cu PVC LV',
    '16mm² x4C Cu PVC/SWA': '16mm² Cu PVC LV',
    '25mm² x4C Cu PVC/SWA': '25mm² Cu PVC LV',
    '35mm² x4C Cu PVC/SWA': '35mm² Cu PVC LV',
    '50mm² x4C Cu PVC/SWA': '50mm² Cu PVC LV',
    '70mm² x4C Cu PVC/SWA': '70mm² Cu PVC LV',
    '95mm² x4C Cu PVC/SWA': '95mm² Cu PVC LV',
  },

  all() { return typeof STANDARD_CABLES !== 'undefined' ? STANDARD_CABLES : []; },

  // Fill `construction` / `cores` on an entry that predates them.
  normalize(c) {
    if (!c) return c;
    if (!c.construction) c.construction = 'armoured';
    if (!(Number(c.cores) > 0)) c.cores = c.construction === 'armoured' ? (Number(c.voltage_kv) > 1 ? 3 : 4) : 2;
    return c;
  },
  normalizeAll() { for (const c of this.all()) this.normalize(c); },

  resolveName(name) { return this.ALIASES[name] || name; },
  byName(name) {
    if (!name) return null;
    const n = this.resolveName(name);
    return this.all().find(c => c.name === n) || null;
  },
  byId(id) { return id ? this.all().find(c => c.id === id) || null : null; },

  isMV(c) { return Number(c.voltage_kv) > 1; },
  isDistribution(c) { return (c.construction || 'armoured') === 'armoured'; },
  isWiring(c) { return ['te', 'surfix', 'single'].includes(c.construction); },

  // "95mm² Al XLPE LV" → "95mm² Al XLPE LV, 4-core". Names that already say
  // how many cores (2c, x4C, T+E, 2C+E, H07V-R single) are left as they are.
  label(c) {
    if (!c) return '';
    if (/\b\d\s*c\b|x\d\s*C\b|\dC\+E|T\+E|H07V/i.test(c.name) || c.construction === 'control') return c.name;
    return `${c.name}, ${this.normalize(c).cores}-core`;
  },

  // The same cable with a different core count (a 2-core service's 4-core sibling).
  sibling(c, cores) {
    if (!c) return null;
    return this.all().find(x => x !== c && x.conductor === c.conductor && x.insulation === c.insulation
      && Number(x.size_mm2) === Number(c.size_mm2) && Number(x.voltage_kv) === Number(c.voltage_kv)
      && (x.construction || 'armoured') === (c.construction || 'armoured') && Number(this.normalize(x).cores) === Number(cores)) || null;
  },

  // A cable renamed in Settings: carry the new name into the open project,
  // wherever it is referenced by name (Demand, plan routes, DB ways, and SLD
  // cables named after their type). Returns how many references changed.
  renameInProject(oldName, newName) {
    if (!oldName || !newName || oldName === newName || typeof AppState === 'undefined') return 0;
    let n = 0;
    const fix = (obj, key) => { if (obj && obj[key] === oldName) { obj[key] = newName; n++; } };
    const R = AppState.reticulation;
    if (R) {
      if (R.settings) { fix(R.settings, 'quickFeederCable'); fix(R.settings, 'quickServiceCable'); }
      for (const k of R.kiosks || []) { fix(k, 'feederCable'); for (const e of k.erfs || []) fix(e, 'cableType'); }
    }
    try { for (const r of AppState.planAllRoutes()) fix(r, 'cableType'); } catch (e) { /* no plan */ }
    for (const c of AppState.components.values()) {
      if (c.type === 'distribution_board') for (const w of c.props.circuits || []) fix(w, 'cable');
      if (c.type === 'cable') fix(c.props, 'name');
    }
    if (n) AppState.dirty = true;
    return n;
  },

  // Every cable the open project references (by name or SLD id).
  _usedEntries() {
    const out = new Set();
    const byN = (n) => { const c = this.byName(n); if (c) out.add(c); };
    const R = AppState.reticulation;
    if (R) {
      if (R.settings) { byN(R.settings.quickFeederCable); byN(R.settings.quickServiceCable); }
      for (const k of R.kiosks || []) { byN(k.feederCable); for (const e of k.erfs || []) byN(e.cableType); }
    }
    try { for (const r of AppState.planAllRoutes()) byN(r.cableType); } catch (e) { /* no plan */ }
    for (const c of AppState.components.values()) {
      if (c.type === 'cable') { const x = this.byId(c.props.standard_type); if (x) out.add(x); }
      if (c.type === 'distribution_board') for (const w of c.props.circuits || []) byN(w.cable);
    }
    return [...out];
  },
  // Cables the user added to their own library that this project uses —
  // saved with the project so it opens complete on another computer.
  projectCustomCables() {
    const shipped = new Set(((typeof StandardData !== 'undefined' && StandardData._defaults) ? StandardData._defaults.cables : []).map(c => c.id));
    if (!shipped.size) return [];
    return this._usedEntries().filter(c => !shipped.has(c.id)).map(c => JSON.parse(JSON.stringify(c)));
  },
  // A project just loaded: add its custom cables that this library lacks
  // (matched by id; a local cable with the same id is kept as it is), then
  // rewrite former building-library names to the one library's names.
  onProjectLoaded(customCables) {
    let added = 0;
    if (Array.isArray(customCables) && typeof StandardData !== 'undefined' && Array.isArray(StandardData.cables)) {
      const have = new Set(StandardData.cables.map(c => c.id));
      for (const c of customCables) {
        if (!c || !c.id || !c.name || have.has(c.id)) continue;
        StandardData.cables.push(JSON.parse(JSON.stringify(c)));
        have.add(c.id);
        added++;
      }
      if (added) StandardData.syncCableLibrary();
    }
    for (const [from, to] of Object.entries(this.ALIASES)) this.renameInProject(from, to);
    if (added && typeof UI !== 'undefined') {
      setTimeout(() => UI.toast(`This project uses ${added} cable${added === 1 ? '' : 's'} that ${added === 1 ? 'was' : 'were'} not in your library; ${added === 1 ? 'it has' : 'they have'} been added (Settings › Cables).`, 'info', 6000), 800);
    }
    return added;
  },

  // ── Pickers ────────────────────────────────────────────────────────
  // <option>s for a <select> of cables.
  //   filter    (c) => bool — which cables this picker offers
  //   groups    [{ label, test(c) }] — optgroups, in order (default: by construction)
  //   prefer    'Al' | 'Cu' | '' — the project's standard conductor: those
  //             cables first; the others only after "Show all cables…"
  //   showAll   true once the user asked for everything
  // The selected cable always stays listed, whatever the filter.
  options(selectedName, { filter, groups, prefer = '', showAll = false } = {}) {
    const sel = this.resolveName(selectedName || '');
    let list = this.all().map(c => this.normalize(c)).filter(c => !filter || filter(c));
    let hidden = 0;
    if (prefer && !showAll) {
      const keep = list.filter(c => c.conductor === prefer || c.name === sel);
      hidden = list.length - keep.length;
      list = keep;
    } else if (prefer) {
      list = [...list.filter(c => c.conductor === prefer), ...list.filter(c => c.conductor !== prefer)];
    }
    const opt = (c) => `<option value="${escHtml(c.name)}"${c.name === sel ? ' selected' : ''}>${escHtml(c.name)}</option>`;
    const gs = groups || this.CONSTRUCTIONS.map(k => ({ label: k.label, test: (c) => c.construction === k.id }));
    let html = '<option value="">— select —</option>';
    const used = new Set();
    for (const g of gs) {
      const items = list.filter(c => !used.has(c) && g.test(c));
      items.forEach(c => used.add(c));
      if (items.length) html += `<optgroup label="${escHtml(g.label)}">${items.map(opt).join('')}</optgroup>`;
    }
    const rest = list.filter(c => !used.has(c));
    if (rest.length) html += `<optgroup label="Other">${rest.map(opt).join('')}</optgroup>`;
    if (hidden) html += `<option value="__all__">Show all cables… (${hidden} ${prefer === 'Al' ? 'Cu' : 'Al'} or other)</option>`;
    return html;
  },

  // Reticulation pickers: LV distribution 4-core, LV 2-core services, MV —
  // never building wiring or control cables.
  reticGroups() {
    return [
      { label: 'LV 4-core', test: (c) => !this.isMV(c) && Number(c.cores) !== 2 },
      { label: 'LV 2-core (single-phase services)', test: (c) => !this.isMV(c) && Number(c.cores) === 2 },
      { label: 'MV', test: (c) => this.isMV(c) },
    ];
  },
  reticFilter(voltage) {
    return (c) => this.isDistribution(c) && (voltage === 'mv' ? this.isMV(c) : voltage === 'lv' ? !this.isMV(c) : true);
  },
  // The conductor to list first for a picker, from the Demand settings.
  reticPrefer(voltage) {
    const s = (typeof AppState !== 'undefined' && AppState.reticulation && AppState.reticulation.settings) || {};
    return (voltage === 'mv' ? s.mvConductor : s.lvConductor) || '';
  },

  // A <select> offering "Show all cables…": when that entry is chosen, swap
  // in the full list and put back the value the model still holds. Call from
  // the change handler BEFORE acting on the value; true = it was only
  // "show all" (the caller does nothing else).
  handleShowAll(sel, currentValue, rebuild) {
    if (!sel || sel.value !== '__all__') return false;
    sel.innerHTML = rebuild(currentValue || '');
    sel.value = this.resolveName(currentValue || '');
    setTimeout(() => { try { sel.focus(); if (sel.showPicker) sel.showPicker(); } catch (e) { /* not supported */ } }, 0);
    return true;
  },
};
