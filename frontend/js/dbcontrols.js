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
 *                    coil: '230 V AC', switches: [{ kind, tag, setting,
 *                      device, mount: 'din'|'door'|'field', contact }],
 *                    combine: 'series'|'parallel', selector: 'hoa'|'oa'|'none',
 *                    selector_tag, supply: <supply id>,
 *                    lamp, lamp_tag: 'H1', lamp_color: 'green'|…, lamp_shows: 'on'|'off' }],
 *   }
 *   way.contactor = <contactor id>   (in props.circuits)
 *
 * A 'direct' record may carry a bypass round its switching contact:
 * `bypass: 'switch'|'hoa'` (absent / 'none' ⇒ none) — 'switch' = an Auto / On
 * switch, 'hoa' = an Auto – Off – On selector — with `bypass_tag` (BS1),
 * `bypass_a` (blank = the largest MCB on the circuit), `bypass_mount`
 * ('door' default | 'din') and an optional lamp (`bypass_lamp`, `bypass_lamp_tag`).
 * In On the supply goes straight to the load past the contact.
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
 * A switch's `device` / `mount` / `contact` and a lamp's tag / colour / what it
 * shows are optional: blank reads as the kind's default (switchMount,
 * lampTag …), so records saved before they existed draw as they did.
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
  { v: 'direct', label: 'Switched direct (no contactor)', hint: 'MCB → timer / photocell contact → circuit' },
];
// A directly switched circuit runs through the switching device's own output contact.
const CTL_DIRECT_RATINGS = [6, 10, 16, 20, 25, 32, 40, 63];
// Switching devices that can carry a load through their own contact.
const CTL_DIRECT_KINDS = ['photocell', 'timer', 'astro', 'thermostat'];
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
const CTL_MOUNTS = [
  { v: 'din', label: 'DIN rail in the board' },
  { v: 'door', label: 'Board door' },
  { v: 'field', label: 'Outside the board' },
];
const CTL_LAMP_COLOURS = [
  { v: 'green', label: 'Green', hex: '#2e7d32' },
  { v: 'red', label: 'Red', hex: '#c62828' },
  { v: 'amber', label: 'Amber', hex: '#e08a00' },
  { v: 'white', label: 'White', hex: '#8a8f98' },
  { v: 'blue', label: 'Blue', hex: '#1565c0' },
];
// What a door lamp shows, and the auxiliary contact it is wired through.
const CTL_LAMP_SHOWS = [
  { v: 'on', label: 'Lit when the contactor is closed', aux: '13-14', nc: false },
  { v: 'off', label: 'Lit when the contactor is open', aux: '21-22', nc: true },
];
// Bypass round a directly switched circuit's contact.
const CTL_BYPASS = [
  { v: 'none', label: 'None', hint: 'Only the switching device switches the circuit' },
  { v: 'switch', label: 'Bypass switch', hint: 'Auto / On: On connects the supply straight to the load' },
  { v: 'hoa', label: 'Auto – Off – On selector', hint: 'Three positions; Off isolates the circuit' },
];
// The "?" beside each arrangement in the editor: a small diagram and what it means.
const CTL_ARRANGEMENT_HELP = {
  single: 'The contactor sits after the way’s MCB and switches that one circuit. Use it for a single heater, pump or lighting circuit.',
  poles: 'Each circuit keeps its own MCB. One pole of the contactor sits in each circuit and they all switch together — up to as many circuits as the contactor has poles.',
  direct: 'No contactor: the circuit’s load current runs through the output contact of the timer, astronomical clock or photocell itself, after the way’s MCB. Use it for small loads — the contact rating must cover the MCB, and lighting or motor loads need the AC-5 / AC-3 contact rating. Add a bypass switch (or an Auto – Off – On selector) to force the circuit on past the contact for testing or a failed sensor.',
  section: 'The contactor sits ahead of the circuits and feeds a small bus; their MCBs hang from it. Use it when there are more circuits than poles, or a whole group must go off together.',
};

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

  isDirect(k) { return !!k && k.arrangement === 'direct'; },
  // A direct circuit that splits into one branch per switching device, each
  // device feeding its own equipment (switch `contact_a`, `load_a`, `feeds`).
  isBranched(k) { return this.isDirect(k) && k.combine === 'branches' && (k.switches || []).length > 1; },
  branches(k) {
    return (k.switches || []).map(s => ({ s, tag: s.tag || '', label: this.switchKind(s.kind).label,
      rating: Number(s.contact_a) || Number(k.rating_a) || 0, cat: k.category, terms: this.switchContact(s),
      load_a: Number(s.load_a) || 0, feeds: String(s.feeds || '').trim() }));
  },
  // 'Contactor 2P 25 A AC-1' or, for a directly switched circuit, 'Direct contact 16 A AC-5a'.
  specText(k) { return this.isDirect(k) ? `${k.poles} ${k.rating_a} A ${k.category} contact` : `${k.poles} ${k.rating_a} A ${k.category}`; },
  noun(k) { return this.isDirect(k) ? 'direct switching' : 'contactor'; },

  // ── Bypass (directly switched circuits only) ────────────────────────
  bypassMode(k) { return this.isDirect(k) && (k.bypass === 'switch' || k.bypass === 'hoa') ? k.bypass : 'none'; },
  hasBypass(k) { return this.bypassMode(k) !== 'none'; },
  bypassKind(k) { return CTL_BYPASS.find(x => x.v === this.bypassMode(k)) || CTL_BYPASS[0]; },
  bypassTag(k) { return String(k.bypass_tag || '').trim() || (this.bypassMode(k) === 'hoa' ? 'S-' : 'BS-') + k.tag; },
  bypassMount(k) { return k.bypass_mount === 'din' ? 'din' : 'door'; },
  bypassLampTag(k) { return String(k.bypass_lamp_tag || '').trim() || 'H-' + this.bypassTag(k); },
  // Rating: typed, else the largest MCB on the circuit (it carries the whole load when bypassed).
  bypassA(comp, k) { return Number(k.bypass_a) || this.dutyA(comp, k, this.waysOf(comp, k)) || Number(k.rating_a) || 0; },
  bypassModules(k) { return this.bypassMount(k) === 'din' ? Math.max(1, Math.ceil(this._polesN(k) / 2)) : 0; },
  bypassSpec(comp, k) {
    return `${this.bypassKind(k).label} ${k.poles} ${this.bypassA(comp, k)} A${this.bypassMode(k) === 'hoa' ? ' · Auto–Off–On' : ' · Auto / On'}`;
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
    if (!k || (k.arrangement !== 'poles' && k.arrangement !== 'direct')) return '';
    let n = 0;
    for (const w of this.waysOf(comp, k)) {
      const p = this._is3(w) ? 3 : 1;
      if (w === c) return p === 1 ? `${n + 1}` : `${n + 1}–${n + p}`;
      n += p;
    }
    return '';
  },

  _is3(c) { return wayIs3(c); },
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
      if (!this.isDirect(k)) out.push(k.selector_tag);
      if (this.hasBypass(k)) out.push(k.bypass_tag, k.bypass_lamp_tag);
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
  newContactor(comp, ways, arrangement) {
    const d = this.peek(comp);
    const direct = arrangement === 'direct';
    const k = {
      id: this._uid('k'), tag: this._nextTag(d.contactors.map(x => x.tag), direct ? 'SW' : 'K'),
      label: ways && ways.length ? String(ways[0].description || '').trim() : '',
      arrangement: direct ? 'direct' : ways && ways.length > 1 ? 'poles' : 'single',
      poles: '2P', rating_a: 25, category: 'AC-1', coil: '230 V AC',
      switches: [], combine: 'series', selector: 'hoa', selector_tag: '', supply: d.supplies.length ? d.supplies[0].id : '',
      lamp: false,
    };
    k.selector_tag = this._nextTag(this._allSwitchTags(comp), 'S');
    if (direct) { k.selector = 'none'; k.supply = ''; }
    Object.assign(k, this.suggest(comp, k, ways || []));
    if (ways && ways.some(w => this._isLighting(w))) k.switches.push(this.newSwitch(comp, 'photocell'));
    return k;
  },

  // Adds a contactor (with a control supply if the board has none) and links `ways`.
  addContactor(comp, ways, arrangement) {
    const d = this.data(comp);
    const k = this.newContactor(comp, ways, arrangement);
    if (!this.isDirect(k)) {
      if (!d.supplies.length) this.addSupply(comp);
      if (!k.supply) k.supply = d.supplies[0].id;
    }
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

  // Moves a record between contactor and direct switching: a direct circuit has
  // no coil, selector, lamp or control supply; going back gives it a selector.
  setArrangement(comp, k, v) {
    const wasDirect = this.isDirect(k);
    k.arrangement = v;
    if (v === 'direct' && !wasDirect) {
      k.selector = 'none'; k.lamp = false; k.supply = '';
      if (/^K\d+$/i.test(String(k.tag || ''))) k.tag = this._nextTag(this.contactors(comp).filter(x => x.id !== k.id).map(x => x.tag), 'SW');
    } else if (v !== 'direct' && wasDirect) {
      for (const f of ['bypass', 'bypass_tag', 'bypass_a', 'bypass_mount', 'bypass_lamp', 'bypass_lamp_tag']) delete k[f];
      k.selector = 'hoa';
      if (k.combine === 'branches') k.combine = 'series';
      const d = this.peek(comp);
      if (!k.supply && d.supplies.length) k.supply = d.supplies[0].id;
      if (/^SW\d+$/i.test(String(k.tag || ''))) k.tag = this._nextTag(this.contactors(comp).filter(x => x.id !== k.id).map(x => x.tag), 'K');
    }
  },

  // ── Sizing ──────────────────────────────────────────────────────────
  polesNeeded(k, ways) {
    if (!ways.length) return 0;
    if (k.arrangement === 'poles' || k.arrangement === 'direct') return ways.reduce((n, w) => n + (this._is3(w) ? 3 : 1), 0);
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
    const direct = this.isDirect(k);
    const poles = direct ? (n <= 1 ? '1P' : n === 2 ? '2P' : n === 3 ? '3P' : '4P') : n <= 2 ? '2P' : n === 3 ? '3P' : '4P';
    const duty = this.dutyA(comp, k, ways);
    const sizes = direct ? CTL_DIRECT_RATINGS : CTL_RATINGS;
    const rating_a = sizes.find(r => r >= duty) || sizes[sizes.length - 1];
    const category = ways.some(w => this._isMotor(w)) ? 'AC-3'
      : ways.length && ways.every(w => this._isLighting(w)) ? 'AC-5a' : 'AC-1';
    return { poles, rating_a: direct ? rating_a : Math.max(16, rating_a), category };
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
    if (this.isDirect(k)) return out.concat(this._directWarnings(k, ways, rating, cat));
    if (ways.length && rating) {
      if (k.arrangement === 'section') {
        if (typeof DBSchedule !== 'undefined' && DBSchedule.elStraddles) {
          for (const st of DBSchedule.elStraddles(comp)) {
            if (st.parts.some(p => p.hub === k.id)) out.push({ level: 'warn', block: true, text: DBSchedule._straddleText(st) });
          }
        }
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

  // A directly switched circuit: the device's own contact carries the load.
  _directWarnings(k, ways, rating, cat) {
    const out = [];
    const sw = k.switches || [];
    if (!sw.length) out.push({ level: 'warn', text: 'Nothing switches it — add a photocell, time switch or thermostat.' });
    for (const s of sw) {
      if (!CTL_DIRECT_KINDS.includes(s.kind)) {
        out.push({ level: 'warn', text: `${s.tag}: a ${this.switchKind(s.kind).label.toLowerCase()} is a control contact — it cannot carry a load; use a contactor.` });
      }
    }
    const pcs = sw.filter(s => s.kind === 'photocell').map(s => s.tag).join(', ');
    if (pcs) out.push({ level: 'info', text: `${pcs}: a photocell has three terminals — Line, Load and Neutral — so take its neutral from the circuit’s neutral bar as well as the live.` });
    if (sw.length > 1 && k.combine === 'parallel' && !this.isBranched(k)) {
      out.push({ level: 'info', text: 'Devices in parallel each carry the full load current — rate every contact for it.' });
    }
    if (this.isBranched(k)) {
      const brs = this.branches(k);
      for (const w of ways) {
        const a = Number(w.breaker_a) || 0;
        let sum = 0, known = true;
        for (const b of brs) {
          if (b.load_a > 0) sum += b.load_a; else known = false;
          const need = b.load_a > 0 ? b.load_a : a;
          if (need && b.rating < need) out.push({ level: 'warn', text: `${b.tag}: the ${b.rating} A contact is below its ${b.load_a > 0 ? b.load_a + ' A load' : a + ' A breaker (enter its load to size it on that)'}.` });
        }
        if (known && a && sum > a) out.push({ level: 'warn', text: `Way ${w.way}: the branch loads add up to ${sum.toFixed(1)} A, above its ${a} A breaker.` });
      }
      for (const b of brs) if (!b.feeds) out.push({ level: 'info', text: `${b.tag}: say what it feeds so the branch is labelled on the single line.` });
    } else if (ways.length && rating) {
      for (const w of ways) {
        const a = Number(w.breaker_a) || 0;
        if (a > rating) out.push({ level: 'warn', text: `Way ${w.way}: the ${rating} A ${cat} contact is below its ${a} A breaker — the breaker does not protect the contact; fit a contactor or a bigger contact.` });
      }
    }
    if (this.hasBypass(k)) {
      const bt = this.bypassTag(k), a = Number(k.bypass_a) || 0;
      const big = Math.max(0, ...ways.map(w => Number(w.breaker_a) || 0));
      if (a && big && a < big) out.push({ level: 'warn', text: `${bt}: the ${a} A ${this.bypassKind(k).label.toLowerCase()} is below the ${big} A breaker — it carries the whole load when the contact is bypassed.` });
      out.push({ level: 'info', text: `${bt}: in On the circuit stays live whatever ${this.switchedBy(k)} says — label it on the door and set it back to Auto.${this.bypassMode(k) === 'hoa' ? ' Off opens the circuit.' : ''}` });
      if (this.isBranched(k)) out.push({ level: 'info', text: `${bt} bypasses every branch together.` });
    }
    if (ways.some(w => this._isMotor(w))) out.push({ level: 'warn', text: 'Switches a motor load directly — use a contactor, or check the contact’s AC-3 rating.' });
    if (ways.some(w => this._isLighting(w)) && !/^AC-5/.test(cat)) {
      out.push({ level: 'info', text: 'Switches lighting — use the contact’s AC-5a (LED / discharge) or AC-5b (incandescent) rating; LED drivers draw a high inrush.' });
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
      const direct = this.isDirect(k);
      if (!direct) {
        const sz = this.contactorSize(k);
        out.push({ id: 'k:' + k.id, group: k.id, tag: k.tag, kind: 'contactor', label: k.tag,
          spec: `Contactor ${k.poles} ${k.rating_a} A ${k.category}`, modules: sz.modules, heat_w: sz.heat_w });
      }
      for (const s of (k.switches || [])) {
        const key = String(s.tag || '').trim().toLowerCase() || ('?' + out.length);
        if (seen.has(key)) continue;
        seen.add(key);
        const kd = CTL_SWITCH_KINDS.find(x => x.key === s.kind) || CTL_SWITCH_KINDS[CTL_SWITCH_KINDS.length - 1];
        const mods = this.switchModules(s);
        const mount = this.switchMount(s);
        out.push({ id: 'sw:' + k.id + ':' + key, group: k.id, tag: s.tag, kind: s.kind, label: s.tag,
          spec: `${this.switchDevice(s)}${direct ? ` · ${this.branchRating(k, s)} A ${k.category} contact` : ''}${direct && k.combine === 'branches' && s.feeds ? ' · feeds ' + s.feeds : ''}${s.setting ? ' · ' + s.setting : ''}${mount === 'din' ? (kd.field ? ' · ' + kd.field : '') : ' · ' + this.mountLabel(mount).toLowerCase()}`,
          modules: mods, heat_w: mods ? kd.heat_w : 0, field: !mods });
      }
      if (direct && this.hasBypass(k)) {
        const mount = this.bypassMount(k), mods = this.bypassModules(k);
        out.push({ id: 'byp:' + k.id, group: k.id, tag: this.bypassTag(k), kind: 'bypass', label: this.bypassTag(k),
          spec: `${this.bypassSpec(comp, k)} · across ${this.switchedBy(k)} · ${this.mountLabel(mount).toLowerCase()}`,
          modules: mods, heat_w: mods ? 0.5 : 0, field: !mods,
          bypass: { mode: this.bypassMode(k), poles: k.poles, a: this.bypassA(comp, k) } });
        if (k.bypass_lamp) {
          out.push({ id: 'bypl:' + k.id, group: k.id, tag: this.bypassLampTag(k), kind: 'bypasslamp', label: this.bypassLampTag(k),
            spec: `Indicator lamp (door) — Amber LED 22 mm · lit while ${this.bypassTag(k)} is On`, modules: 0, heat_w: 0.5, field: true });
        }
      }
      const selKey = 'sel|' + String(k.selector_tag || 'S').trim().toLowerCase() + '|' + k.selector;
      if (!direct && (k.selector || 'hoa') !== 'none' && !seen.has(selKey)) {
        seen.add(selKey);       // one selector switching several contactors is fitted once
        out.push({ id: 'sel:' + k.id, group: k.id, tag: k.selector_tag || 'S', kind: 'selector', label: k.selector_tag || 'S',
          spec: `Selector ${(CTL_SELECTORS.find(x => x.v === k.selector) || CTL_SELECTORS[0]).label}`, modules: 1, heat_w: 0 });
      }
      if (!direct && k.lamp) {
        out.push({ id: 'lamp:' + k.id, group: k.id, tag: this.lampTag(k), kind: 'lamp', label: this.lampTag(k),
          spec: `Indicator lamp (door) — ${this.lampSpec(k)}`, modules: 0, heat_w: 0.5, field: true });
      }
    }
    return out;
  },

  // BOQ lines: { key, desc } — one per device.
  boqLines(comp) {
    const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const out = [];
    for (const k of this.contactors(comp)) {
      if (this.isDirect(k)) continue;
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
      if (dv.kind === 'bypass') {
        const b = dv.bypass;
        out.push({ key: `CTL-BYPASS-${b.mode === 'hoa' ? 'HOA' : 'SW'}-${b.poles}-${b.a}A`,
          desc: b.mode === 'hoa' ? `Selector switch Auto – Off – On ${b.poles} ${b.a} A (bypass)` : `Bypass switch Auto / On ${b.poles} ${b.a} A` });
        continue;
      }
      if (dv.kind === 'bypasslamp') { out.push({ key: 'CTL-LAMP', desc: 'Indicator lamp, amber LED 22 mm' }); continue; }
      if (dv.kind === 'lamp') {
        const k = this.contactors(comp).find(x => 'lamp:' + x.id === dv.id);
        const col = k ? this.lampColour(k) : CTL_LAMP_COLOURS[0];
        out.push({ key: 'CTL-LAMP', desc: `Indicator lamp, ${col.label.toLowerCase()} LED 22 mm` });
        continue;
      }
      const label = dv.kind === 'selector' ? 'Selector switch' : (kd ? kd.label : dv.kind);
      out.push({ key: `CTL-${slug(dv.kind)}`, desc: label });
    }
    return out;
  },

  // ── Text helpers ────────────────────────────────────────────────────
  switchKind(kind) { return CTL_SWITCH_KINDS.find(x => x.key === kind) || CTL_SWITCH_KINDS[CTL_SWITCH_KINDS.length - 1]; },

  switchedBy(k) {
    const sw = (k.switches || []).map(s => s.tag || this.switchKind(s.kind).label);
    if (!sw.length) return this.isDirect(k) ? '—' : k.selector === 'hoa' ? 'Hand only' : '—';
    return sw.join(k.combine === 'parallel' ? ' or ' : k.combine === 'branches' && this.isDirect(k) ? ', ' : ' + ');
  },

  // A switching device's details, blank fields falling back to its kind.
  switchMount(s) {
    if (s.mount) return s.mount;
    const kd = this.switchKind(s.kind);
    return kd.modules ? 'din' : kd.key === 'pushbutton' ? 'door' : 'field';
  },
  branchRating(k, s) { return (k.combine === 'branches' && Number(s.contact_a)) || Number(k.rating_a) || 0; },
  switchModules(s) { return this.switchMount(s) === 'din' ? (this.switchKind(s.kind).modules || 1) : 0; },
  switchDevice(s) { return String(s.device || '').trim() || this.switchKind(s.kind).label; },
  // A photocell is wired Line / Load / Neutral, not as a NO / NC contact.
  switchContact(s) { return String(s.contact || '').trim() || (s.kind === 'photocell' ? 'L · Load · N' : s.kind === 'fire' ? 'NC' : 'NO'); },
  mountLabel(v) { return (CTL_MOUNTS.find(x => x.v === v) || CTL_MOUNTS[0]).label; },

  // The door lamp: 'H-K1' for records saved before lamps had their own tag.
  lampTag(k) { return String(k.lamp_tag || '').trim() || 'H-' + k.tag; },
  lampColour(k) { return CTL_LAMP_COLOURS.find(x => x.v === k.lamp_color) || CTL_LAMP_COLOURS[0]; },
  lampShows(k) { return CTL_LAMP_SHOWS.find(x => x.v === k.lamp_shows) || CTL_LAMP_SHOWS[0]; },
  lampSpec(k) {
    const sh = this.lampShows(k);
    return `${this.lampColour(k).label} LED 22 mm · lit when ${k.tag} ${sh.nc ? 'open' : 'closed'}`;
  },
  _nextLampTag(comp, k) {
    return this._nextTag(this.contactors(comp).filter(x => x.id !== k.id && x.lamp).map(x => this.lampTag(x)), 'H');
  },

  // The control device schedule (drawing table): selectors, switching devices
  // (one row per tag, listing every contactor it switches) and door lamps.
  deviceSchedule(comp) {
    const rows = [];
    const byTag = new Map();
    const selRows = new Map();
    for (const k of this.contactors(comp)) {
      const sup = this.supply(comp, k.supply);
      const volts = sup ? (sup.voltage || '') : (k.coil || '');
      const selKey = 'sel|' + String(k.selector_tag || 'S').trim().toLowerCase() + '|' + k.selector;
      if (!this.isDirect(k) && (k.selector || 'hoa') !== 'none' && selRows.has(selKey)) selRows.get(selKey).ctrs.push(k.tag);
      else if (!this.isDirect(k) && (k.selector || 'hoa') !== 'none') {
        const r = { tag: k.selector_tag || 'S', device: `Selector ${(CTL_SELECTORS.find(x => x.v === k.selector) || CTL_SELECTORS[0]).label}`,
          setting: '', contact: k.selector === 'hoa' ? 'Hand 13-14 · Auto 23-24' : 'Auto 13-14',
          mount: this.mountLabel('din'), modules: 1, ctrs: [k.tag] };
        selRows.set(selKey, r);
        rows.push(r);
      }
      for (const s of (k.switches || [])) {
        const key = String(s.tag || '').trim().toLowerCase();
        const seen = key && byTag.get(key);
        if (seen) { if (!seen.ctrs.includes(k.tag)) seen.ctrs.push(k.tag); continue; }
        const r = { tag: s.tag || '', device: this.switchDevice(s), setting: s.setting || '', contact: this.switchContact(s) + (this.isDirect(k) ? ` · ${this.branchRating(k, s)} A ${k.category}` : ''),
          mount: this.mountLabel(this.switchMount(s)), modules: this.switchModules(s), ctrs: [k.tag] };
        if (key) byTag.set(key, r);
        rows.push(r);
      }
      if (this.hasBypass(k)) {
        const hoa = this.bypassMode(k) === 'hoa';
        rows.push({ tag: this.bypassTag(k), device: `${this.bypassKind(k).label} ${k.poles} ${this.bypassA(comp, k)} A`,
          setting: hoa ? 'Auto · Off · On' : 'Auto / On', contact: hoa ? 'Auto → contact · On → direct' : 'On → direct, past the contact',
          mount: this.mountLabel(this.bypassMount(k)), modules: this.bypassModules(k), ctrs: [k.tag] });
        if (k.bypass_lamp) rows.push({ tag: this.bypassLampTag(k), device: 'Indicator, amber LED 22 mm', setting: `Lit while ${this.bypassTag(k)} is On`,
          contact: `across ${this.bypassTag(k)} On`, mount: this.mountLabel('door'), modules: 0, ctrs: [k.tag] });
      }
      if (!this.isDirect(k) && k.lamp) {
        const sh = this.lampShows(k);
        rows.push({ tag: this.lampTag(k), device: `Indicator, ${this.lampColour(k).label.toLowerCase()} LED 22 mm${volts ? ', ' + volts : ''}`,
          setting: `Lit when ${k.tag} ${sh.nc ? 'open' : 'closed'}`, contact: `via ${k.tag} ${sh.aux}`,
          mount: this.mountLabel('door'), modules: 0, ctrs: [k.tag] });
      }
    }
    return rows;
  },

  // Puts `ways` on contactor k (taking them off any other); one circuit
  // becomes "a pole each" once it has more than one way.
  assign(comp, k, ways) {
    for (const w of ways) w.contactor = k.id;
    if (k.arrangement === 'single' && this.waysOf(comp, k).length > 1) k.arrangement = 'poles';
  },
  unassign(ways) { for (const w of ways) delete w.contactor; },

  // Small single-line sketch of an arrangement (the editor's "?" tip).
  arrangementSvg(v) {
    const mcb = (x, y) => `M ${x} ${y} v 18 M ${x - 4} ${y + 14} l 8 8 M ${x + 4} ${y + 14} l -8 8 M ${x - 9} ${y + 21} L ${x} ${y + 39}`;
    const pole = (x, y) => `M ${x - 4} ${y} a 4 4 0 0 0 8 0 M ${x - 9} ${y + 4} L ${x} ${y + 22}`;
    const arrow = (x) => `M ${x - 4} 96 L ${x} 104 L ${x + 4} 96 Z`;
    let ink = '', ctl = '', fill = '', txt = '';
    if (v === 'section') {
      ink = `M 40 12 H 260 M 150 12 V 22 M 150 44 V 52 M 80 52 H 220 ` + [90, 150, 210].map(x => `${mcb(x, 52)} V 96`).join(' ');
      ctl = pole(150, 22);
      fill = [90, 150, 210].map(arrow).join(' ');
      txt = '<text x="162" y="38" class="dbc-tip-k">K1</text><text x="226" y="74">MCBs</text>';
    } else if (v === 'direct') {
      ink = `M 110 12 H 190 ${mcb(150, 12)} V 60 M 150 82 V 96`;
      ctl = pole(150, 60);
      fill = arrow(150);
      txt = '<text x="162" y="40">MCB</text><text x="162" y="76" class="dbc-tip-k">PC1 / T1 contact</text>';
    } else {
      const xs = v === 'poles' ? [90, 150, 210] : [150];
      ink = `M ${v === 'poles' ? 40 : 110} 12 H ${v === 'poles' ? 260 : 190} ` + xs.map(x => `${mcb(x, 12)} V 60 M ${x} 82 V 96`).join(' ');
      ctl = xs.map(x => pole(x, 60)).join(' ') + (v === 'poles' ? ' M 86 73 H 206' : '');
      fill = xs.map(arrow).join(' ');
      const tx = xs[xs.length - 1] + 12;
      txt = `<text x="${tx}" y="40">${v === 'poles' ? 'MCB each' : 'MCB'}</text><text x="${tx}" y="76" class="dbc-tip-k">K1</text>`;
    }
    return `<svg class="dbc-tip-svg" viewBox="0 0 300 110" width="300" height="110" aria-hidden="true">
      <path d="${ink}" class="dbc-tip-ink"/><path d="${ctl}" class="dbc-tip-ctl${v === 'poles' ? ' dbc-tip-link' : ''}"/><path d="${escHtml(fill)}" class="dbc-tip-fill"/>${txt}</svg>`;
  },

  // Single-line sketch of a directly switched circuit with its bypass (the editor's
  // Bypass section): MCB → PEC (photocell: Line top, Load left, N right) → Auto
  // terminal of the selector; the supply goes straight to On past the PEC.
  bypassSvg(mode) {
    const arrow = (x1, y1, x2, y2) => {
      const L = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / L, uy = (y2 - y1) / L;
      const bx = x2 - ux * 6, by = y2 - uy * 6, px = -uy * 2.5, py = ux * 2.5, f = (n) => n.toFixed(1);
      return `<path d="M${x1} ${y1} L${f(bx)} ${f(by)}" class="dbc-by-ink dbc-by-thin"/><path d="M${x2} ${y2} L${f(bx + px)} ${f(by + py)} L${f(bx - px)} ${f(by - py)} Z" class="dbc-tip-fill"/>`;
    };
    const term = (x, y) => `<circle cx="${x}" cy="${y}" r="4" class="dbc-by-bg"/><path d="M${x - 2.8} ${y + 2.8} L${x + 2.8} ${y - 2.8}" class="dbc-by-ink dbc-by-thin"/>`;
    const hollow = (x, y, hot) => `<circle cx="${x}" cy="${y}" r="4" class="dbc-by-bg${hot ? ' dbc-by-hotring' : ''}"/>`;
    const byp = mode !== 'none', hoa = mode === 'hoa';
    let ink = `<path d="M150 6 V22 M150 40 L141 26 M150 40 V60 M150 68 V86 M122 100 H136 M164 100 H178 M186 100 H192" class="dbc-by-ink"/>`
      + `<circle cx="150" cy="100" r="14" class="dbc-by-bg"/><path d="M146 93 V107 M154 93 V107" class="dbc-by-ink dbc-by-thin"/>`
      + arrow(178, 74, 165, 87) + arrow(185, 80, 172, 93)
      + term(150, 64) + term(118, 100) + term(182, 100)
      + (byp ? `<path d="M118 104 V146 M150 164 V180" class="dbc-by-ink"/>${hollow(118, 150)}` : `<path d="M118 104 V170 H150 V180" class="dbc-by-ink"/>`)
      + `<rect x="130" y="180" width="40" height="24" rx="3" class="dbc-by-ink"/>`;
    let hot = '', txt = `<text x="162" y="36">MCB</text><text x="108" y="95" text-anchor="end" class="dbc-tip-k">PEC</text><text x="196" y="104">N</text><text x="150" y="196" text-anchor="middle">Load</text>`;
    if (byp) {
      hot = `<path d="M150 64 H250 V150 H186" class="dbc-by-hot"/>${hollow(182, 150, true)}${hoa ? hollow(150, 140) : ''}`
        + `<path d="M150 160 L121.5 152" class="dbc-by-hot dbc-by-blade"/><circle cx="150" cy="160" r="3.5" class="dbc-tip-fill"/>`;
      txt += `<text x="118" y="170" text-anchor="middle" class="dbc-by-lbl">AUTO</text><text x="182" y="170" text-anchor="middle" class="dbc-by-lbl">ON</text>`
        + (hoa ? `<text x="150" y="134" text-anchor="middle" class="dbc-by-lbl">OFF</text>` : '')
        + `<text x="258" y="112" class="dbc-by-lbl">${hoa ? 'Selector' : 'Bypass switch'}</text><text x="258" y="125" class="dbc-by-lbl dbc-by-plain">${hoa ? 'Auto · Off · On' : 'Auto / On'}</text>`;
    }
    const label = byp ? `Single line: the PEC switches the circuit in Auto; in On the supply goes straight to the load${hoa ? '; Off opens it' : ''}` : 'Single line: MCB, PEC, load';
    return `<svg class="dbc-tip-svg dbc-by-svg" viewBox="0 0 360 212" width="300" height="177" role="img" aria-label="${label}">${ink}${hot}${txt}</svg>`;
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
          <div class="dbc-dim">${e(`${this.isDirect(k) ? 'direct ' : ''}${this.specText(k)} · ways ${ways.map(x => x.way).join(', ') || '—'}`)}</div>
          <div class="dbc-dim">${e(this.switchedBy(k))}${sup ? ' · ' + e(sup.tag) : ''}${this.hasBypass(k) ? ' · bypass ' + e(this.bypassTag(k)) : ''}</div>
          ${bad.length ? `<div class="dbc-bad">⚠ ${e(bad[0].text)}</div>` : ''}</div>`;
      }
      return `<tr>
        <td>${chip(k.tag)}</td>
        <td>${e(k.label || '—')}</td>
        <td>${e(arr)}</td>
        <td>${e(`${k.poles} ${k.rating_a} A · ${k.category}`)}<br><span class="dbc-dim">${this.isDirect(k) ? 'contact on the device' : 'coil ' + e(k.coil || '')}${k.arrangement === 'poles' || this.isDirect(k) ? ` · ${this.polesNeeded(k, ways)} of ${this._polesN(k)} poles` : ''}</span></td>
        <td><div class="dbc-sws">${sw || '<span class="dbc-dim">—</span>'}</div></td>
        <td>${e(this.hasBypass(k) ? `${this.bypassKind(k).label} ${this.bypassTag(k)}` : k.selector === 'none' ? '—' : `${sel.label} ${k.selector_tag || ''}`)}</td>
        <td>${e(sup ? sup.tag : '—')}</td>
        <td>${e(ways.map(x => x.way).join(', ') || '—')}</td>
        <td>${din} mod</td>
        <td>${check}</td>
        <td class="dbc-act"><button type="button" class="btn-small" data-dbc-edit="${e(k.id)}" aria-label="Edit ${e(k.tag)}" title="Edit">✎</button><button type="button" class="btn-small" data-dbc-del="${e(k.id)}" aria-label="Remove ${e(k.tag)}" title="Remove">✕</button></td>
      </tr>`;
    }).join('');

    const supRows = supplies.map(s => {
      const users = contactors.filter(k => !this.isDirect(k) && k.supply === s.id).map(k => k.tag);
      const kindOpts = CTL_SUPPLY_KINDS.map(x => `<option value="${escHtml(x.v)}"${s.kind === x.v ? ' selected' : ''}>${e(x.label)}</option>`).join('');
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
    const nDirect = contactors.filter(k => this.isDirect(k)).length;
    const nCtr = contactors.length - nDirect;
    const summary = contactors.length
      ? [nCtr ? `${nCtr} contactor${nCtr === 1 ? '' : 's'}` : '', nDirect ? `${nDirect} switched direct` : '',
        supplies.length ? `${supplies.length} control suppl${supplies.length === 1 ? 'y' : 'ies'}` : '', `${mods} DIN modules, ${heat.toFixed(0)} W`].filter(Boolean).join(' · ')
      : 'none';

    const body = `<div class="dbc-body">
      <div class="dbc-bar">
        <button type="button" class="btn-small btn-primary" data-dbc="add">+ Contactor</button>
        <button type="button" class="btn-small" data-dbc="add-direct" title="A timer or photocell contact wired straight into the circuit, no contactor">+ Direct switching</button>
        ${DBSchedule._selected && DBSchedule._selected.size && !panel ? `<button type="button" class="btn-small" data-dbc="add-sel" title="One contactor switching the ways ticked in the grid">+ Contactor for ${DBSchedule._selected.size} ticked way${DBSchedule._selected.size === 1 ? '' : 's'}</button>` : ''}
        <span class="dbc-dim">${e(summary)}</span>
      </div>
      ${contactors.length ? (panel ? `<div class="dbc-cards">${rows}</div>` : `<div class="dbc-table-wrap"><table class="dbc-table">
        <thead><tr><th>Tag</th><th>Duty</th><th>Arrangement</th><th>Contactor</th><th>Switched by</th><th>Override</th><th>Supply</th><th>Ways</th><th>DIN</th><th>Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`)
        : `<div class="dba-empty">No contactors yet. Add one to switch outdoor lights on a photocell or timer, HVAC on a thermostat or BMS enable — or tick ways in the grid and add one for them. A small circuit wired straight through a timer or photocell contact, with no contactor, is “Direct switching”. They appear on the single line and take space on the GA.</div>`}
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
      } else if (a === 'add-direct') {
        const k = this.newContactor(comp, [], 'direct');
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
    let tip = null;                                // arrangement whose "?" diagram is open

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
      const branched = this.isDirect(k) && k.combine === 'branches' && k.switches.length > 1;
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
        <select data-sw="${i}" data-swk="kind" aria-label="Kind">${CTL_SWITCH_KINDS.map(x => opt(x.key, s.kind, x.label)).join('')}</select>
        <input type="text" data-sw="${i}" data-swk="setting" value="${e(s.setting || '')}" placeholder="Setting / program" aria-label="Setting">
        <button type="button" class="btn-small" data-sw-del="${i}" aria-label="Remove ${e(s.tag || '')}">✕</button>
        <div class="dbc-swmore">
          <label>Device <input type="text" data-sw="${i}" data-swk="device" value="${e(s.device || '')}" placeholder="${e(this.switchKind(s.kind).label)}"></label>
          <label>Mounting <select data-sw="${i}" data-swk="mount">${CTL_MOUNTS.map(x => opt(x.v, this.switchMount(s), x.label)).join('')}</select></label>
          ${branched ? `<label>Contact (A) <input type="number" data-sw="${i}" data-swk="contact_a" value="${e(s.contact_a ?? '')}" placeholder="${e(k.rating_a)}" min="1" step="1"></label>
          <label>Load (A) <input type="number" data-sw="${i}" data-swk="load_a" value="${e(s.load_a ?? '')}" min="0" step="0.1"></label>
          <label>Feeds <input type="text" data-sw="${i}" data-swk="feeds" value="${e(s.feeds || '')}" placeholder="e.g. Car park"></label>` : ''}
          <label>${s.kind === 'photocell' ? 'Terminals' : 'Contact'} <input type="text" data-sw="${i}" data-swk="contact" value="${e(s.contact || '')}" placeholder="${e(this.switchContact({ kind: s.kind }))}${s.kind === 'photocell' ? '' : ' (e.g. NO 15-18)'}"></label>
        </div></div>`).join('');
      const direct = this.isDirect(k);
      const tmp = Object.assign({}, k);
      const warnList = this._draftWarnings(comp, tmp, ways);
      const din = (() => {
        const parts = [];
        if (!direct) parts.push(`${k.tag} ${this.contactorSize(k).modules}`);
        for (const s of k.switches) { const n = this.switchModules(s); if (n) parts.push(`${s.tag} ${n}`); }
        if (!direct && k.selector !== 'none') parts.push(`${k.selector_tag || 'S'} 1`);
        if (direct && this.hasBypass(k) && this.bypassModules(k)) parts.push(`${this.bypassTag(k)} ${this.bypassModules(k)}`);
        return parts.join(' · ');
      })();

      m.innerHTML = `<div class="modal-content dbc-dialog">
        <div class="modal-header"><h3 id="dbc-title"><span class="dbc-tag">${e(k.tag)}</span> ${direct ? 'Direct switching' : 'Contactor'} — ${e(comp.props.name || comp.id)}</h3>
          <button class="modal-close" data-dbc-x="cancel" aria-label="Close">&times;</button></div>
        <div class="dbc-dlg-body">
          <div class="dbc-grid2">
            <label>Tag <input type="text" data-kk="tag" value="${e(k.tag)}"></label>
            <label>Duty <input type="text" data-kk="label" value="${e(k.label || '')}" placeholder="e.g. External lighting"></label>
          </div>
          <fieldset><legend>What it switches</legend>
            <div class="dbc-arr">${CTL_ARRANGEMENTS.map(a => `<div class="dbc-arr-opt${k.arrangement === a.v ? ' on' : ''}">
              <label><input type="radio" name="dbc-arr" value="${escHtml(a.v)}"${k.arrangement === a.v ? ' checked' : ''}><span>${e(a.label)}<small>${e(a.hint)}</small></span></label>
              <button type="button" class="dbc-tipbtn" data-dbc-tip="${escHtml(a.v)}" aria-expanded="${tip === a.v}" aria-label="What “${e(a.label)}” means"><span aria-hidden="true">?</span></button></div>`).join('')}</div>
            ${tip ? `<div class="dbc-tip" role="note"><strong>${e((CTL_ARRANGEMENTS.find(a => a.v === tip) || {}).label || '')}</strong>${this.arrangementSvg(tip)}<p>${e(CTL_ARRANGEMENT_HELP[tip] || '')}</p></div>` : ''}
            <div class="dbc-ways">${wayList || '<span class="dbc-dim">This board has no ways yet.</span>'}</div>
          </fieldset>
          <fieldset><legend>${direct ? 'Switching contact' : 'Contactor'}</legend>
            <div class="dbc-grid4">
              <label>Poles <select data-kk="poles">${(direct ? ['1P', '2P', '3P', '4P'] : ['2P', '3P', '4P']).map(p => opt(p, k.poles)).join('')}</select></label>
              <label>${direct ? 'Contact rating (A)' : 'Rating (A)'} <input type="number" data-kk="rating_a" value="${e(k.rating_a)}" min="1" step="1"></label>
              <label>Utilisation <select data-kk="category">${CTL_CATEGORIES.map(c => opt(c.v, k.category, c.label)).join('')}</select></label>
              ${direct ? '' : `<label>Coil <select data-kk="coil">${CTL_COILS.map(c => opt(c, k.coil)).join('')}</select></label>`}
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
              ${k.switches.length > 1 ? `<label>Combine <select data-kk="combine">${opt('series', k.combine, 'In series — all must close')}${opt('parallel', k.combine, 'In parallel — any one closes')}${direct ? opt('branches', k.combine, 'Separate branches — each feeds its own equipment') : ''}</select></label>` : ''}
            </div>
            <div class="dbc-dim">${direct ? 'The device’s own output contact carries the circuit current — enter its rating above.' : 'A tag used on another contactor is the same device (one photocell switching several contactors).'}</div>
          </fieldset>
          ${direct ? this._bypassHtml(comp, k, ways) : ''}
          ${direct ? '' : `<fieldset><legend>Override and supply</legend>
            <div class="dbc-grid4">
              <label>Selector <select data-kk="selector">${CTL_SELECTORS.map(x => opt(x.v, k.selector, x.label)).join('')}</select></label>
              <label>Selector tag <input type="text" data-kk="selector_tag" value="${e(k.selector_tag || '')}"${k.selector === 'none' ? ' disabled' : ''}></label>
              <label>Control supply <select data-kk="supply">${opt('', k.supply, '— none')}${supplies.map(s => opt(s.id, k.supply, `${s.tag} · ${s.voltage || ''}`)).join('')}${opt('__new', '', '+ New supply…')}</select></label>
              <label class="dbc-chk"><input type="checkbox" data-kk="lamp"${k.lamp ? ' checked' : ''}> Indicator lamp on the door</label>
            </div>
            ${k.lamp ? `<div class="dbc-grid4 dbc-lamp">
              <label>Lamp tag <input type="text" data-kk="lamp_tag" value="${e(k.lamp_tag || '')}" placeholder="${e(this.lampTag(k))}"></label>
              <label>Colour <select data-kk="lamp_color">${CTL_LAMP_COLOURS.map(x => opt(x.v, this.lampColour(k).v, x.label)).join('')}</select></label>
              <label class="dbc-span2">Lit when <select data-kk="lamp_shows">${CTL_LAMP_SHOWS.map(x => opt(x.v, this.lampShows(k).v, `${x.label} (aux ${x.aux})`)).join('')}</select></label>
            </div>` : ''}
          </fieldset>`}
          ${warnList.length ? `<div class="dbc-warns">${warnList.map(w => `<div class="dba-note ${e(w.level)}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${e(w.text)}</div>`).join('')}</div>` : ''}
          <div class="dbc-where"><div><small>Schedule</small>${ways.length ? `Ways ${e(ways.map(w => w.way).join(', '))} show ${e(k.tag)}` : 'No ways'}</div>
            <div><small>Single line</small>${ways.length ? `${e(k.tag)} on ${ways.length} way${ways.length === 1 ? '' : 's'}${direct ? ' (contact in the circuit' + (this.hasBypass(k) ? `, ${e(this.bypassTag(k))} round it` : '') + ')' : ' + control rung'}` : direct ? 'No ways' : 'Control rung only'}</div>
            <div><small>GA</small>${e(din)} modules</div></div>
        </div>
        <div class="modal-footer dbc-foot">
          ${opts.isNew ? '' : '<button type="button" class="btn-small dbc-del" data-dbc-x="delete">Delete</button>'}
          <span style="flex:1"></span>
          <button type="button" class="btn-small" data-dbc-x="cancel">Cancel</button>
          <button type="button" class="btn-small btn-primary" data-dbc-x="save">${opts.isNew ? (direct ? 'Add' : 'Add contactor') : 'Save'}</button>
        </div></div>`;
    };
    draw();

    const finish = () => { document.removeEventListener('keydown', onKey, true); m.remove(); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);

    m.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.name === 'dbc-arr') {
        const was = this.isDirect(k);
        this.setArrangement(comp, k, t.value);
        if (this.isDirect(k) !== was) sized.auto = true;      // the other kind of device is sized differently
        draw(); return;
      }
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
          delete s.device; delete s.mount; delete s.contact;
        }
        draw(); return;
      }
      if (t.name === 'dbc-bypass') {
        if (t.value === 'none') k.bypass = 'none';
        else {
          const wasTag = String(k.bypass_tag || '');
          k.bypass = t.value;
          if (!wasTag || /^(BS|S)\d+$/i.test(wasTag)) {
            const mine = new Set([wasTag.toLowerCase()]);
            k.bypass_tag = this._nextTag(this._allSwitchTags(comp).filter(x => !mine.has(String(x || '').toLowerCase())).concat(k.switches.map(x => x.tag)), t.value === 'hoa' ? 'S' : 'BS');
          }
        }
        draw(); return;
      }
      const kk = t.dataset.kk;
      if (!kk) return;
      if (kk === 'bypass_lamp') {
        k.bypass_lamp = t.checked;
        if (k.bypass_lamp && !k.bypass_lamp_tag) k.bypass_lamp_tag = this._nextTag(this.contactors(comp).filter(x => x.id !== k.id && x.bypass_lamp_tag).map(x => x.bypass_lamp_tag).concat(this.contactors(comp).filter(x => x.lamp).map(x => this.lampTag(x))), 'H');
      }
      else if (kk === 'bypass_a') k.bypass_a = parseFloat(t.value) || 0;
      else if (kk === 'lamp') {
        k.lamp = t.checked;
        if (k.lamp && !k.lamp_tag) k.lamp_tag = this._nextLampTag(comp, k);
      }
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
      const tb = ev.target.closest('[data-dbc-tip]');
      if (tb) { tip = tip === tb.dataset.dbcTip ? null : tb.dataset.dbcTip; draw(); return; }
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
        if (k.arrangement === 'section' && typeof DBSchedule !== 'undefined' && DBSchedule.elStraddles) {
          const ids = new Set(circuits.filter(c => picked.has(c.id)).map(c => c.id));
          const bad = this._draftWarnings(comp, k, circuits.filter(c => ids.has(c.id))).find(w => w.block);
          if (bad) { if (typeof UI !== 'undefined' && UI.toast) UI.toast(bad.text, 'warning'); return; }
        }
        k.tag = tag;
        if (!this.isDirect(k) && !k.supply && !d.supplies.length) k.supply = this.addSupply(comp).id;   // the board's first control supply
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

  // The editor's Bypass section for a directly switched circuit.
  _bypassHtml(comp, k, ways) {
    const e = escHtml, mode = this.bypassMode(k), on = mode !== 'none';
    const big = Math.max(0, ...ways.map(w => Number(w.breaker_a) || 0));
    const radios = CTL_BYPASS.map(b => `<label class="dbc-byopt${mode === b.v ? ' on' : ''}"><input type="radio" name="dbc-bypass" value="${e(b.v)}"${mode === b.v ? ' checked' : ''}>
        <span>${e(b.label)}<small>${e(b.hint)}</small></span></label>`).join('');
    const fields = on ? `<div class="dbc-grid4 dbc-bypass-f">
        <label>Tag <input type="text" data-kk="bypass_tag" value="${e(k.bypass_tag || '')}" placeholder="${e(this.bypassTag(k))}"></label>
        <label>Rating (A) <input type="number" data-kk="bypass_a" value="${e(k.bypass_a || '')}" placeholder="${e(big || k.rating_a)}" min="1" step="1"></label>
        <label>Poles <input type="text" value="${e(k.poles)}" readonly aria-label="Poles follow the contact"></label>
        <label>Mounted <select data-kk="bypass_mount">${CTL_MOUNTS.filter(x => x.v !== 'field').map(x => `<option value="${e(x.v)}"${this.bypassMount(k) === x.v ? ' selected' : ''}>${e(x.label)}</option>`).join('')}</select></label>
      </div>
      <label class="dbc-chk"><input type="checkbox" data-kk="bypass_lamp"${k.bypass_lamp ? ' checked' : ''}> Indicator lamp on the door, lit while bypassed${k.bypass_lamp ? ` (${e(this.bypassLampTag(k))} · amber)` : ''}</label>
      <div class="dbc-dim">${big ? `Suggested ${big} A — the largest breaker on the circuit; ` : ''}the bypass carries the whole load, so it is not limited by the contact’s ${e(k.rating_a)} A.</div>` : '';
    return `<fieldset class="dbc-bypass"><legend>Bypass</legend>
      <div class="dbc-bypass-row"><div class="dbc-byopts">${radios}</div>${this.bypassSvg(mode)}</div>${fields}</fieldset>`;
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
    if (typeof SchMobile !== 'undefined' && SchMobile.comp() === comp) SchMobile.refresh();
  },
};
