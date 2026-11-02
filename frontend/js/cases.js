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
};
