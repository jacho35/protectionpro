/* ProtectionPro — Trip-unit profiles for MCCBs and ACBs.
 *
 * Picking a library breaker sets up its trip unit: the entry points at a
 * profile (TRIP_UNITS in constants.js: which settings the unit has and the
 * dial positions each can take) and the entry's own setting values are the
 * defaults written. The panel then offers the real dial steps, marks the dials
 * changed from default, resets one or all, suggests an Ir that fits the load
 * and the protected cable, and asks before a breaker swap drops the changes.
 *
 * A breaker has a trip unit once `props.trip_unit` holds a profile id; it also
 * carries `props.trip_unit_kind` ('tm' / 'electronic'), which the engines read
 * (cbHasElectronicTrip) so an electronic MCCB gets short-time/instantaneous
 * elements. Breakers without `trip_unit` (saved before this, or set to "None")
 * keep their free-number fields and behave exactly as before.
 */

const TripUnit = {
  // Breaker props a profile controls (hidden from the plain field list while
  // a trip unit is set up)
  DIAL_KEYS: Object.keys(TRIP_DIALS),

  _num(v) {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  },

  // ── Breakers of an interlocked-breaker-pair changeover ──

  // A breaker of a breaker-pair changeover as a CB-shaped object: its props
  // read and write the changeover's cb<n>_* keys (a blank rating falls back to
  // the changeover's own, CB type to ACB and In to the rated current — the
  // same view backend/analysis/changeover.py hands the engines). `id` is the
  // device id that leg has in the analysis (the live leg keeps the changeover
  // id, the other is <id>__in_<n>).
  leg(comp, n) {
    const pre = `cb${n}_`;
    const skip = new Set(['co_type', 'state', 'contact_duty', 'input_1_label', 'input_2_label', 'name']);
    const read = (t, k) => {
      const v = t[pre + k];
      if (v !== undefined && v !== '' && v !== null) return v;
      if (k === 'cb_type') return 'acb';
      if (k === 'trip_rating_a') return read(t, 'rated_current_a');
      return skip.has(k) || /^cb[12]_/.test(k) ? undefined : t[k];
    };
    const legKeys = (t) => {
      const keys = new Set();
      for (const k of Object.keys(t)) {
        if (k.startsWith(pre)) keys.add(k.slice(pre.length));
        else if (!/^cb[12]_/.test(k) && !skip.has(k)) keys.add(k);
      }
      return [...keys];
    };
    const props = new Proxy(comp.props, {
      get: (t, k) => (typeof k === 'string' ? read(t, k) : t[k]),
      set: (t, k, v) => { t[typeof k === 'string' ? pre + k : k] = v; return true; },
      deleteProperty: (t, k) => { delete t[typeof k === 'string' ? pre + k : k]; return true; },
      has: (t, k) => typeof k === 'string' ? read(t, k) !== undefined : k in t,
      ownKeys: (t) => legKeys(t),
      getOwnPropertyDescriptor: (t, k) => (typeof k === 'string' && legKeys(t).includes(k)
        ? { value: read(t, k), writable: true, enumerable: true, configurable: true } : undefined),
    });
    const pos = String(comp.props.state || 'in_1');
    const through = pos === 'in_2' ? 2 : 1;
    const roman = n === 1 ? 'I' : 'II';
    return {
      type: 'cb', props, coParent: comp.id, coLeg: n,
      id: n === through ? comp.id : `${comp.id}__in_${n}`,
      label: `${comp.props.name || comp.id} (${roman})`,
    };
  },

  // The CB (or changeover breaker) a TCC device stands for
  targetOfDev(dev) {
    if (!dev) return null;
    if (dev.coParent) {
      const parent = AppState.components.get(dev.coParent);
      return parent && Components.isBreakerPair(parent) ? this.leg(parent, dev.coLeg) : null;
    }
    return AppState.components.get(dev.id) || null;
  },

  // ── Profile resolution ──

  entryOf(comp) {
    if (!comp || comp.type !== 'cb' || !comp.props.standard_type) return null;
    return STANDARD_CBS.find(c => c.id === comp.props.standard_type) || null;
  },

  // Profiles that fit a breaker type
  profilesForType(cbType) {
    const t = cbType || 'mccb';
    if (t === 'acb') return ['etu_lsi'];
    if (t === 'mccb') return ['tm_fixed', 'tm_adj', 'etu_lsi_mccb'];
    return [];
  },

  // The profile a library entry gets when it names none: MCBs and MV breakers
  // none; MCCB by frame (≤ 100 A fixed thermal-magnetic, ≤ 250 A adjustable,
  // larger electronic); ACB electronic.
  inferFor(entry) {
    if (!entry) return null;
    const t = entry.cb_type || 'mccb';
    if (t === 'mcb' || (this._num(entry.rated_voltage_kv) || 0) > 1) return null;
    if (t === 'acb') return 'etu_lsi';
    const frame = this._num(entry.frame_a) || this._num(entry.trip_rating_a) || 0;
    if (frame <= 100) return 'tm_fixed';
    if (frame <= 250) return 'tm_adj';
    return 'etu_lsi_mccb';
  },

  // An entry's default profile: its own `default_trip_unit` / `trip_units`
  // (an empty list = no trip unit), else the inferred one
  defaultIdFor(entry) {
    if (!entry) return null;
    if (Array.isArray(entry.trip_units)) {
      const ok = entry.trip_units.filter(id => TRIP_UNITS[id]);
      if (!ok.length) return null;
      return ok.includes(entry.default_trip_unit) ? entry.default_trip_unit : ok[0];
    }
    return this.inferFor(entry);
  },

  activeId(comp) {
    const id = comp && comp.type === 'cb' && comp.props.trip_unit;
    return id && TRIP_UNITS[id] ? id : null;
  },

  profile(comp) {
    const id = this.activeId(comp);
    return id ? TRIP_UNITS[id] : null;
  },

  _isElectronicMccb(profile, cbType) {
    return profile && profile.kind === 'electronic' && (cbType || 'mccb') === 'mccb';
  },

  // ── Values ──

  // Nearest dial position (fixed dials take any value)
  snap(dial, v) {
    const n = this._num(v);
    if (!dial || dial.fixed || !dial.steps || !dial.steps.length) return n;
    if (n === null) return dial.def;
    if (dial.off && n <= 0) return 0;
    let best = null;
    for (const s of dial.steps) {
      if (dial.off && s === 0) continue;
      if (best === null || Math.abs(s - n) < Math.abs(best - n)) best = s;
    }
    return best;
  },

  // Settings a breaker gets on profile `pid`: the entry's own values snapped to
  // the dials (so a company/shared/user library edit is the default), else the
  // dial default. Props outside the profile keep the library behaviour
  // (thermal-magnetic: no short-time/instantaneous).
  defaults(entry, pid) {
    const prof = TRIP_UNITS[pid];
    const e = entry || {};
    const out = {
      thermal_pickup: 1.0,
      long_time_delay: this._num(e.long_time_delay) ?? 10,
      magnetic_pickup: this._num(e.magnetic_pickup) ?? 10,
      short_time_pickup: 0,
      short_time_delay: 0,
      instantaneous_pickup: 0,
    };
    if (!prof) return out;
    for (const [k, d] of Object.entries(prof.dials)) {
      const ev = this._num(e[k]);
      out[k] = ev === null ? d.def : (d.fixed ? ev : this.snap(d, ev));
    }
    this._mirrorMagnetic(out, prof, e.cb_type);
    return out;
  },

  // An electronic MCCB's magnetic pickup follows its instantaneous dial, so
  // anything that only knows the thermal-magnetic model sees the same trip.
  _mirrorMagnetic(vals, prof, cbType) {
    if (this._isElectronicMccb(prof, cbType) && vals.instantaneous_pickup > 0) {
      vals.magnetic_pickup = vals.instantaneous_pickup;
    }
  },

  // Defaults for the breaker as it stands (its library entry, if any)
  currentDefaults(comp) {
    const pid = this.activeId(comp);
    if (!pid) return null;
    const entry = this.entryOf(comp) || { cb_type: comp.props.cb_type };
    return this.defaults(entry, pid);
  },

  // Adjustable dials that differ from their default
  edited(comp) {
    const prof = this.profile(comp);
    if (!prof) return [];
    const def = this.currentDefaults(comp);
    return Object.entries(prof.dials)
      .filter(([k, d]) => !d.fixed && Math.abs((this._num(comp.props[k]) ?? 0) - (def[k] ?? 0)) > 1e-9)
      .map(([k]) => k);
  },

  _write(comp, pid, vals) {
    Object.assign(comp.props, vals);
    comp.props.trip_unit = pid;
    comp.props.trip_unit_kind = TRIP_UNITS[pid].kind;
  },

  // Fresh defaults (library pick, Reset all)
  apply(comp, entry, pid) {
    this._write(comp, pid, this.defaults(entry || { cb_type: comp.props.cb_type }, pid));
  },

  // Set up a trip unit on a breaker that already has settings (a breaker saved
  // before trip-unit profiles, a custom breaker, or a change of profile): the
  // current value of each dial is kept, moved to the nearest dial position.
  adopt(comp, pid) {
    const prof = TRIP_UNITS[pid];
    const entry = this.entryOf(comp) || { cb_type: comp.props.cb_type };
    const vals = this.defaults(entry, pid);
    const p = comp.props;
    const elecMccb = this._isElectronicMccb(prof, p.cb_type);
    for (const [k, d] of Object.entries(prof.dials)) {
      let cur = this._num(p[k]);
      // A thermal-magnetic MCCB's instantaneous trip is its magnetic pickup
      if (k === 'instantaneous_pickup' && elecMccb && !(cur > 0)) cur = this._num(p.magnetic_pickup);
      if (cur === null || (cur <= 0 && !d.off)) continue;
      vals[k] = d.fixed ? cur : this.snap(d, cur);
    }
    this._mirrorMagnetic(vals, prof, p.cb_type);
    this._write(comp, pid, vals);
  },

  // Back to free settings. An MCCB drops the electronic-only elements the
  // thermal-magnetic model can't show.
  clear(comp) {
    const p = comp.props;
    if ((p.cb_type || 'mccb') === 'mccb' && p.trip_unit_kind === 'electronic') {
      p.short_time_pickup = 0;
      p.short_time_delay = 0;
      p.instantaneous_pickup = 0;
    }
    delete p.trip_unit;
    delete p.trip_unit_kind;
  },

  // Settings for a new breaker that keep the changed dials of the old one:
  // Ir kept in amps (nearest dial position at or above), the other changed
  // dials copied across where the new unit has them.
  keepInAmps(oldProps, editedKeys, newEntry, newPid) {
    const prof = TRIP_UNITS[newPid];
    const vals = this.defaults(newEntry, newPid);
    const newIn = this._num(newEntry.trip_rating_a) || 0;
    for (const k of editedKeys) {
      const d = prof.dials[k];
      if (!d || d.fixed) continue;
      if (k === 'thermal_pickup' && newIn > 0) {
        const irA = (this._num(oldProps.trip_rating_a) || 0) * (this._num(oldProps.thermal_pickup) || 1);
        const fit = d.steps.filter(s => s * newIn >= irA - 1e-6);
        vals[k] = fit.length ? Math.min(...fit) : Math.max(...d.steps);
      } else {
        vals[k] = this.snap(d, oldProps[k]);
      }
    }
    this._mirrorMagnetic(vals, prof, newEntry.cb_type);
    return vals;
  },

  // ── Ir suggestion: Ib ≤ Ir ≤ Iz ──

  // Load current and installed rating of the cable this breaker protects: from
  // Cable Sizing (which already knows each cable's protective device), else
  // from load flow when the breaker feeds exactly one cable directly.
  _circuit(comp) {
    const cs = AppState.cableSizingResults && AppState.cableSizingResults.cables;
    if (Array.isArray(cs)) {
      const mine = cs.filter(c => c.protective_device_id === comp.id);
      if (mine.length) {
        const izs = mine.map(c => (c.derated_ampacity_a || 0) * (c.num_parallel || 1)).filter(v => v > 0);
        return {
          ib: Math.max(...mine.map(c => c.load_current_a || 0)),
          iz: izs.length ? Math.min(...izs) : null,
          from: mine.length === 1 ? mine[0].cable_name : `${mine.length} cables`,
          study: 'Cable sizing',
        };
      }
    }
    const lf = AppState.loadFlowResults;
    if (!lf || !Array.isArray(lf.branches)) return null;
    const cable = this._fedCable(comp);
    if (!cable) return null;
    const br = lf.branches.find(b => b.elementId === cable.id);
    if (!br) return null;
    const n = this._num(cable.props.num_parallel) || 1;
    const amp = cable.props.ampacity;
    const per = amp && amp.applied ? this._num(amp.derated_a) : this._num(cable.props.rated_amps);
    return {
      ib: br.i_amps || 0,
      iz: per ? per * n : null,
      from: cable.props.name || cable.id,
      study: 'Load flow',
    };
  },

  // The one cable reached from the breaker through closed switchgear without
  // crossing a bus (null when none or several)
  _fedCable(comp) {
    const pass = new Set(['cb', 'switch', 'fuse', 'ct', 'pt', 'surge_arrester', 'bus_duct']);
    const seen = new Set([comp.id]);
    const stack = [comp.id];
    const found = new Map();
    while (stack.length) {
      const id = stack.pop();
      for (const { componentId } of Components.getConnectedComponents(id)) {
        if (seen.has(componentId)) continue;
        seen.add(componentId);
        const c = AppState.components.get(componentId);
        if (!c) continue;
        if (c.type === 'cable') found.set(c.id, c);
        else if (pass.has(c.type) && !Components.isOpenSwitching(c)) stack.push(c.id);
      }
    }
    return found.size === 1 ? [...found.values()][0] : null;
  },

  // → { ib, iz, step, amps, from, study } when a different Ir fits, or
  // { …, problem } when none does; null without results or an Ir dial
  suggestIr(comp) {
    const prof = this.profile(comp);
    const d = prof && prof.dials.thermal_pickup;
    if (!d || d.fixed) return null;
    const inA = this._num(comp.props.trip_rating_a) || 0;
    const c = this._circuit(comp);
    if (!c || !(c.ib > 0) || !(inA > 0)) return null;
    const fits = d.steps.filter(s => s * inA >= c.ib - 1e-6);
    if (!fits.length) return { ...c, problem: `Ib ${this.fmtA(c.ib)} is more than In ${this.fmtA(inA)}: pick a larger breaker.` };
    const step = Math.min(...fits);
    if (c.iz && step * inA > c.iz + 1e-6) {
      return { ...c, problem: `No Ir setting carries Ib ${this.fmtA(c.ib)} without exceeding Iz ${this.fmtA(c.iz)}.` };
    }
    if (Math.abs(step - (this._num(comp.props.thermal_pickup) || 1)) < 1e-9) return null;
    return { ...c, step, amps: step * inA };
  },

  // ── Display ──

  fmtA(a) {
    return a >= 1000 ? `${+(a / 1000).toFixed(2)} kA` : `${Math.round(a)} A`;
  },

  fmtVal(key, v, dial) {
    if (dial && dial.off && v === 0) return 'Off';
    return String(+(+v).toFixed(3));
  },

  // Amps a dial position trips at (Ir from In; the rest from Ir)
  amps(comp, key, v) {
    const meta = TRIP_DIALS[key];
    if (!meta || !meta.ampsOf || !(v > 0)) return '';
    const inA = this._num(comp.props.trip_rating_a) || 0;
    const ir = inA * (this._num(comp.props.thermal_pickup) || 1);
    return this.fmtA(meta.ampsOf === 'In' ? inA * v : ir * v);
  },

  optionsHtml(dial, value) {
    const steps = [...dial.steps];
    const cur = this._num(value);
    if (cur !== null && !steps.some(s => Math.abs(s - cur) < 1e-9)) steps.push(cur);
    steps.sort((a, b) => a - b);
    return steps.map(s => {
      const sel = cur !== null && Math.abs(s - cur) < 1e-9 ? ' selected' : '';
      return `<option value="${s}"${sel}>${this.fmtVal(null, s, dial)}</option>`;
    }).join('');
  },

  _profileOptions(comp) {
    const entry = this.entryOf(comp);
    const def = entry ? this.defaultIdFor(entry) : null;
    const ids = this.profilesForType(comp.props.cb_type);
    const active = this.activeId(comp);
    if (active && !ids.includes(active)) ids.push(active);
    const opts = [`<option value=""${active ? '' : ' selected'}>None — free settings</option>`];
    for (const id of ids) {
      const tag = id === def ? ' (default)' : '';
      opts.push(`<option value="${id}"${id === active ? ' selected' : ''}>${escHtml(TRIP_UNITS[id].label)}${tag}</option>`);
    }
    return opts.join('');
  },

  // The Trip unit section of the properties panel ('' for an MCB or MV breaker)
  panelHtml(comp) {
    if (!comp || comp.type !== 'cb') return '';
    const types = this.profilesForType(comp.props.cb_type);
    const prof = this.profile(comp);
    if (!types.length && !prof) return '';
    const p = comp.props;
    const entry = this.entryOf(comp);
    let html = `<div class="prop-section tu-section" data-trip-unit="${comp.coLeg || ''}">
      <div class="prop-section-title tu-head"><span>Trip unit</span>${prof ? `<button type="button" class="tu-reset-all" data-tu-reset-all title="Put every dial back to the ${entry ? escHtml(entry.name) : 'profile'} default">Reset all</button>` : ''}</div>
      <div class="prop-row"><label>Trip unit</label><select data-tu-profile aria-label="Trip unit">${this._profileOptions(comp)}</select></div>`;
    if (!prof) {
      const hint = entry
        ? 'Set up a trip unit to adjust this breaker in its real dial steps. Its current settings are kept.'
        : 'Pick a trip unit to set this breaker with dial steps instead of free numbers.';
      return html + `<div class="prop-hint tu-hint">${hint}</div></div>`;
    }
    const inA = this._num(p.trip_rating_a) || 0;
    const frame = entry && this._num(entry.frame_a);
    html += `<div class="prop-hint tu-meta">In ${this.fmtA(inA)}${frame && frame !== inA ? ` · frame ${this.fmtA(frame)}` : ''}${entry ? ` · ${escHtml(entry.name)}` : ''}</div>`;

    const sug = this.suggestIr(comp);
    if (sug) {
      const basis = `${escHtml(sug.study)}: Ib ${this.fmtA(sug.ib)}${sug.iz ? `, Iz ${this.fmtA(sug.iz)}` : ''} (${escHtml(sug.from)}).`;
      html += sug.problem
        ? `<div class="tu-suggest tu-suggest--warn" role="status">${basis} ${escHtml(sug.problem)}</div>`
        : `<div class="tu-suggest" role="status">${basis} <strong>Ir ${this.fmtVal(null, sug.step)} (${this.fmtA(sug.amps)})</strong> fits.
            <button type="button" class="tu-apply" data-tu-apply-ir="${sug.step}">Apply</button></div>`;
    }

    const def = this.currentDefaults(comp);
    const edited = new Set(this.edited(comp));
    const stOff = prof.dials.short_time_pickup && !(this._num(p.short_time_pickup) > 0);
    for (const [k, d] of Object.entries(prof.dials)) {
      const meta = TRIP_DIALS[k];
      const v = this._num(p[k]);
      const label = `${meta.label} <span class="tu-unit">${meta.unit}</span>`;
      const amps = this.amps(comp, k, v);
      if (d.fixed) {
        html += `<div class="prop-row tu-row"><label>${label}</label><span class="tu-fixed">${this.fmtVal(k, v, d)} (fixed)</span><span class="tu-amps">${amps}</span></div>`;
        continue;
      }
      const isEd = edited.has(k);
      const dim = k === 'short_time_delay' && stOff;
      html += `<div class="prop-row tu-row${isEd ? ' tu-row--edited' : ''}">
        <label>${label}</label>
        <select data-tu-dial="${k}" aria-label="${meta.label} (${meta.unit})"${dim ? ' disabled title="Short-time is off"' : ''}>${this.optionsHtml(d, v)}</select>
        <span class="tu-amps">${amps}</span>
        ${isEd
          ? `<button type="button" class="tu-reset" data-tu-reset="${k}" title="Reset to default (${this.fmtVal(k, def[k], d)})" aria-label="Reset ${meta.label} to default ${this.fmtVal(k, def[k], d)}">&#x21A9;</button>`
          : `<span class="tu-def" title="Default setting">def</span>`}
      </div>`;
    }
    const nAdj = Object.values(prof.dials).filter(d => !d.fixed).length;
    if (nAdj) {
      html += `<div class="prop-hint tu-foot">${edited.size ? `${edited.size} of ${nAdj} dial${nAdj === 1 ? '' : 's'} changed from default` : 'All dials at default'}</div>`;
    }
    return html + '</div>';
  },

  // ── Binding (properties panel + properties window) ──

  _commit(comp) {
    AppState.dirty = true;
    Properties._notifyResultsCleared();
    AppState.clearResults();
    if (typeof UndoManager !== 'undefined') UndoManager.snapshot();
    Canvas.render();
    Properties.show(comp.coParent || comp.id);
  },

  setDial(comp, key, value) {
    const prof = this.profile(comp);
    const d = prof && prof.dials[key];
    if (!d || d.fixed) return;
    comp.props[key] = this.snap(d, value);
    this._mirrorMagnetic(comp.props, prof, comp.props.cb_type);
  },

  bind(root, owner) {
    root.querySelectorAll('[data-trip-unit]').forEach(sec => {
      const n = parseInt(sec.dataset.tripUnit, 10);
      this._bindSection(sec, n ? this.leg(owner, n) : owner);
    });
  },

  _bindSection(sec, comp) {
    sec.querySelector('[data-tu-profile]')?.addEventListener('change', (e) => {
      const pid = e.target.value;
      if (pid && TRIP_UNITS[pid]) this.adopt(comp, pid);
      else this.clear(comp);
      this._commit(comp);
    });
    sec.querySelectorAll('[data-tu-dial]').forEach(sel => {
      sel.addEventListener('change', () => {
        this.setDial(comp, sel.dataset.tuDial, parseFloat(sel.value));
        this._commit(comp);
      });
    });
    sec.querySelectorAll('[data-tu-reset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const def = this.currentDefaults(comp);
        const k = btn.dataset.tuReset;
        if (def && k in def) this.setDial(comp, k, def[k]);
        this._commit(comp);
      });
    });
    sec.querySelector('[data-tu-reset-all]')?.addEventListener('click', () => {
      const pid = this.activeId(comp);
      if (!pid) return;
      this.apply(comp, this.entryOf(comp), pid);
      this._commit(comp);
    });
    sec.querySelector('[data-tu-apply-ir]')?.addEventListener('click', (e) => {
      this.setDial(comp, 'thermal_pickup', parseFloat(e.currentTarget.dataset.tuApplyIr));
      this._commit(comp);
    });
  },

  // ── Picking a different library breaker ──

  // Before `comp` changes from its library entry to `newId`: when dials were
  // changed from default and the new breaker has a trip unit, ask whether to
  // keep them. → Promise of { keep: bool } or null (cancelled). Resolves
  // { keep: false } straight away when there is nothing to ask.
  confirmSwap(comp, newId) {
    const newEntry = STANDARD_CBS.find(c => c.id === newId);
    const newPid = newEntry && this.defaultIdFor(newEntry);
    const editedKeys = this.edited(comp);
    if (!newPid || !editedKeys.length || newId === comp.props.standard_type) {
      return Promise.resolve({ keep: false, editedKeys: [] });
    }
    const oldProps = { ...comp.props };
    const keepVals = this.keepInAmps(oldProps, editedKeys, newEntry, newPid);
    const defVals = this.defaults(newEntry, newPid);
    const newIn = this._num(newEntry.trip_rating_a) || 0;
    const prof = TRIP_UNITS[newPid];
    const cell = (props, inA, k) => {
      const v = this._num(props[k]);
      const d = prof.dials[k] || this.profile(comp)?.dials[k];
      const meta = TRIP_DIALS[k];
      let amps = '';
      if (meta.ampsOf && v > 0) {
        const ir = inA * (this._num(props.thermal_pickup) || 1);
        amps = ` → ${this.fmtA(meta.ampsOf === 'In' ? inA * v : ir * v)}`;
      }
      return `${this.fmtVal(k, v, d)}${amps}`;
    };
    const oldIn = this._num(oldProps.trip_rating_a) || 0;
    const rows = editedKeys.map(k => `<tr>
        <th scope="row">${TRIP_DIALS[k].label}</th>
        <td class="tu-sw-now">${cell(oldProps, oldIn, k)}</td>
        <td>${prof.dials[k] ? cell(keepVals, newIn, k) : '—'}</td>
        <td>${cell(defVals, newIn, k)}</td></tr>`).join('');
    const name = escHtml(comp.label || comp.props.name || comp.id);
    const irKept = editedKeys.includes('thermal_pickup') && prof.dials.thermal_pickup && !prof.dials.thermal_pickup.fixed;

    return new Promise((resolve) => {
      const prevFocus = document.activeElement;
      const overlay = document.createElement('div');
      overlay.className = 'modal ui-dialog';
      overlay.style.zIndex = '3000';
      overlay.innerHTML = `<div class="modal-content ui-dialog-content tu-swap" role="dialog" aria-modal="true" aria-labelledby="tu-swap-title">
        <div class="modal-header"><h3 id="tu-swap-title">Change ${name} to ${escHtml(newEntry.name)}?</h3></div>
        <div class="modal-body">
          <p class="ui-dialog-message">${editedKeys.length === 1 ? 'One dial on this breaker was' : `${editedKeys.length} dials on this breaker were`} changed from default. Pick what the new breaker starts from.</p>
          <table class="tu-sw-table">
            <thead><tr><th scope="col">Dial</th><th scope="col">Now (In ${this.fmtA(oldIn)})</th><th scope="col">Keep</th><th scope="col">New defaults</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <fieldset class="tu-sw-opts">
            <legend class="sr-only">Settings for the new breaker</legend>
            <label class="tu-sw-opt"><input type="radio" name="tu-sw" value="keep" checked>
              <span><strong>Keep my settings</strong><br><span class="tu-sw-sub">${irKept ? 'Ir moves to the nearest dial step at or above the current amps. ' : ''}Changed dials are copied across where the new unit has them.</span></span></label>
            <label class="tu-sw-opt"><input type="radio" name="tu-sw" value="reset">
              <span><strong>Use ${escHtml(newEntry.name)} defaults</strong><br><span class="tu-sw-sub">Every dial goes to the library default. Your changes are dropped.</span></span></label>
          </fieldset>
          <div class="ui-dialog-actions">
            <button type="button" class="btn-small ui-dialog-cancel">Cancel</button>
            <button type="button" class="btn-primary ui-dialog-ok">Change breaker</button>
          </div>
        </div></div>`;
      document.body.appendChild(overlay);
      const content = overlay.querySelector('.modal-content');
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        try { prevFocus && prevFocus.focus && prevFocus.focus(); } catch (_) { /* gone */ }
        resolve(result);
      };
      const ok = () => done({ keep: content.querySelector('input[name="tu-sw"]:checked').value === 'keep', editedKeys, oldProps });
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
        else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.preventDefault(); ok(); }
        else if (e.key === 'Tab') {
          const items = [...content.querySelectorAll('button, input')].filter(el => !el.disabled);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      };
      document.addEventListener('keydown', onKey, true);
      content.querySelector('.ui-dialog-ok').addEventListener('click', ok);
      content.querySelector('.ui-dialog-cancel').addEventListener('click', () => done(null));
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null); });
      requestAnimationFrame(() => content.querySelector('.ui-dialog-ok').focus());
    });
  },

  // After a library pick: set up the new entry's trip unit (or drop it), then
  // carry the kept dials when the swap dialog said so.
  afterLibraryPick(comp, swap) {
    const entry = this.entryOf(comp);
    const pid = entry && this.defaultIdFor(entry);
    if (!pid) { this.clear(comp); return; }
    if (swap && swap.keep && swap.editedKeys && swap.editedKeys.length) {
      this._write(comp, pid, this.keepInAmps(swap.oldProps, swap.editedKeys, entry, pid));
    } else {
      this.apply(comp, entry, pid);
    }
  },

  // ── TCC ──

  // Snap a TCC drag / arrow-key change of a trip-unit breaker to its dials.
  // An electronic MCCB's magnetic handle moves its instantaneous dial.
  snapTccDevice(dev, mode) {
    const comp = this.targetOfDev(dev);
    const prof = comp && this.profile(comp);
    if (!prof) return;
    const p = dev.cbParams;
    if (mode === 'thermal') {
      const d = prof.dials.thermal_pickup;
      p.thermal_pickup = d.fixed ? comp.props.thermal_pickup : this.snap(d, p.thermal_pickup);
    } else if (mode === 'magnetic') {
      if (this._isElectronicMccb(prof, p.cb_type)) {
        p.instantaneous_pickup = this.snap(prof.dials.instantaneous_pickup, p.magnetic_pickup);
        p.magnetic_pickup = p.instantaneous_pickup;
      } else if (prof.dials.magnetic_pickup) {
        const d = prof.dials.magnetic_pickup;
        p.magnetic_pickup = d.fixed ? comp.props.magnetic_pickup : this.snap(d, p.magnetic_pickup);
      }
    }
  },

  // Dial rows for the TCC settings drawer (data-sel-field="cb.<key>")
  tccRowsHtml(comp, p) {
    const prof = this.profile(comp);
    if (!prof) return '';
    return Object.entries(prof.dials).map(([k, d]) => {
      const meta = TRIP_DIALS[k];
      const label = `${meta.label} (${meta.unit})`;
      const control = d.fixed
        ? `<span class="tu-fixed">${this.fmtVal(k, p[k], d)} (fixed)</span>`
        : `<select data-sel-field="cb.${k}" data-num="1">${this.optionsHtml(d, p[k])}</select>`;
      return `<div class="tcc-form-row"><label>${label}</label>${control}</div>`;
    }).join('');
  },
};
