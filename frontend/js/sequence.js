/* ProtectionPro — Protective Device Sequence of Operation study.
 *
 * Simulates the time-ordered operation of relays / circuit breakers / fuses for
 * a fault and verifies the primary → backup → final sequence and grading.
 * Reuses the TCC engine (TCC.computeSequenceOfOperation) for the trip-time,
 * protection-path and coordination logic; this module is the dedicated launcher,
 * fault-type / breaker-time setup, and the timeline report.
 *
 * Uses the existing fault-study results (both ik3 and ik1 are stored per bus,
 * so 3φ and SLG sequences need no re-run).
 */
const SOO = {
  _lastResult: null,
  _opts: null,

  _faultedBuses() {
    const fr = AppState.faultResults;
    if (!fr || !fr.buses) return [];
    return [...AppState.components.values()]
      .filter(c => c.type === 'bus' && fr.buses[c.id])
      .map(c => ({ id: c.id, name: c.props?.name || c.id }));
  },

  _fmtTime(t) {
    if (t == null || !isFinite(t) || t <= 0) return '—';
    return t >= 1 ? `${t.toFixed(2)} s` : `${(t * 1000).toFixed(0)} ms`;
  },

  _fmtCurrent(a) {
    if (a == null || !isFinite(a)) return '—';
    return a >= 1000 ? `${(a / 1000).toFixed(2)} kA` : `${a.toFixed(0)} A`;
  },

  // ── Setup modal ──────────────────────────────────────────────────────────
  openConfig(prefill = {}) {
    const modal = document.getElementById('sequence-config-modal');
    const body = document.getElementById('sequence-config-body');
    const runBtn = document.getElementById('btn-sequence-run');
    if (!modal || !body) return;

    const fr = AppState.faultResults;
    if (!fr || !fr.buses || !Object.keys(fr.buses).length) {
      body.innerHTML = '<p style="font-size:13px;margin:4px 0">Run <strong>Fault Analysis</strong> first — the sequence study reads the fault current at each bus.</p>';
      if (runBtn) runBtn.disabled = true;
      modal.style.display = '';
      return;
    }
    if (runBtn) runBtn.disabled = false;

    const buses = this._faultedBuses();
    const prev = this._opts || {};
    const ft = prefill.faultType || prev.faultType || '3ph';
    const selBus = (prefill.busId && fr.buses[prefill.busId]) ? prefill.busId : (prev.busId || 'all');
    const bt = prev.breakerTimeMs != null ? prev.breakerTimeMs : 50;

    body.innerHTML = `
      <style>
        .soo-cfg-row { display:flex; align-items:center; gap:10px; margin:8px 0; font-size:13px; }
        .soo-cfg-row > label { min-width:120px; font-weight:600; }
        .soo-cfg-row select, .soo-cfg-row input { font-size:13px; padding:3px 6px; }
      </style>
      <div class="soo-cfg-row">
        <label for="soo-fault-type">Fault type</label>
        <select id="soo-fault-type">
          <option value="3ph"${ft === '3ph' ? ' selected' : ''}>Three-phase (balanced)</option>
          <option value="slg"${ft === 'slg' ? ' selected' : ''}>Single-line-to-ground (earth)</option>
        </select>
      </div>
      <div class="soo-cfg-row">
        <label for="soo-bus">Fault location</label>
        <select id="soo-bus">
          <option value="all"${selBus === 'all' ? ' selected' : ''}>All faulted buses</option>
          ${buses.map(b => `<option value="${escHtml(b.id)}"${selBus === b.id ? ' selected' : ''}>${escHtml(b.name)}</option>`).join('')}
        </select>
      </div>
      <div class="soo-cfg-row">
        <label for="soo-breaker-ms">Breaker clearing</label>
        <span><input id="soo-breaker-ms" type="number" min="0" max="500" step="5" value="${bt}"> ms</span>
      </div>
      <p style="font-size:11px;color:var(--text-muted,#6d6d6d);margin:8px 0 0;line-height:1.5">
        The breaker clearing time is added to each circuit breaker's relay trip time to give the actual
        fault-clearing instant. The earliest-clearing device isolates the fault; slower backups then reset.
        A single-line-to-ground fault uses each bus's earth-fault current (ik1) and includes 50N/51N earth elements.
      </p>`;
    modal.style.display = '';
  },

  run() {
    const ftEl = document.getElementById('soo-fault-type');
    const busEl = document.getElementById('soo-bus');
    const msEl = document.getElementById('soo-breaker-ms');
    const faultType = ftEl ? ftEl.value : '3ph';
    const busSel = busEl ? busEl.value : 'all';
    const breakerTimeMs = msEl ? Math.max(0, +msEl.value || 0) : 50;
    this._opts = { faultType, breakerTimeMs, busId: busSel };

    // Standalone launch — the TCC modal may never have been opened, so its
    // device list is stale/empty. Rebuild it before tracing paths.
    if (typeof TCC !== 'undefined' && TCC._loadDevicesFromNetwork) TCC._loadDevicesFromNetwork();
    const busFilter = busSel === 'all' ? null : new Set([busSel]);
    const res = TCC.computeSequenceOfOperation({ faultType, breakerTimeS: breakerTimeMs / 1000, busFilter });

    const cfg = document.getElementById('sequence-config-modal');
    if (cfg) cfg.style.display = 'none';
    this._lastResult = res;
    this.show(res, { faultType, breakerTimeMs });
  },

  // ── Results modal ──────────────────────────────────────────────────────────
  show(res, meta = {}) {
    const modal = document.getElementById('sequence-modal');
    const body = document.getElementById('sequence-body');
    if (!modal || !body) return;
    body.innerHTML = this._render(res, meta);
    modal.style.display = '';
  },

  _render(res, meta) {
    if (res.error) return `<div class="soo-info">${escHtml(res.error)}</div>${this._style()}`;
    const buses = res.buses || [];
    if (!buses.length) return `<div class="soo-info">No faulted buses with protection devices on their source side.</div>${this._style()}`;

    const ftLabel = meta.faultType === 'slg' ? 'Single-line-to-ground (earth)' : 'Three-phase';
    const passed = buses.filter(b => b.passed).length;
    const totalViol = buses.reduce((s, b) => s + b.violations.length, 0);
    const verdictCls = totalViol === 0 ? 'soo-ok' : 'soo-bad';
    const verdict = totalViol === 0
      ? `All ${buses.length} location(s) verified — devices operate in the correct primary → backup → final sequence.`
      : `${passed}/${buses.length} location(s) passed — ${totalViol} coordination issue(s) found.`;

    let html = this._style();
    html += `<div class="soo-verdict ${verdictCls}">${escHtml(verdict)}</div>`;
    html += `<div class="soo-meta">Fault type: <strong>${escHtml(ftLabel)}</strong>${meta.breakerTimeMs != null ? ` · Breaker clearing: <strong>${meta.breakerTimeMs} ms</strong>` : ''}
      <button class="btn btn-small" id="soo-copy-btn" style="float:right">Copy report</button></div>`;

    for (const bus of buses) {
      html += this._busCard(bus);
    }
    return html;
  },

  _busCard(bus) {
    const cleared = bus.clearedAtS != null
      ? `Fault cleared at <strong>${this._fmtTime(bus.clearedAtS)}</strong> by <strong>${escHtml(bus.clearedBy)}</strong>`
      : '<strong>Fault NOT cleared</strong> — no device operates';
    const statusIcon = bus.passed ? '✅' : '❌';

    let h = `<div class="soo-card ${bus.passed ? 'soo-pass' : 'soo-fail'}">`;
    h += `<div class="soo-card-head">${statusIcon} <strong>${escHtml(bus.busName)}</strong>
      <span class="soo-fault">${this._fmtCurrent(bus.faultCurrentA)}</span></div>`;
    h += `<div class="soo-cleared ${bus.clearedAtS != null ? '' : 'soo-bad-text'}">${cleared}</div>`;

    h += this._timelineSvg(bus);

    // Operations table
    h += `<table class="soo-table"><thead><tr>
      <th>#</th><th>Device</th><th>Role</th><th>I seen</th><th>Trip</th><th>+Breaker</th><th>Clear</th><th>Status</th>
      </tr></thead><tbody>`;
    let n = 1;
    for (const op of bus.sequence) {
      const roleCls = `soo-role-${op.role || 'na'}`;
      let status, sCls;
      if (!op.operates) { status = 'Does not operate'; sCls = 'soo-st-fail'; }
      else if (op.name === bus.clearedBy) { status = 'Trips → clears fault'; sCls = 'soo-st-clear'; }
      else if (op.resets) { status = 'Resets (fault cleared first)'; sCls = 'soo-st-reset'; }
      else { status = 'Trips (backup)'; sCls = 'soo-st-trip'; }
      h += `<tr class="${op.resets ? 'soo-row-reset' : ''}">
        <td>${op.operates ? n++ : '—'}</td>
        <td>${escHtml(op.name)} <span class="soo-dtype">${escHtml(op.deviceType)}</span></td>
        <td class="${roleCls}">${escHtml(op.role || '—')}</td>
        <td>${this._fmtCurrent(op.currentA)}</td>
        <td>${op.operates ? this._fmtTime(op.tripTime) : '—'}</td>
        <td>${op.breakerTime ? this._fmtTime(op.breakerTime) : '—'}</td>
        <td>${op.operates ? this._fmtTime(op.clearTime) : '—'}</td>
        <td class="${sCls}">${status}</td>
      </tr>`;
    }
    h += '</tbody></table>';

    if (bus.violations.length) {
      const sev = { critical: '⛔', warning: '⚠', marginal: '△' };
      h += '<div class="soo-viol">';
      for (const v of bus.violations) {
        h += `<div class="soo-viol-item soo-sev-${v.severity}">${sev[v.severity] || ''} ${escHtml(v.message)}</div>`;
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  },

  // Absolute time-line: each operating device drawn as a bar from its trip time
  // to its clear time; a dashed marker at the fault-clearing instant.
  _timelineSvg(bus) {
    const ops = bus.sequence.filter(o => o.operates);
    if (!ops.length) return '';
    const W = 660, padL = 150, padR = 24, rowH = 22, top = 10;
    const H = top + ops.length * rowH + 34;
    const x0 = padL, x1 = W - padR;
    let tMax = 0;
    for (const o of ops) tMax = Math.max(tMax, o.clearTime);
    if (bus.clearedAtS) tMax = Math.max(tMax, bus.clearedAtS);
    if (!(tMax > 0)) tMax = 1;
    tMax *= 1.08;
    const xOf = (t) => x0 + (Math.max(0, Math.min(t, tMax)) / tMax) * (x1 - x0);

    const roleColor = { primary: '#2e7d32', backup: '#f57c00', final: '#616161', failed: '#b71c1c' };
    let s = `<svg class="soo-timeline" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMinYMin meet">`;
    // axis baseline
    const axisY = top + ops.length * rowH + 6;
    s += `<line x1="${x0}" y1="${axisY}" x2="${x1}" y2="${axisY}" stroke="currentColor" stroke-width="1" opacity="0.4"/>`;
    // ticks
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const t = (tMax / ticks) * i;
      const x = xOf(t);
      s += `<line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + 4}" stroke="currentColor" stroke-width="1" opacity="0.4"/>`;
      s += `<text x="${x}" y="${axisY + 15}" font-size="9" text-anchor="middle" fill="currentColor" opacity="0.7">${this._fmtTime(t)}</text>`;
    }
    // fault-clear marker
    if (bus.clearedAtS != null) {
      const xc = xOf(bus.clearedAtS);
      s += `<line x1="${xc}" y1="${top - 4}" x2="${xc}" y2="${axisY}" stroke="#d32f2f" stroke-width="1.3" stroke-dasharray="3 2"/>`;
      s += `<text x="${xc}" y="${top - 6}" font-size="9" text-anchor="middle" fill="#d32f2f">cleared</text>`;
    }
    // device rows
    ops.forEach((o, i) => {
      const y = top + i * rowH + 6;
      const barH = 11;
      const xa = xOf(o.tripTime);
      const xb = Math.max(xa + 3, xOf(o.clearTime));
      const color = roleColor[o.role] || '#616161';
      const faded = o.resets ? ' opacity="0.4"' : '';
      s += `<text x="${padL - 8}" y="${y + barH - 1}" font-size="10" text-anchor="end" fill="currentColor">${escHtml(o.name)}</text>`;
      s += `<rect x="${xa}" y="${y}" width="${xb - xa}" height="${barH}" rx="2" fill="${color}"${faded}/>`;
      if (o.resets) {
        s += `<text x="${xb + 4}" y="${y + barH - 1}" font-size="9" fill="currentColor" opacity="0.6">resets</text>`;
      } else if (o.name === bus.clearedBy) {
        s += `<text x="${xb + 4}" y="${y + barH - 1}" font-size="9" fill="#2e7d32">◀ clears</text>`;
      }
    });
    s += '</svg>';
    return s;
  },

  _copyReport() {
    const res = this._lastResult;
    if (!res || !res.buses) return;
    const lines = [];
    lines.push(`Sequence of Operation — ${(this._opts && this._opts.faultType) === 'slg' ? 'SLG (earth)' : '3-phase'} fault`);
    for (const bus of res.buses) {
      lines.push('');
      lines.push(`${bus.busName}  —  fault ${this._fmtCurrent(bus.faultCurrentA)}  —  ${bus.passed ? 'PASS' : 'FAIL'}`);
      if (bus.clearedAtS != null) lines.push(`  Cleared at ${this._fmtTime(bus.clearedAtS)} by ${bus.clearedBy}`);
      for (const op of bus.sequence) {
        const t = op.operates ? `trip ${this._fmtTime(op.tripTime)}, clear ${this._fmtTime(op.clearTime)}` : 'no trip';
        lines.push(`  [${op.role || '-'}] ${op.name} (${op.deviceType}) @ ${this._fmtCurrent(op.currentA)} — ${t}${op.resets ? ' (resets)' : ''}`);
      }
      for (const v of bus.violations) lines.push(`  ! ${v.message}`);
    }
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).catch(() => this._execCopy(text));
    } else {
      this._execCopy(text);
    }
    if (typeof UI !== 'undefined' && UI.toast) UI.toast('Sequence report copied', 'success');
  },

  _execCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* best effort */ }
    document.body.removeChild(ta);
  },

  _style() {
    return `<style>
      .soo-info { font-size:13px; padding:8px; }
      .soo-verdict { padding:8px 10px; border-radius:6px; font-size:13px; font-weight:600; margin-bottom:8px; }
      .soo-verdict.soo-ok { background:rgba(46,125,50,0.12); color:#2e7d32; }
      .soo-verdict.soo-bad { background:rgba(211,47,47,0.12); color:#c62828; }
      .soo-meta { font-size:12px; margin-bottom:10px; overflow:hidden; }
      .soo-card { border:1px solid var(--border,#ddd); border-radius:8px; padding:10px 12px; margin-bottom:12px; }
      .soo-card.soo-fail { border-color:#e57373; }
      .soo-card-head { font-size:14px; margin-bottom:2px; }
      .soo-card-head .soo-fault { float:right; font-weight:600; color:#c62828; }
      .soo-cleared { font-size:12px; margin-bottom:6px; }
      .soo-cleared.soo-bad-text { color:#c62828; }
      .soo-timeline { display:block; margin:4px 0 8px; max-width:100%; }
      .soo-table { width:100%; border-collapse:collapse; font-size:11.5px; }
      .soo-table th, .soo-table td { border-bottom:1px solid var(--border,#eee); padding:3px 6px; text-align:left; }
      .soo-table th { font-weight:600; opacity:0.75; }
      .soo-dtype { font-size:9.5px; opacity:0.55; }
      .soo-row-reset { opacity:0.6; }
      .soo-role-primary { color:#2e7d32; font-weight:600; }
      .soo-role-backup { color:#f57c00; font-weight:600; }
      .soo-role-final { color:#616161; }
      .soo-role-failed { color:#b71c1c; font-weight:600; }
      .soo-st-clear { color:#2e7d32; }
      .soo-st-reset { color:#888; }
      .soo-st-fail { color:#c62828; }
      .soo-viol { margin-top:8px; }
      .soo-viol-item { font-size:11.5px; padding:3px 6px; border-radius:4px; margin-top:3px; }
      .soo-sev-critical { background:rgba(211,47,47,0.12); color:#c62828; }
      .soo-sev-warning { background:rgba(245,124,0,0.12); color:#e65100; }
      .soo-sev-marginal { background:rgba(255,193,7,0.14); color:#8d6e00; }
      body.dark-mode .soo-table th, body.dark-mode .soo-table td { border-color:#3a3a4a; }
    </style>`;
  },
};

if (typeof window !== 'undefined') window.SOO = SOO;
