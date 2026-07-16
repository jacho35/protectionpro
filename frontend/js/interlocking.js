// Circuit-Breaker Interlocking Logic builder (boolean-gate diagram + simulator).
//
// A dedicated workspace (4th tab) where the user wires boolean logic gates
// (AND/OR/NOT/NAND/NOR/XOR) between INPUTS and OUTPUTS to express breaker
// interlocking rules:
//   • INPUTS  — a real circuit breaker's live position (props.state closed=TRUE)
//               or a manually-defined signal (key switch, maintenance, SCADA).
//   • GATES   — boolean logic, distinctive IEEE/IEC shapes.
//   • OUTPUTS — block/allow close permissive, trip command, alarm/indication,
//               or an interlock-violation flag (a state that must never occur).
//
// The logic diagram persists with the project (AppState.interlockLogic). It is
// evaluated by a memoized depth-first walk of the DAG with cycle detection.
// Three ways to SIMULATE:
//   1. Interactive — toggle each input, watch gates/wires/outputs update live.
//   2. Conflict check — sweep every 2^n input combination and report any that
//      raises a violation flag (proves e.g. two sources can never be paralleled).
//   3. From live SLD — read the breakers' current open/closed positions and
//      evaluate the logic against the present network configuration.
//
// Nothing here mutates the SLD; "From live SLD" only READS breaker states.

const Interlocking = {
  _active: false,
  _built: false,
  _sim: false,              // interactive simulation mode on/off
  _selected: null,          // selected node id
  _selectedLink: null,      // selected link id
  _drag: null,              // {id, ox, oy} while dragging a node
  _pending: null,           // {fromNode, x, y} while dragging a new wire
  _values: {},              // nodeId -> boolean (last evaluation)
  _manual: {},              // input nodeId -> boolean (interactive sim state)
  _cycle: false,            // last evaluation hit a feedback loop
  _svg: null,

  GATE_OPS: ['AND', 'OR', 'NOT', 'NAND', 'NOR', 'XOR'],
  OUTPUT_TYPES: {
    block_close: { label: 'Block close', color: '#e67e22', tag: 'BLOCK' },
    trip:        { label: 'Trip command', color: '#e74c3c', tag: 'TRIP' },
    alarm:       { label: 'Alarm / indication', color: '#f1c40f', tag: 'ALARM' },
    violation:   { label: 'Interlock violation', color: '#c0392b', tag: '⚠ VIOLATION' },
  },

  // ── Model ────────────────────────────────────────────────────────────
  _model() {
    if (!AppState.interlockLogic || typeof AppState.interlockLogic !== 'object') {
      AppState.interlockLogic = { nodes: [], links: [] };
    }
    const m = AppState.interlockLogic;
    if (!Array.isArray(m.nodes)) m.nodes = [];
    if (!Array.isArray(m.links)) m.links = [];
    return m;
  },
  _node(id) { return this._model().nodes.find(n => n.id === id) || null; },
  _newId(prefix) {
    // Timestamp+counter id; avoids Date collisions across rapid adds.
    this._seq = (this._seq || 0) + 1;
    return `il_${prefix}_${Date.now()}_${this._seq}`;
  },

  // Circuit breakers (and switches) available on the SLD as input sources.
  _breakers() {
    const out = [];
    for (const c of AppState.components.values()) {
      if (c.type === 'cb' || c.type === 'switch') {
        out.push({ id: c.id, name: c.props?.name || c.id, type: c.type });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  },

  // ── Lifecycle ──────────────────────────────────────────────────────────
  init() {
    // Delete key while the workspace is active removes the selection.
    document.addEventListener('keydown', (e) => {
      if (!this._active) return;
      if (e.target.matches && e.target.matches('input,select,textarea')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this._selected) { this._removeNode(this._selected); e.preventDefault(); }
        else if (this._selectedLink) { this._removeLink(this._selectedLink); e.preventDefault(); }
      } else if (e.key === 'Escape') {
        this._pending = null; this._selected = null; this._selectedLink = null; this.render();
      }
    }, true);
  },

  activate() {
    this._active = true;
    if (!this._built) this.buildDOM();
    this._built = true;
    this._selected = null; this._selectedLink = null; this._pending = null;
    this._sim = false;
    this.evaluate();
    this.render();
    this.renderInspector();
  },

  deactivate() {
    this._active = false;
    this._stopSim();
  },

  onProjectChanged() {
    // A project load/reset replaced AppState.interlockLogic — refresh if visible.
    this._selected = null; this._selectedLink = null; this._pending = null;
    if (this._active) { this.evaluate(); this.render(); this.renderInspector(); }
  },

  // ── DOM ────────────────────────────────────────────────────────────────
  buildDOM() {
    const ws = document.getElementById('interlock-workspace');
    if (!ws) return;
    ws.innerHTML = `
      <div class="il-toolbar">
        <span class="il-title">Circuit-Breaker Interlocking</span>
        <span class="il-sep"></span>
        <button class="il-btn" id="il-add-input-cb">+ CB input</button>
        <button class="il-btn" id="il-add-input-manual">+ Manual input</button>
        <span class="il-gate-adds">
          <button class="il-btn il-gate" data-op="AND">AND</button>
          <button class="il-btn il-gate" data-op="OR">OR</button>
          <button class="il-btn il-gate" data-op="NOT">NOT</button>
          <button class="il-btn il-gate" data-op="NAND">NAND</button>
          <button class="il-btn il-gate" data-op="NOR">NOR</button>
          <button class="il-btn il-gate" data-op="XOR">XOR</button>
        </span>
        <button class="il-btn" id="il-add-output">+ Output</button>
        <span class="il-sep"></span>
        <button class="il-btn il-btn-primary" id="il-sim">▶ Simulate</button>
        <button class="il-btn" id="il-drive">⟳ From live SLD</button>
        <button class="il-btn" id="il-conflict">✓ Conflict check</button>
        <span class="il-sep"></span>
        <button class="il-btn" id="il-clear">Clear</button>
        <span class="il-status" id="il-status"></span>
      </div>
      <div class="il-body">
        <div class="il-canvas-wrap">
          <svg id="il-canvas" class="il-canvas" xmlns="http://www.w3.org/2000/svg"></svg>
        </div>
        <aside class="il-inspector" id="il-inspector"></aside>
      </div>
      <div class="il-modal" id="il-conflict-modal" style="display:none">
        <div class="il-modal-content">
          <div class="il-modal-header">
            <span id="il-conflict-title">Conflict check</span>
            <button class="il-modal-close" id="il-conflict-close">&times;</button>
          </div>
          <div class="il-modal-body" id="il-conflict-body"></div>
        </div>
      </div>`;

    this._svg = document.getElementById('il-canvas');
    this._svg.setAttribute('viewBox', '0 0 2200 1400');

    document.getElementById('il-add-input-cb').addEventListener('click', () => this._addInput('cb'));
    document.getElementById('il-add-input-manual').addEventListener('click', () => this._addInput('manual'));
    document.getElementById('il-add-output').addEventListener('click', () => this._addOutput());
    ws.querySelectorAll('.il-gate').forEach(b =>
      b.addEventListener('click', () => this._addGate(b.dataset.op)));
    document.getElementById('il-sim').addEventListener('click', () => this._toggleSim());
    document.getElementById('il-drive').addEventListener('click', () => this._driveFromSLD());
    document.getElementById('il-conflict').addEventListener('click', () => this._conflictCheck());
    document.getElementById('il-clear').addEventListener('click', () => this._clearAll());
    document.getElementById('il-conflict-close').addEventListener('click', () =>
      { document.getElementById('il-conflict-modal').style.display = 'none'; });

    // Canvas pointer handling: node drag, wire drag, background click.
    this._svg.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    this._svg.addEventListener('pointermove', (e) => this._onPointerMove(e));
    window.addEventListener('pointerup', (e) => this._onPointerUp(e));
  },

  // ── Node creation ────────────────────────────────────────────────────
  _spawnXY() {
    // Stagger new nodes so they don't stack exactly.
    const n = this._model().nodes.length;
    return { x: 80 + (n % 6) * 40, y: 80 + (n % 8) * 30 };
  },

  _addInput(src) {
    const { x, y } = this._spawnXY();
    const brs = this._breakers();
    const node = { id: this._newId('in'), kind: 'input', x, y, src,
                   cbId: src === 'cb' && brs.length ? brs[0].id : '',
                   label: src === 'manual' ? 'Signal' : '', invert: false, def: false };
    this._model().nodes.push(node);
    this._commit(node.id);
  },
  _addGate(op) {
    const { x, y } = this._spawnXY();
    const node = { id: this._newId('gate'), kind: 'gate', x: x + 400, y,
                   op, arity: op === 'NOT' ? 1 : 2 };
    this._model().nodes.push(node);
    this._commit(node.id);
  },
  _addOutput() {
    const { x, y } = this._spawnXY();
    const node = { id: this._newId('out'), kind: 'output', x: x + 900, y,
                   otype: 'block_close', cbId: '', label: '' };
    this._model().nodes.push(node);
    this._commit(node.id);
  },

  _commit(selectId) {
    // The interlock diagram persists via AppState.dirty + save; it deliberately
    // does not hook the SLD UndoManager (whose snapshot is a fixed component/
    // wire allow-list that would not capture interlockLogic anyway).
    AppState.dirty = true;
    if (selectId !== undefined) { this._selected = selectId; this._selectedLink = null; }
    this.evaluate();
    this.render();
    this.renderInspector();
  },

  _removeNode(id) {
    const m = this._model();
    m.nodes = m.nodes.filter(n => n.id !== id);
    m.links = m.links.filter(l => l.fromNode !== id && l.toNode !== id);
    if (this._selected === id) this._selected = null;
    this._commit();
  },
  _removeLink(id) {
    const m = this._model();
    m.links = m.links.filter(l => l.id !== id);
    if (this._selectedLink === id) this._selectedLink = null;
    this._commit();
  },
  _clearAll() {
    if (!this._model().nodes.length) return;
    if (!window.confirm('Clear the entire interlocking diagram?')) return;
    AppState.interlockLogic = { nodes: [], links: [] };
    this._selected = null; this._selectedLink = null;
    this._commit();
  },

  // ── Geometry ─────────────────────────────────────────────────────────
  _dims(node) {
    if (node.kind === 'input') return { w: 150, h: 34 };
    if (node.kind === 'output') return { w: 168, h: 42 };
    return { w: 70, h: Math.max(46, 20 + (node.arity || 2) * 14) }; // gate
  },
  _hasBubble(node) { return node.kind === 'gate' && ['NOT', 'NAND', 'NOR'].includes(node.op); },
  // Output port (right side) absolute coords.
  _outPort(node) {
    const d = this._dims(node);
    const bub = this._hasBubble(node) ? 9 : 0;
    return { x: node.x + d.w + bub, y: node.y + d.h / 2 };
  },
  // Input port `i` (left side) absolute coords.
  _inPort(node, i) {
    const d = this._dims(node);
    const k = node.kind === 'gate' ? (node.arity || 2) : 1;
    const y = node.y + (d.h * (i + 1)) / (k + 1);
    return { x: node.x, y };
  },
  _inPortCount(node) {
    if (node.kind === 'output') return 1;
    if (node.kind === 'gate') return node.arity || 2;
    return 0;
  },

  // ── Evaluation ───────────────────────────────────────────────────────
  // opts.inputs : optional map {inputNodeId: bool} forcing input values.
  // opts.useManual : read interactive-sim states from this._manual.
  evaluate(opts = {}) {
    const m = this._model();
    const byId = {}; m.nodes.forEach(n => (byId[n.id] = n));
    const incoming = {}; m.nodes.forEach(n => (incoming[n.id] = []));
    m.links.forEach(l => { if (byId[l.toNode]) incoming[l.toNode].push(l); });

    const val = {}, state = {}; // state: 1 visiting, 2 done
    this._cycle = false;
    const compute = (id) => {
      if (state[id] === 2) return val[id];
      if (state[id] === 1) { this._cycle = true; return false; }
      state[id] = 1;
      const n = byId[id];
      let v = false;
      if (!n) { v = false; }
      else if (n.kind === 'input') {
        if (opts.inputs && (n.id in opts.inputs)) v = !!opts.inputs[n.id];
        else if (opts.useManual) v = !!this._manual[n.id];
        else if (n.src === 'cb' && n.cbId) {
          const c = AppState.components.get(n.cbId);
          v = c ? (c.props?.state !== 'open') : false;
        } else v = !!n.def;
        if (n.invert) v = !v;
      } else {
        const ins = incoming[id].slice()
          .sort((a, b) => (a.toPort || 0) - (b.toPort || 0))
          .map(l => compute(l.fromNode));
        v = n.kind === 'output' ? ins.some(Boolean) : this._gateEval(n, ins);
      }
      state[id] = 2; val[id] = v; return v;
    };
    m.nodes.forEach(n => compute(n.id));
    if (!opts.inputs && !opts.transient) this._values = val;
    return val;
  },

  _gateEval(n, ins) {
    const k = ins.length;
    const t = ins.filter(Boolean).length;
    switch (n.op) {
      case 'AND':  return k > 0 && t === k;
      case 'OR':   return t > 0;
      case 'NOT':  return !ins[0];
      case 'NAND': return !(k > 0 && t === k);
      case 'NOR':  return !(t > 0);
      case 'XOR':  return (t % 2) === 1;
      default:     return false;
    }
  },

  // ── Rendering ────────────────────────────────────────────────────────
  _color(v) { return v ? '#2ecc71' : '#8892a0'; },

  render() {
    if (!this._svg) return;
    const m = this._model();
    const parts = [];

    // Links (behind nodes)
    m.links.forEach(l => {
      const from = this._node(l.fromNode), to = this._node(l.toNode);
      if (!from || !to) return;
      const a = this._outPort(from), b = this._inPort(to, l.toPort || 0);
      const v = !!this._values[l.fromNode];
      const sel = this._selectedLink === l.id;
      const c1x = a.x + 50, c2x = b.x - 50;
      parts.push(`<path class="il-link" data-link="${l.id}" d="M${a.x},${a.y} C${c1x},${a.y} ${c2x},${b.y} ${b.x},${b.y}" stroke="${sel ? '#3498db' : this._color(v)}" stroke-width="${sel ? 3.5 : 2.5}" fill="none"/>`);
    });

    // Pending wire
    if (this._pending) {
      const from = this._node(this._pending.fromNode);
      if (from) {
        const a = this._outPort(from);
        parts.push(`<path d="M${a.x},${a.y} L${this._pending.x},${this._pending.y}" stroke="#3498db" stroke-width="2" stroke-dasharray="5 4" fill="none"/>`);
      }
    }

    // Nodes
    m.nodes.forEach(n => {
      if (n.kind === 'input') parts.push(this._renderInput(n));
      else if (n.kind === 'gate') parts.push(this._renderGate(n));
      else parts.push(this._renderOutput(n));
    });

    this._svg.innerHTML = parts.join('');

    // Status line
    const st = document.getElementById('il-status');
    if (st) {
      const bits = [];
      bits.push(`${m.nodes.length} node${m.nodes.length === 1 ? '' : 's'}`);
      if (this._sim) bits.push('● SIMULATING (click inputs to toggle)');
      if (this._cycle) bits.push('⚠ feedback loop detected — outputs frozen');
      st.textContent = bits.join('   ·   ');
      st.classList.toggle('il-status-warn', this._cycle);
    }
    const simBtn = document.getElementById('il-sim');
    if (simBtn) { simBtn.classList.toggle('il-btn-on', this._sim); simBtn.textContent = this._sim ? '■ Stop' : '▶ Simulate'; }
  },

  _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },

  _renderInput(n) {
    const d = this._dims(n);
    const v = !!this._values[n.id];
    const sel = this._selected === n.id;
    const p = this._outPort(n);
    let label;
    if (n.src === 'cb') {
      const c = n.cbId && AppState.components.get(n.cbId);
      label = c ? (c.props?.name || n.cbId) : '(no CB)';
    } else label = n.label || 'Signal';
    const clickable = this._sim ? ' il-clickable' : '';
    return `
      <g class="il-node il-input${clickable}" data-node="${n.id}" data-kind="input">
        <rect x="${n.x}" y="${n.y}" width="${d.w}" height="${d.h}" rx="17"
              fill="${v ? '#1e3a2a' : '#2a2f3a'}" stroke="${sel ? '#3498db' : this._color(v)}" stroke-width="${sel ? 2.5 : 1.8}"/>
        <circle cx="${n.x + 14}" cy="${n.y + d.h / 2}" r="5" fill="${this._color(v)}"/>
        <text x="${n.x + 26}" y="${n.y + d.h / 2 + 4}" fill="#e6e9ef" font-size="12">${this._esc(label)}${n.invert ? ' (¬)' : ''}</text>
        <text x="${n.x + d.w - 8}" y="${n.y + 12}" fill="#8892a0" font-size="8" text-anchor="end">${n.src === 'cb' ? 'CB' : 'MAN'}</text>
        <circle class="il-port il-port-out" data-node="${n.id}" cx="${p.x}" cy="${p.y}" r="6" fill="${this._color(v)}" stroke="#11151c" stroke-width="1.5"/>
      </g>`;
  },

  _renderGate(n) {
    const d = this._dims(n);
    const v = !!this._values[n.id];
    const sel = this._selected === n.id;
    const col = sel ? '#3498db' : this._color(v);
    const x = n.x, y = n.y, w = d.w, h = d.h;
    let shape;
    if (n.op === 'NOT') {
      shape = `<path d="M${x},${y} L${x},${y + h} L${x + w},${y + h / 2} Z" fill="#2a2f3a" stroke="${col}" stroke-width="1.8"/>`;
    } else if (n.op === 'OR' || n.op === 'NOR' || n.op === 'XOR') {
      shape = `<path d="M${x},${y} Q${x + w * 0.35},${y + h / 2} ${x},${y + h} Q${x + w * 0.65},${y + h} ${x + w},${y + h / 2} Q${x + w * 0.65},${y} ${x},${y} Z" fill="#2a2f3a" stroke="${col}" stroke-width="1.8"/>`;
      if (n.op === 'XOR') shape = `<path d="M${x - 7},${y} Q${x + w * 0.28},${y + h / 2} ${x - 7},${y + h}" fill="none" stroke="${col}" stroke-width="1.8"/>` + shape;
    } else { // AND / NAND
      shape = `<path d="M${x},${y} L${x + w * 0.5},${y} A${h / 2},${h / 2} 0 0 1 ${x + w * 0.5},${y + h} L${x},${y + h} Z" fill="#2a2f3a" stroke="${col}" stroke-width="1.8"/>`;
    }
    // Output bubble for inverting gates
    let bubble = '';
    if (this._hasBubble(n)) bubble = `<circle cx="${x + w + 4}" cy="${y + h / 2}" r="4.5" fill="#2a2f3a" stroke="${col}" stroke-width="1.8"/>`;
    // Ports
    let ports = '';
    const k = n.arity || (n.op === 'NOT' ? 1 : 2);
    for (let i = 0; i < k; i++) {
      const ip = this._inPort(n, i);
      ports += `<circle class="il-port il-port-in" data-node="${n.id}" data-port="${i}" cx="${ip.x}" cy="${ip.y}" r="6" fill="#2a2f3a" stroke="#8892a0" stroke-width="1.5"/>`;
    }
    const op = this._outPort(n);
    ports += `<circle class="il-port il-port-out" data-node="${n.id}" cx="${op.x}" cy="${op.y}" r="6" fill="${this._color(v)}" stroke="#11151c" stroke-width="1.5"/>`;
    return `
      <g class="il-node il-gate-node" data-node="${n.id}" data-kind="gate">
        ${shape}${bubble}
        <text x="${x + w * 0.42}" y="${y + h / 2 + 4}" fill="#e6e9ef" font-size="10" text-anchor="middle" pointer-events="none">${n.op}</text>
        ${ports}
      </g>`;
  },

  _renderOutput(n) {
    const d = this._dims(n);
    const v = !!this._values[n.id];
    const sel = this._selected === n.id;
    const meta = this.OUTPUT_TYPES[n.otype] || this.OUTPUT_TYPES.alarm;
    const ip = this._inPort(n, 0);
    let label = n.label;
    if (!label) {
      if ((n.otype === 'block_close' || n.otype === 'trip') && n.cbId) {
        const c = AppState.components.get(n.cbId);
        label = `${meta.label}: ${c ? (c.props?.name || n.cbId) : '?'}`;
      } else label = meta.label;
    }
    const activeFill = v ? meta.color : '#2a2f3a';
    return `
      <g class="il-node il-output" data-node="${n.id}" data-kind="output">
        <rect x="${n.x}" y="${n.y}" width="${d.w}" height="${d.h}" rx="6"
              fill="${activeFill}" stroke="${sel ? '#3498db' : (v ? meta.color : '#8892a0')}" stroke-width="${sel ? 2.5 : 1.8}"/>
        <circle class="il-port il-port-in" data-node="${n.id}" data-port="0" cx="${ip.x}" cy="${ip.y}" r="6" fill="#2a2f3a" stroke="#8892a0" stroke-width="1.5"/>
        <text x="${n.x + 14}" y="${n.y + 16}" fill="${v ? '#11151c' : '#8892a0'}" font-size="8" font-weight="bold">${this._esc(meta.tag)}</text>
        <text x="${n.x + 14}" y="${n.y + 32}" fill="${v ? '#11151c' : '#e6e9ef'}" font-size="11">${this._esc(label)}</text>
      </g>`;
  },

  // ── Inspector ────────────────────────────────────────────────────────
  renderInspector() {
    const el = document.getElementById('il-inspector');
    if (!el) return;
    const n = this._selected && this._node(this._selected);
    if (!n) {
      el.innerHTML = `
        <div class="il-insp-empty">
          <h4>Interlocking</h4>
          <p>Add <b>inputs</b> (a breaker's live open/closed state, or a manual signal), wire them through <b>gates</b>, and drive <b>outputs</b> (block-close, trip, alarm, violation flag).</p>
          <p>Drag a node to move it. Drag from an <span class="il-dot out"></span> output port to an <span class="il-dot in"></span> input port to connect. Select a node/wire and press Delete to remove.</p>
          <p><b>▶ Simulate</b>: click inputs to toggle them live. <b>From live SLD</b>: read the real breaker positions. <b>Conflict check</b>: sweep every input combination for violations.</p>
        </div>`;
      return;
    }
    let body = '';
    if (n.kind === 'input') {
      const brs = this._breakers();
      body = `
        <label>Source</label>
        <select data-f="src">
          <option value="cb" ${n.src === 'cb' ? 'selected' : ''}>Circuit breaker (live state)</option>
          <option value="manual" ${n.src === 'manual' ? 'selected' : ''}>Manual signal</option>
        </select>
        ${n.src === 'cb' ? `
          <label>Breaker</label>
          <select data-f="cbId">
            <option value="">— select —</option>
            ${brs.map(b => `<option value="${b.id}" ${n.cbId === b.id ? 'selected' : ''}>${this._esc(b.name)}${b.type === 'switch' ? ' (switch)' : ''}</option>`).join('')}
          </select>
          <p class="il-hint">TRUE when the breaker is <b>closed</b>.</p>
        ` : `
          <label>Label</label>
          <input type="text" data-f="label" value="${this._esc(n.label || '')}"/>
          <label class="il-check"><input type="checkbox" data-f="def" ${n.def ? 'checked' : ''}/> Default state = TRUE</label>
        `}
        <label class="il-check"><input type="checkbox" data-f="invert" ${n.invert ? 'checked' : ''}/> Invert (¬) this input</label>`;
    } else if (n.kind === 'gate') {
      body = `
        <label>Gate</label>
        <select data-f="op">${this.GATE_OPS.map(o => `<option ${n.op === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        ${n.op === 'NOT' ? '' : `
          <label>Inputs</label>
          <select data-f="arity">${[2, 3, 4, 5, 6].map(k => `<option value="${k}" ${n.arity === k ? 'selected' : ''}>${k}</option>`).join('')}</select>`}`;
    } else {
      const brs = this._breakers();
      const needsCb = n.otype === 'block_close' || n.otype === 'trip';
      body = `
        <label>Output type</label>
        <select data-f="otype">${Object.entries(this.OUTPUT_TYPES).map(([k, v]) => `<option value="${k}" ${n.otype === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
        ${needsCb ? `
          <label>Target breaker</label>
          <select data-f="cbId">
            <option value="">— none —</option>
            ${brs.map(b => `<option value="${b.id}" ${n.cbId === b.id ? 'selected' : ''}>${this._esc(b.name)}</option>`).join('')}
          </select>` : ''}
        <label>Label (optional)</label>
        <input type="text" data-f="label" value="${this._esc(n.label || '')}"/>`;
    }
    el.innerHTML = `
      <div class="il-insp">
        <div class="il-insp-head"><span>${n.kind === 'gate' ? n.op + ' gate' : (n.kind === 'input' ? 'Input' : 'Output')}</span>
          <button class="il-btn il-btn-danger" id="il-del-node">Delete</button></div>
        ${body}
      </div>`;
    el.querySelectorAll('[data-f]').forEach(inp => {
      inp.addEventListener('change', () => this._onField(n.id, inp));
      if (inp.tagName === 'INPUT' && inp.type === 'text') inp.addEventListener('input', () => this._onField(n.id, inp, true));
    });
    document.getElementById('il-del-node').addEventListener('click', () => this._removeNode(n.id));
  },

  _onField(id, inp, noRerender) {
    const n = this._node(id); if (!n) return;
    const f = inp.dataset.f;
    let v = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (f === 'arity') v = parseInt(v, 10) || 2;
    if (f === 'op') { n.op = v; if (v === 'NOT') n.arity = 1; else if (n.arity === 1) n.arity = 2; }
    else n[f] = v;
    if (f === 'src' && v === 'cb' && !n.cbId) { const b = this._breakers(); if (b.length) n.cbId = b[0].id; }
    AppState.dirty = true;
    this.evaluate();
    this.render();
    if (!noRerender) this.renderInspector();
  },

  // ── Pointer interaction ──────────────────────────────────────────────
  _pt(e) {
    const r = this._svg.getBoundingClientRect();
    const vb = this._svg.viewBox.baseVal;
    return { x: (e.clientX - r.left) / r.width * vb.width, y: (e.clientY - r.top) / r.height * vb.height };
  },

  _onPointerDown(e) {
    const port = e.target.closest('.il-port');
    if (port && port.classList.contains('il-port-out')) {
      // Start a new wire from this output.
      this._pending = { fromNode: port.dataset.node, ...this._pt(e) };
      e.preventDefault();
      return;
    }
    const link = e.target.closest('.il-link');
    if (link && !port) {
      this._selectedLink = link.dataset.link; this._selected = null;
      this.render(); this.renderInspector();
      return;
    }
    const g = e.target.closest('.il-node');
    if (g) {
      const id = g.dataset.node;
      // In simulation, clicking an input toggles it instead of dragging.
      if (this._sim && g.dataset.kind === 'input') { this._toggleInput(id); return; }
      this._selected = id; this._selectedLink = null;
      const n = this._node(id);
      const p = this._pt(e);
      this._drag = { id, ox: p.x - n.x, oy: p.y - n.y, moved: false };
      this.render(); this.renderInspector();
      e.preventDefault();
      return;
    }
    // Background: deselect
    this._selected = null; this._selectedLink = null;
    this.render(); this.renderInspector();
  },

  _onPointerMove(e) {
    if (this._pending) { const p = this._pt(e); this._pending.x = p.x; this._pending.y = p.y; this.render(); return; }
    if (this._drag) {
      const n = this._node(this._drag.id); if (!n) return;
      const p = this._pt(e);
      n.x = Math.max(0, Math.round((p.x - this._drag.ox) / 5) * 5);
      n.y = Math.max(0, Math.round((p.y - this._drag.oy) / 5) * 5);
      this._drag.moved = true;
      this.render();
    }
  },

  _onPointerUp(e) {
    if (this._pending) {
      const port = e.target.closest && e.target.closest('.il-port.il-port-in');
      if (port) this._connect(this._pending.fromNode, port.dataset.node, parseInt(port.dataset.port, 10) || 0);
      this._pending = null;
      this.render();
    }
    if (this._drag) {
      if (this._drag.moved) AppState.dirty = true;
      this._drag = null;
    }
  },

  _connect(fromNode, toNode, toPort) {
    if (fromNode === toNode) return;
    const from = this._node(fromNode), to = this._node(toNode);
    if (!from || !to || to.kind === 'input') return; // can't feed an input
    const m = this._model();
    // One link per input port — replace any existing.
    m.links = m.links.filter(l => !(l.toNode === toNode && (l.toPort || 0) === toPort));
    m.links.push({ id: this._newId('lnk'), fromNode, toNode, toPort });
    this._commit();
  },

  // ── Simulation ───────────────────────────────────────────────────────
  _toggleSim() {
    this._sim = !this._sim;
    if (this._sim) {
      // Seed interactive states from the current live/default resolution.
      const base = this.evaluate({ transient: true });
      this._manual = {};
      this._model().nodes.forEach(n => { if (n.kind === 'input') this._manual[n.id] = !!base[n.id]; });
    }
    this.evaluate(this._sim ? { useManual: true } : {});
    this.render();
  },
  _stopSim() { if (this._sim) { this._sim = false; this.evaluate(); this.render(); } },

  _toggleInput(id) {
    this._manual[id] = !this._manual[id];
    this.evaluate({ useManual: true });
    this.render();
  },

  _driveFromSLD() {
    const brs = this._breakers();
    if (!brs.length) { UI && UI.toast && UI.toast('No breakers on the SLD to read.', 'warning'); return; }
    // Enter sim mode seeded from live breaker positions; manual inputs keep
    // their configured default. _manual holds the RAW (pre-invert) value —
    // evaluate() re-applies each input's invert flag.
    this._sim = true;
    this._manual = {};
    this._model().nodes.forEach(n => {
      if (n.kind !== 'input') return;
      let v;
      if (n.src === 'cb' && n.cbId) { const c = AppState.components.get(n.cbId); v = c ? (c.props?.state !== 'open') : false; }
      else v = !!n.def;
      this._manual[n.id] = v;
    });
    this.evaluate({ useManual: true });
    this.render();
    UI && UI.toast && UI.toast('Loaded live breaker positions. Outputs reflect the present network.', 'info');
  },

  _conflictCheck() {
    const m = this._model();
    const inputs = m.nodes.filter(n => n.kind === 'input');
    const outputs = m.nodes.filter(n => n.kind === 'output');
    const modal = document.getElementById('il-conflict-modal');
    const body = document.getElementById('il-conflict-body');
    const title = document.getElementById('il-conflict-title');
    title.textContent = 'Conflict check';
    if (!inputs.length || !outputs.length) {
      body.innerHTML = `<p class="il-warn">Add at least one input and one output first.</p>`;
      modal.style.display = 'flex'; return;
    }
    const n = inputs.length;
    if (n > 18) {
      body.innerHTML = `<p class="il-warn">${n} inputs ⇒ 2<sup>${n}</sup> states — too many to sweep exhaustively. Reduce to ≤ 18 inputs (group signals through gates) and re-run.</p>`;
      modal.style.display = 'flex'; return;
    }
    const total = 1 << n;
    const violOuts = outputs.filter(o => o.otype === 'violation');
    const violations = [];      // combos raising ANY violation flag
    const blockStats = {};      // outputId -> count of states where TRUE
    outputs.forEach(o => (blockStats[o.id] = 0));
    for (let mask = 0; mask < total; mask++) {
      const assign = {};
      inputs.forEach((inp, i) => { assign[inp.id] = !!(mask & (1 << i)); });
      const val = this.evaluate({ inputs: assign });
      outputs.forEach(o => { if (val[o.id]) blockStats[o.id]++; });
      const hit = violOuts.filter(o => val[o.id]);
      if (hit.length) {
        violations.push({
          inputs: inputs.map(inp => ({ label: this._inputLabel(inp), on: assign[inp.id] })),
          flags: hit.map(o => o.label || this.OUTPUT_TYPES.violation.label),
        });
      }
    }
    // Restore live display
    this.evaluate(this._sim ? { useManual: true } : {});
    this.render();

    let html = `<p>Swept <b>${total.toLocaleString()}</b> input combination${total === 1 ? '' : 's'} across <b>${n}</b> input${n === 1 ? '' : 's'}.</p>`;
    if (this._cycle) html += `<p class="il-warn">⚠ The logic contains a feedback loop; results may be unreliable.</p>`;
    if (!violOuts.length) {
      html += `<p class="il-note">No <b>violation</b> outputs defined — add an "Interlock violation" output describing a state that must never occur (e.g. two incomers closed onto a bus-tie) to have it checked here.</p>`;
    } else if (!violations.length) {
      html += `<p class="il-ok">✓ No violation flags were raised in any state. The interlock is sound for the modelled inputs.</p>`;
    } else {
      html += `<p class="il-warn">✗ ${violations.length} state${violations.length === 1 ? '' : 's'} raise an interlock-violation flag:</p>`;
      html += `<table class="il-table"><thead><tr>${violations[0].inputs.map(i => `<th>${this._esc(i.label)}</th>`).join('')}<th>Violation</th></tr></thead><tbody>`;
      violations.slice(0, 200).forEach(row => {
        html += `<tr>${row.inputs.map(i => `<td class="${i.on ? 'il-t1' : 'il-t0'}">${i.on ? 'CLOSED/1' : 'open/0'}</td>`).join('')}<td class="il-tv">${row.flags.map(f => this._esc(f)).join(', ')}</td></tr>`;
      });
      html += `</tbody></table>`;
      if (violations.length > 200) html += `<p class="il-note">…showing first 200 of ${violations.length}.</p>`;
    }
    // Output activity summary
    html += `<h4 class="il-sub">Output activity (states TRUE / ${total})</h4><ul class="il-list">`;
    outputs.forEach(o => {
      const meta = this.OUTPUT_TYPES[o.otype] || this.OUTPUT_TYPES.alarm;
      const lbl = o.label || (((o.otype === 'block_close' || o.otype === 'trip') && o.cbId && AppState.components.get(o.cbId)) ? `${meta.label}: ${AppState.components.get(o.cbId).props?.name || o.cbId}` : meta.label);
      html += `<li><span class="il-badge" style="background:${meta.color}">${this._esc(meta.tag)}</span> ${this._esc(lbl)} — <b>${blockStats[o.id]}</b> / ${total}</li>`;
    });
    html += `</ul>`;
    body.innerHTML = html;
    modal.style.display = 'flex';
  },

  _inputLabel(inp) {
    if (inp.src === 'cb') { const c = inp.cbId && AppState.components.get(inp.cbId); return (c ? (c.props?.name || inp.cbId) : '(no CB)') + (inp.invert ? ' ¬' : ''); }
    return (inp.label || 'Signal') + (inp.invert ? ' ¬' : '');
  },
};

if (typeof window !== 'undefined') window.Interlocking = Interlocking;
