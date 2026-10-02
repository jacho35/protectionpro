/* ProtectionPro — conduit / trunking fill for DB schedule ways.
 *
 * Each way may carry conduit_tag / conduit_type / conduit_size. Ways with the
 * same non-blank tag share ONE conduit: their conductors are added together
 * and the group has one type and one size. A way with no tag has its own.
 * A blank size is "auto" — the smallest size of that type that passes.
 *
 * Fill = Σ conductor cross-section (insulated OD) ÷ internal area of the
 * conduit, against the space-factor limit. Conductors per way: the live cores
 * (1 for 1P, 3 for 3P) + neutral at the live size + the ECC (declared, else
 * the IEC 60364-5-54 Table 54.7 minimum). Overall diameters are typical
 * values for single-core PVC (H07V-R) wiring and conduit internal diameters
 * are typical medium-duty values — a manufacturer's figures for the products
 * actually specified take precedence. Pure geometry; no backend call.
 */

const Conduit = {
  LIMIT_PCT: 40,        // space factor, all types
  NEAR_FRAC: 0.8,       // "near limit" above this share of the limit

  // Internal diameter (mm) by nominal size; trunking is internal W×H area.
  TYPES: [
    { id: 'pvc', label: 'PVC rigid', id_mm: { '20': 16.9, '25': 21.4, '32': 27.8, '40': 35.4, '50': 44.3, '63': 57.4 } },
    { id: 'steel', label: 'Galv. steel', id_mm: { '20': 17.0, '25': 22.0, '32': 28.8, '40': 36.8, '50': 46.8 } },
    { id: 'flex', label: 'Flexible', id_mm: { '20': 14.3, '25': 18.6, '32': 24.2, '40': 31.5, '50': 39.6 } },
    { id: 'trunking', label: 'Trunking', area_mm2: { '50×50': 2500, '75×50': 3750, '100×50': 5000, '100×100': 10000, '150×100': 15000 } },
  ],

  // Typical insulated single-core overall diameter (mm) by conductor mm².
  OD_MM: { 1.5: 3.0, 2.5: 3.6, 4: 4.2, 6: 4.8, 10: 6.3, 16: 7.4, 25: 9.0, 35: 10.1, 50: 12.0,
    70: 13.9, 95: 16.0, 120: 17.7, 150: 19.7, 185: 22.1, 240: 25.1 },

  type(id) { return this.TYPES.find(t => t.id === id) || null; },
  sizes(typeId) {
    const t = this.type(typeId);
    if (!t) return [];
    return Object.keys(t.id_mm || t.area_mm2);
  },
  capacity(typeId, size) {
    const t = this.type(typeId);
    if (!t) return 0;
    if (t.area_mm2) return t.area_mm2[size] || 0;
    const d = t.id_mm[size];
    return d ? Math.PI / 4 * d * d : 0;
  },

  odMm(mm2) {
    const s = Number(mm2);
    if (!(s > 0)) return 0;
    const keys = Object.keys(this.OD_MM).map(Number).sort((a, b) => a - b);
    const hit = keys.find(k => k >= s);
    if (hit !== undefined) return this.OD_MM[hit];
    return 1.47 * Math.sqrt(s) + 1.65;       // beyond the table: fit through 10–95 mm²
  },
  // IEC 60364-5-54 Table 54.7 minimum when the ECC is not declared.
  eccMm2(c) {
    const e = Number(c.ecc_mm2);
    if (e > 0) return e;
    const s = Number(c.cable_mm2) || 0;
    return s <= 16 ? s : (s <= 35 ? 16 : s / 2);
  },
  // Cross-section (mm²) taken up by one way's conductors.
  wayAreaMm2(c) {
    const s = Number(c.cable_mm2) || 0;
    const live = (c.poles === '3P' ? 3 : 1) + 1;           // + neutral
    const a = (mm2) => { const d = this.odMm(mm2); return Math.PI / 4 * d * d; };
    return live * a(s) + a(this.eccMm2(c));
  },

  // Group ways sharing a conduit. Returns Map(key → [circuits]).
  groups(circuits) {
    const m = new Map();
    for (const c of circuits) {
      const tag = String(c.conduit_tag || '').trim();
      const key = tag ? 'tag:' + tag.toLowerCase() : 'way:' + c.id;
      if (!m.has(key)) m.set(key, []);
      m.get(key).push(c);
    }
    return m;
  },

  // Make every member of a tag group carry the same type/size (first member
  // that has a type wins), so the grid never shows two answers for one conduit.
  syncGroups(circuits) {
    for (const [key, members] of this.groups(circuits)) {
      if (!key.startsWith('tag:') || members.length < 2) continue;
      const src = members.find(c => c.conduit_type) || members[0];
      for (const c of members) {
        c.conduit_type = src.conduit_type || '';
        c.conduit_size = src.conduit_size || '';
      }
    }
  },

  // Per-way verdict, keyed by way id.
  evaluate(circuits) {
    const out = new Map();
    for (const [, members] of this.groups(circuits)) {
      const src = members.find(c => c.conduit_type) || members[0];
      const typeId = src.conduit_type || '';
      const tag = String(src.conduit_tag || '').trim();
      const area = members.reduce((s, c) => s + this.wayAreaMm2(c), 0);
      let res;
      if (!typeId || !this.type(typeId)) {
        res = { status: 'none', type: '', n: members.length, tag };
      } else {
        const sizes = this.sizes(typeId);
        const pass = (sz) => area / this.capacity(typeId, sz) * 100 <= this.LIMIT_PCT;
        const manual = members.map(c => String(c.conduit_size || '')).find(v => v && sizes.includes(v)) || '';
        const smallest = sizes.find(pass) || '';
        const size = manual || smallest || sizes[sizes.length - 1];
        const cap = this.capacity(typeId, size);
        const fill = area / cap * 100;
        const status = fill > this.LIMIT_PCT ? 'over' : (fill > this.LIMIT_PCT * this.NEAR_FRAC ? 'near' : 'ok');
        res = {
          status, type: typeId, size, auto: !manual, n: members.length, tag,
          areaMm2: area, capMm2: cap, fillPct: fill, suggest: smallest,
          unfittable: !smallest,
        };
      }
      for (const c of members) out.set(c.id, Object.assign({ members: members.length }, res));
    }
    return out;
  },

  statusLabel(r) {
    if (!r || r.status === 'none') return '—';
    if (r.status === 'over') return r.suggest ? `Over · use ${r.suggest}` : 'Over · no size fits';
    return r.status === 'near' ? 'Near limit' : 'OK';
  },
  tooltip(r) {
    if (!r || r.status === 'none') return 'No conduit chosen for this way.';
    const t = this.type(r.type);
    return `${t.label} ${r.size}${t.area_mm2 ? '' : ' mm'}${r.auto ? ' (auto)' : ''}: ${r.areaMm2.toFixed(0)} mm² of conductor `
      + `in ${r.capMm2.toFixed(0)} mm² = ${r.fillPct.toFixed(1)} % (limit ${this.LIMIT_PCT} %). `
      + `${r.n > 1 ? r.n + ' ways share this conduit. ' : ''}Conductors: live + neutral + ECC, typical single-core PVC diameters.`;
  },
  parseType(raw) {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    const t = this.TYPES.find(x => x.id === s || x.label.toLowerCase() === s);
    return t ? t.id : '';
  },
};

if (typeof module !== 'undefined') module.exports = Conduit;
