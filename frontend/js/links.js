/* ProtectionPro — Links: one table of every link between workspaces.
 *
 * The same thing often lives in two workspaces — a kiosk drawn on the site
 * plan and its Demand row, a board on a floor plan and on the single line, a
 * minisub in Demand and its transformer stack on the single line. Each link
 * is stored where it has always been (reticId on a drawn element, planLink on
 * a single-line part, planKey on a street-lighting circuit, …), so the
 * project file is unchanged; this module is the one place that knows every
 * kind of link (KINDS), lists them (all / of) and takes the user from a field
 * owned elsewhere to its owner and back (go, the link marks).
 *
 * An item is addressed as 'ws:id':
 *   sld:<component id>        a single-line part
 *   plan:<element / route id> anything drawn on a site or floor plan
 *   retic:<row id>            a Demand minisub, kiosk or erf
 *   sl:<circuit or pole id>   a Street lighting circuit or pole
 *   rp:<road id>              a road on the road plan
 *   way:<board id>/<way id>   a way in a board schedule
 *
 * A link mark (markHtml) is a small button beside a field another workspace
 * owns: it goes to the owner, and a "← Back" chip returns to where you were.
 */

const Links = {
  WS_LABEL: { sld: 'the single line', plan: 'the plan', retic: 'Demand', sl: 'Street lighting', rp: 'the road plan', way: 'the schedule' },

  // Every kind of link: where it is stored and what it joins. list() yields
  // [a, b] address pairs from the project as it is now.
  KINDS: [
    { id: 'plan-demand', label: 'Drawn item ↔ Demand row', field: 'element.reticId',
      list: (L) => L._els().filter(e => e.reticId && ['minisub', 'kiosk', 'erf'].includes(e.type)).map(e => ['plan:' + e.id, 'retic:' + e.reticId]) },
    { id: 'plan-sld', label: 'Drawn board / supply ↔ single-line part', field: 'element.sldId',
      list: (L) => L._els().filter(e => e.sldId).map(e => ['plan:' + e.id, 'sld:' + e.sldId]) },
    { id: 'plan-sld-members', label: 'Drawn switchboard ↔ its single-line sections', field: 'element.sldMembers',
      list: (L) => L._els().filter(e => Array.isArray(e.sldMembers)).flatMap(e => e.sldMembers.map(m => ['plan:' + e.id, 'sld:' + m])) },
    { id: 'sld-plan', label: 'Single-line board / feeder ↔ plan', field: 'component.planLink',
      list: (L) => L._comps().filter(c => c.planLink).map(c => ['sld:' + c.id, 'plan:' + c.planLink]) },
    { id: 'sld-switchboard', label: 'Single-line section ↔ drawn switchboard', field: 'component.swLink',
      list: (L) => L._comps().filter(c => c.swLink).map(c => ['sld:' + c.id, 'plan:' + c.swLink]) },
    { id: 'sld-riser', label: 'Single-line riser feeder ↔ its riser leg', field: 'component.riserLink',
      list: (L) => L._comps().filter(c => c.riserLink).map(c => ['sld:' + c.id, 'plan:' + c.riserLink]) },
    { id: 'route-sld', label: 'Drawn feeder ↔ single-line cable', field: 'route.sldCableId / sldRiserCableId',
      list: (L) => L._routes().flatMap(r => [r.sldCableId, r.sldRiserCableId].filter(Boolean).map(id => ['plan:' + r.id, 'sld:' + id])) },
    { id: 'demand-sld', label: 'Demand minisub ↔ its single-line stack', field: 'component.reticMinisubId',
      list: (L) => L._comps().filter(c => c.reticMinisubId).map(c => ['sld:' + c.id, 'retic:' + c.reticMinisubId]) },
    { id: 'sl-plan', label: 'Street-light pole ↔ drawn pole', field: 'pole.planId',
      list: (L) => L._circuits().flatMap(c => c.poles.filter(p => p.planId).map(p => ['sl:' + p.id, 'plan:' + p.planId])) },
    { id: 'sl-road', label: 'Street-light circuit ↔ road', field: 'circuit.roadKey',
      list: (L) => L._circuits().filter(c => c.roadKey).map(c => ['sl:' + c.id, 'rp:' + c.roadKey]) },
    { id: 'sl-source', label: 'Street-light circuit ↔ its kiosk / minisub', field: 'circuit.source',
      list: (L) => L._circuits().filter(c => c.source && c.source.id).map(c => ['sl:' + c.id, 'retic:' + c.source.id]) },
    { id: 'device-way', label: 'Drawn device ↔ board way', field: 'element.props.circuitDbId / circuitWid',
      list: (L) => L._els().filter(e => e.props && e.props.circuitDbId && e.props.circuitWid).map(e => ['plan:' + e.id, `way:${L._boardOf(e.props.circuitDbId)}/${e.props.circuitWid}`]) },
    { id: 'way-sld', label: 'Feeder way ↔ single-line breaker / cable', field: 'way.sld',
      list: (L) => L._ways().flatMap(([b, w]) => [w.sld && w.sld.device, w.sld && w.sld.cable].filter(Boolean).map(id => [`way:${b.id}/${w.id}`, 'sld:' + id])) },
    { id: 'way-board', label: 'Feeder way ↔ the board it feeds', field: 'way.feedsDbId',
      list: (L) => L._ways().filter(([, w]) => w.feedsDbId).map(([b, w]) => [`way:${b.id}/${w.id}`, 'sld:' + w.feedsDbId]) },
    { id: 'offpage', label: 'Off-page connector pair', field: 'component.props.linked_to',
      list: (L) => L._comps().filter(c => c.type === 'offpage_connector' && c.props && c.props.linked_to).map(c => ['sld:' + c.id, 'sld:' + c.props.linked_to]) },
  ],

  // ── Sources (each safe when its workspace is absent) ──
  _comps() { return AppState.components ? [...AppState.components.values()] : []; },
  _els() { return AppState.planMarkup && typeof AppState.planAllElements === 'function' ? AppState.planAllElements() : []; },
  _routes() { return AppState.planMarkup && typeof AppState.planAllRoutes === 'function' ? AppState.planAllRoutes() : []; },
  _circuits() {
    const sl = AppState.reticulation && AppState.reticulation.streetLighting;
    return (sl && Array.isArray(sl.circuits)) ? sl.circuits : [];
  },
  _ways() {
    const out = [];
    for (const c of this._comps()) if (Array.isArray(c.props && c.props.circuits)) for (const w of c.props.circuits) out.push([c, w]);
    return out;
  },
  // A plan board element id → its single-line board id (ways live there).
  _boardOf(id) {
    if (AppState.components && AppState.components.has(id)) return id;
    const el = this._els().find(e => e.id === id);
    return (el && el.sldId) || id;
  },

  // Every link now: [{ kind, a, b }].
  all() {
    const out = [];
    for (const k of this.KINDS) {
      let pairs = [];
      try { pairs = k.list(this); } catch (e) { pairs = []; }
      for (const [a, b] of pairs) out.push({ kind: k.id, a, b });
    }
    return out;
  },
  // What an item is linked to: [{ kind, to }] (either end). The index is
  // built once per task (a render asks for many items) and dropped after it,
  // so it is never stale.
  of(addr) {
    if (!this._idx) {
      const idx = new Map();
      const add = (k, v) => { let a = idx.get(k); if (!a) idx.set(k, a = []); a.push(v); };
      for (const l of this.all()) { add(l.a, { kind: l.kind, to: l.b }); add(l.b, { kind: l.kind, to: l.a }); }
      this._idx = idx;
      queueMicrotask(() => { this._idx = null; });
    }
    return this._idx.get(addr) || [];
  },
  _idx: null,
  // The first item of workspace `ws` an item is linked to, or null.
  find(addr, ws, kind) {
    const l = this.of(addr).find(x => x.to.startsWith(ws + ':') && (!kind || x.kind === kind));
    return l ? l.to : null;
  },

  _parse(addr) {
    const s = String(addr || ''), i = s.indexOf(':');
    return i < 0 ? null : { ws: s.slice(0, i), id: s.slice(i + 1) };
  },

  // The workspace an item is in, for text ("Demand", "the plan").
  where(addr) { const t = this._parse(addr); return t ? (this.WS_LABEL[t.ws] || t.ws) : ''; },

  // A short name for an item, for the Back chip and titles.
  name(addr) {
    const t = this._parse(addr);
    if (!t) return '';
    try {
      if (t.ws === 'sld') { const c = AppState.components.get(t.id); return c ? (c.props.name || c.id) : t.id; }
      if (t.ws === 'plan') {
        const e = this._els().find(x => x.id === t.id) || this._routes().find(x => x.id === t.id);
        return e ? (e.name || (e.fromId ? 'cable' : e.type)) : t.id;
      }
      if (t.ws === 'retic' && typeof PlanSync !== 'undefined') { const f = PlanSync._reticRow(t.id); return f ? PlanSync._reticRowName(f) : t.id; }
      if (t.ws === 'sl') {
        for (const c of this._circuits()) { if (c.id === t.id) return c.name; const p = c.poles.find(x => x.id === t.id); if (p) return `${c.name} · ${p.name}`; }
      }
      if (t.ws === 'rp' && typeof RoadPlan !== 'undefined') { const r = RoadPlan.road(t.id); return r ? r.name : t.id; }
      if (t.ws === 'way') {
        const [b, w] = t.id.split('/'); const c = AppState.components.get(b);
        const way = c && (c.props.circuits || []).find(x => x.id === w);
        return way ? `${c.props.name || b} way ${way.way || ''}`.trim() : t.id;
      }
    } catch (e) { /* fall through */ }
    return t.id;
  },

  // ── Link marks ──
  // A small button beside a field another workspace owns. `text` is what it
  // says ("from plan", "typed · plan 38 m"); `back` is where the user is.
  markHtml(to, back, text, cls) {
    const t = this._parse(to);
    if (!t) return '';
    const where = this.WS_LABEL[t.ws] || t.ws;
    return `<button type="button" class="link-mark${cls ? ' ' + escHtml(cls) : ''}" data-link-go="${escHtml(to)}"${back ? ` data-link-back="${escHtml(back)}"` : ''} title="${escHtml(`Set in ${where}: ${this.name(to)}. Click to go there.`)}">${escHtml(text || 'from ' + where.replace(/^the /, ''))}</button>`;
  },

  init() {
    if (typeof document === 'undefined' || this._init) return;
    this._init = true;
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('[data-link-go]');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      this.go(b.dataset.linkGo, b.dataset.linkBack || null);
    }, true);
  },

  // ── Go to an item, with a Back chip to `back` ──
  go(to, back) {
    const t = this._parse(to);
    if (!t) return false;
    const ok = this._focus(t);
    if (ok === false) { if (typeof UI !== 'undefined') UI.toast(`${this.name(to)} is no longer in ${this.WS_LABEL[t.ws] || t.ws}.`, 'warning'); return false; }
    this._showBack(back);
    return true;
  },

  _sw(ws) { if (typeof window !== 'undefined' && typeof window.switchWorkspace === 'function') window.switchWorkspace(ws); },
  _flash(el) {
    if (!el) return;
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('link-flash');
    setTimeout(() => el.classList.remove('link-flash'), 1600);
  },
  _later(fn) { setTimeout(fn, 60); },

  _focus(t) {
    const { ws, id } = t;
    if (ws === 'sld') {
      if (!AppState.components.has(id)) return false;
      this._sw('sld');
      AppState.selectedIds = new Set([id]);
      if (typeof Canvas !== 'undefined') { Canvas.render(); if (Canvas.centerOnComponent) Canvas.centerOnComponent(id); }
      if (typeof Properties !== 'undefined' && Properties.show) Properties.show(id);
      return true;
    }
    if (ws === 'plan') {
      const pm = AppState.planMarkup;
      if (!pm) return false;
      const fl = AppState.planFloors().find(f => (f.data.elements || []).some(e => e.id === id) || (f.data.routes || []).some(r => r.id === id));
      if (!fl) return false;
      this._sw('plan');
      if (fl.id !== pm.activeFloorId && typeof PlanMarkup !== 'undefined' && PlanMarkup.setActiveFloor) PlanMarkup.setActiveFloor(fl.id);
      if (typeof PlanMarkup !== 'undefined') PlanMarkup.selectOnly(id);
      const item = pm.elements.find(e => e.id === id) || pm.routes.find(r => r.id === id);
      if (typeof PlanEngine !== 'undefined' && PlanEngine.zoomToPoints && item) PlanEngine.zoomToPoints(item.points || [{ x: item.x, y: item.y }]);
      if (typeof PlanUI !== 'undefined') { PlanUI.renderProps(); }
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ all: true });
      return true;
    }
    if (ws === 'retic') {
      const f = typeof PlanSync !== 'undefined' ? PlanSync._reticRow(id) : null;
      if (!f) return false;
      this._sw('retic');
      if (f.kind === 'minisub') {
        if (typeof Retic !== 'undefined' && Retic._isMobile && Retic._isMobile() && Retic._toggleSummary) Retic._toggleSummary(true);
        this._later(() => this._flash(document.querySelector(`[data-ms-block="${CSS.escape(id)}"]`)));
      } else {
        const k = f.kind === 'kiosk' ? f.row : f.kiosk;
        if (k && k.collapsed) { k.collapsed = false; if (typeof Retic !== 'undefined') Retic.render(); }
        this._later(() => this._flash(f.kind === 'kiosk'
          ? document.querySelector(`.kiosk-card[data-kiosk="${CSS.escape(id)}"]`)
          : document.querySelector(`tr[data-erf="${CSS.escape(id)}"]`)));
      }
      return true;
    }
    if (ws === 'sl') {
      if (typeof StreetLight === 'undefined') return false;
      const c = StreetLight.circuits.find(x => x.id === id || x.poles.some(p => p.id === id));
      if (!c) return false;
      this._sw('streetlight');
      if (StreetLight.setView) StreetLight.setView('circuits');
      StreetLight._selId = c.id;
      StreetLight.render();
      if (id !== c.id) this._later(() => this._flash(document.querySelector(`#sl-pole-body tr[data-pole="${CSS.escape(id)}"]`)));
      return true;
    }
    if (ws === 'rp') {
      if (typeof RoadPlan === 'undefined' || !RoadPlan.road(id)) return false;
      this._sw('streetlight');
      if (StreetLight.setView) StreetLight.setView('plan');
      RoadPlan._selRoad = id;
      RoadPlan.render();
      return true;
    }
    if (ws === 'way') {
      const [b, w] = id.split('/');
      const comp = AppState.components.get(b);
      if (!comp || !(comp.props.circuits || []).some(x => x.id === w)) return false;
      this._sw('schedules');
      if (typeof Schedules !== 'undefined' && Schedules.selectBoard) Schedules.selectBoard(b);
      this._later(() => this._flash(document.querySelector(`tr[data-id="${CSS.escape(w)}"]`)));
      return true;
    }
    return false;
  },

  // "← Back to …": returns to where the link mark was clicked.
  _showBack(back) {
    let chip = document.getElementById('link-back');
    if (!back || !this._parse(back)) { if (chip) chip.hidden = true; return; }
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'link-back';
      chip.className = 'link-back';
      document.body.appendChild(chip);
      chip.addEventListener('click', () => {
        const to = chip.dataset.to;
        chip.hidden = true;
        if (to) this.go(to, null);
      });
    }
    chip.dataset.to = back;
    const t = this._parse(back);
    chip.textContent = `← Back to ${this.name(back)} in ${this.WS_LABEL[t.ws] || t.ws}`;
    chip.hidden = false;
  },
};

if (typeof window !== 'undefined') window.Links = Links;
if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('DOMContentLoaded', () => Links.init());
if (typeof module !== 'undefined' && module.exports) module.exports = Links;
