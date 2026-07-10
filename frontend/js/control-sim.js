// Control circuit simulation (IEC 60617 schematic components).
//
// Model: every control device is a two-terminal series element. A load
// (coil, lamp) is energized iff its two terminals reach the L and N
// terminals of the same control supply through wires and CLOSED contacts.
// Contacts bind to coils by tag: `ctl_contact_no` with tag "K1" closes
// while coil K1 is energized. Evaluation iterates to a fixed point so
// seal-in circuits resolve; a circuit that never settles (e.g. a relay
// wired through its own NC contact) is flagged as oscillating and frozen
// at its last state. Timer coils (on/off-delay) update on a 200 ms tick.
//
// Simulation is fully transient: maintained-switch positions are restored
// when the simulation stops, and nothing is written to the project.

const ControlSim = {
  active: false,
  _held: new Set(),          // momentary pushbuttons currently pressed
  _coilOut: new Map(),       // tag -> boolean (contact-driving output)
  _timers: new Map(),        // tag -> {input, out, since}
  _savedSwitchStates: new Map(),
  _liveWires: new Set(),
  _oscillating: false,
  _interval: null,

  CONDUCTOR_TYPES: new Set(['ctl_pb_no', 'ctl_pb_nc', 'ctl_switch',
                            'ctl_breaker', 'ctl_contact_no', 'ctl_contact_nc']),
  LOAD_TYPES: new Set(['ctl_coil', 'ctl_lamp']),

  init() {
    const svg = document.getElementById('sld-canvas');
    // Pointer events (mouse AND touch), capture phase so simulation presses
    // never start a drag/selection in the canvas pipeline
    svg.addEventListener('pointerdown', (e) => this._onMouseDown(e), true);
    window.addEventListener('pointerup', () => this._onMouseUp(), true);
    window.addEventListener('pointercancel', () => this._onMouseUp(), true);
    document.addEventListener('keydown', (e) => {
      if (this.active && e.key === 'Escape') { this.stop(); e.stopPropagation(); }
    }, true);
  },

  toggle() { this.active ? this.stop() : this.start(); },

  start() {
    const comps = [...AppState.components.values()];
    if (!comps.some(c => c.type === 'ctl_supply')) {
      UI.toast('Add a Control Supply and control components first.', 'warning');
      return;
    }
    this.active = true;
    this._held.clear();
    this._coilOut.clear();
    this._timers.clear();
    this._oscillating = false;
    this._savedSwitchStates.clear();
    for (const c of comps) {
      if (c.type === 'ctl_switch' || c.type === 'ctl_breaker') {
        this._savedSwitchStates.set(c.id, c.props.state);
      }
    }
    this._interval = setInterval(() => this._tick(), 200);
    this.evaluate();
    this.render();
    document.getElementById('status-info').textContent =
      'Control simulation ACTIVE — hold pushbuttons / click switches to operate. Esc to exit.';
    const btn = document.getElementById('btn-control-sim');
    if (btn) btn.classList.add('active');
  },

  stop() {
    this.active = false;
    clearInterval(this._interval);
    this._interval = null;
    this._held.clear();
    // Restore maintained-switch positions changed during the simulation
    let changed = false;
    for (const [id, state] of this._savedSwitchStates) {
      const c = AppState.components.get(id);
      if (c && c.props.state !== state) { c.props.state = state; changed = true; }
    }
    this._savedSwitchStates.clear();
    this._clearHighlights();
    if (changed) Canvas.render();
    document.getElementById('status-info').textContent = 'Control simulation stopped.';
    const btn = document.getElementById('btn-control-sim');
    if (btn) btn.classList.remove('active');
  },

  // ── Interaction ──

  _onMouseDown(e) {
    if (!this.active) return;
    const g = e.target.closest('.sld-component');
    if (!g) return;
    const comp = AppState.components.get(g.dataset.id);
    if (!comp) return;
    if (comp.type === 'ctl_pb_no' || comp.type === 'ctl_pb_nc') {
      this._held.add(comp.id);
    } else if (comp.type === 'ctl_switch' || comp.type === 'ctl_breaker') {
      // No Canvas.render() here: rebuilding the DOM would kill the CSS
      // swing transition — the ctl-open/ctl-closed classes carry the visual.
      comp.props.state = comp.props.state === 'closed' ? 'open' : 'closed';
    } else {
      return; // not a control operator — let normal canvas handling run
    }
    e.stopPropagation();
    e.preventDefault();
    this.evaluate();
    this.render();
  },

  _onMouseUp() {
    if (!this.active || this._held.size === 0) return;
    this._held.clear();
    this.evaluate();
    this.render();
  },

  // ── Evaluation ──

  _contactClosed(comp) {
    switch (comp.type) {
      case 'ctl_pb_no': return this._held.has(comp.id);
      case 'ctl_pb_nc': return !this._held.has(comp.id);
      case 'ctl_switch': {
        const closed = comp.props.state === 'closed';
        return comp.props.contact_type === 'nc' ? !closed : closed;
      }
      case 'ctl_breaker': return comp.props.state === 'closed';
      case 'ctl_contact_no': return !!this._coilOut.get(comp.props.tag);
      case 'ctl_contact_nc': return !this._coilOut.get(comp.props.tag);
      default: return false;
    }
  },

  // Union-find over "componentId:portId" nodes: wires always conduct,
  // closed two-terminal contacts bridge their own terminals.
  _buildNets() {
    const parent = new Map();
    const find = (x) => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r);
      let c = x;
      while (parent.get(c) !== c) { const n = parent.get(c); parent.set(c, r); c = n; }
      return r;
    };
    const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
    const union = (a, b) => { ensure(a); ensure(b); parent.set(find(a), find(b)); };

    for (const w of AppState.wires.values()) {
      union(`${w.fromComponent}:${w.fromPort}`, `${w.toComponent}:${w.toPort}`);
    }
    for (const c of AppState.components.values()) {
      if (this.CONDUCTOR_TYPES.has(c.type) && this._contactClosed(c)) {
        union(`${c.id}:top`, `${c.id}:bottom`);
      }
    }
    return { find, has: (x) => parent.has(x) };
  },

  // One fixed-point evaluation of coil/lamp energization from the current
  // contact states. Returns per-component energization and live nets.
  evaluate() {
    const comps = [...AppState.components.values()];
    const supplies = comps.filter(c => c.type === 'ctl_supply');
    const loads = comps.filter(c => this.LOAD_TYPES.has(c.type));

    // Non-timer coil outputs follow energization instantly, so iterate;
    // timer outputs only change on the tick.
    let energized = new Map();
    let stable = false;
    for (let i = 0; i < 30 && !stable; i++) {
      const nets = this._buildNets();
      const supplyNets = supplies.map(s => ({
        l: nets.has(`${s.id}:l`) ? nets.find(`${s.id}:l`) : null,
        n: nets.has(`${s.id}:n`) ? nets.find(`${s.id}:n`) : null,
      })).filter(s => s.l !== null && s.n !== null && s.l !== s.n);

      energized = new Map();
      for (const load of loads) {
        const a = nets.has(`${load.id}:top`) ? nets.find(`${load.id}:top`) : null;
        const b = nets.has(`${load.id}:bottom`) ? nets.find(`${load.id}:bottom`) : null;
        const on = a !== null && b !== null && a !== b && supplyNets.some(s =>
          (a === s.l && b === s.n) || (a === s.n && b === s.l));
        energized.set(load.id, on);
      }

      stable = true;
      for (const load of loads) {
        if (load.type !== 'ctl_coil') continue;
        const tag = load.props.tag;
        if (!tag) continue;
        const type = load.props.coil_type || 'contactor';
        if (type === 'timer_on' || type === 'timer_off') {
          // Timer input recorded for the tick; output unchanged here
          const t = this._timers.get(tag) || { input: false, out: false, since: 0 };
          t.input = energized.get(load.id);
          this._timers.set(tag, t);
          if (this._coilOut.get(tag) !== !!t.out) {
            this._coilOut.set(tag, !!t.out);
            stable = false;
          }
        } else if (!!this._coilOut.get(tag) !== !!energized.get(load.id)) {
          this._coilOut.set(tag, !!energized.get(load.id));
          stable = false;
        }
      }
    }
    this._oscillating = !stable;

    // Live-wire highlighting: nets reachable from any supply L terminal
    const nets = this._buildNets();
    const liveRoots = new Set();
    for (const s of supplies) {
      if (nets.has(`${s.id}:l`)) liveRoots.add(nets.find(`${s.id}:l`));
    }
    this._liveWires.clear();
    for (const w of AppState.wires.values()) {
      const fromComp = AppState.components.get(w.fromComponent);
      const toComp = AppState.components.get(w.toComponent);
      if (!fromComp || !toComp) continue;
      if (!CONTROL_TYPES.has(fromComp.type) || !CONTROL_TYPES.has(toComp.type)) continue;
      if (liveRoots.has(nets.find(`${w.fromComponent}:${w.fromPort}`))) {
        this._liveWires.add(w.id);
      }
    }
    this._energized = energized;
  },

  _tick() {
    if (!this.active) return;
    const now = performance.now();
    let changed = false;
    for (const [tag, t] of this._timers) {
      const delayMs = 1000 * this._timerDelay(tag);
      if (t.input && !t._wasInput) t.since = now;         // rising edge
      if (!t.input && t._wasInput) t.since = now;         // falling edge
      t._wasInput = t.input;
      let out = t.out;
      const type = this._timerType(tag);
      if (type === 'timer_on') {
        out = t.input && (now - t.since >= delayMs);
      } else if (type === 'timer_off') {
        out = t.input || (t.out && now - t.since < delayMs);
      }
      if (out !== t.out) { t.out = out; changed = true; }
    }
    if (changed) this.evaluate();
    this.render(); // cheap; also repairs highlights after any canvas re-render
  },

  _timerCoil(tag) {
    for (const c of AppState.components.values()) {
      if (c.type === 'ctl_coil' && c.props.tag === tag) return c;
    }
    return null;
  },
  _timerDelay(tag) {
    const c = this._timerCoil(tag);
    return c ? (parseFloat(c.props.delay_s) || 1) : 1;
  },
  _timerType(tag) {
    const c = this._timerCoil(tag);
    return c ? c.props.coil_type : 'contactor';
  },

  // ── Rendering ──

  render() {
    if (!this.active) return;
    const svg = document.getElementById('sld-canvas');
    for (const c of AppState.components.values()) {
      if (!CONTROL_TYPES.has(c.type)) continue;
      const g = svg.querySelector(`.sld-component[data-id="${c.id}"]`);
      if (!g) continue;
      g.classList.toggle('ctl-energized',
        this.LOAD_TYPES.has(c.type) && !!(this._energized && this._energized.get(c.id)));
      const isConductor = this.CONDUCTOR_TYPES.has(c.type);
      const closed = isConductor && this._contactClosed(c);
      g.classList.toggle('ctl-closed', closed);
      g.classList.toggle('ctl-open', isConductor && !closed);
      g.classList.toggle('ctl-actuated', this._held.has(c.id));
    }
    for (const w of AppState.wires.values()) {
      const el = svg.querySelector(`.sld-wire[data-id="${w.id}"]`);
      if (el) el.classList.toggle('ctl-live', this._liveWires.has(w.id));
    }
    if (this._oscillating) {
      document.getElementById('status-info').textContent =
        '⚠ Control circuit is oscillating (unstable feedback) — check contacts wired against their own coil.';
    }
  },

  _clearHighlights() {
    const svg = document.getElementById('sld-canvas');
    svg.querySelectorAll('.ctl-energized, .ctl-closed, .ctl-open, .ctl-actuated').forEach(el =>
      el.classList.remove('ctl-energized', 'ctl-closed', 'ctl-open', 'ctl-actuated'));
    svg.querySelectorAll('.ctl-live').forEach(el => el.classList.remove('ctl-live'));
  },
};
