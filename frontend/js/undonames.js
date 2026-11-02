/* ProtectionPro — names for the undo of the plan, Demand and the road plan
 * (UX plan item 13, same idea as the single line's UndoManager.describe).
 *
 * Each workspace keeps its own history of snapshots. `UndoNames` turns two
 * snapshots into a short name — "Move Kiosk K-3", "Add 12 erven", "Edit
 * Erf 12: ADMD" — and `title` writes the button text. All pure (node-testable).
 */

const UndoNames = {
  POS: new Set(['x', 'y', 'points', 'cx', 'cy', 'pos', 'at']),

  _same(a, b) { return JSON.stringify(a) === JSON.stringify(b); },
  _plural(noun, n) { return n + ' ' + (noun.endsWith('s') ? noun : noun + 's'); },

  // Diff two arrays of {id, …} items. o = { noun, name(item), field(key) }.
  // Returns '' when nothing in the list differs.
  list(a, b, o) {
    const A = new Map((a || []).map(i => [i.id, i])), B = new Map((b || []).map(i => [i.id, i]));
    const noun = o.noun || 'item';
    const nm = o.name || (i => i.name || i.id);
    const added = [...B.values()].filter(i => !A.has(i.id));
    const removed = [...A.values()].filter(i => !B.has(i.id));
    const many = (l, v) => l.length === 1 ? `${v} ${nm(l[0])}` : `${v} ${this._plural(noun, l.length)}`;
    if (added.length && !removed.length) return many(added, 'Add');
    if (removed.length && !added.length) return many(removed, 'Delete');
    if (added.length || removed.length) return 'Edit ' + noun + 's';
    const moved = [], edited = [];
    for (const [id, n] of B) {
      const old = A.get(id);
      if (!old || this._same(old, n)) continue;
      const keys = new Set([...Object.keys(old), ...Object.keys(n)]);
      const changed = [];
      for (const k of keys) {
        if (this._same(old[k], n[k])) continue;
        if (k === 'props' && old.props && n.props && typeof old.props === 'object' && typeof n.props === 'object') {
          for (const pk of new Set([...Object.keys(old.props), ...Object.keys(n.props)])) if (!this._same(old.props[pk], n.props[pk])) changed.push(pk);
        } else changed.push(k);
      }
      if (changed.length && changed.every(k => this.POS.has(k))) moved.push(n); else edited.push([n, changed]);
    }
    if (moved.length && !edited.length) return many(moved, 'Move');
    if (edited.length === 1 && !moved.length) {
      const [n, ch] = edited[0];
      const f = o.field || (k => k.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').toLowerCase());
      return ch.length === 1 ? `Edit ${nm(n)}: ${f(ch[0])}` : `Edit ${nm(n)}`;
    }
    if (edited.length || moved.length) return `Edit ${this._plural(noun, edited.length + moved.length)}`;
    return '';
  },

  _parse(s) { try { return typeof s === 'string' ? JSON.parse(s) : s; } catch (e) { return null; } },

  // Plan markup (the active floor's elements and routes).
  plan(prev, next) {
    const a = this._parse(prev), b = this._parse(next);
    if (!a || !b) return '';
    return this.list(a.elements, b.elements, { noun: 'item', name: e => e.name || e.type || e.id })
      || this.list(a.routes, b.routes, { noun: 'route', name: r => r.name || 'route' })
      || (this._same(a.floors, b.floors) ? '' : 'Edit floors')
      || (this._same(a.settings, b.settings) ? '' : 'Plan settings')
      || (this._same(a.scale, b.scale) ? '' : 'Set scale') || 'Edit plan';
  },

  // Demand (minisubs, kiosks, and the erven inside kiosks).
  demand(prev, next) {
    const a = this._parse(prev), b = this._parse(next);
    if (!a || !b) return '';
    const erfs = (r) => (r.kiosks || []).flatMap(k => (k.erfs || []).map(e => ({ ...e, _k: k.id })));
    const erfName = e => 'Erf ' + (e.erfNumber || e.id);
    const kiosks = (r) => (r.kiosks || []).map(({ erfs: _e, ...k }) => k);
    return this.list(a.minisubs, b.minisubs, { noun: 'minisub', name: m => m.name || 'minisub' })
      || this.list(kiosks(a), kiosks(b), { noun: 'kiosk', name: k => k.name || 'kiosk' })
      || this.list(erfs(a), erfs(b), { noun: 'erf', name: erfName, field: k => ({ erfNumber: 'number' }[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase()) })
      || (this._same(a.settings, b.settings) ? '' : 'Edit Demand settings') || 'Edit Demand';
  },

  // Road plan: roads, junction classes, settings, scene.
  road(prev, next) {
    const a = this._parse(prev), b = this._parse(next);
    if (!a || !b) return '';
    return this.list(a.roads, b.roads, { noun: 'road', name: r => r.name || 'road' })
      || (this._same(a.junctionCls, b.junctionCls) ? '' : 'Junction class')
      || (this._same(a.settings, b.settings) ? '' : 'Road plan settings')
      || (this._same(a.scene, b.scene) ? '' : 'Edit scene') || 'Edit road plan';
  },

  // "Undo: Move K-3 (Ctrl+Z)"
  title(verb, label, key) { return verb + (label ? ': ' + label : '') + (key ? ' (' + key + ')' : ''); },
};
