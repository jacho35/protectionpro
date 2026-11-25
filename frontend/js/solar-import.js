/* SolarImport — reads PVsyst module (.PAN) and inverter (.OND) files and CSV tables into Solar library entries.
 * Pure (no DOM): returns entries in the shape Solar.validatePanel / validateInverter check, so the project Library tab
 * adds them exactly as if they had been typed. Nothing here touches a user library; the caller puts them in the
 * project's own list (settings.solar.customPanels / customInverters).
 *
 * .PAN / .OND are INI-like: `Key=value` lines, nested objects closed by `End of PVObject …`. Only the keys below are read;
 * unknown keys are ignored. Values PVsyst files do not carry are DERIVED and listed in `entry.derived` so the UI can say so:
 *   - Vmp temperature coefficient = power coeff − Isc coeff (Pmp ≈ Vmp × Imp)
 *   - NOCT defaults to 44 °C (PVsyst keeps its own thermal model, not NOCT)
 *   - inverter fault current defaults to 1.1 × rated, and max Isc per MPPT is Solar's own 1.25 × max A (inverterBody)
 */
const SolarImport = {
  // Flatten a PVsyst file to {Key: value}: first occurrence wins; nested commercial block keys are kept as `Manufacturer`/`Model`.
  parseIni(text) {
    const out = {};
    for (const raw of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(raw);
      if (m && !(m[1] in out)) out[m[1]] = m[2];
    }
    return out;
  },
  _n(v) { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(x) ? x : NaN; },
  // PVsyst writes a list for some inverter voltages ("570,720,880"): take the first number.
  _first(v) { return this._n(String(v == null ? '' : v).split(',')[0]); },

  // The points of a nested profile (`Key=TCubicProfile` … `Point_n=a,b` … `End of TCubicProfile`) as [[a, b], …].
  _profile(text, key) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/), pts = [];
    let on = false;
    for (const raw of lines) {
      if (!on) { if (new RegExp('^\\s*' + key + '\\s*=').test(raw)) on = true; continue; }
      if (/^\s*End of TCubicProfile/i.test(raw)) break;
      const m = /^\s*Point_\d+\s*=\s*([-+0-9.eE]+)\s*,\s*([-+0-9.eE]+)/.exec(raw);
      if (m) pts.push([parseFloat(m[1]), parseFloat(m[2])]);
    }
    return pts;
  },

  parsePan(text) {
    const k = this.parseIni(text), n = (x) => this._n(k[x]);
    const derived = [];
    const w = n('PNom'), voc = n('Voc'), vmp = n('Vmp'), isc = n('Isc'), imp = n('Imp');
    // PVsyst: muVocSpec mV/°C (module), muISC mA/°C, muPmpReq %/°C
    const betaVoc = n('muVocSpec') / voc / 10;
    const iscPct = n('muISC') / isc / 10;
    const kPmax = n('muPmpReq');
    const gammaVmp = kPmax - (isFinite(iscPct) ? iscPct : 0);
    derived.push('Vmp coefficient', 'NOCT');
    const width = n('Width'), height = n('Height');
    const name = [k.Manufacturer, k.Model].filter(Boolean).join(' ') || k.Model || '';
    const iam = this._profile(text, 'IAMProfile').filter(q => isFinite(q[0]) && isFinite(q[1]));      // the manufacturer's incidence-angle table (angle deg, factor)
    const e = { name, w, voc, vmp, isc, imp, beta_voc: this._r(betaVoc, 3), gamma_vmp: this._r(gammaVmp, 3), k_pmax: kPmax,
      len: Math.max(width || NaN, height || NaN), wid: Math.min(width || NaN, height || NaN), noct: 44,
      sysv: isFinite(n('VMaxIEC')) && n('VMaxIEC') > 0 ? n('VMaxIEC') : (isFinite(n('VMaxUL')) ? n('VMaxUL') : 1000), derived };
    if (iam.length >= 3) e.iam = iam;
    return e;
  },

  // Real .OND files (checked against a Chint Power CPS SCH275KTL file): the nominal AC power is PNomConv in kW (older files carry
  // Pnom in W), PMaxOUT the largest AC output, MonoTri / TPhase the phases, IMaxDC the total DC current over NbMPPT trackers.
  parseOnd(text) {
    const k = this.parseIni(text), n = (x) => this._n(k[x]);
    const derived = ['Fault current'];
    let acKw = n('PNomConv');
    if (!(acKw > 0)) acKw = n('PMaxOUT');
    if (!(acKw > 0) && n('Pnom') > 0) acKw = n('Pnom') / 1000;
    if (!(acKw > 0) && n('PmaxOUT') > 0) acKw = n('PmaxOUT') / 1000;
    const mppt = n('NbMPPT') > 0 ? n('NbMPPT') : n('NbInputs');
    const eff = n('EfficEuro') > 0 ? n('EfficEuro') : n('EfficMax');
    const ph = k.MonoTri || k.TPhase || '';
    const phases = /^tri/i.test(ph) ? 3 : /^mono/i.test(ph) ? 1 : 3;
    if (!ph) derived.push('Phases');
    const name = [k.Manufacturer, k.Model].filter(Boolean).join(' ') || k.Model || '';
    const out = { name, ac_kw: this._r(acKw, 3), phases, dc_max_v: this._first(k.VAbsMax), mppt_min_v: this._first(k.VMppMin),
      mppt_max_v: this._first(k.VMPPMax), mppt_count: mppt, mppt_max_a: this._r(n('IMaxDC') / mppt, 2), eff_pct: eff,
      fault_x: 1.1, derived };
    // The efficiency curve (ProfilPIO: DC input W, AC output W) as [relative DC load, efficiency], the load taken against the
    // nominal DC input (PNomDC kW, else the AC rating over the Euro efficiency).
    const dcNom = (n('PNomDC') > 0 ? n('PNomDC') : acKw / (eff / 100)) * 1000;
    const pts = this._profile(text, 'ProfilPIO').filter(q => q[0] > 0 && q[1] >= 0 && q[1] <= q[0] * 1.001).sort((a, b) => a[0] - b[0]);
    if (pts.length >= 3 && dcNom > 0) out.eff_curve = pts.map(q => [this._r(q[0] / dcNom, 5), this._r(Math.min(1, q[1] / q[0]), 5)]);
    return out;
  },

  _r(x, d) { return isFinite(x) ? Math.round(x * Math.pow(10, d)) / Math.pow(10, d) : x; },

  // CSV with a header row. Columns are the library field keys (w, voc, …, ac_kw, …) or the aliases below.
  ALIASES: {
    name: ['name', 'model', 'description'], w: ['w', 'pmax', 'pmax_w', 'power_w', 'pnom'], voc: ['voc', 'voc_v'], vmp: ['vmp', 'vmp_v'],
    isc: ['isc', 'isc_a'], imp: ['imp', 'imp_a'], beta_voc: ['beta_voc', 'voc_coeff', 'k_voc', 'k_voc_pct'],
    gamma_vmp: ['gamma_vmp', 'vmp_coeff', 'k_vmp', 'k_vmp_pct'], k_pmax: ['k_pmax', 'pmax_coeff', 'power_coeff', 'k_pmax_pct'],
    len: ['len', 'length', 'length_m'], wid: ['wid', 'width', 'width_m'], noct: ['noct', 'noct_c'], sysv: ['sysv', 'max_system_v', 'system_v'],
    ac_kw: ['ac_kw', 'pac_kw', 'rated_kw', 'power_kw'], phases: ['phases'], dc_max_v: ['dc_max_v', 'max_dc_v', 'vdc_max'],
    mppt_min_v: ['mppt_min_v', 'mppt_min'], mppt_max_v: ['mppt_max_v', 'mppt_max'], mppt_count: ['mppt_count', 'mppts', 'mppt_inputs'],
    mppt_max_a: ['mppt_max_a', 'max_a_per_mppt', 'imax_mppt'], eff_pct: ['eff_pct', 'efficiency', 'efficiency_pct'],
    fault_x: ['fault_x', 'fault_x_rated'],
  },
  _splitCsv(line) {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === ',' && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  },
  // → { kind: 'panel' | 'inv', entries: [...] }; kind is decided from the header (an ac_kw column = inverters)
  parseCsv(text) {
    const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return { kind: '', entries: [] };
    const head = this._splitCsv(lines[0]).map(h => h.toLowerCase().replace(/[\s()%/°-]+/g, '_').replace(/^_|_$/g, ''));
    const key = (h) => { for (const f in this.ALIASES) if (this.ALIASES[f].includes(h)) return f; return null; };
    const cols = head.map(key);
    const kind = cols.includes('ac_kw') ? 'inv' : cols.includes('w') ? 'panel' : '';
    if (!kind) return { kind: '', entries: [] };
    const entries = lines.slice(1).map(l => {
      const cells = this._splitCsv(l), e = { derived: [] };
      cols.forEach((f, i) => { if (f) e[f] = f === 'name' ? cells[i] : this._n(cells[i]); });
      if (kind === 'panel') {
        if (!(e.noct > 0)) { e.noct = 44; e.derived.push('NOCT'); }
        if (!isFinite(e.gamma_vmp) && isFinite(e.k_pmax)) { e.gamma_vmp = e.k_pmax; e.derived.push('Vmp coefficient'); }
      } else {
        if (!(e.phases > 0)) { e.phases = 3; e.derived.push('Phases'); }
        if (!(e.fault_x > 0)) { e.fault_x = 1.1; e.derived.push('Fault current'); }
      }
      return e;
    });
    return { kind, entries };
  },

  // Read one file by extension. → { kind, entries: [{entry}], skipped: [reason] }; nothing is added here.
  // `validate` is Solar.validatePanel / validateInverter for the kind; `existing` the names already in the project library.
  fromFile(fileName, text, validate, existing) {
    const ext = String(fileName).toLowerCase().split('.').pop();
    let kind, list;
    if (ext === 'pan') { kind = 'panel'; list = [this.parsePan(text)]; }
    else if (ext === 'ond') { kind = 'inv'; list = [this.parseOnd(text)]; }
    else if (ext === 'csv') { ({ kind, entries: list } = this.parseCsv(text)); }
    else return { kind: '', entries: [], skipped: [`${fileName}: use a .pan, .ond or .csv file.`] };
    if (!kind) return { kind: '', entries: [], skipped: [`${fileName}: the CSV needs a header with a w (module) or ac_kw (inverter) column.`] };
    const have = new Set((existing || []).map(s => String(s).toLowerCase()));
    const entries = [], skipped = [];
    list.forEach((e, i) => {
      const err = validate(kind, e);
      const label = e.name || `${fileName} row ${i + 1}`;
      if (err) skipped.push(`${label}: ${err}`);
      else if (have.has(String(e.name).toLowerCase())) skipped.push(`${label}: already in this project's library.`);
      else { have.add(String(e.name).toLowerCase()); entries.push(e); }
    });
    return { kind, entries, skipped };
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = SolarImport;
