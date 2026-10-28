/* ProtectionPro — DB controls: contactors, what switches them and their supplies.
 *
 * A contactor is defined once on the board and the ways it switches point at
 * it, so the schedule, the board single line (DBDrawing), the GA (GA.items)
 * and the BOQ all read the same record:
 *
 *   comp.props.controls = {
 *     supplies:   [{ id, tag: 'CB-C1', kind: 'mcb'|'transformer'|'external',
 *                    breaker_a, phase: 'R'|'W'|'B', voltage: '230 V AC', note }],
 *     contactors: [{ id, tag: 'K1', label, arrangement: 'single'|'poles'|'section',
 *                    poles: '2P'|'3P'|'4P', rating_a, category: 'AC-1'|'AC-3'|…,
 *                    coil: '230 V AC', switches: [{ kind, tag, setting }],
 *                    combine: 'series'|'parallel', selector: 'hoa'|'oa'|'none',
 *                    selector_tag, supply: <supply id>, lamp }],
 *   }
 *   way.contactor = <contactor id>   (in props.circuits)
 *
 * Arrangements: 'single' — one way through its own contactor; 'poles' — one
 * contactor, each way on a pole of its own after its own MCB; 'section' — the
 * contactor feeds a group of ways (a switched busbar section).
 *
 * A switching device with the same tag on two contactors is ONE device (a
 * photocell PC1 switching K1 and K5): drawn on both control rungs, fitted and
 * priced once. A board can have any number of control supplies; each contactor
 * names the one its coil runs from.
 *
 * Absent `controls` ⇒ nothing changes anywhere — reads go through peek(), which
 * never writes, so a board that is only looked at stays byte-identical. Sizes
 * (DIN modules, heat) are generic; the checks are advisory, like
 * DBAccessories.warnings().
 */

const CTL_CATEGORIES = [
  { v: 'AC-1', label: 'AC-1 resistive / heating' },
  { v: 'AC-3', label: 'AC-3 motors' },
  { v: 'AC-5a', label: 'AC-5a discharge / LED lighting' },
  { v: 'AC-5b', label: 'AC-5b incandescent lighting' },
  { v: 'AC-7a', label: 'AC-7a household loads' },
];
const CTL_RATINGS = [16, 20, 25, 32, 40, 63, 80, 100, 125, 160, 200, 250, 315, 400];
const CTL_ARRANGEMENTS = [
  { v: 'single', label: 'One circuit', hint: 'MCB → contactor → circuit' },
  { v: 'poles', label: 'Several circuits, a pole each', hint: 'each circuit keeps its own MCB' },
  { v: 'section', label: 'Switched section', hint: 'the contactor feeds a group of ways' },
];
// modules = DIN width in the board; 0 = a field / door device wired to terminals.
const CTL_SWITCH_KINDS = [
  { key: 'photocell', label: 'Photocell', prefix: 'PC', modules: 1, heat_w: 1, field: 'sensor head mounted outside', setting: 'On at 50 lx' },
  { key: 'timer', label: 'Time switch', prefix: 'T', modules: 2, heat_w: 1, setting: 'Mon–Fri 06:00–18:00' },
  { key: 'astro', label: 'Astronomical clock', prefix: 'AT', modules: 2, heat_w: 1, setting: 'Dusk to 23:00' },
  { key: 'thermostat', label: 'Thermostat', prefix: 'TS', modules: 0, heat_w: 0, field: 'field device', setting: 'Cooling call' },
  { key: 'bms', label: 'BMS / remote enable', prefix: 'BMS', modules: 0, heat_w: 0, field: 'volt-free contact', setting: 'Enable' },
  { key: 'pushbutton', label: 'Start / stop push-buttons', prefix: 'PB', modules: 0, heat_w: 0, field: 'door or field', setting: '' },
  { key: 'fire', label: 'Fire alarm trip', prefix: 'FA', modules: 0, heat_w: 0, field: 'from the fire panel', setting: 'Opens on alarm' },
  { key: 'other', label: 'Other contact', prefix: 'X', modules: 0, heat_w: 0, field: 'field device', setting: '' },
];
const CTL_SELECTORS = [
  { v: 'hoa', label: 'Hand – Off – Auto' },
  { v: 'oa', label: 'Off – Auto' },
  { v: 'none', label: 'None' },
];
const CTL_SUPPLY_KINDS = [
  { v: 'mcb', label: 'MCB off the busbar', modules: 1, heat_w: 1 },
  { v: 'transformer', label: 'Control transformer + MCB', modules: 5, heat_w: 7 },
  { v: 'external', label: 'External / UPS supply', modules: 0, heat_w: 0 },
];
const CTL_COILS = ['230 V AC', '24 V AC', '24 V DC', '110 V AC', '400 V AC'];

const DBControls = {
  _seq: 0,
  _openSection: true,

  // ── Model ───────────────────────────────────────────────────────────
  _uid(p) { return p + (++this._seq).toString(36) + Math.random().toString(36).slice(2, 7); },

  // Read-only view of a board's controls — never writes, so drawing / GA /
  // BOQ reads cannot dirty a board that has none.
  peek(comp) {
    const d = comp && comp.props && comp.props.controls;
    return {
      supplies: d && Array.isArray(d.supplies) ? d.supplies : [],
      contactors: d && Array.isArray(d.contactors) ? d.contactors : [],
    };
  },

  // The writable record (created on the first edit).
  data(comp) {
    if (!comp.props.controls || typeof comp.props.controls !== 'object') comp.props.controls = {};
    const d = comp.props.controls;
    if (!Array.isArray(d.supplies)) d.supplies = [];
    if (!Array.isArray(d.contactors)) d.contactors = [];
    return d;
  },

  has(comp) { return this.peek(comp).contactors.length > 0; },
  contactors(comp) { return this.peek(comp).contactors; },
  supplies(comp) { return this.peek(comp).supplies; },
  contactor(comp, id) { return this.contactors(comp).find(k => k.id === id) || null; },
  supply(comp, id) { return this.supplies(comp).find(s => s.id === id) || null; },

  // The contactor a way is switched by. A pasted / imported tag ('K1') resolves too.
  wayContactor(comp, c) {
    const v = c && c.contactor;
    if (!v) return null;
    const list = this.contactors(comp);
    return list.find(k => k.id === v)
      || list.find(k => String(k.tag || '').toLowerCase() === String(v).trim().toLowerCase()) || null;
  },

  waysOf(comp, k) {
    const ways = (comp.props.circuits || []).filter(c => this.wayContactor(comp, c) === k);
    return ways.sort((a, b) => String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }));
  },

  // Pole numbers a way takes on a 'poles' contactor ('1' or '2–4'), else ''.
  poleLabel(comp, k, c) {
    if (!k || k.arrangement !== 'poles') return '';
    let n = 0;
    for (const w of this.waysOf(comp, k)) {
      const p = this._is3(w) ? 3 : 1;
      if (w === c) return p === 1 ? `${n + 1}` : `${n + 1}–${n + p}`;
      n += p;
    }
    return '';
  },

  _is3(c) { return c.poles === '3P' || c.phase === 'RWB'; },
  _isLighting(c) { return /light|lamp|lumin|flood|fa[cç]ade|sign|street|parking/i.test(String(c.description || '')); },
  _isMotor(c) { return /pump|motor|fan|compress|hvac|aircon|a\/c|ahu|condens|chiller|drive|extract|fcu|split/i.test(String(c.description || '')); },
  _polesN(k) { return parseInt(String(k.poles || '3P'), 10) || 3; },

  _nextTag(tags, prefix) {
    let max = 0;
    const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '(\\d+)$', 'i');
    for (const t of tags) { const m = re.exec(String(t || '').trim()); if (m) max = Math.max(max, Number(m[1])); }
    return prefix + (max + 1);
  },

  // Every switching-device and selector tag on the board (for numbering).
  _allSwitchTags(comp) {
    const out = [];
    for (const k of this.contactors(comp)) {
      for (const s of (k.switches || [])) out.push(s.tag);
      out.push(k.selector_tag);
    }
    return out;
  },

  newSwitch(comp, kind, extraTags) {
    const kd = CTL_SWITCH_KINDS.find(x => x.key === kind) || CTL_SWITCH_KINDS[0];
    return { kind: kd.key, tag: this._nextTag(this._allSwitchTags(comp).concat(extraTags || []), kd.prefix), setting: kd.setting || '' };
  },

  addSupply(comp) {
    const d = this.data(comp);
    const s = { id: this._uid('cs'), tag: this._nextTag(d.supplies.map(x => x.tag), 'CB-C'), kind: 'mcb',
      breaker_a: 6, phase: 'R', voltage: '230 V AC', note: '' };
    d.supplies.push(s);
    return s;
  },

  removeSupply(comp, id) {
    const d = this.data(comp);
    d.supplies = d.supplies.filter(s => s.id !== id);
    for (const k of d.contactors) if (k.supply === id) k.supply = '';
  },

  // A new contactor for `ways` (circuit objects), sized from them, on the
  // board's first control supply (one is made when the board has none).
  newContactor(comp, ways) {
    const d = this.peek(comp);
    const k = {
      id: this._uid('k'), tag: this._nextTag(d.contactors.map(x => x.tag), 'K'),
      label: ways && ways.length ? String(ways[0].description || '').trim() : '',
      arrangement: ways && ways.length > 1 ? 'poles' : 'single',
      poles: '2P', rating_a: 25, category: 'AC-1', coil: '230 V AC',
      switches: [], combine: 'series', selector: 'hoa', selector_tag: '', supply: d.supplies.length ? d.supplies[0].id : '',
      lamp: false,
    };
    k.selector_tag = this._nextTag(this._allSwitchTags(comp), 'S');
    Object.assign(k, this.suggest(comp, k, ways || []));
    if (ways && ways.some(w => this._isLighting(w))) k.switches.push(this.newSwitch(comp, 'photocell'));
    return k;
  },

  // Adds a contactor (with a control supply if the board has none) and links `ways`.
  addContactor(comp, ways) {
    const d = this.data(comp);
    if (!d.supplies.length) this.addSupply(comp);
    const k = this.newContactor(comp, ways);
    if (!k.supply) k.supply = d.supplies[0].id;
    d.contactors.push(k);
    for (const w of ways || []) w.contactor = k.id;
    return k;
  },

  removeContactor(comp, id) {
    const d = this.data(comp);
    d.contactors = d.contactors.filter(k => k.id !== id);
    for (const c of (comp.props.circuits || [])) {
      if (c.contactor && !this.wayContactor(comp, c)) delete c.contactor;
    }
  },

  // ── Sizing ──────────────────────────────────────────────────────────
  polesNeeded(k, ways) {
    if (!ways.length) return 0;
    if (k.arrangement === 'poles') return ways.reduce((n, w) => n + (this._is3(w) ? 3 : 1), 0);
    if (k.arrangement === 'section') {
      const phases = new Set(ways.map(w => this._is3(w) ? 'RWB' : (w.phase || 'R')));
      return phases.has('RWB') || phases.size > 1 ? 4 : 2;
    }
    return ways.some(w => this._is3(w)) ? 3 : 2;
  },

  // Highest phase current the contactor carries: the worst way for 'single' /
  // 'poles' (its breaker rating — what it must withstand), the diversified
  // phase sum for a switched section.
  dutyA(comp, k, ways) {
    if (!ways.length) return 0;
    if (k.arrangement !== 'section') return Math.max(...ways.map(w => Number(w.breaker_a) || 0));
    const vll = DBSchedule._boardVll(comp);
    const ph = { R: 0, W: 0, B: 0 };
    for (const w of ways) {
      const a = DBSchedule._wayCurrentA(w, vll);
      if (this._is3(w)) { ph.R += a; ph.W += a; ph.B += a; } else ph[w.phase || 'R'] += a;
    }
    return Math.max(ph.R, ph.W, ph.B);
  },

  suggest(comp, k, ways) {
    const n = this.polesNeeded(k, ways);
    const poles = n <= 2 ? '2P' : n === 3 ? '3P' : '4P';
    const duty = this.dutyA(comp, k, ways);
    const rating_a = CTL_RATINGS.find(r => r >= duty) || CTL_RATINGS[CTL_RATINGS.length - 1];
    const category = ways.some(w => this._isMotor(w)) ? 'AC-3'
      : ways.length && ways.every(w => this._isLighting(w)) ? 'AC-5a' : 'AC-1';
    return { poles, rating_a: Math.max(16, rating_a), category };
  },

  // ── Checks (advisory) ───────────────────────────────────────────────
  warnings(comp, k) {
    const out = [];
    const ways = this.waysOf(comp, k);
    const rating = Number(k.rating_a) || 0;
    const cat = k.category || 'AC-1';
    if (!ways.length) out.push({ level: 'info', text: 'Switches no way yet — pick its ways in the Control column or the editor.' });
    const need = this.polesNeeded(k, ways);
    const have = this._polesN(k);
    if (k.arrangement === 'single' && ways.length > 1) {
      out.push({ level: 'warn', text: `Set as one circuit but ${ways.length} ways point at it — choose “Several circuits, a pole each” or a switched section.` });
    } else if (need > have) {
      out.push({ level: 'warn', text: `Needs ${need} poles for its ways but is ${k.poles}.` });
    }
    if (ways.length && rating) {
      if (k.arrangement === 'section') {
        const duty = this.dutyA(comp, k, ways);
        if (duty > rating) out.push({ level: 'warn', text: `Section current ${duty.toFixed(1)} A per phase is above the ${rating} A ${cat} rating.` });
      } else {
        for (const w of ways) {
          const a = Number(w.breaker_a) || 0;
          if (a > rating) out.push({ level: 'warn', text: `Way ${w.way}: ${rating} A ${cat} is below its ${a} A breaker — the breaker does not protect the contactor.` });
        }
      }
    }
    if (ways.some(w => this._isMotor(w)) && cat !== 'AC-3') {
      out.push({ level: 'info', text: 'Switches a motor load — use the contactor’s AC-3 rating.' });
    }
    if (ways.some(w => this._isLighting(w)) && !/^AC-5/.test(cat)) {
      out.push({ level: 'info', text: 'Switches lighting — use the AC-5a (LED / discharge) or AC-5b (incandescent) rating; LED drivers draw a high inrush.' });
    }
    if (!(k.switches || []).length && (k.selector || 'hoa') !== 'hoa') {
      out.push({ level: 'warn', text: 'Nothing switches the coil — add a photocell, timer, thermostat or other contact.' });
    }
    const sup = this.supply(comp, k.supply);
    if (!sup) out.push({ level: 'warn', text: 'No control supply — pick the one its coil runs from.' });
    else if (sup.voltage && k.coil && String(sup.voltage).replace(/\s/g, '') !== String(k.coil).replace(/\s/g, '')) {
      out.push({ level: 'warn', text: `Coil is ${k.coil} but ${sup.tag} supplies ${sup.voltage}.` });
    }
    return out;
  },

  boardWarnings(comp) {
    const out = [];
    for (const k of this.contactors(comp)) for (const w of this.warnings(comp, k)) out.push(Object.assign({ tag: k.tag }, w));
    return out;
  },

  // ── Devices (GA + BOQ) ──────────────────────────────────────────────
  contactorSize(k) {
    const a = Number(k.rating_a) || 0, n = this._polesN(k);
    if (a <= 25) return { modules: n <= 2 ? 1 : 2, heat_w: 2.5 };
    if (a <= 40) return { modules: n <= 2 ? 2 : 3, heat_w: 3.5 };
    if (a <= 63) return { modules: 3, heat_w: 4.5 };
    if (a <= 100) return { modules: 4, heat_w: 7 };
    return { modules: 6, heat_w: 12 };
  },

  // Every physical device the controls add, grouped per contactor so a GA can
  // keep them together. A switching device shared by tag is listed once (with
  // the first contactor that uses it). Field devices carry modules 0.
  devices(comp) {
    const out = [];
    const seen = new Set();
    for (const s of this.supplies(comp)) {
      const kd = CTL_SUPPLY_KINDS.find(x => x.v === s.kind) || CTL_SUPPLY_KINDS[0];
      out.push({ id: 'sup:' + s.id, group: 'supply', tag: s.tag, kind: 'supply', label: s.tag,
        spec: s.kind === 'external' ? `${s.voltage || ''} external${s.note ? ' · ' + s.note : ''}`
          : `${kd.label} · ${s.breaker_a || '?'} A · ${s.phase || 'R'} · ${s.voltage || ''}`,
        modules: kd.modules, heat_w: kd.heat_w });
    }
    for (const k of this.contactors(comp)) {
      const sz = this.contactorSize(k);
      out.push({ id: 'k:' + k.id, group: k.id, tag: k.tag, kind: 'contactor', label: k.tag,
        spec: `Contactor ${k.poles} ${k.rating_a} A ${k.category}`, modules: sz.modules, heat_w: sz.heat_w });
      for (const s of (k.switches || [])) {
        const key = String(s.tag || '').trim().toLowerCase() || ('?' + out.length);
        if (seen.has(key)) continue;
        seen.add(key);
        const kd = CTL_SWITCH_KINDS.find(x => x.key === s.kind) || CTL_SWITCH_KINDS[CTL_SWITCH_KINDS.length - 1];
        out.push({ id: 'sw:' + k.id + ':' + key, group: k.id, tag: s.tag, kind: s.kind, label: s.tag,
          spec: `${kd.label}${s.setting ? ' · ' + s.setting : ''}${kd.field ? ' · ' + kd.field : ''}`,
          modules: kd.modules, heat_w: kd.heat_w, field: !kd.modules });
      }
      if ((k.selector || 'hoa') !== 'none') {
        out.push({ id: 'sel:' + k.id, group: k.id, tag: k.selector_tag || 'S', kind: 'selector', label: k.selector_tag || 'S',
          spec: `Selector ${(CTL_SELECTORS.find(x => x.v === k.selector) || CTL_SELECTORS[0]).label}`, modules: 1, heat_w: 0 });
      }
      if (k.lamp) {
        out.push({ id: 'lamp:' + k.id, group: k.id, tag: 'H-' + k.tag, kind: 'lamp', label: 'H-' + k.tag,
          spec: `Indicator lamp (door) — ${k.tag} on`, modules: 0, heat_w: 0.5, field: true });
      }
    }
    return out;
  },

  // BOQ lines: { key, desc } — one per device.
  boqLines(comp) {
    const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const out = [];
    for (const k of this.contactors(comp)) {
      out.push({ key: `CTL-K-${k.poles}-${k.rating_a}A-${slug(k.category)}`, desc: `Contactor ${k.poles} ${k.rating_a} A ${k.category}, ${k.coil || ''} coil` });
    }
    for (const dv of this.devices(comp)) {
      if (dv.kind === 'contactor') continue;
      if (dv.kind === 'supply') {
        const s = this.supplies(comp).find(x => 'sup:' + x.id === dv.id);
        if (s && s.kind === 'external') continue;
        out.push({ key: `CTL-SUP-${slug(s ? s.kind : 'mcb')}`, desc: s && s.kind === 'transformer' ? 'Control transformer with MCB' : 'Control circuit MCB' });
        continue;
      }
      const kd = CTL_SWITCH_KINDS.find(x => x.key === dv.kind);
      const label = dv.kind === 'selector' ? 'Selector switch' : dv.kind === 'lamp' ? 'Indicator lamp' : (kd ? kd.label : dv.kind);
      out.push({ key: `CTL-${slug(dv.kind)}`, desc: label });
    }
    return out;
  },

  // ── Text helpers ────────────────────────────────────────────────────
  switchKind(kind) { return CTL_SWITCH_KINDS.find(x => x.key === kind) || CTL_SWITCH_KINDS[CTL_SWITCH_KINDS.length - 1]; },

  switchedBy(k) {
    const sw = (k.switches || []).map(s => s.tag || this.switchKind(s.kind).label);
    if (!sw.length) return k.selector === 'hoa' ? 'Hand only' : '—';
    return sw.join(k.combine === 'parallel' ? ' or ' : ' + ');
  },

  // ── Rendering: the Controls section under the schedule grid ─────────
  // mode 'section' (schedule) | 'panel' (the single-line side panel, compact).
  render(comp, host, onChange, opts) {
    if (!host) return;
    opts = opts || {};
    if (!comp) { host.innerHTML = ''; return; }
    const e = escHtml;
    const { supplies, contactors } = this.peek(comp);
    const warns = this.boardWarnings(comp);
    const nWarn = warns.filter(w => w.level === 'warn').length;
    const panel = opts.mode === 'panel';

    const chip = (t) => `<span class="dbc-tag">${e(t)}</span>`;
    const rows = contactors.map(k => {
      const ways = this.waysOf(comp, k);
      const w = this.warnings(comp, k);
      const bad = w.filter(x => x.level === 'warn');
      const sup = this.supply(comp, k.supply);
      const arr = (CTL_ARRANGEMENTS.find(a => a.v === k.arrangement) || CTL_ARRANGEMENTS[0]).label;
      const sw = (k.switches || []).map(s => `<span class="dbc-sw" title="${e(this.switchKind(s.kind).label)}">${e(s.tag)} · ${e(this.switchKind(s.kind).label)}${s.setting ? ' · ' + e(s.setting) : ''}</span>`).join(k.combine === 'parallel' ? '<span class="dbc-or">or</span>' : '');
      const sel = (CTL_SELECTORS.find(x => x.v === k.selector) || CTL_SELECTORS[0]);
      const din = this.devices(comp).filter(d => d.group === k.id).reduce((n, d) => n + d.modules, 0);
      const check = bad.length
        ? `<span class="dbc-bad" title="${e(bad.map(x => x.text).join('\n'))}">⚠ ${e(bad[0].text)}</span>`
        : (ways.length ? `<span class="dbc-ok" title="${e(w.map(x => x.text).join('\n'))}">✓ ${e(k.arrangement === 'section' ? `${this.dutyA(comp, k, ways).toFixed(1)} A ≤ ${k.rating_a} A` : `${this.dutyA(comp, k, ways)} A ≤ ${k.rating_a} A`)}${w.length ? ' ⓘ' : ''}</span>` : '<span class="dbc-dim">no ways</span>');
      if (panel) {
        return `<div class="dbc-card${bad.length ? ' dbc-card-bad' : ''}">
          <div class="dbc-card-head">${chip(k.tag)}<span>${e(k.label || '')}</span><button type="button" class="btn-small" data-dbc-edit="${e(k.id)}">Edit</button></div>
          <div class="dbc-dim">${e(`${k.poles} ${k.rating_a} A ${k.category} · ways ${ways.map(x => x.way).join(', ') || '—'}`)}</div>
          <div class="dbc-dim">${e(this.switchedBy(k))}${sup ? ' · ' + e(sup.tag) : ''}</div>
          ${bad.length ? `<div class="dbc-bad">⚠ ${e(bad[0].text)}</div>` : ''}</div>`;
      }
      return `<tr>
        <td>${chip(k.tag)}</td>
        <td>${e(k.label || '—')}</td>
        <td>${e(arr)}</td>
        <td>${e(`${k.poles} ${k.rating_a} A · ${k.category}`)}<br><span class="dbc-dim">coil ${e(k.coil || '')}${k.arrangement === 'poles' ? ` · ${this.polesNeeded(k, ways)} of ${this._polesN(k)} poles` : ''}</span></td>
        <td><div class="dbc-sws">${sw || '<span class="dbc-dim">—</span>'}</div></td>
        <td>${e(k.selector === 'none' ? '—' : `${sel.label} ${k.selector_tag || ''}`)}</td>
        <td>${e(sup ? sup.tag : '—')}</td>
        <td>${e(ways.map(x => x.way).join(', ') || '—')}</td>
        <td>${din} mod</td>
        <td>${check}</td>
        <td class="dbc-act"><button type="button" class="btn-small" data-dbc-edit="${e(k.id)}" aria-label="Edit ${e(k.tag)}" title="Edit">✎</button><button type="button" class="btn-small" data-dbc-del="${e(k.id)}" aria-label="Remove ${e(k.tag)}" title="Remove">✕</button></td>
      </tr>`;
    }).join('');

    const supRows = supplies.map(s => {
      const users = contactors.filter(k => k.supply === s.id).map(k => k.tag);
      const kindOpts = CTL_SUPPLY_KINDS.map(x => `<option value="${x.v}"${s.kind === x.v ? ' selected' : ''}>${e(x.label)}</option>`).join('');
      const phOpts = ['R', 'W', 'B'].map(p => `<option${(s.phase || 'R') === p ? ' selected' : ''}>${p}</option>`).join('');
      const vOpts = CTL_COILS.map(v => `<option${s.voltage === v ? ' selected' : ''}>${e(v)}</option>`).join('');
      return `<div class="dbc-sup" data-dbc-sup="${e(s.id)}">
        <input type="text" data-sk="tag" value="${e(s.tag || '')}" aria-label="Supply tag" class="dbc-sup-tag">
        <select data-sk="kind" aria-label="Supply type">${kindOpts}</select>
        ${s.kind === 'external' ? '' : `<label>MCB <input type="number" data-sk="breaker_a" value="${e(s.breaker_a ?? 6)}" min="1" step="1" style="width:52px"> A</label>
        <label>Phase <select data-sk="phase">${phOpts}</select></label>`}
        <label>${s.kind === 'transformer' ? 'Secondary' : 'Voltage'} <select data-sk="voltage">${vOpts}</select></label>
        <input type="text" data-sk="note" value="${e(s.note || '')}" placeholder="Note (e.g. from UPS-1)" aria-label="Note" class="dbc-sup-note">
        <span class="dbc-dim">${users.length ? 'feeds ' + e(users.join(', ')) : 'unused'}</span>
        <button type="button" class="btn-small" data-dbc-sdel="${e(s.id)}" aria-label="Remove ${e(s.tag)}" title="Remove">✕</button>
      </div>`;
    }).join('');

    const nDev = this.devices(comp);
    const mods = nDev.reduce((n, d) => n + d.modules, 0);
    const heat = nDev.reduce((n, d) => n + d.heat_w, 0);
    const summary = contactors.length
      ? `${contactors.length} contactor${contactors.length === 1 ? '' : 's'} · ${supplies.length} control suppl${supplies.length === 1 ? 'y' : 'ies'} · ${mods} DIN modules, ${heat.toFixed(0)} W`
      : 'none';

    const body = `<div class="dbc-body">
      <div class="dbc-bar">
        <button type="button" class="btn-small btn-primary" data-dbc="add">+ Contactor</button>
        ${DBSchedule._selected && DBSchedule._selected.size && !panel ? `<button type="button" class="btn-small" data-dbc="add-sel" title="One contactor switching the ways ticked in the grid">+ Contactor for ${DBSchedule._selected.size} ticked way${DBSchedule._selected.size === 1 ? '' : 's'}</button>` : ''}
        <span class="dbc-dim">${e(summary)}</span>
      </div>
      ${contactors.length ? (panel ? `<div class="dbc-cards">${rows}</div>` : `<div class="dbc-table-wrap"><table class="dbc-table">
        <thead><tr><th>Tag</th><th>Duty</th><th>Arrangement</th><th>Contactor</th><th>Switched by</th><th>Override</th><th>Supply</th><th>Ways</th><th>DIN</th><th>Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`)
        : `<div class="dba-empty">No contactors yet. Add one to switch outdoor lights on a photocell or timer, HVAC on a thermostat or BMS enable — or tick ways in the grid and add one for them. They appear on the single line and take space on the GA.</div>`}
      <div class="dbc-sup-head"><strong>Control supplies</strong>
        <button type="button" class="btn-small" data-dbc="add-sup">+ Supply</button>
        <span class="dbc-dim">Each contactor’s coil runs from one of these — a board may have several (a 230 V MCB, a 24 V transformer, a UPS-backed supply).</span></div>
      ${supRows || '<div class="dbc-dim" style="padding:4px 0">None yet — one is added with the first contactor.</div>'}
    </div>`;

    if (panel) {
      host.innerHTML = `<div class="dba-panel dbc-panel"><div class="dba-head">Controls <span class="dba-count">${contactors.length}</span>
        ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn}</span>` : ''}</div>${body}</div>`;
    } else {
      host.innerHTML = `<details class="db-el-details dbc-details"${this._openSection ? ' open' : ''}>
        <summary>Controls <span class="db-el-count">${e(summary)}</span>
          ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn} to check</span>` : ''}
          <span class="db-el-ref">Contactors, photocells, timers — drawn on the single line and placed on the GA</span></summary>
        ${body}</details>`;
      const det = host.querySelector('details.dbc-details');
      if (det) det.addEventListener('toggle', () => { this._openSection = det.open; });
    }
    this._bind(comp, host, onChange, opts);
  },

  _changed(onChange) {
    if (typeof DBSchedule !== 'undefined' && DBSchedule._notifyEdited) DBSchedule._notifyEdited();
    if (onChange) onChange();
  },

  _bind(comp, host, onChange, opts) {
    const rerender = () => { this.render(comp, host, onChange, opts); this._changed(onChange); };
    host.querySelectorAll('[data-dbc]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.dbc;
      if (a === 'add') {
        const k = this.newContactor(comp, []);
        this.edit(comp, k, { isNew: true, onSave: onChange });
      } else if (a === 'add-sel') {
        const ways = (comp.props.circuits || []).filter(c => DBSchedule._selected.has(c.id));
        const k = this.newContactor(comp, ways);
        this.edit(comp, k, { isNew: true, ways: ways.map(w => w.id), onSave: onChange });
      } else if (a === 'add-sup') {
        this.addSupply(comp);
        rerender();
      }
    }));
    host.querySelectorAll('[data-dbc-edit]').forEach(b => b.addEventListener('click', () => {
      const k = this.contactor(comp, b.dataset.dbcEdit);
      if (k) this.edit(comp, k, { onSave: onChange });
    }));
    host.querySelectorAll('[data-dbc-del]').forEach(b => b.addEventListener('click', () => {
      this.removeContactor(comp, b.dataset.dbcDel);
      rerender();
    }));
    host.querySelectorAll('[data-dbc-sdel]').forEach(b => b.addEventListener('click', () => {
      this.removeSupply(comp, b.dataset.dbcSdel);
      rerender();
    }));
    host.querySelectorAll('[data-dbc-sup] [data-sk]').forEach(el => el.addEventListener('change', () => {
      const s = this.supply(comp, el.closest('[data-dbc-sup]').dataset.dbcSup);
      if (!s) return;
      const k = el.dataset.sk;
      s[k] = k === 'breaker_a' ? (parseFloat(el.value) || null) : el.value;
      if (k === 'kind' && el.value === 'transformer' && s.voltage === '230 V AC') s.voltage = '24 V AC';
      rerender();
    }));
  },

  // The schedule (grid + Controls section) after an edit made outside it.
  _refreshSchedule(comp) {
    if (typeof DBSchedule !== 'undefined' && DBSchedule.body && DBSchedule.currentId === comp.id) DBSchedule.render();
  },

  // ── Contactor editor ────────────────────────────────────────────────
  // Edits a copy; Save writes it and re-links the ways. opts: { isNew, ways: [way ids], onSave }.
  edit(comp, k0, opts) {
    opts = opts || {};
    const e = escHtml;
    const k = JSON.parse(JSON.stringify(k0));
    if (!Array.isArray(k.switches)) k.switches = [];
    const circuits = comp.props.circuits || [];
    const picked = new Set(opts.ways || circuits.filter(c => this.wayContactor(comp, c) === k0).map(c => c.id));
    const sized = { auto: !!opts.isNew };          // follow the suggestion until a size is typed

    const m = document.createElement('div');
    m.className = 'modal dbc-modal';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-labelledby', 'dbc-title');
    m.style.display = 'flex'; m.style.zIndex = '3000';
    document.body.appendChild(m);

    const pickedWays = () => circuits.filter(c => picked.has(c.id))
      .sort((a, b) => String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }));
    const opt = (v, cur, label) => `<option value="${e(v)}"${String(v) === String(cur) ? ' selected' : ''}>${e(label ?? v)}</option>`;

    const draw = () => {
      const ways = pickedWays();
      if (sized.auto) Object.assign(k, this.suggest(comp, k, ways));
      const sug = this.suggest(comp, k, ways);
      const supplies = this.supplies(comp);
      const others = new Map();
      for (const c of circuits) { const o = this.wayContactor(comp, c); if (o && o.id !== k.id) others.set(c.id, o.tag); }
      const wayList = circuits.slice().sort((a, b) => String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }))
        .map(c => `<label class="dbc-way${picked.has(c.id) ? ' on' : ''}"><input type="checkbox" data-dbc-way="${e(c.id)}"${picked.has(c.id) ? ' checked' : ''}>
          <b>${e(c.way ?? '')}</b> ${e(c.description || '—')} <span class="dbc-dim">${e(`${c.breaker_a || 0} A ${c.poles || '1P'}`)}${others.has(c.id) ? ' · now ' + e(others.get(c.id)) : ''}</span></label>`).join('');
      const sw = k.switches.map((s, i) => `<div class="dbc-swrow">
        <input type="text" data-sw="${i}" data-swk="tag" value="${e(s.tag || '')}" aria-label="Tag" class="dbc-swtag">
        <select data-sw="${i}" data-swk="kind" aria-label="Device">${CTL_SWITCH_KINDS.map(x => opt(x.key, s.kind, x.label)).join('')}</select>
        <input type="text" data-sw="${i}" data-swk="setting" value="${e(s.setting || '')}" placeholder="Setting / program" aria-label="Setting">
        <button type="button" class="btn-small" data-sw-del="${i}" aria-label="Remove ${e(s.tag || '')}">✕</button></div>`).join('');
      const tmp = Object.assign({}, k);
      const warnList = this._draftWarnings(comp, tmp, ways);
      const din = (() => {
        const sz = this.contactorSize(k);
        const parts = [`${k.tag} ${sz.modules}`];
        for (const s of k.switches) { const kd = this.switchKind(s.kind); if (kd.modules) parts.push(`${s.tag} ${kd.modules}`); }
        if (k.selector !== 'none') parts.push(`${k.selector_tag || 'S'} 1`);
        return parts.join(' · ');
      })();

      m.innerHTML = `<div class="modal-content dbc-dialog">
        <div class="modal-header"><h3 id="dbc-title"><span class="dbc-tag">${e(k.tag)}</span> Contactor — ${e(comp.props.name || comp.id)}</h3>
          <button class="modal-close" data-dbc-x="cancel" aria-label="Close">&times;</button></div>
        <div class="dbc-dlg-body">
          <div class="dbc-grid2">
            <label>Tag <input type="text" data-kk="tag" value="${e(k.tag)}"></label>
            <label>Duty <input type="text" data-kk="label" value="${e(k.label || '')}" placeholder="e.g. External lighting"></label>
          </div>
          <fieldset><legend>What it switches</legend>
            <div class="dbc-arr">${CTL_ARRANGEMENTS.map(a => `<label class="${k.arrangement === a.v ? 'on' : ''}"><input type="radio" name="dbc-arr" value="${a.v}"${k.arrangement === a.v ? ' checked' : ''}><span>${e(a.label)}<small>${e(a.hint)}</small></span></label>`).join('')}</div>
            <div class="dbc-ways">${wayList || '<span class="dbc-dim">This board has no ways yet.</span>'}</div>
          </fieldset>
          <fieldset><legend>Contactor</legend>
            <div class="dbc-grid4">
              <label>Poles <select data-kk="poles">${['2P', '3P', '4P'].map(p => opt(p, k.poles)).join('')}</select></label>
              <label>Rating (A) <input type="number" data-kk="rating_a" value="${e(k.rating_a)}" min="1" step="1"></label>
              <label>Utilisation <select data-kk="category">${CTL_CATEGORIES.map(c => opt(c.v, k.category, c.label)).join('')}</select></label>
              <label>Coil <select data-kk="coil">${CTL_COILS.map(c => opt(c, k.coil)).join('')}</select></label>
            </div>
            <div class="dbc-sug${sized.auto ? ' on' : ''}">${ways.length
              ? `Suggested ${e(`${sug.poles} ${sug.rating_a} A ${sug.category}`)} — ${e(k.arrangement === 'section' ? `${this.dutyA(comp, k, ways).toFixed(1)} A per phase (diversified)` : `largest breaker ${this.dutyA(comp, k, ways)} A`)}, ${this.polesNeeded(k, ways)} pole${this.polesNeeded(k, ways) === 1 ? '' : 's'} used.
                ${sized.auto ? '' : '<button type="button" class="btn-small" data-dbc-x="use-sug">Use it</button>'}`
              : 'Pick its ways for a suggested size.'}</div>
          </fieldset>
          <fieldset><legend>Switched by</legend>
            <div class="dbc-swlist">${sw || '<span class="dbc-dim">Nothing yet — the selector alone switches it.</span>'}</div>
            <div class="dbc-swadd">
              <select id="dbc-swkind" aria-label="Device to add">${CTL_SWITCH_KINDS.map(x => opt(x.key, '', x.label)).join('')}</select>
              <button type="button" class="btn-small" data-dbc-x="sw-add">+ Add</button>
              ${k.switches.length > 1 ? `<label>Combine <select data-kk="combine">${opt('series', k.combine, 'In series — all must close')}${opt('parallel', k.combine, 'In parallel — any one closes')}</select></label>` : ''}
            </div>
            <div class="dbc-dim">A tag used on another contactor is the same device (one photocell switching several contactors).</div>
          </fieldset>
          <fieldset><legend>Override and supply</legend>
            <div class="dbc-grid4">
              <label>Selector <select data-kk="selector">${CTL_SELECTORS.map(x => opt(x.v, k.selector, x.label)).join('')}</select></label>
              <label>Selector tag <input type="text" data-kk="selector_tag" value="${e(k.selector_tag || '')}"${k.selector === 'none' ? ' disabled' : ''}></label>
              <label>Control supply <select data-kk="supply">${opt('', k.supply, '— none')}${supplies.map(s => opt(s.id, k.supply, `${s.tag} · ${s.voltage || ''}`)).join('')}${opt('__new', '', '+ New supply…')}</select></label>
              <label class="dbc-chk"><input type="checkbox" data-kk="lamp"${k.lamp ? ' checked' : ''}> Indicator lamp on the door</label>
            </div>
          </fieldset>
          ${warnList.length ? `<div class="dbc-warns">${warnList.map(w => `<div class="dba-note ${e(w.level)}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${e(w.text)}</div>`).join('')}</div>` : ''}
          <div class="dbc-where"><div><small>Schedule</small>${ways.length ? `Ways ${e(ways.map(w => w.way).join(', '))} show ${e(k.tag)}` : 'No ways'}</div>
            <div><small>Single line</small>${ways.length ? `${e(k.tag)} on ${ways.length} way${ways.length === 1 ? '' : 's'} + control rung` : 'Control rung only'}</div>
            <div><small>GA</small>${e(din)} modules</div></div>
        </div>
        <div class="modal-footer dbc-foot">
          ${opts.isNew ? '' : '<button type="button" class="btn-small dbc-del" data-dbc-x="delete">Delete</button>'}
          <span style="flex:1"></span>
          <button type="button" class="btn-small" data-dbc-x="cancel">Cancel</button>
          <button type="button" class="btn-small btn-primary" data-dbc-x="save">${opts.isNew ? 'Add contactor' : 'Save'}</button>
        </div></div>`;
    };
    draw();

    const finish = () => { document.removeEventListener('keydown', onKey, true); m.remove(); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);

    m.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.name === 'dbc-arr') { k.arrangement = t.value; draw(); return; }
      if (t.dataset.dbcWay) {
        if (t.checked) picked.add(t.dataset.dbcWay); else picked.delete(t.dataset.dbcWay);
        if (picked.size > 1 && k.arrangement === 'single') k.arrangement = 'poles';
        if (!k.label) { const w = pickedWays()[0]; if (w) k.label = String(w.description || '').trim(); }
        draw(); return;
      }
      if (t.dataset.sw !== undefined) {
        const s = k.switches[Number(t.dataset.sw)];
        if (!s) return;
        s[t.dataset.swk] = t.value;
        if (t.dataset.swk === 'kind') {
          const kd = this.switchKind(t.value);
          s.tag = this._nextTag(this._allSwitchTags(comp).concat(k.switches.map(x => x.tag)), kd.prefix);
          s.setting = kd.setting || '';
        }
        draw(); return;
      }
      const kk = t.dataset.kk;
      if (!kk) return;
      if (kk === 'lamp') k.lamp = t.checked;
      else if (kk === 'rating_a') { k.rating_a = parseFloat(t.value) || 0; sized.auto = false; }
      else if (kk === 'poles' || kk === 'category') { k[kk] = t.value; sized.auto = false; }
      else if (kk === 'supply' && t.value === '__new') {
        const s = this.addSupply(comp);
        k.supply = s.id;
        this._changed(opts.onSave);
      } else k[kk] = t.value;
      draw();
    });
    m.addEventListener('click', (ev) => {
      if (ev.target === m) return finish();
      const del = ev.target.closest('[data-sw-del]');
      if (del) { k.switches.splice(Number(del.dataset.swDel), 1); draw(); return; }
      const b = ev.target.closest('[data-dbc-x]');
      if (!b) return;
      const a = b.dataset.dbcX;
      if (a === 'cancel') return finish();
      if (a === 'use-sug') { sized.auto = true; draw(); return; }
      if (a === 'sw-add') {
        const kind = m.querySelector('#dbc-swkind').value;
        k.switches.push(this.newSwitch(comp, kind, k.switches.map(x => x.tag)));
        draw(); return;
      }
      if (a === 'delete') {
        this.removeContactor(comp, k.id);
        finish();
        this._afterSave(comp, opts);
        return;
      }
      if (a === 'save') {
        const d = this.data(comp);
        const tag = String(k.tag || '').trim() || this._nextTag(d.contactors.map(x => x.tag), 'K');
        if (d.contactors.some(x => x.id !== k.id && String(x.tag).toLowerCase() === tag.toLowerCase())) {
          if (typeof UI !== 'undefined' && UI.toast) UI.toast(`${tag} is already used on this board.`, 'warning');
          return;
        }
        k.tag = tag;
        if (!k.supply && !d.supplies.length) k.supply = this.addSupply(comp).id;   // the board's first control supply
        const i = d.contactors.findIndex(x => x.id === k.id);
        if (i >= 0) d.contactors[i] = k; else d.contactors.push(k);
        for (const c of circuits) {
          if (picked.has(c.id)) c.contactor = k.id;
          else if (this.wayContactor(comp, c) === k || c.contactor === k.id) delete c.contactor;
        }
        finish();
        this._afterSave(comp, opts);
      }
    });
  },

  // Warnings for the editor's working copy (its ways are the picked ones).
  _draftWarnings(comp, k, ways) {
    const saved = comp.props.circuits || [];
    const ids = new Set(ways.map(w => w.id));
    const d = this.peek(comp);
    const had = d.contactors.find(x => x.id === k.id);
    // Evaluate against a temporary board view without touching the project.
    const fake = { props: Object.assign({}, comp.props, {
      controls: { supplies: d.supplies, contactors: d.contactors.filter(x => x.id !== k.id).concat([k]) },
      circuits: saved.map(c => (ids.has(c.id) ? Object.assign({}, c, { contactor: k.id })
        : (c.contactor === k.id || (had && this.wayContactor(comp, c) === had)) ? Object.assign({}, c, { contactor: '' }) : c)),
    }) };
    return this.warnings(fake, k);
  },

  _afterSave(comp, opts) {
    this._changed(opts.onSave);
    this._refreshSchedule(comp);
  },
};
