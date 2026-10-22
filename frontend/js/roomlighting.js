/* ProtectionPro — Room lighting data (Plan › Lighting).
 *
 * What a room needs to be designed and judged: the task it is used for (its
 * targets), the geometry the calculation needs beyond the floor outline
 * (ceiling height, work plane, wall zone) and the surface finish (reflectances,
 * maintenance factor). Stored flat on the room as `room.lighting`; a room
 * without it behaves exactly as before.
 *
 * The task table below is a PROVISIONAL transcription of the common rows of
 * EN 12464-1:2021 (SANS 10114-1 follows the same values). Every value is
 * editable, and the panel says so; confirm it against the standard you design
 * to before issuing a result.
 */

const ROOM_TASK_TABLE_NOTE = 'Targets are provisional table values — confirm them against the standard you design to.';

// key → { group, name, em (lx maintained), uo, ugr (limit), ra (min), ez (lx, 0 = none) }
const ROOM_TASKS = {
  off_filing:    { group: 'Offices', name: 'Filing, copying, circulation', em: 300, uo: 0.40, ugr: 19, ra: 80, ez: 0 },
  off_writing:   { group: 'Offices', name: 'Writing, typing, reading, data processing', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150 },
  off_cad:       { group: 'Offices', name: 'CAD workstations', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150 },
  off_drawing:   { group: 'Offices', name: 'Technical drawing', em: 750, uo: 0.70, ugr: 16, ra: 80, ez: 150 },
  off_meeting:   { group: 'Offices', name: 'Conference and meeting rooms', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150 },
  off_reception: { group: 'Offices', name: 'Reception desk', em: 300, uo: 0.60, ugr: 22, ra: 80, ez: 0 },
  off_archive:   { group: 'Offices', name: 'Archives', em: 200, uo: 0.40, ugr: 25, ra: 80, ez: 0 },
  edu_class:     { group: 'Education', name: 'Classrooms, tutorial rooms', em: 300, uo: 0.60, ugr: 19, ra: 80, ez: 0 },
  retail_sales:  { group: 'Retail', name: 'Sales area', em: 300, uo: 0.40, ugr: 22, ra: 80, ez: 0 },
  ind_rough:     { group: 'Industry', name: 'Rough work and assembly', em: 300, uo: 0.40, ugr: 25, ra: 60, ez: 0 },
  ind_medium:    { group: 'Industry', name: 'Medium bench and machine work', em: 500, uo: 0.60, ugr: 22, ra: 80, ez: 0 },
  ind_fine:      { group: 'Industry', name: 'Fine assembly and inspection', em: 750, uo: 0.60, ugr: 19, ra: 80, ez: 0 },
  gen_corridor:  { group: 'General areas', name: 'Circulation areas and corridors', em: 100, uo: 0.40, ugr: 28, ra: 40, ez: 0 },
  gen_stairs:    { group: 'General areas', name: 'Stairs', em: 150, uo: 0.40, ugr: 25, ra: 40, ez: 0 },
  gen_lobby:     { group: 'General areas', name: 'Entrance halls', em: 100, uo: 0.40, ugr: 22, ra: 60, ez: 0 },
  gen_canteen:   { group: 'General areas', name: 'Canteens, pantries', em: 200, uo: 0.40, ugr: 22, ra: 80, ez: 0 },
  gen_wc:        { group: 'General areas', name: 'Washrooms, bathrooms, toilets', em: 200, uo: 0.40, ugr: 25, ra: 80, ez: 0 },
  gen_store:     { group: 'General areas', name: 'Storage rooms', em: 100, uo: 0.40, ugr: 25, ra: 60, ez: 0 },
  gen_plant:     { group: 'General areas', name: 'Plant rooms, switchgear', em: 200, uo: 0.40, ugr: 25, ra: 60, ez: 0 },
  gen_carpark:   { group: 'General areas', name: 'Car park (indoor)', em: 75, uo: 0.40, ugr: 25, ra: 40, ez: 0 },
};

const RoomLighting = {
  DEFAULTS: { task: 'off_writing', ceilH: 2.7, workH: 0.75, wallZone: 0.5, rhoC: 0.7, rhoW: 0.5, rhoF: 0.2, mf: 0.8, wallE: 75, ceilE: 50 },
  MF_PRESETS: [[0.8, 'Clean, LED, regular cleaning'], [0.67, 'Normal'], [0.57, 'Dirty, infrequent cleaning']],

  _num(v, d, lo, hi) {
    const x = parseFloat(v);
    if (!Number.isFinite(x)) return d;
    return Math.max(lo, Math.min(hi, x));
  },

  // A normalised copy of a room's lighting data (never trusts saved values).
  read(room) {
    const L = (room && room.lighting && typeof room.lighting === 'object') ? room.lighting : {};
    const D = this.DEFAULTS;
    const task = (L.task === 'custom' || ROOM_TASKS[L.task]) ? L.task : D.task;
    const T = ROOM_TASKS[task] || ROOM_TASKS[D.task];
    return {
      task,
      em: this._num(L.em, T.em, 1, 20000), uo: this._num(L.uo, T.uo, 0, 1),
      ugr: this._num(L.ugr, T.ugr, 10, 40), ra: this._num(L.ra, T.ra, 0, 100),
      ez: this._num(L.ez, T.ez, 0, 5000),
      wallE: this._num(L.wallE, D.wallE, 0, 5000), ceilE: this._num(L.ceilE, D.ceilE, 0, 5000),
      ceilH: this._num(L.ceilH, D.ceilH, 1.5, 30), workH: this._num(L.workH, D.workH, 0, 5),
      wallZone: this._num(L.wallZone, D.wallZone, 0, 2),
      rhoC: this._num(L.rhoC, D.rhoC, 0, 1), rhoW: this._num(L.rhoW, D.rhoW, 0, 1), rhoF: this._num(L.rhoF, D.rhoF, 0, 1),
      mf: this._num(L.mf, D.mf, 0.3, 1),
      edited: !!L.edited,
    };
  },

  // Task change: targets come from the table; geometry/finish are kept.
  applyTask(room, key) {
    const cur = this.read(room);
    const T = ROOM_TASKS[key];
    room.lighting = Object.assign({}, room.lighting || {}, cur, { task: key, edited: false });
    if (T) Object.assign(room.lighting, { em: T.em, uo: T.uo, ugr: T.ugr, ra: T.ra, ez: T.ez });
  },

  set(room, field, value) {
    if (field === 'task') { this.applyTask(room, value); return; }
    const cur = this.read(room);
    if (!(field in cur) || field === 'edited' || field === 'task') return;
    const L = Object.assign({}, cur, { [field]: value });
    L.edited = ['em', 'uo', 'ugr', 'ra', 'ez'].includes(field) ? true : cur.edited;
    room.lighting = this.read({ lighting: L });
    room.lighting.edited = L.edited;
  },

  // ─── Properties panel section ───
  panel(room) {
    const L = this.read(room);
    const f = PlanEngine.factor();
    const area = f ? PlanEngine._polyArea(room.points) * f * f : null;
    const groups = {};
    for (const [k, t] of Object.entries(ROOM_TASKS)) (groups[t.group] = groups[t.group] || []).push([k, t.name]);
    const opts = Object.entries(groups).map(([g, items]) =>
      `<optgroup label="${escHtml(g)}">${items.map(([k, n]) => `<option value="${k}"${k === L.task ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}</optgroup>`).join('')
      + `<option value="custom"${L.task === 'custom' ? ' selected' : ''}>Custom targets</option>`;
    const num = (key, label, unit, step, extra) => `<label class="plan-field"><span>${label}</span>
      <input type="number" data-rl="${key}" value="${L[key]}" step="${step}" ${extra || ''} style="width:100%"><small>${unit}</small></label>`;
    return `<div class="rl-room" data-rl-room="${escHtml(room.id)}" style="margin-top:12px;border-top:1px solid var(--border,#d9dee4);padding-top:10px">
      <div class="plan-props-title" style="font-size:13px">Lighting${area != null ? ` — ${(area).toFixed(1)} m²` : ''}</div>
      <label class="plan-field"><span>Task</span><select data-rl="task" style="width:100%">${opts}</select></label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        ${num('em', 'Ēm', 'lx', 10, 'min="1"')}${num('uo', 'U₀', '', 0.05, 'min="0" max="1"')}
        ${num('ugr', 'UGR limit', '', 1, 'min="10" max="40"')}${num('ra', 'Ra min', '', 5, 'min="0" max="100"')}
        ${num('wallE', 'Walls Ēm', 'lx', 5, 'min="0"')}${num('ceilE', 'Ceiling Ēm', 'lx', 5, 'min="0"')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin:4px 0 8px">${L.edited ? 'Edited. ' : ''}${ROOM_TASK_TABLE_NOTE}${L.edited && L.task !== 'custom' ? ' <button type="button" class="btn-small" data-rl-reset>Reset to table</button>' : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
        ${num('ceilH', 'Ceiling', 'm', 0.1, 'min="1.5"')}${num('workH', 'Work plane', 'm', 0.05, 'min="0"')}${num('wallZone', 'Wall zone', 'm', 0.1, 'min="0"')}
        ${num('rhoC', 'ρ ceiling', '', 0.05, 'min="0" max="1"')}${num('rhoW', 'ρ walls', '', 0.05, 'min="0" max="1"')}${num('rhoF', 'ρ floor', '', 0.05, 'min="0" max="1"')}
      </div>
      <label class="plan-field" style="margin-top:6px"><span>Maintenance factor</span>
        <input type="number" data-rl="mf" value="${L.mf}" step="0.01" min="0.3" max="1" style="width:100%">
        <select data-rl-mfpreset style="width:100%"><option value="">Presets…</option>${this.MF_PRESETS.map(([v, n]) => `<option value="${v}">${v} — ${escHtml(n)}</option>`).join('')}</select></label>
      ${typeof RoomCalc !== 'undefined' ? RoomCalc.layoutHtml(room) + RoomCalc.resultHtml(room) : ''}
    </div>`;
  },

  _bound: false,
  bind(propsEl) {
    if (typeof RoomCalc !== 'undefined') RoomCalc.bind(propsEl);
    if (this._bound || !propsEl) return;
    this._bound = true;
    const commit = (fn) => {
      const wrap = propsEl.querySelector('[data-rl-room]');
      const room = wrap && (AppState.planMarkup.rooms || []).find(r => r.id === wrap.dataset.rlRoom);
      if (!room) return;
      fn(room);
      PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
    };
    propsEl.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset && t.dataset.rl) commit(room => this.set(room, t.dataset.rl, t.value));
      else if (t.dataset && 'rlMfpreset' in t.dataset && t.value) commit(room => this.set(room, 'mf', t.value));
    });
    propsEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-rl-reset]')) commit(room => this.applyTask(room, this.read(room).task));
    });
  },
};
