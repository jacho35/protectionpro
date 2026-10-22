/* ProtectionPro — Room lighting data (Plan › Lighting).
 *
 * What a room needs to be designed and judged: the task it is used for (its
 * targets), the geometry the calculation needs beyond the floor outline
 * (ceiling height, work plane, wall zone) and the surface finish (reflectances,
 * maintenance factor). Stored flat on the room as `room.lighting`; a room
 * without it behaves exactly as before.
 *
 * The project picks the standard the targets come from
 * (`AppState.planMarkup.settings.lightingStandard`: 'EN' = EN 12464-1:2021,
 * 'SANS' = SANS 10114-1:2020; absent ⇒ EN). ROOM_TASKS holds the EN 12464-1
 * rows: Ēm (required), Uo, Ra, UGR and the Ēz / wall / ceiling targets of
 * the chapter 7 tables. SANS 10114-1 Table 1 gives only Ēm, UGR and Ra, so
 * ROOM_TASKS_SANS overrides just those where they differ and every other
 * target (Uo, Ēz, walls, ceiling) stays the EN 12464-1 value. A task with
 * no SANS row of its own (archives) uses the EN row.
 */

// key → { group, name, em (lx maintained), uo, ugr (limit), ra (min), ez (lx, 0 = none), wall, ceil (lx) }
const ROOM_TASKS = {
  off_filing:    { group: 'Offices', name: 'Filing, copying, circulation', em: 300, uo: 0.40, ugr: 19, ra: 80, ez: 100, wall: 100, ceil: 75 },
  off_writing:   { group: 'Offices', name: 'Writing, typing, reading, data processing', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150, wall: 150, ceil: 100 },
  off_cad:       { group: 'Offices', name: 'CAD workstations', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150, wall: 150, ceil: 100 },
  off_drawing:   { group: 'Offices', name: 'Technical drawing', em: 750, uo: 0.70, ugr: 16, ra: 80, ez: 150, wall: 150, ceil: 100 },
  off_meeting:   { group: 'Offices', name: 'Conference and meeting rooms', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150, wall: 150, ceil: 100 },
  off_reception: { group: 'Offices', name: 'Reception desk', em: 300, uo: 0.60, ugr: 22, ra: 80, ez: 100, wall: 100, ceil: 75 },
  off_archive:   { group: 'Offices', name: 'Archives', em: 200, uo: 0.40, ugr: 25, ra: 80, ez: 75, wall: 75, ceil: 50 },
  edu_class:     { group: 'Education', name: 'Classrooms, tutorial rooms', em: 500, uo: 0.60, ugr: 19, ra: 80, ez: 150, wall: 150, ceil: 100 },
  retail_sales:  { group: 'Retail', name: 'Sales area', em: 300, uo: 0.40, ugr: 22, ra: 80, ez: 75, wall: 75, ceil: 30 },
  ind_rough:     { group: 'Industry', name: 'Rough assembly', em: 300, uo: 0.60, ugr: 25, ra: 80, ez: 100, wall: 100, ceil: 50 },
  ind_medium:    { group: 'Industry', name: 'Medium assembly', em: 500, uo: 0.60, ugr: 22, ra: 80, ez: 150, wall: 150, ceil: 100 },
  ind_fine:      { group: 'Industry', name: 'Fine assembly', em: 750, uo: 0.70, ugr: 19, ra: 80, ez: 150, wall: 150, ceil: 100 },
  gen_corridor:  { group: 'General areas', name: 'Circulation areas and corridors', em: 100, uo: 0.40, ugr: 28, ra: 40, ez: 50, wall: 50, ceil: 30 },
  gen_stairs:    { group: 'General areas', name: 'Stairs', em: 100, uo: 0.40, ugr: 25, ra: 40, ez: 50, wall: 50, ceil: 30 },
  gen_lobby:     { group: 'General areas', name: 'Entrance halls', em: 100, uo: 0.40, ugr: 22, ra: 80, ez: 50, wall: 50, ceil: 30 },
  gen_canteen:   { group: 'General areas', name: 'Canteens, pantries', em: 200, uo: 0.40, ugr: 22, ra: 80, ez: 75, wall: 75, ceil: 50 },
  gen_wc:        { group: 'General areas', name: 'Washrooms, bathrooms, toilets', em: 200, uo: 0.40, ugr: 25, ra: 80, ez: 75, wall: 75, ceil: 50 },
  gen_store:     { group: 'General areas', name: 'Storage rooms', em: 100, uo: 0.40, ugr: 25, ra: 80, ez: 50, wall: 50, ceil: 30 },
  gen_plant:     { group: 'General areas', name: 'Plant rooms, switchgear', em: 200, uo: 0.40, ugr: 25, ra: 80, ez: 50, wall: 50, ceil: 30 },
  gen_carpark:   { group: 'General areas', name: 'Car park (indoor) — traffic lanes', em: 75, uo: 0.40, ugr: 25, ra: 40, ez: 50, wall: 50, ceil: 30 },
  gen_parking:   { group: 'General areas', name: 'Car park (indoor) — parking areas', em: 75, uo: 0.25, ugr: 40, ra: 40, ez: 50, wall: 30, ceil: 15 },
};

// SANS 10114-1:2020 Table 1 where it differs from EN 12464-1 (Ēm, UGR, Ra only).
const ROOM_TASKS_SANS = {
  off_filing:   { ugr: 22 },
  edu_class:    { em: 300 },
  gen_corridor: { ra: 60 },
  gen_stairs:   { em: 150, ra: 60 },
  gen_lobby:    { ra: 60 },
  gen_store:    { ra: 60 },
  gen_plant:    { ra: 60 },
  gen_carpark:  { ra: 60 },
  gen_parking:  { ugr: 28, ra: 60 },
};

const LIGHTING_STANDARDS = {
  EN:   { label: 'EN 12464-1:2021 / EN 1838', room: 'EN 12464-1:2021', emerg: 'EN 1838:1999' },
  SANS: { label: 'SANS 10114-1:2020 / SANS 10114-2', room: 'SANS 10114-1:2020', emerg: 'SANS 10114-2:2020' },
};

const RoomLighting = {
  DEFAULTS: { emerg: 'none', tD: 2250, tN: 250, fo: 1, fd: 1, fc: 1, task: 'off_writing', ceilH: 2.7, workH: 0.75, wallZone: 0.5, rhoC: 0.7, rhoW: 0.5, rhoF: 0.2, mf: 0.8, wallE: 75, ceilE: 50, grid: 0 },

  // The project's lighting standard ('EN' unless set to 'SANS').
  standard() {
    const s = typeof AppState !== 'undefined' && AppState.planMarkup && AppState.planMarkup.settings;
    return s && s.lightingStandard === 'SANS' ? 'SANS' : 'EN';
  },
  setStandard(std) {
    AppState.planMarkup.settings.lightingStandard = std === 'SANS' ? 'SANS' : 'EN';
  },
  // The task row under the project's standard (EN row with the SANS differences laid over it).
  task(key) {
    const T = ROOM_TASKS[key];
    if (!T) return null;
    return this.standard() === 'SANS' ? Object.assign({}, T, ROOM_TASKS_SANS[key] || {}) : T;
  },
  tableNote() {
    const S = LIGHTING_STANDARDS[this.standard()];
    return this.standard() === 'SANS'
      ? `Targets: ${S.room} Table 1 (Ēm, UGR, Ra); Uo, Ēz, wall and ceiling targets are not given there and follow EN 12464-1:2021.`
      : `Targets: ${S.room}, the required (not the modified) Ēm.`;
  },
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
    const T = this.task(task) || this.task(D.task);
    // A table task that has not been edited follows the table (so a change of standard moves it);
    // an edited or custom room keeps what was entered.
    const S = (task !== 'custom' && !L.edited) ? {} : L;
    return {
      task,
      em: this._num(S.em, T.em, 1, 20000), uo: this._num(S.uo, T.uo, 0, 1),
      ugr: this._num(S.ugr, T.ugr, 10, 40), ra: this._num(S.ra, T.ra, 0, 100),
      ez: this._num(S.ez, T.ez, 0, 5000),
      wallE: this._num(S.wallE, task === 'custom' ? D.wallE : T.wall, 0, 5000), ceilE: this._num(S.ceilE, task === 'custom' ? D.ceilE : T.ceil, 0, 5000),
      ceilH: this._num(L.ceilH, D.ceilH, 1.5, 30), workH: this._num(L.workH, D.workH, 0, 5),
      wallZone: this._num(L.wallZone, D.wallZone, 0, 2),
      rhoC: this._num(L.rhoC, D.rhoC, 0, 1), rhoW: this._num(L.rhoW, D.rhoW, 0, 1), rhoF: this._num(L.rhoF, D.rhoF, 0, 1),
      mf: this._num(L.mf, D.mf, 0.3, 1),
      grid: this._num(L.grid, 0, 0, 5),   // calculation grid (m); 0 = automatic
      emerg: ['none', 'open', 'highrisk'].includes(L.emerg) ? L.emerg : 'none',
      tD: this._num(L.tD, D.tD, 0, 8760), tN: this._num(L.tN, D.tN, 0, 8760),
      fo: this._num(L.fo, D.fo, 0, 1), fd: this._num(L.fd, D.fd, 0, 1), fc: this._num(L.fc, D.fc, 0.5, 1),
      lpd: this._num(L.lpd, 0, 0, 1000),
      edited: !!L.edited,
    };
  },

  // Task change: targets come from the table; geometry/finish are kept.
  applyTask(room, key) {
    const cur = this.read(room);
    const T = this.task(key);
    room.lighting = Object.assign({}, room.lighting || {}, cur, { task: key, edited: false });
    if (T) Object.assign(room.lighting, { em: T.em, uo: T.uo, ugr: T.ugr, ra: T.ra, ez: T.ez, wallE: T.wall, ceilE: T.ceil });
  },

  set(room, field, value) {
    if (field === 'task') { this.applyTask(room, value); return; }
    const cur = this.read(room);
    if (!(field in cur) || field === 'edited' || field === 'task') return;
    const L = Object.assign({}, cur, { [field]: value });
    L.edited = ['em', 'uo', 'ugr', 'ra', 'ez', 'wallE', 'ceilE'].includes(field) ? true : cur.edited;
    room.lighting = this.read({ lighting: L });
    room.lighting.edited = L.edited;
  },

  // LENI (kWh/m²·yr) by the EN 15193-1 quick method and the power-density check.
  energy(room, res) {
    const L = this.read(room);
    const watts = res && res.power ? res.power.watts : 0, area = res ? res.area : 0;
    if (!(watts > 0) || !(area > 0)) return null;
    const kwh = watts * L.fc * (L.tD * L.fo * L.fd + L.tN * L.fo) / 1000.0;
    const out = { leni: kwh / area, kwh, wm2: watts / area, lpd: L.lpd };
    out.lpdPass = L.lpd > 0 ? out.wm2 <= L.lpd + 1e-9 : null;
    return out;
  },

  // ─── Properties panel section ───
  typeSelect(room) {
    const k = room.kind || 'room';
    return `<label class="plan-field"><span>Type</span><select data-rl-kind style="width:100%">
      <option value="room"${k === 'room' ? ' selected' : ''}>Room (indoor)</option>
      <option value="outdoor"${k === 'outdoor' ? ' selected' : ''}>Outdoor area</option>
      <option value="perimeter"${k === 'perimeter' ? ' selected' : ''}>Perimeter / fence</option>
      <option value="escape"${k === 'escape' ? ' selected' : ''}>Escape route</option></select></label>`;
  },

  // Project-wide: the standard the indoor targets and the emergency limits come from.
  standardSelect() {
    const cur = this.standard();
    return `<label class="plan-field"><span>Standard</span><select data-rl-standard style="width:100%">${Object.entries(LIGHTING_STANDARDS).map(([k, v]) =>
      `<option value="${k}"${k === cur ? ' selected' : ''}>${escHtml(v.label)}</option>`).join('')}</select></label>`;
  },

  panel(room) {
    if (room.kind === 'escape' && typeof EmergCalc !== 'undefined') return EmergCalc.routePanel(room);
    if ((room.kind === 'outdoor' || room.kind === 'perimeter') && typeof AreaCalc !== 'undefined') return AreaCalc.panel(room);
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
      ${this.typeSelect(room)}
      ${typeof Light3D !== 'undefined' ? '<button type="button" class="plan-circuit-btn" data-rl-3d style="margin:2px 0 6px">View in 3D — add desks, shelving, windows…</button>' : ''}
      ${this.standardSelect()}
      <label class="plan-field"><span>Task</span><select data-rl="task" style="width:100%">${opts}</select></label>
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px">
        ${num('em', 'Ēm', 'lx', 10, 'min="1"')}${num('uo', 'U₀', '', 0.05, 'min="0" max="1"')}
        ${num('ugr', 'UGR limit', '', 1, 'min="10" max="40"')}${num('ra', 'Ra min', '', 5, 'min="0" max="100"')}
        ${num('wallE', 'Walls Ēm', 'lx', 5, 'min="0"')}${num('ceilE', 'Ceiling Ēm', 'lx', 5, 'min="0"')}
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin:4px 0 8px">${L.edited ? 'Edited. ' : ''}${escHtml(this.tableNote())}${L.edited && L.task !== 'custom' ? ' <button type="button" class="btn-small" data-rl-reset>Reset to table</button>' : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
        ${num('ceilH', 'Ceiling', 'm', 0.1, 'min="1.5"')}${num('workH', 'Work plane', 'm', 0.05, 'min="0"')}${num('wallZone', 'Wall zone', 'm', 0.1, 'min="0"')}
        ${num('rhoC', 'ρ ceiling', '', 0.05, 'min="0" max="1"')}${num('rhoW', 'ρ walls', '', 0.05, 'min="0" max="1"')}${num('rhoF', 'ρ floor', '', 0.05, 'min="0" max="1"')}
      </div>
      <label class="plan-field" style="margin-top:6px"><span>Maintenance factor</span>
        <input type="number" data-rl="mf" value="${L.mf}" step="0.01" min="0.3" max="1" style="width:100%">
        <select data-rl-mfpreset style="width:100%"><option value="">Presets…</option>${this.MF_PRESETS.map(([v, n]) => `<option value="${v}">${v} — ${escHtml(n)}</option>`).join('')}</select></label>
      <label class="plan-field" style="margin-top:6px"><span>Calculation grid</span>
        <input type="number" data-rl="grid" value="${L.grid > 0 ? L.grid : ''}" step="0.05" min="0.05" max="5" placeholder="automatic" style="width:100%"><small>m — blank = automatic</small></label>
      <div style="font-size:11px;color:var(--text-muted)">Automatic follows the EN 12464-1 maximum for the room's size, at most 0.5 m.</div>
      <div style="margin-top:8px;border-top:1px solid var(--border,#d9dee4);padding-top:8px">
        <div class="plan-props-title" style="font-size:13px">Energy</div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
          ${num('tD', 'Day hours', 'h/yr', 50, 'min="0" max="8760"')}${num('tN', 'Night hours', 'h/yr', 50, 'min="0" max="8760"')}${num('lpd', 'Limit W/m²', '0 = none', 0.5, 'min="0"')}
          ${num('fo', 'F occupancy', '', 0.05, 'min="0" max="1"')}${num('fd', 'F daylight', '', 0.05, 'min="0" max="1"')}${num('fc', 'F constant-lux', '', 0.05, 'min="0.5" max="1"')}
        </div>
        <div style="font-size:11px;color:var(--text-muted)">LENI by the EN 15193-1 quick method, without parasitic and emergency standby energy. Enter the power-density limit from your regulation (e.g. SANS 10400-XA) to have it checked.</div>
      </div>
      ${typeof EmergCalc !== 'undefined' ? EmergCalc.roomSection(room) : ''}
      ${typeof RoomCalc !== 'undefined' ? RoomCalc.layoutHtml(room) + RoomCalc.resultHtml(room) : ''}
    </div>`;
  },

  // ─── Tooltips ───
  // What each entry box means, shown on hover / long-press and read out as the
  // field's description. Keyed by the control's data attribute, per panel.
  TIPS: {
    rl: {
      task: 'The visual task done in this room. Picks the target average lux, uniformity, glare limit and Ra from the standard\'s table. Change a value below to override it.',
      em: 'Maintained average illuminance required on the work plane, in lux. Comes from the task table; editing it makes the targets your own.',
      uo: 'Minimum uniformity U₀ = lowest ÷ average illuminance on the work plane (0–1). Typical targets are 0.4 to 0.7.',
      ugr: 'Glare limit: the calculated Unified Glare Rating (CIE 117) must not exceed this. Lower means less glare; offices are usually 19.',
      ra: 'Minimum colour rendering index (0–100) the light source must have. Not calculated here: check it on the luminaire data sheet.',
      wallE: 'Required average illuminance on the walls, in lux. Leave at 0 if the standard sets no wall requirement for this task.',
      ceilE: 'Required average illuminance on the ceiling, in lux. Leave at 0 if there is no ceiling requirement.',
      ceilH: 'Floor-to-ceiling height in metres. Recessed and surface fittings are taken to be at this height.',
      workH: 'Height above the floor of the plane where the task is done, in metres. 0.75 for a desk; 0 for floor-level tasks.',
      wallZone: 'Strip along the walls, in metres, left out of the average and uniformity. Standards usually allow 0.5 m. 0 includes the whole room.',
      rhoC: 'Ceiling reflectance (0–1): the share of light the surface reflects. White ceiling about 0.7.',
      rhoW: 'Wall reflectance (0–1). Light-coloured walls about 0.5, dark about 0.2.',
      rhoF: 'Floor reflectance (0–1). Typical floors are 0.2.',
      mf: 'Maintenance factor (0.3–1): the share of the initial light still delivered after lamp ageing and dirt. All results are maintained values. About 0.8 for LED in a clean room.',
      grid: 'Spacing of the calculation points, in metres. Blank = automatic (the EN 12464 maximum for the room, at most 0.5 m). A finer grid is more exact and slower.',
      tD: 'Hours per year the lighting is on during daylight hours. Used for the energy figure (LENI). Offices: about 2250.',
      tN: 'Hours per year the lighting is on outside daylight hours. Offices: about 250.',
      lpd: 'Power-density limit in W/m² from your regulation (e.g. SANS 10400-XA). The result is checked against it. 0 = no limit checked.',
      fo: 'Occupancy factor (0–1): the share of the time the lights are on when the room is occupied. 1 = no presence control.',
      fd: 'Daylight factor (0–1): 1 = no daylight control; lower values mean daylight dims or switches the lights.',
      fc: 'Constant-illuminance factor (0.5–1): 1 = no control. About 0.9 when the output is dimmed to hold the maintained level.',
      emerg: 'Check this room\'s emergency lighting: as an open (anti-panic) area, or as a high-risk task area. Emergency fittings are those with an Emergency output % or kind Emergency.',
    },
    ac: {
      task: 'The outdoor task. Picks the target illuminance, uniformity and glare limit from the EN 12464-2 table. Change a value to override it.',
      em: 'Maintained average illuminance required on the ground, in lux.',
      uo: 'Minimum uniformity U₀ = lowest ÷ average ground illuminance (0–1).',
      gr: 'Glare Rating limit (CIE 112): the calculated GR must not exceed this.',
      groundRho: 'Reflectance of the ground (0.01–0.9). Dark asphalt about 0.07; light concrete about 0.3.',
      mf: 'Maintenance factor (0.3–1): the share of the initial light still delivered after ageing and dirt. About 0.8 for LED.',
      grid: 'Spacing of the calculation points, in metres. Blank = automatic (the EN 12464-2 maximum for the size, 0.5–2 m).',
      closed: 'Tick when the fence or boundary goes all the way round (a ring). Leave unticked for an open line.',
      side: 'Which face of the fence is measured: outward or inward for a ring, left or right of the drawn direction for an open line. Ticks on the plan show it.',
      evMin: 'Minimum vertical illuminance required on the measured face, in lux. A site-security target you set.',
      evRatio: 'Required minimum ÷ average vertical illuminance (0–1), a uniformity along the line.',
      height: 'Height above the ground of the measured line, in metres. 1.5 m is face height.',
      step: 'Distance between measurement points along the line, in metres.',
    },
    em: {
      width: 'Clear width of the escape route in metres. Sets the band either side of the centre line over which emergency illuminance is checked.',
      mf: 'Maintenance factor (0.3–1) for the emergency fittings: the share of light still delivered at the end of the battery duration.',
    },
    key: {
      name: 'A label for this item, shown on the plan and in the reports.',
      symScale: 'Draws this one symbol larger or smaller on the plan (1 = standard). It does not change the calculation.',
      kind: 'What the fitting is. Outdoor kinds (Floodlight, Area light) count in outdoor areas and fences; Emergency and Exit count in emergency lighting; the rest count in the room they are inside.',
      watts: 'Electrical load of the fitting in watts, including the driver. Used for circuits, energy and W/m².',
      lumens: 'Luminous flux of the fitting in lumens. Leave blank to use the luminaire library entry\'s flux.',
      photoId: 'The luminaire from the library whose light distribution is used in the calculation. A fitting with none is not calculated.',
      mount: 'How the fitting is mounted. Recessed and surface sit at ceiling height; suspended hangs below it by the drop.',
      drop: 'How far a suspended fitting hangs below the ceiling, in metres.',
      fluxPct: 'Light output as a percentage of full output (100 = undimmed). Use it for dimmed or reduced-output fittings.',
      emergPct: 'Output on battery as a percentage of full output. 0 = not an emergency fitting. Fittings above 0 count in the emergency calculation.',
      mountH: 'Height of an outdoor fitting above the ground, in metres (pole or mast height).',
      tilt: 'Tilt of an outdoor fitting from straight down, in degrees, towards the front of the fitting. 0 = pointing straight down.',
    },
    misc: {
      'data-rl-kind': 'What this shape is assessed as: an indoor room, an outdoor area, a fence line (vertical lux) or an escape route.',
      'data-rl-standard': 'Project-wide. Chooses where the task targets and emergency limits come from: EN 12464-1 / EN 1838, or SANS 10114-1 / -2.',
      'data-rl-mfpreset': 'Fills in the maintenance factor for a typical environment and cleaning interval. You can still edit the number.',
      'data-rc-lum': 'The luminaire from the library that the suggested layouts use.',
      'data-ac-lum': 'The luminaire from the library that the suggested layouts use.',
      'data-ac-h': 'Mounting height of the poles in the suggested layout, in metres.',
      'data-ac-tilt': 'Tilt of the luminaires in the suggested layout from straight down, in degrees.',
    },
  },

  // Put the tips on the controls (and their labels) under `root`. `itemType`
  // is set for a placed element's panel, whose fields use data-key.
  tipify(root, itemType) {
    if (!root) return;
    const set = (ctl, tip) => {
      if (!tip) return;
      ctl.title = tip;
      const lab = ctl.closest('label') || (ctl.parentElement && ctl.parentElement.querySelector('.plan-field-label'));
      if (lab) { lab.title = tip; (lab.closest('.plan-field') || lab).classList.add('has-tip'); }
    };
    const T = this.TIPS;
    root.querySelectorAll('[data-rl], [data-ac], [data-em]').forEach(c => {
      const d = c.dataset;
      set(c, d.rl !== undefined ? T.rl[d.rl] : d.ac !== undefined ? T.ac[d.ac] : T.em[d.em]);
    });
    for (const [attr, tip] of Object.entries(T.misc)) root.querySelectorAll('[' + attr + ']').forEach(c => set(c, tip));
    root.querySelectorAll('[data-key]').forEach(c => {
      const k = c.dataset.key;
      set(c, k === 'name' ? T.key.name : itemType === 'bd_light' ? T.key[k] : (k === 'symScale' ? T.key[k] : null));
    });
  },

  _bound: false,
  bind(propsEl) {
    if (typeof RoomCalc !== 'undefined') RoomCalc.bind(propsEl);
    if (typeof AreaCalc !== 'undefined') AreaCalc.bind(propsEl);
    if (typeof EmergCalc !== 'undefined') EmergCalc.bind(propsEl);
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
      if (t.dataset && 'rlKind' in t.dataset) {
        const w = propsEl.querySelector('[data-rl-room], [data-ac-room]');
        const room = w && (AppState.planMarkup.rooms || []).find(r => r.id === (w.dataset.rlRoom || w.dataset.acRoom));
        if (room) {
          room.kind = t.value === 'room' ? undefined : t.value;
          if (room.kind === 'perimeter' && room.lighting && room.lighting.closed == null) room.lighting.closed = false;
          PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps(); PlanEngine.requestDraw({ fg: true });
        }
        return;
      }
      if (t.dataset && 'rlStandard' in t.dataset) {
        this.setStandard(t.value);
        PlanMarkup.snapshot(); PlanMarkup.markDirty(); PlanMarkup.refreshProps();
        PlanEngine.requestDraw({ fg: true });
        return;
      }
      if (t.dataset && t.dataset.rl) commit(room => this.set(room, t.dataset.rl, t.value));
      else if (t.dataset && 'rlMfpreset' in t.dataset && t.value) commit(room => this.set(room, 'mf', t.value));
    });
    propsEl.addEventListener('click', (e) => {
      if (e.target.closest('[data-rl-reset]')) commit(room => this.applyTask(room, this.read(room).task));
      if (e.target.closest('[data-rl-3d]') && typeof LightingWS !== 'undefined') {
        const wrap = propsEl.querySelector('[data-rl-room]');
        if (wrap) LightingWS.open3D(wrap.dataset.rlRoom);
      }
    });
  },
};
