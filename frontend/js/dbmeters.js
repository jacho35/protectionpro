/* ProtectionPro — Energy metering: meters in a board and on the single line,
 * and how they reach the BMS / control system.
 *
 * A board's meters are defined once on the board and the ways they measure
 * point at them, the same way contactors do (DBControls):
 *
 *   comp.props.meters = [{ id, tag: 'M1', label,
 *     scope: 'way' | 'incomer' | 'group',
 *     group_mode: 'subbus' | 'virtual',      // group only
 *     type: 'multifunction' | 'kwh' | 'mid' | 'pulse', cls: '0.5S',
 *     system: '3P4W' | '1P2W' | '3P3W', mount: 'din' | 'door96' | 'door72',
 *     conn: 'direct63' | 'direct125' | 'ct5' | 'ct1' | 'rogowski',
 *     ct_ratio: '200/5', ct_class: '0.5S', model,
 *     protocol: 'modbus_rtu' | 'modbus_tcp' | 'bacnet_ip' | 'bacnet_mstp' | 'mbus' | 'pulse' | 'none',
 *     network: 'Loop A', address: '11', gateway: <SLD bms_gateway id> | 'direct' | '',
 *     points: ['kWh', 'kW', …], iso_a }]
 *   way.meter = <meter id>   (in props.circuits)
 *
 * Scopes: 'way' — one circuit; 'incomer' — the whole board on its supply (no
 * ways); 'group' — several ways, measured either by ONE meter ahead of a
 * sub-busbar the ways hang from ('subbus': drawn that way, with its own
 * isolator) or by a meter on each way that the BMS adds up ('virtual').
 *
 * On the single line an Energy Meter (COMPONENT_DEFS.energy_meter) has no power
 * ports, like a relay: `measures` names the CT (or the breaker / cable it sits
 * on), `gateway` the BMS Gateway it reports through. Neither changes any study.
 *
 * Every meter in the project (both kinds) is read through all(), which the
 * address / network checks, the meter schedule (MeterSchedule) and the BOQ use.
 * Absent `meters` ⇒ nothing changes anywhere — reads go through peek().
 */

const MTR_TYPES = [
  { v: 'multifunction', label: 'Multi-function power meter', short: 'Multi-function', cls: '1', modules: 4, points: ['kWh', 'kW', 'kVAr', 'PF', 'V', 'I', 'MD'] },
  { v: 'kwh', label: 'kWh sub-meter', short: 'kWh sub-meter', cls: '1', modules: 4, points: ['kWh', 'kW'] },
  { v: 'mid', label: 'MID billing meter', short: 'MID billing', cls: 'B (MID)', modules: 4, points: ['kWh'] },
  { v: 'pulse', label: 'Pulse-output kWh meter', short: 'Pulse kWh', cls: '1', modules: 2, points: ['kWh'] },
];
const MTR_CLASSES = ['0.2S', '0.5S', '1', '2', 'A (MID)', 'B (MID)', 'C (MID)'];
const MTR_SYSTEMS = [
  { v: '3P4W', label: '3P4W — three-phase + N' },
  { v: '1P2W', label: '1P2W — single-phase + N' },
  { v: '3P3W', label: '3P3W — three-phase, no N' },
];
const MTR_CONNS = [
  { v: 'direct63', label: 'Direct ≤ 63 A', max: 63 },
  { v: 'direct125', label: 'Direct ≤ 125 A', max: 125 },
  { v: 'ct5', label: 'CT-operated, /5 A', ct: true, sec: 5 },
  { v: 'ct1', label: 'CT-operated, /1 A', ct: true, sec: 1 },
  { v: 'rogowski', label: 'Rogowski coils', ct: true, sec: 0 },
];
const MTR_MOUNTS = [
  { v: 'din', label: 'DIN rail' },
  { v: 'door96', label: 'Door cut-out 96×96' },
  { v: 'door72', label: 'Door cut-out 72×72' },
];
// bus: the medium the protocol runs on — RS-485 / M-Bus segments are checked
// for device count and need a gateway (or BMS controller) at one end.
const MTR_PROTOCOLS = [
  { v: 'modbus_rtu', label: 'Modbus RTU (RS-485)', short: 'Modbus RTU', bus: 'rs485', max: 32 },
  { v: 'modbus_tcp', label: 'Modbus TCP', short: 'Modbus TCP', bus: 'ip' },
  { v: 'bacnet_ip', label: 'BACnet/IP', short: 'BACnet/IP', bus: 'ip' },
  { v: 'bacnet_mstp', label: 'BACnet MS/TP (RS-485)', short: 'BACnet MS/TP', bus: 'rs485', max: 32 },
  { v: 'mbus', label: 'M-Bus', short: 'M-Bus', bus: 'mbus', max: 250 },
  { v: 'pulse', label: 'Pulse output to a BMS input', short: 'Pulse', bus: 'pulse' },
  { v: 'none', label: 'None — local display only', short: 'Local only', bus: 'none' },
];
// The readings a meter can hand the BMS. perPhase points expand to L1–L3 on a
// three-phase meter in the points list.
const MTR_POINTS = [
  { k: 'kWh', label: 'kWh', unit: 'kWh', desc: 'Active energy import', obj: 'AI' },
  { k: 'kW', label: 'kW', unit: 'kW', desc: 'Total active power', obj: 'AI' },
  { k: 'kVAr', label: 'kVAr', unit: 'kVAr', desc: 'Total reactive power', obj: 'AI' },
  { k: 'kVA', label: 'kVA', unit: 'kVA', desc: 'Total apparent power', obj: 'AI' },
  { k: 'PF', label: 'PF', unit: '', desc: 'Power factor', obj: 'AI' },
  { k: 'V', label: 'V L–N', unit: 'V', desc: 'Voltage L–N', obj: 'AI', perPhase: true },
  { k: 'I', label: 'I per phase', unit: 'A', desc: 'Phase current', obj: 'AI', perPhase: true },
  { k: 'Hz', label: 'Hz', unit: 'Hz', desc: 'Frequency', obj: 'AI' },
  { k: 'THD', label: 'THD', unit: '%', desc: 'Current THD', obj: 'AI', perPhase: true },
  { k: 'MD', label: 'Max demand', unit: 'kW', desc: 'Maximum demand', obj: 'AI' },
  { k: 'Alarm', label: 'Alarms', unit: '', desc: 'Meter alarm / comms fault', obj: 'BI' },
];
const MTR_CT_PRIMARIES = [5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600,
  750, 800, 1000, 1200, 1250, 1500, 1600, 2000, 2500, 3000, 4000, 5000];
const MTR_ISO_RATINGS = [20, 32, 40, 63, 80, 100, 125, 160, 200, 250, 315, 400];
const MTR_SCOPES = [
  { v: 'way', label: 'One circuit', hint: 'A meter on a single way' },
  { v: 'incomer', label: 'Incomer', hint: 'The whole board, on its supply' },
  { v: 'group', label: 'Group of circuits', hint: 'Several ways together' },
];
const MTR_GROUP_MODES = [
  { v: 'subbus', label: 'Metered sub-busbar', hint: 'One meter; the ways hang from their own sub-bus behind it, with an isolator. Drawn that way on the board single line.' },
  { v: 'virtual', label: 'Sum of circuit meters', hint: 'A meter on each way; the BMS adds them into one total. No change to the board wiring, more meters.' },
];

const DBMeters = {
  _seq: 0,
  _openSection: true,

  // ── Model ───────────────────────────────────────────────────────────
  _uid() { return 'm' + (++this._seq).toString(36) + Math.random().toString(36).slice(2, 7); },

  // Read-only list — never writes, so drawing / GA / BOQ reads cannot dirty a board.
  list(comp) {
    const d = comp && comp.props && comp.props.meters;
    return Array.isArray(d) ? d : [];
  },
  // The writable list (created on the first edit).
  data(comp) {
    if (!Array.isArray(comp.props.meters)) comp.props.meters = [];
    return comp.props.meters;
  },
  has(comp) { return this.list(comp).length > 0; },
  meter(comp, id) { return this.list(comp).find(m => m.id === id) || null; },

  // The meter a way is measured by. A pasted / imported tag ('M2') resolves too.
  wayMeter(comp, c) {
    const v = c && c.meter;
    if (!v) return null;
    const list = this.list(comp);
    return list.find(m => m.id === v)
      || list.find(m => String(m.tag || '').toLowerCase() === String(v).trim().toLowerCase()) || null;
  },
  waysOf(comp, m) {
    if (!m || m.scope === 'incomer') return [];
    const ways = (comp.props.circuits || []).filter(c => this.wayMeter(comp, c) === m);
    return ways.sort((a, b) => String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }));
  },

  type(v) { return MTR_TYPES.find(x => x.v === v) || MTR_TYPES[0]; },
  conn(v) { return MTR_CONNS.find(x => x.v === v) || MTR_CONNS[0]; },
  protocol(v) { return MTR_PROTOCOLS.find(x => x.v === v) || MTR_PROTOCOLS[0]; },
  system(v) { return MTR_SYSTEMS.find(x => x.v === v) || MTR_SYSTEMS[0]; },
  mount(v) { return MTR_MOUNTS.find(x => x.v === v) || MTR_MOUNTS[0]; },
  scope(v) { return MTR_SCOPES.find(x => x.v === v) || MTR_SCOPES[0]; },
  isGroup(m) { return m && m.scope === 'group'; },
  isVirtual(m) { return this.isGroup(m) && m.group_mode === 'virtual'; },
  isSubbus(m) { return this.isGroup(m) && m.group_mode !== 'virtual'; },

  _is3(c) { return c.poles === '3P' || c.phase === 'RWB'; },

  _nextTag(tags, prefix) {
    const used = new Set(tags.map(t => String(t || '').toUpperCase()));
    let n = 1;
    while (used.has(`${prefix}${n}`.toUpperCase())) n++;
    return `${prefix}${n}`;
  },

  newMeter(comp, scope, ways) {
    ways = ways || [];
    const list = this.list(comp);
    if (!scope) scope = ways.length > 1 ? 'group' : ways.length ? 'way' : 'incomer';
    const m = {
      id: this._uid(), tag: this._nextTag(list.map(x => x.tag), 'M'),
      label: scope === 'incomer' ? 'Board incomer' : (ways[0] ? String(ways[0].description || '').trim() : ''),
      scope, group_mode: 'subbus',
      type: scope === 'incomer' ? 'multifunction' : 'kwh', cls: scope === 'incomer' ? '0.5S' : '1',
      system: '3P4W', mount: scope === 'incomer' ? 'door96' : 'din',
      conn: 'direct63', ct_ratio: '', ct_class: '', model: '',
      protocol: 'modbus_rtu', network: this._defaultNetwork(), address: '', gateway: this._defaultGateway(),
      points: [],
    };
    m.points = this.type(m.type).points.slice();
    if (scope === 'group' && ways.length && m.label) m.label = 'Group · ' + m.label;
    Object.assign(m, this.suggest(comp, m, ways));
    m.address = String(this.nextAddress(m));
    return m;
  },

  removeMeter(comp, id) {
    const d = this.data(comp);
    const i = d.findIndex(m => m.id === id);
    if (i >= 0) d.splice(i, 1);
    for (const c of (comp.props.circuits || [])) {
      if (c.meter && !this.wayMeter(comp, c)) delete c.meter;
    }
  },

  assign(comp, m, ways) { for (const w of ways) w.meter = m.id; },
  unassign(ways) { for (const w of ways) delete w.meter; },

  // ── Sizing ──────────────────────────────────────────────────────────
  // The highest phase current through the meter (one of them, for a virtual
  // group): the breaker rating for one way (what the circuit may carry), the
  // diversified phase sum for a sub-bus, the incomer rating for the board.
  currentA(comp, m, ways) {
    if (m.scope === 'incomer') {
      const inc = typeof DBAccessories !== 'undefined' ? DBAccessories.incomer(comp) : null;
      return Number(inc && inc.rating_a) || Number(comp.props.rated_current_a) || 0;
    }
    ways = ways || this.waysOf(comp, m);
    if (!ways.length) return 0;
    if (m.scope === 'way' || this.isVirtual(m)) return Math.max(...ways.map(w => Number(w.breaker_a) || 0));
    const vll = DBSchedule._boardVll(comp);
    const ph = { R: 0, W: 0, B: 0 };
    for (const w of ways) {
      const a = DBSchedule._wayCurrentA(w, vll);
      if (this._is3(w)) { ph.R += a; ph.W += a; ph.B += a; } else ph[w.phase || 'R'] += a;
    }
    return Math.max(ph.R, ph.W, ph.B);
  },

  // Phases a meter sees: 'RWB' when any way is three-phase or the ways span
  // more than one phase (an incomer is assumed three-phase), else the one phase.
  phases(comp, m, ways) {
    if (m.scope === 'incomer') return 'RWB';
    ways = ways || this.waysOf(comp, m);
    if (!ways.length) return '';
    if (this.isVirtual(m)) return ways.some(w => this._is3(w)) ? 'RWB' : (ways[0].phase || 'R');
    const set = new Set(ways.map(w => this._is3(w) ? 'RWB' : (w.phase || 'R')));
    return set.has('RWB') || set.size > 1 ? 'RWB' : [...set][0];
  },

  _ctPrimary(a) { return MTR_CT_PRIMARIES.find(p => p >= a) || MTR_CT_PRIMARIES[MTR_CT_PRIMARIES.length - 1]; },
  ctPrimary(m) { const n = parseFloat(String(m.ct_ratio || '').split('/')[0]); return Number.isFinite(n) ? n : null; },

  // Connection, CT and system for the current the meter carries.
  suggest(comp, m, ways) {
    const a = this.currentA(comp, m, ways);
    const ph = this.phases(comp, m, ways);
    const out = { system: ph && ph !== 'RWB' ? '1P2W' : '3P4W' };
    if (!a) return out;
    if (a <= 63 && m.scope !== 'incomer') { out.conn = 'direct63'; out.ct_ratio = ''; out.ct_class = ''; }
    else {
      out.conn = 'ct5';
      out.ct_ratio = `${this._ctPrimary(a)}/5`;
      out.ct_class = /0\.2S|0\.5S/.test(m.cls) ? m.cls : (m.type === 'mid' ? '0.5S' : '1');
    }
    if (this.isSubbus(m)) out.iso_a = MTR_ISO_RATINGS.find(r => r >= a) || MTR_ISO_RATINGS[MTR_ISO_RATINGS.length - 1];
    return out;
  },

  // Physical meters a record stands for: one per way for a virtual group.
  count(comp, m) { return this.isVirtual(m) ? Math.max(1, this.waysOf(comp, m).length) : 1; },

  // ── Points & addresses ─────────────────────────────────────────────
  pointsOf(m) {
    const p = Array.isArray(m.points) ? m.points : String(m.points || '').split(/[,;]\s*/);
    return p.map(s => String(s).trim()).filter(Boolean);
  },
  // Expanded BMS points of one meter: [{ name, desc, unit, obj }]. `prefix` is
  // the point-name stem ('DB-G1.M1'); `three` expands per-phase points.
  pointList(m, prefix, three) {
    const out = [];
    for (const k of this.pointsOf(m)) {
      const p = MTR_POINTS.find(x => x.k.toLowerCase() === k.toLowerCase()) || { k, label: k, unit: '', desc: k, obj: 'AI' };
      if (p.perPhase && three) {
        for (const L of ['L1', 'L2', 'L3']) out.push({ name: `${prefix}.${p.k}_${L}`, desc: `${p.desc} ${L}`, unit: p.unit, obj: p.obj });
      } else out.push({ name: `${prefix}.${p.k}`, desc: p.desc, unit: p.unit, obj: p.obj });
    }
    return out;
  },
  _slug(s) { return String(s || '').trim().replace(/\s+/g, '-').replace(/[^\w.\-]+/g, ''); },

  _defaultNetwork() {
    const nets = this.networks();
    return nets[0] || 'Loop A';
  },
  _defaultGateway() {
    const gws = this.gateways();
    return gws.length === 1 ? gws[0].id : '';
  },
  networks() {
    const s = new Set();
    for (const r of this.all()) if (r.network && this.protocol(r.protocol).bus !== 'ip') s.add(r.network);
    return [...s].sort();
  },
  gateways() {
    return [...AppState.components.values()].filter(c => c.type === 'bms_gateway');
  },
  gatewayLabel(id) {
    if (!id) return 'no gateway';
    if (id === 'direct') return 'BMS controller';
    const g = AppState.components.get(id);
    return g ? (g.props.name || g.id) : 'missing gateway';
  },
  // The next free RS-485 / M-Bus address on the meter's segment (1–247).
  nextAddress(m) {
    const used = new Set();
    const key = this._segKey(m);
    for (const r of this.all()) if (r.id !== m.id && this._segKey(r) === key) for (const a of r.addresses) used.add(a);
    let n = 1;
    while (used.has(String(n))) n++;
    return n;
  },
  _segKey(r) {
    const bus = this.protocol(r.protocol).bus;
    if (bus === 'ip') return 'ip';
    if (bus === 'pulse' || bus === 'none') return null;
    return `${bus}|${r.gateway || '-'}|${String(r.network || '').trim().toLowerCase()}`;
  },
  // The addresses a record occupies (a virtual group: consecutive from its own).
  _addresses(addr, n) {
    const s = String(addr == null ? '' : addr).trim();
    if (!s) return [];
    const k = parseInt(s, 10);
    if (n <= 1 || !/^\d+$/.test(s)) return [s];
    return Array.from({ length: n }, (_, i) => String(k + i));
  },

  // ── Every meter in the project ─────────────────────────────────────
  // One row per meter record (board or single line), normalised.
  all() {
    const out = [];
    if (typeof AppState === 'undefined' || !AppState.components) return out;
    for (const comp of AppState.components.values()) {
      if (comp.type === 'energy_meter') {
        const p = comp.props || {};
        const meas = p.measures ? AppState.components.get(p.measures) : null;
        out.push({
          src: 'sld', id: comp.id, comp, m: p, tag: p.name || comp.id, board: 'Single line',
          what: meas ? `${meas.props.name || meas.id}` : 'not linked', type: p.meter_type, cls: p.cls,
          system: p.system, conn: p.conn, ct_ratio: this.sldCtRatio(comp), protocol: p.protocol, network: p.network,
          address: p.address, gateway: p.gateway, points: this.pointsOf({ points: p.points }), count: 1,
          addresses: this._addresses(p.address, 1), prefix: this._slug(p.name || comp.id),
        });
      } else if (this.has(comp)) {
        const board = comp.props.name || comp.id;
        for (const m of this.list(comp)) {
          const ways = this.waysOf(comp, m);
          const n = this.count(comp, m);
          out.push({
            src: 'board', id: m.id, comp, m, tag: m.tag, board,
            what: this.measuresText(comp, m, ways), type: m.type, cls: m.cls, system: m.system, conn: m.conn,
            ct_ratio: this.conn(m.conn).ct ? m.ct_ratio : '', protocol: m.protocol, network: m.network,
            address: m.address, gateway: m.gateway, points: this.pointsOf(m), count: n,
            addresses: this._addresses(m.address, n), prefix: `${this._slug(board)}.${this._slug(m.tag)}`,
          });
        }
      }
    }
    return out;
  },

  measuresText(comp, m, ways) {
    ways = ways || this.waysOf(comp, m);
    if (m.scope === 'incomer') return 'Incomer (whole board)';
    if (!ways.length) return m.scope === 'group' ? 'Group — no ways yet' : 'No way yet';
    const list = ways.map(w => w.way).join(', ');
    if (m.scope === 'way') return `Way ${list}${ways[0].description ? ' · ' + ways[0].description : ''}`;
    return `${this.isVirtual(m) ? 'Σ of ways' : 'Sub-bus: ways'} ${list}`;
  },

  // An SLD meter's CT ratio: its measuring CT's, else what it was typed as.
  sldCtRatio(comp) {
    const p = comp.props || {};
    const meas = p.measures ? AppState.components.get(p.measures) : null;
    if (meas && meas.type === 'ct') return meas.props.ratio || '';
    return this.conn(p.conn).ct ? (p.ct_ratio || '') : '';
  },

  // ── Checks ──────────────────────────────────────────────────────────
  // Project-wide: duplicate addresses on a segment, too many devices on one,
  // a bus protocol with nowhere to report. Map row id → [{ level, text }].
  projectChecks() {
    const rows = this.all();
    const res = new Map(rows.map(r => [r.id, []]));
    const seg = new Map();
    for (const r of rows) {
      const k = this._segKey(r);
      if (!k) continue;
      if (!seg.has(k)) seg.set(k, []);
      seg.get(k).push(r);
    }
    for (const [k, list] of seg) {
      const seen = new Map();
      for (const r of list) for (const a of r.addresses) {
        if (seen.has(a) && seen.get(a) !== r) {
          const o = seen.get(a);
          const where = (x) => x.src === 'sld' ? x.tag : `${x.board} ${x.tag}`;
          res.get(r.id).push({ level: 'warn', text: `Address ${a} is also used by ${where(o)}${k === 'ip' ? '' : ` on ${r.network || 'the same network'}`}` });
          res.get(o.id).push({ level: 'warn', text: `Address ${a} is also used by ${where(r)}${k === 'ip' ? '' : ` on ${r.network || 'the same network'}`}` });
        } else seen.set(a, r);
      }
      const pr = this.protocol(list[0].protocol);
      const n = list.reduce((s, r) => s + r.count, 0);
      if (k !== 'ip' && pr.max && n > pr.max) {
        for (const r of list) res.get(r.id).push({ level: 'warn', text: `${r.network || 'This network'} has ${n} devices — more than the ${pr.max} one ${pr.short} segment takes without a repeater` });
      }
    }
    for (const r of rows) {
      const bus = this.protocol(r.protocol).bus;
      if ((bus === 'rs485' || bus === 'mbus') && !r.gateway) {
        res.get(r.id).push({ level: 'warn', text: `${this.protocol(r.protocol).short} meter with no gateway — the BMS will not read it` });
      } else if (r.gateway && r.gateway !== 'direct' && !AppState.components.get(r.gateway)) {
        res.get(r.id).push({ level: 'warn', text: 'Its gateway is no longer on the single line' });
      }
      if ((bus === 'rs485' || bus === 'mbus' || bus === 'ip') && !String(r.address || '').trim()) {
        res.get(r.id).push({ level: 'warn', text: 'No address set' });
      }
      if (bus === 'pulse' && r.points.some(p => p !== 'kWh')) {
        res.get(r.id).push({ level: 'info', text: 'A pulse output gives energy only — the other points need a comms meter' });
      }
    }
    return res;
  },

  // A board meter's own checks (sizing, phases, ways), plus the project ones.
  warnings(comp, m, ways, project) {
    ways = ways || this.waysOf(comp, m);
    const out = [];
    const cn = this.conn(m.conn);
    const a = this.currentA(comp, m, ways);
    const ph = this.phases(comp, m, ways);
    if (m.scope !== 'incomer' && !ways.length) out.push({ level: 'warn', text: m.scope === 'group' ? 'Pick the ways in the group' : 'Pick the way it measures' });
    if (m.scope === 'way' && ways.length > 1) out.push({ level: 'warn', text: `A circuit meter on ${ways.length} ways — make it a group` });
    if (m.scope === 'incomer' && !a) out.push({ level: 'info', text: 'The incomer rating is not known — set it on the single line or the board' });
    if (a && cn.max && a > cn.max) out.push({ level: 'warn', text: `${a.toFixed(0)} A is above the ${cn.max} A a direct meter takes — use CTs` });
    if (cn.ct && cn.sec) {
      const p = this.ctPrimary(m);
      if (!p) out.push({ level: 'warn', text: 'CT ratio not set' });
      else if (a && p < a) out.push({ level: 'warn', text: `CT ${p} A primary is below ${a.toFixed(0)} A` });
      else if (a && p > 4 * a) out.push({ level: 'info', text: `CT ${p} A is over four times ${a.toFixed(0)} A — accuracy at light load suffers` });
      const sec = parseFloat(String(m.ct_ratio || '').split('/')[1]);
      if (Number.isFinite(sec) && sec !== cn.sec) out.push({ level: 'warn', text: `CT secondary /${sec} A does not match a /${cn.sec} A meter input` });
    }
    if (ph === 'RWB' && m.system === '1P2W') out.push({ level: 'warn', text: this.isGroup(m) ? 'The ways span more than one phase — a three-phase meter is needed' : 'Three-phase circuit on a single-phase meter' });
    if (m.type === 'mid' && !/MID/.test(m.cls || '')) out.push({ level: 'info', text: 'A billing meter is usually MID class A, B or C' });
    if (m.type === 'pulse' && !['pulse', 'none'].includes(m.protocol)) out.push({ level: 'info', text: 'A pulse meter reports through a BMS input — protocol set to pulse is usual' });
    if (this.isGroup(m) && m.group_mode !== 'virtual' && ways.length) {
      const breakers = Math.max(...ways.map(w => Number(w.breaker_a) || 0));
      if (Number(m.iso_a) && breakers > Number(m.iso_a)) out.push({ level: 'warn', text: `Sub-bus isolator ${m.iso_a} A is below its largest way breaker (${breakers} A)` });
    }
    const pc = (project || this.projectChecks()).get(m.id);
    if (pc) out.push(...pc);
    return out;
  },

  boardWarnings(comp) {
    const pc = this.projectChecks();
    return this.list(comp).flatMap(m => this.warnings(comp, m, null, pc));
  },

  // An SLD meter's checks (shown in its properties and the meter schedule).
  sldWarnings(comp, project) {
    const p = comp.props || {};
    const out = [];
    const meas = p.measures ? AppState.components.get(p.measures) : null;
    if (!meas) out.push({ level: 'warn', text: 'Pick what it measures — the CT, breaker or cable it sits on' });
    const cn = this.conn(p.conn);
    if (meas && meas.type === 'ct' && !cn.ct) out.push({ level: 'warn', text: 'Measures through a CT but is set to a direct connection' });
    if (meas && meas.type === 'ct' && cn.sec) {
      const sec = parseFloat(String(meas.props.ratio || '').split('/')[1]);
      if (Number.isFinite(sec) && sec !== cn.sec) out.push({ level: 'warn', text: `CT ${meas.props.ratio} — its /${sec} A secondary does not match a /${cn.sec} A meter` });
      if (meas.props.ct_type === 'core_balance') out.push({ level: 'warn', text: 'A core-balance CT measures residual current, not energy' });
    }
    if (meas && meas.type !== 'ct' && cn.max) {
      const a = Number(meas.props.rated_current_a || meas.props.trip_rating_a || meas.props.rating_a) || 0;
      if (a > cn.max) out.push({ level: 'warn', text: `${meas.props.name || meas.id} is rated ${a} A — above the ${cn.max} A a direct meter takes` });
    }
    const pc = (project || this.projectChecks()).get(comp.id);
    if (pc) out.push(...pc);
    return out;
  },

  // ── Text ────────────────────────────────────────────────────────────
  spec(m) {
    const cn = this.conn(m.conn);
    const parts = [this.type(m.type).short, m.cls ? `cl ${m.cls}` : '', m.system || ''];
    parts.push(cn.ct ? `${m.conn === 'rogowski' ? 'Rogowski' : 'CT'} ${m.ct_ratio || '?'}${m.ct_class ? ' cl ' + m.ct_class : ''}` : cn.label.replace('Direct', 'direct'));
    return parts.filter(Boolean).join(' · ');
  },
  comms(m) {
    const pr = this.protocol(m.protocol);
    if (pr.bus === 'none') return 'Local display only';
    if (pr.bus === 'pulse') return `Pulse → ${m.gateway ? this.gatewayLabel(m.gateway) : 'BMS input'}${m.address ? ' ' + m.address : ''}`;
    const where = pr.bus === 'ip' ? (m.address || 'no IP') : `${m.network || 'network'} #${m.address || '?'}`;
    return `${pr.short} · ${where} → ${this.gatewayLabel(m.gateway)}`;
  },

  // ── BOQ ─────────────────────────────────────────────────────────────
  // One line per physical item: meters, their CTs, a sub-bus isolator.
  boqLines(comp) {
    const slug = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]+/g, '');
    const out = [];
    for (const m of this.list(comp)) {
      const n = this.count(comp, m);
      const cn = this.conn(m.conn);
      const pr = this.protocol(m.protocol);
      const desc = `Energy meter, ${this.type(m.type).short}, ${m.system || '3P4W'}, ${cn.ct ? (m.conn === 'rogowski' ? 'Rogowski' : `CT /${cn.sec} A`) : cn.label.replace('Direct', 'direct')}${pr.bus === 'none' ? '' : ', ' + pr.short}`;
      for (let i = 0; i < n; i++) out.push({ key: `MTR-${slug(m.type)}-${slug(m.system || '3P4W')}-${slug(m.conn)}-${slug(pr.v)}`, desc });
      if (cn.ct && m.ct_ratio) {
        const three = (m.system || '3P4W') !== '1P2W';
        const nCt = (three ? 3 : 1) * n;
        const what = m.conn === 'rogowski' ? 'Rogowski coil' : 'Measuring CT';
        for (let i = 0; i < nCt; i++) out.push({ key: `MTR-CT-${slug(m.ct_ratio)}-${slug(m.ct_class || '1')}`, desc: `${what} ${m.ct_ratio} A${m.ct_class ? ' cl ' + m.ct_class : ''}` });
      }
      if (this.isSubbus(m) && this.waysOf(comp, m).length) {
        out.push({ key: `MTR-SUBBUS-${m.iso_a || 63}A`, desc: `Metered sub-busbar with ${m.iso_a || 63} A isolator` });
      }
    }
    return out;
  },

  // ── Schedule section (and the drawing / phone side panel) ──────────
  render(comp, host, onChange, opts) {
    if (!host) return;
    opts = opts || {};
    if (!comp) { host.innerHTML = ''; return; }
    const e = escHtml;
    const list = this.list(comp);
    const pc = this.projectChecks();
    const panel = opts.mode === 'panel';
    let nWarn = 0;
    const tag = (m) => `<span class="dbm-tag${this.isGroup(m) ? ' grp' : ''}">${e(m.tag)}</span>`;
    const rows = list.map(m => {
      const ways = this.waysOf(comp, m);
      const w = this.warnings(comp, m, ways, pc);
      const bad = w.filter(x => x.level === 'warn');
      nWarn += bad.length;
      const scope = m.scope === 'group' ? `Group · ${ways.length} way${ways.length === 1 ? '' : 's'}${this.isVirtual(m) ? ' (Σ)' : ''}` : this.scope(m.scope).label;
      const check = bad.length
        ? `<span class="dbc-bad" title="${e(bad.map(x => x.text).join('\n'))}">⚠ ${e(bad[0].text)}</span>`
        : `<span class="dbc-ok" title="${e(w.map(x => x.text).join('\n'))}">✓ ${e(this.currentA(comp, m, ways) ? `${this.currentA(comp, m, ways).toFixed(0)} A` : 'OK')}${w.length ? ' ⓘ' : ''}</span>`;
      if (panel) {
        return `<div class="dbc-card${bad.length ? ' dbc-card-bad' : ''}">
          <div class="dbc-card-head">${tag(m)}<span>${e(scope)}</span><button type="button" class="btn-small" data-dbm-edit="${e(m.id)}">Edit</button></div>
          <div>${e(this.measuresText(comp, m, ways))}</div>
          <div class="dbc-dim">${e(this.spec(m))}</div>
          <div class="dbc-dim">${e(this.comms(m))}</div>
          ${bad.length ? `<div class="dbc-bad">⚠ ${e(bad[0].text)}</div>` : ''}</div>`;
      }
      return `<tr>
        <td>${tag(m)}</td>
        <td>${e(scope)}</td>
        <td>${e(this.measuresText(comp, m, ways))}${m.label && m.scope !== 'way' ? `<br><span class="dbc-dim">${e(m.label)}</span>` : ''}</td>
        <td>${e(this.spec(m))}${this.count(comp, m) > 1 ? `<br><span class="dbc-dim">${this.count(comp, m)} meters</span>` : ''}</td>
        <td>${e(this.mount(m.mount).label)}</td>
        <td>${e(this.comms(m))}</td>
        <td><span class="dbc-dim">${e(this.pointsOf(m).join(' · ') || '—')}</span></td>
        <td>${check}</td>
        <td class="dbc-act"><button type="button" class="btn-small" data-dbm-edit="${e(m.id)}" aria-label="Edit ${e(m.tag)}" title="Edit">✎</button><button type="button" class="btn-small" data-dbm-del="${e(m.id)}" aria-label="Remove ${e(m.tag)}" title="Remove">✕</button></td>
      </tr>`;
    }).join('');

    const metered = this.meteredShare(comp);
    const summary = list.length
      ? `${list.length} meter record${list.length === 1 ? '' : 's'}${metered != null ? ` · ${metered.toFixed(0)} % of the board's load metered` : ''}`
      : 'none';
    const hasInc = list.some(m => m.scope === 'incomer');
    const sel = !panel && typeof DBSchedule !== 'undefined' && DBSchedule._selected ? DBSchedule._selected.size : 0;
    const body = `<div class="dbc-body">
      <div class="dbc-bar">
        ${hasInc ? '' : '<button type="button" class="btn-small btn-primary" data-dbm="add-inc">+ Meter on incomer</button>'}
        <button type="button" class="btn-small${hasInc ? ' btn-primary' : ''}" data-dbm="add">+ Meter</button>
        ${sel ? `<button type="button" class="btn-small" data-dbm="add-sel" title="One meter for the ways ticked in the grid">+ Meter for ${sel} ticked way${sel === 1 ? '' : 's'}</button>` : ''}
        <button type="button" class="btn-small" data-dbm="schedule" title="Every meter in the project with its BMS points">Meter schedule…</button>
        <span class="dbc-dim">${e(summary)}</span>
      </div>
      ${list.length ? (panel ? `<div class="dbc-cards">${rows}</div>` : `<div class="dbc-table-wrap"><table class="dbc-table">
        <thead><tr><th>Tag</th><th>Scope</th><th>Measures</th><th>Meter</th><th>Mounting</th><th>BMS / control</th><th>Points</th><th>Check</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`)
        : `<div class="dba-empty">No meters yet. Meter the incomer, one circuit, or a group of circuits — tick ways in the grid and add one for them. Meters report to the BMS through a gateway on the single line, and appear on the board drawing and in the BOQ.</div>`}
    </div>`;

    if (panel) {
      host.innerHTML = `<div class="dba-panel dbc-panel dbm-scope"><div class="dba-head">Metering <span class="dba-count">${list.length}</span>
        ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn}</span>` : ''}</div>${body}</div>`;
    } else {
      host.innerHTML = `<details class="db-el-details dbc-details dbm-scope"${this._openSection ? ' open' : ''}>
        <summary>Metering <span class="db-el-count">${e(summary)}</span>
          ${nWarn ? `<span class="db-el-badge st-fail">⚠ ${nWarn} to check</span>` : ''}
          <span class="db-el-ref">Energy meters by circuit, group or incomer — and how they reach the BMS</span></summary>
        ${body}</details>`;
      const det = host.querySelector('details');
      if (det) det.addEventListener('toggle', () => { this._openSection = det.open; });
    }
    this._bind(comp, host, onChange);
  },

  // Share of the board's connected load measured by a meter (an incomer meter
  // measures it all). null with no load.
  meteredShare(comp) {
    const list = this.list(comp);
    if (!list.length) return null;
    if (list.some(m => m.scope === 'incomer')) return 100;
    const ways = comp.props.circuits || [];
    const tot = ways.reduce((s, c) => s + (Number(c.load_va) || 0), 0);
    if (!tot) return null;
    const met = ways.filter(c => this.wayMeter(comp, c)).reduce((s, c) => s + (Number(c.load_va) || 0), 0);
    return met / tot * 100;
  },

  _changed(onChange) {
    if (typeof DBSchedule !== 'undefined' && DBSchedule._notifyEdited) DBSchedule._notifyEdited();
    if (onChange) onChange();
  },

  _bind(comp, host, onChange) {
    host.querySelectorAll('[data-dbm]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.dbm;
      if (a === 'add-inc') this.edit(comp, this.newMeter(comp, 'incomer', []), { isNew: true, onSave: onChange });
      else if (a === 'add') this.edit(comp, this.newMeter(comp, 'way', []), { isNew: true, onSave: onChange });
      else if (a === 'add-sel') {
        const ways = (comp.props.circuits || []).filter(c => DBSchedule._selected.has(c.id));
        this.edit(comp, this.newMeter(comp, null, ways), { isNew: true, ways: ways.map(w => w.id), onSave: onChange });
      } else if (a === 'schedule') {
        if (typeof MeterSchedule !== 'undefined') MeterSchedule.open();
      }
    }));
    host.querySelectorAll('[data-dbm-edit]').forEach(b => b.addEventListener('click', () => {
      const m = this.meter(comp, b.dataset.dbmEdit);
      if (m) this.edit(comp, m, { onSave: onChange });
    }));
    host.querySelectorAll('[data-dbm-del]').forEach(b => b.addEventListener('click', () => {
      this.removeMeter(comp, b.dataset.dbmDel);
      this._afterSave(comp, { onSave: onChange });
    }));
  },

  _refreshSchedule(comp) {
    if (typeof DBSchedule !== 'undefined' && DBSchedule.body && DBSchedule.currentId === comp.id) DBSchedule.render();
  },

  _afterSave(comp, opts) {
    this._changed(opts && opts.onSave);
    this._refreshSchedule(comp);
    if (typeof SchMobile !== 'undefined' && SchMobile.comp && SchMobile.comp() === comp) SchMobile.refresh();
    if (typeof Canvas !== 'undefined' && Canvas.render) Canvas.render();
  },

  // ── Meter editor ────────────────────────────────────────────────────
  // Edits a copy; Save writes it and re-links the ways. opts: { isNew, ways: [way ids], onSave }.
  edit(comp, m0, opts) {
    opts = opts || {};
    const e = escHtml;
    const m = JSON.parse(JSON.stringify(m0));
    if (!Array.isArray(m.points)) m.points = this.pointsOf(m);
    const circuits = comp.props.circuits || [];
    const picked = new Set(opts.ways || circuits.filter(c => this.wayMeter(comp, c) === m0).map(c => c.id));
    const sized = { auto: !!opts.isNew };       // follow the suggestion until a size is typed

    const dlg = document.createElement('div');
    dlg.className = 'modal dbc-modal dbm-scope';
    dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'dbm-title');
    dlg.style.display = 'flex'; dlg.style.zIndex = '3000';
    document.body.appendChild(dlg);

    const pickedWays = () => circuits.filter(c => picked.has(c.id))
      .sort((a, b) => String(a.way ?? '').localeCompare(String(b.way ?? ''), undefined, { numeric: true }));
    const opt = (v, cur, label) => `<option value="${e(v)}"${String(v) === String(cur ?? '') ? ' selected' : ''}>${e(label ?? v)}</option>`;
    // Evaluate the working copy against a board view that has it, without touching the project.
    const draftWarnings = (ways) => {
      const ids = new Set(ways.map(w => w.id));
      const fake = { id: comp.id, type: comp.type, props: Object.assign({}, comp.props, {
        meters: this.list(comp).filter(x => x.id !== m.id).concat([m]),
        circuits: circuits.map(c => (ids.has(c.id) ? Object.assign({}, c, { meter: m.id })
          : (this.wayMeter(comp, c) === m0 ? Object.assign({}, c, { meter: '' }) : c))),
      }) };
      const pc = this.projectChecks();
      // The draft's own address / gateway, checked against everyone else's.
      const others = this.all().filter(r => r.id !== m.id);
      const mine = { addresses: this._addresses(m.address, m.scope === 'group' && m.group_mode === 'virtual' ? Math.max(1, ways.length) : 1) };
      const own = [];
      const key = this._segKey(m);
      if (key) for (const r of others) if (this._segKey(r) === key) for (const a of r.addresses) if (mine.addresses.includes(a)) own.push({ level: 'warn', text: `Address ${a} is also used by ${r.src === 'sld' ? r.tag : r.board + ' ' + r.tag}` });
      const bus = this.protocol(m.protocol).bus;
      if ((bus === 'rs485' || bus === 'mbus') && !m.gateway) own.push({ level: 'warn', text: `${this.protocol(m.protocol).short} meter with no gateway — the BMS will not read it` });
      pc.set(m.id, own);
      return this.warnings(fake, m, ways, pc);
    };

    const draw = () => {
      const ways = m.scope === 'incomer' ? [] : pickedWays();
      if (sized.auto) Object.assign(m, this.suggest(comp, m, ways));
      const sug = this.suggest(comp, m, ways);
      const a = this.currentA(comp, m, ways);
      const others = new Map();
      for (const c of circuits) { const o = this.wayMeter(comp, c); if (o && o.id !== m.id) others.set(c.id, o.tag); }
      const wayList = circuits.slice().sort((x, y) => String(x.way ?? '').localeCompare(String(y.way ?? ''), undefined, { numeric: true }))
        .map(c => `<label class="dbc-way${picked.has(c.id) ? ' on' : ''}"><input type="checkbox" data-dbm-way="${e(c.id)}"${picked.has(c.id) ? ' checked' : ''}>
          <b>${e(c.way ?? '')}</b> ${e(c.description || '—')} <span class="dbc-dim">${e(`${c.breaker_a || 0} A ${c.poles || '1P'} ${this._is3(c) ? 'RWB' : (c.phase || 'R')}`)}${others.has(c.id) ? ' · now ' + e(others.get(c.id)) : ''}</span></label>`).join('');
      const cn = this.conn(m.conn);
      const pr = this.protocol(m.protocol);
      const gws = this.gateways();
      const nets = this.networks();
      const warnList = draftWarnings(ways);
      const n = m.scope === 'group' && m.group_mode === 'virtual' ? Math.max(1, ways.length) : 1;
      const inc = typeof DBAccessories !== 'undefined' ? DBAccessories.incomer(comp) : null;
      const pts = MTR_POINTS.map(p => `<button type="button" class="dbm-pt${m.points.includes(p.k) ? ' on' : ''}" data-dbm-pt="${e(p.k)}" aria-pressed="${m.points.includes(p.k)}" title="${e(p.desc)}">${e(p.label)}</button>`).join('');
      const prefix = `${this._slug(comp.props.name || comp.id)}.${this._slug(m.tag)}`;
      const nPts = this.pointList(m, prefix, (m.system || '3P4W') !== '1P2W').length * n;

      dlg.innerHTML = `<div class="modal-content dbc-dialog">
        <div class="modal-header"><h3 id="dbm-title"><span class="dbm-tag${m.scope === 'group' ? ' grp' : ''}">${e(m.tag)}</span> Meter — ${e(comp.props.name || comp.id)}</h3>
          <button class="modal-close" data-dbm-x="cancel" aria-label="Close">&times;</button></div>
        <div class="dbc-dlg-body">
          <div class="dbc-grid2">
            <label>Tag <input type="text" data-mk="tag" value="${e(m.tag)}"></label>
            <label>Description <input type="text" data-mk="label" value="${e(m.label || '')}" placeholder="e.g. Lighting — ground floor"></label>
          </div>
          <fieldset><legend>What it measures</legend>
            <div class="dbc-arr">${MTR_SCOPES.map(s => `<div class="dbc-arr-opt${m.scope === s.v ? ' on' : ''}">
              <label><input type="radio" name="dbm-scope" value="${s.v}"${m.scope === s.v ? ' checked' : ''}><span>${e(s.label)}<small>${e(s.hint)}</small></span></label></div>`).join('')}</div>
            ${m.scope === 'incomer'
              ? `<div class="dbc-sug">Incomer ${e(inc && inc.device_label ? inc.device_label : (a ? a + ' A' : 'rating not known'))} — the whole board.</div>`
              : `<div class="dbc-ways">${wayList || '<span class="dbc-dim">This board has no ways yet.</span>'}</div>`}
            ${m.scope === 'group' ? `<div class="dbm-gm"><span class="dbm-gm-h">How the group is measured</span>
              <div class="dbc-arr dbm-arr2">${MTR_GROUP_MODES.map(g => `<div class="dbc-arr-opt${(m.group_mode || 'subbus') === g.v ? ' on' : ''}">
                <label><input type="radio" name="dbm-gm" value="${g.v}"${(m.group_mode || 'subbus') === g.v ? ' checked' : ''}><span>${e(g.label)}<small>${e(g.hint)}</small></span></label></div>`).join('')}</div>
              ${m.group_mode !== 'virtual' ? `<div class="dbc-grid4"><label>Sub-bus isolator (A) <select data-mk="iso_a">${MTR_ISO_RATINGS.map(r => opt(r, m.iso_a)).join('')}</select></label></div>` : ''}
            </div>` : ''}
          </fieldset>
          <fieldset><legend>Meter${n > 1 ? ` <span class="dbc-dim">· ${n} alike, one per way</span>` : ''}</legend>
            <div class="dbc-grid4">
              <label>Type <select data-mk="type">${MTR_TYPES.map(t => opt(t.v, m.type, t.label)).join('')}</select></label>
              <label>Accuracy class <select data-mk="cls">${MTR_CLASSES.map(c => opt(c, m.cls)).join('')}</select></label>
              <label>System <select data-mk="system">${MTR_SYSTEMS.map(s => opt(s.v, m.system, s.label)).join('')}</select></label>
              <label>Mounting <select data-mk="mount">${MTR_MOUNTS.map(x => opt(x.v, m.mount, x.label)).join('')}</select></label>
              <label>Connection <select data-mk="conn">${MTR_CONNS.map(x => opt(x.v, m.conn, x.label)).join('')}</select></label>
              <label>CT ratio <input type="text" data-mk="ct_ratio" value="${e(m.ct_ratio || '')}" placeholder="${cn.ct ? 'e.g. 200/5' : '—'}"${cn.ct ? '' : ' disabled'}></label>
              <label>CT class <input type="text" data-mk="ct_class" value="${e(m.ct_class || '')}" placeholder="${cn.ct ? 'e.g. 0.5S' : '—'}"${cn.ct ? '' : ' disabled'}></label>
              <label>Make / model <input type="text" data-mk="model" value="${e(m.model || '')}" placeholder="Optional"></label>
            </div>
            <div class="dbc-sug${sized.auto ? ' on' : ''}">${a
              ? `Suggested ${e(this.conn(sug.conn || m.conn).label.replace('Direct', 'direct').replace('CT-operated', 'CT-operated'))}${sug.ct_ratio ? ' · CT ' + e(sug.ct_ratio) : ''} · ${e(sug.system)} — ${e(m.scope === 'group' && m.group_mode !== 'virtual' ? `${a.toFixed(1)} A per phase on the sub-bus (diversified)` : m.scope === 'incomer' ? `incomer ${a} A` : `largest breaker ${a} A`)}.
                ${sized.auto ? '' : '<button type="button" class="btn-small" data-dbm-x="use-sug">Use it</button>'}`
              : (m.scope === 'incomer' ? 'The incomer rating is not known — set it on the single line or the board.' : 'Pick its ways for a suggested connection.')}</div>
          </fieldset>
          <fieldset><legend>BMS / control connection</legend>
            <div class="dbc-grid4">
              <label>Protocol <select data-mk="protocol">${MTR_PROTOCOLS.map(x => opt(x.v, m.protocol, x.label)).join('')}</select></label>
              ${pr.bus === 'none' ? '' : `
              ${pr.bus === 'ip' || pr.bus === 'pulse' ? '' : `<label>Network <input type="text" data-mk="network" value="${e(m.network || '')}" list="dbm-nets" placeholder="e.g. Loop A"><datalist id="dbm-nets">${nets.map(x => `<option value="${e(x)}">`).join('')}</datalist></label>`}
              <label>${pr.bus === 'ip' ? 'IP address' : pr.bus === 'pulse' ? 'BMS input' : n > 1 ? 'First address' : 'Address'} <input type="text" data-mk="address" value="${e(m.address || '')}" placeholder="${pr.bus === 'ip' ? 'e.g. 10.20.4.21' : pr.bus === 'pulse' ? 'e.g. DI-07' : '1–247'}"></label>
              <label>${pr.bus === 'ip' || pr.bus === 'pulse' ? 'Reports to' : 'Gateway → BMS'} <select data-mk="gateway">${opt('', m.gateway, '— none')}${opt('direct', m.gateway, 'BMS controller (direct)')}${gws.map(g => opt(g.id, m.gateway, g.props.name || g.id)).join('')}</select></label>`}
            </div>
            ${pr.bus === 'none' ? '' : `<div class="dbm-pts"><span class="dbc-dim">Points to the BMS</span>${pts}
              <span class="dbc-dim">${nPts} point${nPts === 1 ? '' : 's'} · named <code>${e(prefix)}.kWh</code></span></div>`}
            ${gws.length ? '' : '<div class="dbc-dim">Add a BMS Gateway on the single line (Instruments) to report RS-485 / M-Bus meters through it.</div>'}
          </fieldset>
          ${warnList.length ? `<div class="dbc-warns">${warnList.map(w => `<div class="dba-note ${e(w.level)}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${e(w.text)}</div>`).join('')}</div>` : ''}
          <div class="dbc-where"><div><small>Schedule</small>${m.scope === 'incomer' ? 'Incomer strip' : ways.length ? `Ways ${e(ways.map(w => w.way).join(', '))} show ${e(m.tag)}` : 'No ways'}</div>
            <div><small>Board drawing</small>${m.scope === 'incomer' ? 'On the incomer riser' : m.scope === 'group' && m.group_mode !== 'virtual' ? 'Sub-bus behind the meter' : 'On each way it measures'}</div>
            <div><small>BOQ</small>${n} meter${n === 1 ? '' : 's'}${cn.ct && m.ct_ratio ? ` + ${((m.system || '3P4W') !== '1P2W' ? 3 : 1) * n} CT${n > 1 || (m.system || '3P4W') !== '1P2W' ? 's' : ''}` : ''}${m.scope === 'group' && m.group_mode !== 'virtual' ? ' + sub-bus isolator' : ''}</div></div>
        </div>
        <div class="modal-footer dbc-foot">
          ${opts.isNew ? '' : '<button type="button" class="btn-small dbc-del" data-dbm-x="delete">Delete</button>'}
          <span style="flex:1"></span>
          <button type="button" class="btn-small" data-dbm-x="cancel">Cancel</button>
          <button type="button" class="btn-small btn-primary" data-dbm-x="save">${opts.isNew ? 'Add meter' : 'Save'}</button>
        </div></div>`;
    };
    draw();

    const finish = () => { document.removeEventListener('keydown', onKey, true); dlg.remove(); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); finish(); } };
    document.addEventListener('keydown', onKey, true);

    dlg.addEventListener('change', (ev) => {
      const t = ev.target;
      if (t.name === 'dbm-scope') {
        m.scope = t.value;
        if (m.scope === 'incomer') { picked.clear(); if (m.mount === 'din') m.mount = 'door96'; }
        sized.auto = true;
        draw(); return;
      }
      if (t.name === 'dbm-gm') { m.group_mode = t.value; sized.auto = true; draw(); return; }
      if (t.dataset.dbmWay) {
        if (t.checked) picked.add(t.dataset.dbmWay); else picked.delete(t.dataset.dbmWay);
        if (picked.size > 1 && m.scope === 'way') m.scope = 'group';
        if (!m.label) { const w = pickedWays()[0]; if (w) m.label = String(w.description || '').trim(); }
        draw(); return;
      }
      const k = t.dataset.mk;
      if (!k) return;
      if (k === 'type') {
        m.type = t.value;
        const ty = this.type(m.type);
        m.points = ty.points.slice();
        m.cls = ty.cls;
        if (m.type === 'pulse') m.protocol = 'pulse';
        else if (m.protocol === 'pulse') m.protocol = 'modbus_rtu';
      } else if (k === 'conn' || k === 'ct_ratio' || k === 'system') { m[k] = t.value; sized.auto = false; }
      else if (k === 'iso_a') m.iso_a = Number(t.value);
      else if (k === 'protocol') {
        const was = this.protocol(m.protocol).bus;
        m.protocol = t.value;
        const now = this.protocol(m.protocol).bus;
        if (was !== now) { m.address = now === 'ip' || now === 'pulse' || now === 'none' ? '' : String(this.nextAddress(m)); if (now !== 'ip' && now !== 'pulse' && !m.network) m.network = this._defaultNetwork(); }
      } else if (k === 'network' || k === 'gateway') {
        m[k] = t.value;
        if (/^\d*$/.test(String(m.address || ''))) m.address = String(this.nextAddress(m));
      } else m[k] = t.value;
      draw();
    });
    dlg.addEventListener('click', (ev) => {
      if (ev.target === dlg) return finish();
      const pb = ev.target.closest('[data-dbm-pt]');
      if (pb) {
        const k = pb.dataset.dbmPt;
        m.points = m.points.includes(k) ? m.points.filter(x => x !== k) : MTR_POINTS.map(p => p.k).filter(x => x === k || m.points.includes(x));
        draw(); return;
      }
      const b = ev.target.closest('[data-dbm-x]');
      if (!b) return;
      const a = b.dataset.dbmX;
      if (a === 'cancel') return finish();
      if (a === 'use-sug') { sized.auto = true; draw(); return; }
      if (a === 'delete') {
        this.removeMeter(comp, m.id);
        finish();
        this._afterSave(comp, opts);
        return;
      }
      if (a === 'save') {
        const d = this.data(comp);
        const tag = String(m.tag || '').trim() || this._nextTag(d.map(x => x.tag), 'M');
        if (d.some(x => x.id !== m.id && String(x.tag).toLowerCase() === tag.toLowerCase())) {
          if (typeof UI !== 'undefined' && UI.toast) UI.toast(`${tag} is already used on this board.`, 'warning');
          return;
        }
        m.tag = tag;
        if (m.scope !== 'group') delete m.iso_a;
        if (m.scope === 'incomer') picked.clear();
        const i = d.findIndex(x => x.id === m.id);
        if (i >= 0) d[i] = m; else d.push(m);
        for (const c of circuits) {
          if (picked.has(c.id)) c.meter = m.id;
          else if (this.wayMeter(comp, c) === m0 || c.meter === m.id) delete c.meter;
        }
        finish();
        this._afterSave(comp, opts);
      }
    });
  },
};

// ── Project meter schedule + BMS points list (Quantities ▸ Meter schedule) ──
const MeterSchedule = {
  sel: null,

  rows() {
    const pc = DBMeters.projectChecks();
    return DBMeters.all().map(r => {
      const warns = r.src === 'sld' ? DBMeters.sldWarnings(r.comp, pc)
        : DBMeters.warnings(r.comp, r.m, null, pc);
      return Object.assign({}, r, { warns });
    }).sort((a, b) => (a.src === b.src ? 0 : a.src === 'sld' ? -1 : 1)
      || String(a.board).localeCompare(String(b.board), undefined, { numeric: true })
      || String(a.tag).localeCompare(String(b.tag), undefined, { numeric: true }));
  },

  // BMS points of one row: virtual groups expand to a point set per way meter
  // plus the summed total. Instance numbers are a suggestion (address × 100 +
  // point), not anything read from a meter.
  points(r) {
    const three = (r.system || '3P4W') !== '1P2W';
    const m = { points: r.points };
    const pr = DBMeters.protocol(r.protocol);
    if (pr.bus === 'none') return [];
    const out = [];
    const base = (addr) => (parseInt(addr, 10) || 0) * 100;
    if (r.count > 1) {
      const ways = DBMeters.waysOf(r.comp, r.m);
      ways.forEach((w, i) => {
        const sub = `${r.prefix}${String.fromCharCode(97 + (i % 26))}`;
        DBMeters.pointList(m, sub, DBMeters._is3(w)).forEach((p, j) => out.push(Object.assign(p, { meter: `${r.tag}${String.fromCharCode(97 + (i % 26))} · way ${w.way}`, inst: r.addresses[i] ? `${p.obj} ${base(r.addresses[i]) + j + 1}` : '' })));
      });
      out.push({ name: `${r.prefix}.kWh`, desc: `Total of ${ways.length} meters (BMS sum)`, unit: 'kWh', obj: 'AV', meter: `${r.tag} total`, inst: '' });
      return out;
    }
    return DBMeters.pointList(m, r.prefix, three).map((p, j) => Object.assign(p, { meter: r.tag, inst: r.addresses[0] && /^\d+$/.test(r.addresses[0]) ? `${p.obj} ${base(r.addresses[0]) + j + 1}` : '' }));
  },

  open() {
    this._ensureDom();
    const m = document.getElementById('meters-modal');
    m.style.display = 'flex';
    this.render();
  },
  close() { const m = document.getElementById('meters-modal'); if (m && !m.classList.contains('q-docked')) m.style.display = 'none'; },

  _ensureDom() {
    if (document.getElementById('meters-modal')) return;
    const I = (p, s = 16) => Rates._icon(p, s);
    const I_M = I('<circle cx="8" cy="9" r="5"/><path d="M8 9l2.5-2.5M6 2.5h4"/>', 18);
    const I_DOWN = I('<path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10"/>', 14);
    const m = document.createElement('div');
    m.id = 'meters-modal';
    m.className = 'modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'ms-title');
    m.style.display = 'none';
    m.innerHTML = `
    <div class="modal-content rt-dialog cs-dialog ms-dialog">
      <header class="rt-head">
        <span class="rt-mark ms-mark">${I_M}</span>
        <div class="rt-head-text"><h3 id="ms-title">Meter schedule</h3><div class="rt-head-sub" id="ms-sub"></div></div>
        <span class="rt-tag">Every meter on the single line and in the boards, with its BMS points</span>
        <button class="modal-close" data-ms="close" aria-label="Close">&times;</button>
      </header>
      <main class="rt-main">
        <div class="ms-stats" id="ms-stats"></div>
        <div class="ms-split">
          <div class="ms-list" id="ms-list"></div>
          <aside class="ms-side" id="ms-side" aria-label="BMS points"></aside>
        </div>
      </main>
      <footer class="rt-foot">
        <span class="rt-note-i">Point instance numbers are suggested (address × 100 + point) — check them against the meter's register map</span>
        <span class="rt-grow"></span>
        <button type="button" class="rt-btn" data-ms="csv">${I_DOWN}Points CSV</button>
        <button type="button" class="rt-btn primary" data-ms="xlsx">${I_DOWN}Excel</button>
      </footer>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ms]');
      if (!b) { if (e.target === m) this.close(); return; }
      const a = b.dataset.ms;
      if (a === 'close') this.close();
      else if (a === 'pick') { this.sel = b.dataset.id; this.render(); }
      else if (a === 'csv') this.exportCsv();
      else if (a === 'xlsx') this.exportXlsx();
      else if (a === 'goto') this._goto(b.dataset.id);
    });
    m.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.close(); } });
  },

  // Open the meter where it lives: a board's schedule, or select it on the SLD.
  _goto(id) {
    const r = DBMeters.all().find(x => x.id === id);
    if (!r) return;
    if (r.src === 'sld') {
      if (typeof window.switchWorkspace === 'function') window.switchWorkspace('sld');
      AppState.select(r.comp.id);
      if (typeof Canvas !== 'undefined') { Canvas.render(); if (Canvas.centerOnComponent) Canvas.centerOnComponent(r.comp.id); }
      if (typeof Properties !== 'undefined' && Properties.show) Properties.show(r.comp.id);
    } else {
      DBMeters.edit(r.comp, r.m, {});
    }
  },

  render() {
    const m = document.getElementById('meters-modal');
    if (!m) return;
    const e = escHtml;
    const rows = this.rows();
    m.querySelector('#ms-sub').textContent = AppState.projectName || 'Untitled project';
    if (!rows.find(r => r.id === this.sel)) this.sel = rows[0] ? rows[0].id : null;
    const n = rows.reduce((s, r) => s + r.count, 0);
    const pts = rows.reduce((s, r) => s + this.points(r).length, 0);
    const bad = rows.filter(r => r.warns.some(w => w.level === 'warn')).length;
    const gws = DBMeters.gateways().length;
    const stat = (label, value, sub, cls) => `<div class="ms-stat${cls ? ' ' + cls : ''}"><span>${e(label)}</span><b>${e(value)}</b><small>${e(sub)}</small></div>`;
    m.querySelector('#ms-stats').innerHTML = rows.length
      ? stat('Meters', String(n), `${rows.filter(r => r.src === 'sld').length} on the single line · ${rows.filter(r => r.src === 'board').reduce((s, r) => s + r.count, 0)} in boards`)
        + stat('BMS points', String(pts), `through ${gws} gateway${gws === 1 ? '' : 's'}`)
        + stat('To check', String(bad), bad ? 'meters with a warning' : 'all clear', bad ? 'bad' : 'ok')
      : '';
    const list = m.querySelector('#ms-list');
    if (!rows.length) {
      list.innerHTML = `<div class="csz-empty">No meters yet. Add an Energy Meter on the single line (Instruments), or meters in a board's schedule — the Metering section under the grid.</div>`;
      m.querySelector('#ms-side').innerHTML = '';
      return;
    }
    list.innerHTML = `<table class="ms-table"><thead><tr><th>Tag</th><th>Where</th><th>Measures</th><th>Meter</th><th>CT</th><th>Comms</th><th class="num">Pts</th><th>Check</th></tr></thead><tbody>
      ${rows.map(r => {
        const w = r.warns.filter(x => x.level === 'warn');
        const pr = DBMeters.protocol(r.protocol);
        return `<tr class="${r.id === this.sel ? 'on' : ''}${w.length ? ' bad' : ''}" data-ms="pick" data-id="${e(r.id)}" tabindex="0">
          <td><span class="dbm-tag${r.src === 'board' && DBMeters.isGroup(r.m) ? ' grp' : ''}">${e(r.tag)}</span></td>
          <td>${e(r.board)}</td>
          <td>${e(r.what)}</td>
          <td>${e(DBMeters.type(r.type).short)}${r.cls ? ' · ' + e(r.cls) : ''}${r.count > 1 ? ` <span class="dbc-dim">× ${r.count}</span>` : ''}</td>
          <td>${e(r.ct_ratio || (DBMeters.conn(r.conn).max ? 'direct' : '—'))}</td>
          <td>${e(pr.bus === 'none' ? 'Local' : `${pr.short}${pr.bus === 'ip' ? ' ' + (r.address || '') : pr.bus === 'pulse' ? '' : ` · ${r.network || '?'} #${r.address || '?'}`}`)}<br><span class="dbc-dim">→ ${e(DBMeters.gatewayLabel(r.gateway))}</span></td>
          <td class="num">${this.points(r).length}</td>
          <td>${w.length ? `<span class="dbc-bad" title="${e(w.map(x => x.text).join('\n'))}">⚠ ${e(w[0].text)}</span>` : '<span class="dbc-ok">✓</span>'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
    list.querySelectorAll('tr[data-ms="pick"]').forEach(tr => tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.sel = tr.dataset.id; this.render(); }
    }));
    const r = rows.find(x => x.id === this.sel);
    const P = r ? this.points(r) : [];
    m.querySelector('#ms-side').innerHTML = r ? `
      <div class="ms-side-head"><span class="dbm-tag">${e(r.tag)}</span><strong>${e(r.board)}</strong>
        <button type="button" class="btn-small" data-ms="goto" data-id="${e(r.id)}">${r.src === 'sld' ? 'Show on single line' : 'Edit meter'}</button></div>
      <div class="dbc-dim">${e(r.what)} · ${e(DBMeters.comms(r))}</div>
      ${r.warns.length ? `<div class="ms-warns">${r.warns.map(w => `<div class="dba-note ${e(w.level)}">${w.level === 'warn' ? '⚠' : 'ⓘ'} ${e(w.text)}</div>`).join('')}</div>` : ''}
      ${P.length ? `<table class="ms-table ms-pts"><thead><tr><th>Point</th><th>Unit</th><th>Object</th><th>Description</th></tr></thead><tbody>
        ${P.map(p => `<tr><td><code>${e(p.name)}</code></td><td>${e(p.unit)}</td><td>${e(p.inst || p.obj)}</td><td>${e(p.desc)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="csz-empty">No BMS points — the meter is local only.</div>'}` : '';
  },

  _scheduleAoa() {
    const head = ['Tag', 'Where', 'Measures', 'Type', 'Class', 'System', 'Quantity', 'Connection', 'CT ratio', 'Mounting', 'Protocol', 'Network', 'Address', 'Gateway', 'Points', 'Check'];
    return [head, ...this.rows().map(r => [r.tag, r.board, r.what, DBMeters.type(r.type).label, r.cls || '', r.system || '', r.count,
      DBMeters.conn(r.conn).label, r.ct_ratio || '', r.src === 'board' ? DBMeters.mount(r.m.mount).label : '',
      DBMeters.protocol(r.protocol).label, r.network || '', r.address || '', DBMeters.gatewayLabel(r.gateway),
      this.points(r).length, r.warns.filter(w => w.level === 'warn').map(w => w.text).join('; ')])];
  },
  _pointsAoa() {
    const out = [['Point', 'Meter', 'Where', 'Description', 'Unit', 'Object', 'Protocol', 'Network', 'Address', 'Gateway']];
    for (const r of this.rows()) {
      for (const p of this.points(r)) {
        out.push([p.name, p.meter, r.board, p.desc, p.unit, p.inst || p.obj, DBMeters.protocol(r.protocol).short, r.network || '', r.address || '', DBMeters.gatewayLabel(r.gateway)]);
      }
    }
    return out;
  },
  _fname(ext, what) { return `${(AppState.projectName || 'project').replace(/[^\w-]+/g, '_')}_${what}.${ext}`; },

  exportCsv() {
    const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + this._pointsAoa().map(r => r.map(cell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = this._fname('csv', 'bms_points');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  exportXlsx() {
    if (typeof XLSX === 'undefined') { UI.toast('The Excel library did not load. Export CSV instead.', 'error'); return; }
    const wb = XLSX.utils.book_new();
    const s1 = XLSX.utils.aoa_to_sheet(this._scheduleAoa());
    s1['!cols'] = [8, 16, 30, 24, 8, 8, 8, 18, 10, 18, 20, 10, 12, 16, 7, 40].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, s1, 'Meter schedule');
    const s2 = XLSX.utils.aoa_to_sheet(this._pointsAoa());
    s2['!cols'] = [30, 14, 16, 26, 7, 10, 14, 10, 12, 16].map(wch => ({ wch }));
    XLSX.utils.book_append_sheet(wb, s2, 'BMS points');
    XLSX.writeFile(wb, this._fname('xlsx', 'meter_schedule'));
  },
};
