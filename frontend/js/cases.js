/* ProtectionPro — Cases: the one list of named network variants.
 *
 * A case is a saved copy of the network (switching, settings, optionally the
 * drawing layout) that you can load back, edit in the grid, run studies on and
 * compare. It replaces the two lists that used to hold the same idea:
 * Scenarios and Load Flow Study Manager cases. `AppState.cases` is the list;
 * `AppState.scenarios` and `AppState.loadFlowCases` still read and write it, so
 * every older screen keeps working while they move over.
 *
 * case = { id, name, description, timestamp,
 *          applies: { switching, settings, layout },
 *          components, wires, nextId, groups?, pages?, activePageId?,
 *          baseMVA?, loadFlowMethod? }
 *
 * Pure helpers (node-testable): `normalize`, `fromProject`, `nextNumber`.
 */

const Cases = {
  // What a case applies when it has no tick of its own. Layout is off: a case
  // is a network variant, not a drawing variant.
  DEFAULT_APPLIES: { switching: true, settings: true, layout: false },
  LEGACY_APPLIES: { switching: true, settings: true, layout: true },   // a scenario saved before the ticks existed

  // Fill in what an older record lacks. `from` = 'scenario' | 'lf' | 'case'.
  normalize(c, from) {
    const o = { ...c };
    o.name = String(o.name || 'Case');
    o.description = o.description || '';
    o.timestamp = o.timestamp || '';
    if (!o.applies) o.applies = { ...(from === 'scenario' ? this.LEGACY_APPLIES : this.DEFAULT_APPLIES) };
    if (!Array.isArray(o.components)) o.components = [];
    if (!Array.isArray(o.wires)) o.wires = [];
    return o;
  },

  // The list a saved project holds: the new `cases`, or its two old lists
  // joined (an id seen twice keeps the first, the second is renamed).
  fromProject(data) {
    if (Array.isArray(data.cases)) return data.cases.map(c => this.normalize(c, 'case'));
    const out = [], seen = new Set();
    const add = (c, from) => {
      const n = this.normalize(c, from);
      let id = String(n.id || '');
      while (!id || seen.has(id)) id = 'case_' + (this.nextNumber(out.concat([{ id: 'case_' + (out.length + seen.size) }])) );
      n.id = id; seen.add(id); out.push(n);
    };
    for (const s of Array.isArray(data.scenarios) ? data.scenarios : []) add(s, 'scenario');
    for (const c of Array.isArray(data.loadFlowCases) ? data.loadFlowCases : []) add(c, 'lf');
    return out;
  },

  // The next number for a new `case_<n>` id.
  nextNumber(list) {
    let max = 0;
    for (const c of list) { const m = /^(?:case|scenario)_(\d+)$/.exec(String(c.id)); if (m) max = Math.max(max, +m[1]); }
    return max + 1;
  },

  // What differs between two cases: parts added / removed in B and property
  // values that changed. rows = [{ name, what, a, b, delta }]; names and
  // positions are not compared.
  diff(A, B) {
    const map = (c) => new Map((c.components || []).map(x => [x.id, { type: x.type, ...(x.props || {}) }]));
    const ma = map(A), mb = map(B), rows = [];
    for (const id of new Set([...ma.keys(), ...mb.keys()])) {
      const a = ma.get(id), b = mb.get(id);
      if (!a && b) { rows.push({ name: b.name || id, what: 'Added in B', a: '', b: '', delta: '' }); continue; }
      if (a && !b) { rows.push({ name: a.name || id, what: 'Removed in B', a: '', b: '', delta: '' }); continue; }
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (k === 'name' || k === 'x' || k === 'y') continue;
        const va = a[k], vb = b[k];
        if (JSON.stringify(va) === JSON.stringify(vb) || (va == null && vb == null)) continue;
        rows.push({ name: a.name || b.name || id, what: k.replace(/_/g, ' '),
          a: va != null ? String(typeof va === 'object' ? JSON.stringify(va) : va) : '', b: vb != null ? String(typeof vb === 'object' ? JSON.stringify(vb) : vb) : '', delta: this.delta(va, vb) });
      }
    }
    return rows;
  },
  delta(a, b) {
    if (a == null || b == null) return '';
    const na = parseFloat(a), nb = parseFloat(b);
    if (isNaN(na) || isNaN(nb) || typeof a === 'object' || typeof b === 'object') return `${a} \u2192 ${b}`;
    const d = nb - na;
    return (d >= 0 ? '+' : '') + d.toFixed(4);
  },

  // The project a study runs on for this case: the live project with the
  // case's network (and base MVA / solver method) in place of the live one.
  // A case runs as the copy that was saved; its `applies` ticks are only for loading it.
  project(base, c) {
    const o = { ...base };
    if (Array.isArray(c.components) && c.components.length) { o.components = c.components; o.wires = c.wires || []; }
    else if (Array.isArray(c.wires) && c.wires.length) o.wires = c.wires;
    if (c.baseMVA != null) o.baseMVA = c.baseMVA;
    if (c.loadFlowMethod) o.loadFlowMethod = c.loadFlowMethod;
    return o;
  },
};
