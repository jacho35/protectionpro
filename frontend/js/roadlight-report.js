/* ProtectionPro — Road lighting design report (client-side PDF, jsPDF + autoTable).
 *
 * One design: cross-section and luminaire arrangement, the photometric data
 * used, the EN 13201-3 results against each strip's class, energy indicators,
 * the isolux plot and (appendix) every grid value. Drawings are the workspace's
 * own SVGs, re-drawn with a fixed light print palette and rasterised.
 */

const RoadLightReport = {
  PRINT_VARS: {
    '--rl-road': '#5b5f66', '--rl-path': '#c9c3b5', '--rl-cycle': '#c98a6b', '--rl-verge': '#8fb58a', '--rl-mark': '#f4f4f4',
    '--rl-s1': '#2a78d6', '--rl-s2': '#eb6834', '--text-primary': '#1a1a2e', '--text-secondary': '#55565f',
    '--border-color': '#cfd2d8', '--bg-primary': '#ffffff', '--accent': '#0078d7', '--sl-bad': '#b3261e', '--sl-ok': '#2e7d32',
  },

  _t(s) {
    return String(s == null ? '' : s)
      .replace(/<sub>(.*?)<\/sub>/g, '$1').replace(/<[^>]+>/g, '')
      .replace(/≤/g, '<=').replace(/≥/g, '>=').replace(/→/g, '->').replace(/←/g, '<-')
      .replace(/L̄/g, 'Lav').replace(/Ē/g, 'Eav').replace(/γ/g, 'gamma').replace(/·/g, '.').replace(/×/g, 'x').replace(/–/g, '-');
  },

  // SVG string → PNG data URL at `scale`, CSS variables and classes resolved.
  async _png(svg, w, h, scale = 3) {
    let s = svg.replace(/var\((--[\w-]+)\)/g, (m, v) => this.PRINT_VARS[v] || '#888');
    const style = `<style>.rl-xs-t{font:600 11px Helvetica,Arial,sans-serif;fill:#1a1a2e}.rl-xs-s{font:10px Helvetica,Arial,sans-serif;fill:#55565f}.rl-xs-s.bad{fill:#b3261e;font-weight:600}</style>`;
    s = s.replace(/<svg([^>]*)>/, (m, a) => `<svg${a.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')} xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${style}<rect width="100%" height="100%" fill="#fff"/>`);
    const img = new Image();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const c = document.createElement('canvas');
    c.width = w * scale; c.height = h * scale;
    const ctx = c.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  },

  async export() {
    const RL = RoadLight;
    const des = RL.selected;
    const r = des && RL._results[des.id];
    if (!des || !r || r.error) { await UI.alert('Calculate the design first: the report needs a result.'); return; }
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const t = (s) => this._t(s);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const M = 14, W = 210 - 2 * M;
    const blue = [0, 120, 215];
    const tbl = (opts) => doc.autoTable(Object.assign({
      margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' },
      headStyles: { fillColor: blue, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 247, 249] },
    }, opts));
    let y = M + 4;
    const next = (gap = 7) => (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + gap;
    const heading = (txt, at, need = 30) => {
      let yy = at;
      if (yy > 297 - M - need) { doc.addPage(); yy = M + 4; doc.lastAutoTable = null; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(26, 26, 46);
      doc.text(t(txt), M, yy);
      return yy + 2;
    };
    const fmt = (v, dp = 2) => RL._fmt(v, dp);

    // ── Title ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 26, 46);
    doc.text('Road Lighting Design', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    y += 6;
    doc.text(t(`${AppState.projectName || 'Untitled Project'}  |  ${des.name}  |  ${new Date().toLocaleDateString()}`), M, y);
    y += 4.5;
    const sans = RL._std(des) === 'SANS';
    doc.text(sans
      ? 'Lighting categories SANS 10098-1:2007 (group A: Table 1; groups B, C: Table 2) and SANS 10098-2:2005; calculated per CIE 140 / EN 13201-3; energy indicators EN 13201-5.'
      : 'Calculated to EN 13201-3; lighting classes EN 13201-2 (as CIE 115); energy indicators EN 13201-5.', M, y);
    y += 7;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.setTextColor(...(r.pass ? [46, 125, 50] : [179, 38, 30]));
    doc.text(r.pass ? 'Result: meets every lighting class' : 'Result: does NOT meet every lighting class', M, y);
    doc.setTextColor(26, 26, 46);
    y += 4;

    // ── Cross-section drawing ──
    try {
      const xs = RL._sectionSvg(des, { width: 760, height: 230 });
      const png = await this._png(`<svg viewBox="0 0 ${xs.W} ${xs.H}">${xs.svg}</svg>`, xs.W, xs.H);
      const h = W * xs.H / xs.W;
      doc.addImage(png, 'PNG', M, y, W, h);
      y += h + 4;
    } catch (_) { /* drawing is a nicety — the tables carry the data */ }

    // ── Cross-section table ──
    y = heading('1. Road cross-section', y);
    const lay = RL._layout(des);
    tbl({
      startY: y + 1,
      head: [['Strip', 'From - to (m)', 'Width', 'Lanes', 'Class', 'Surface', 'Traffic']],
      body: lay.secs.map(s => [t(s.name || RL._secName(s, des)), `${fmt(s.y0, 2)} - ${fmt(s.y1, 2)}`, `${fmt(s.width, 2)} m`,
        s.type === 'carriageway' ? s.lanes : '-', t(s.cls ? s.cls + (sans && RL_SANS_A[s.cls] ? ` (night traffic ${RL_SANS_BANDS[RL._hasMedian(des) ? 'median' : 'noMedian'][Math.round(RL._num(s.volume, 0))]})` : '') : 'not checked'), s.type === 'carriageway' ? s.surface : '-',
        s.type === 'carriageway' ? (s.direction === 'reverse' ? 'towards' : 'away') : '-']),
    });

    // ── Luminaires ──
    y = heading('2. Luminaire arrangement', next());
    const arr = (RL_ARRANGEMENTS.find(a => a.id === des.arrangement) || {}).name || des.arrangement;
    tbl({
      startY: y + 1,
      head: [['Parameter', 'Value']],
      body: [
        ['Arrangement', t(arr)], ['Spacing S', `${fmt(des.spacing, 2)} m`], ['Maintenance factor', fmt(des.mf, 2)],
        ['Calculation grid', `${r.grid.nLong} points along the field (D = ${fmt(r.grid.D, 2)} m); 3 per lane for luminance, <= 1.5 m across for illuminance`],
        ['Observer', sans
          ? '60 m before the field, 1.5 m eye height; L, Uo and TI from one observer a quarter of the carriageway width from the left-hand side, Ul with the observer in each lane (SANS 10098-1 Appendix D); TI with the 20 deg screening angle'
          : '60 m before the field, 1.5 m eye height, centre of each lane; TI with the 20 deg screening angle'],
      ],
      columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } },
    });
    const rowsP = RL._rowsPayload(des, lay);
    tbl({
      startY: next(3),
      head: [['Row', 'Side', 'Luminaire', 'Pole y', 'Setback', 'Height', 'Overhang', 'Tilt', 'Offset', 'Flux']],
      body: des.rows.map((row, i) => {
        const ph = RL.library[row.photometryId];
        return [i + 1, t((RL_SIDES.find(s => s.id === row.side) || {}).name || row.side), t(ph ? ph.name : '?'),
          `${fmt(rowsP[i].y, 2)} m`, `${fmt(row.setback, 2)} m`, `${fmt(row.height, 2)} m`, `${fmt(row.overhang, 2)} m`,
          `${fmt(row.tilt, 0)} deg`, `${fmt(row.xOffset, 2)} S`, `${fmt(row.fluxPct, 0)} %`];
      }),
      styles: { fontSize: 8, cellPadding: 1.4 },
    });

    // ── Results ──
    y = heading('3. Results against the lighting classes', next());
    const body = [];
    for (const a of r.areas) {
      const name = t(`${a.name}${a.cls ? ' (' + a.cls + ')' : ''}${a.surface ? ', ' + a.surface : ''}`);
      if (a.checks && a.checks.length) {
        a.checks.forEach((c, k) => body.push([k ? '' : name, t(c.label) + (c.unit ? ` (${c.unit})` : ''), `${c.op === '>=' ? '>=' : '<='} ${c.req}`,
          fmt(c.value, c.key === 'TI' ? 1 : 2), c.pass ? 'Pass' : 'FAIL']));
      } else {
        body.push([name, 'Eav / Emin (lx)', '-', `${fmt(a.Eav, 2)} / ${fmt(a.Emin, 2)}`, 'info']);
      }
    }
    tbl({
      startY: y + 1, head: [['Strip', 'Criterion', 'Required', 'Calculated', '']], body,
      didParseCell: (d) => { if (d.section === 'body' && d.column.index === 4) { if (d.cell.raw === 'FAIL') { d.cell.styles.textColor = [179, 38, 30]; d.cell.styles.fontStyle = 'bold'; } else if (d.cell.raw === 'Pass') d.cell.styles.textColor = [46, 125, 50]; } },
    });
    const notes = r.areas.filter(a => a.note).map(a => `${a.name}: ${a.note}`);
    for (const a of r.areas) {
      if (a.family === 'A' && a.ESsides && a.ESsides.length) notes.push(`${a.name}: surround ratio ES ${a.ESsides.map(x => `${x.side} ${fmt(x.REI, 2)}`).join(', ')} (SANS 10098-1 3.6.1 d; no limit tabulated)`);
    }
    if (notes.length) {
      doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(90);
      let yy = next(4);
      for (const n of notes) { doc.text(doc.splitTextToSize(t(n), W), M, yy); yy += 4; }
      doc.lastAutoTable.finalY = yy;
    }

    // ── Energy ──
    y = heading('4. Energy and quantities', next());
    const e = r.energy;
    tbl({
      startY: y + 1, head: [['Indicator', 'Value']],
      body: [
        ['System power per field', `${fmt(e.powerPerFieldW, 1)} W`], ['Power per km', `${Math.round(e.wPerKm).toLocaleString()} W/km`],
        ['Poles per km', fmt(e.polesPerKm, 1)], ['Luminaires per km', fmt(e.luminairesPerKm, 1)],
        ['Power density indicator D_P', e.pdi === null ? '-' : `${fmt(e.pdi * 1000, 2)} mW/(lx.m²)`],
        ['Annual energy consumption indicator D_E', e.aeci === null ? '-' : `${fmt(e.aeci, 2)} kWh/(m².yr) at ${fmt(des.hours, 0)} h/yr`],
      ],
      columnStyles: { 0: { cellWidth: 80 } },
    });

    // ── Isolux ──
    y = heading('5. Illuminance over one field (lx)', next(), 90);
    try {
      const svg = RL._isoluxSvg(r, 520, true).match(/<svg[\s\S]*<\/svg>/)[0];
      const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
      const w = +vb[1], h = +vb[2];
      const png = await this._png(svg, w, h);
      const ih = Math.min(110, W * h / w), iw = ih * w / h;
      doc.addImage(png, 'PNG', M, y + 2, iw, ih);
      // Legend: the same bands the plot uses.
      let max = 0;
      for (const col of r.isolux.v) for (const v of col) if (v > max) max = v;
      const levels = RL._levels(max), ramp = RL._ramp(true);
      const colour = (b) => ramp[Math.min(ramp.length - 1, Math.round(b * (ramp.length - 1) / Math.max(1, levels.length)))];
      let lx = M, ly = y + ih + 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(60);
      [0, ...levels].forEach((lv, k) => {
        const hex = colour(k).replace('#', '');
        doc.setFillColor(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
        doc.rect(lx, ly - 2.6, 4, 3, 'F');
        const label = k === 0 ? `< ${levels[0] ?? ''}` : `>= ${lv}`;
        doc.text(label, lx + 5, ly);
        lx += 7 + doc.getTextWidth(label);
      });
      doc.text(`lx  (max ${fmt(max, 1)})`, lx, ly);
      doc.setTextColor(90);
      doc.text('Plan view: along the road left to right, across the road top (y = 0) to bottom. Iso-lines at the legend levels; dots = luminaires.', M, ly + 5);
      doc.lastAutoTable = { finalY: ly + 7 };
    } catch (_) { /* ignore */ }

    // ── Photometry ──
    const used = [...new Set(des.rows.map(x => x.photometryId))].map(id => RL.library[id]).filter(Boolean);
    y = heading('6. Luminaire data', next(), 60);
    tbl({
      startY: y + 1, head: [['Luminaire', 'Source', 'Flux', 'Power', 'Efficacy', 'Peak', 'C rotation']],
      body: used.map(p => [t(p.name) + (p.manufacturer ? `\n${t(p.manufacturer)}` : ''), t(`${p.format || ''}${p.fileName ? ' ' + p.fileName : ''}`),
        `${Math.round(p.lumens)} lm`, `${fmt(p.watts, 1)} W`, p.watts ? `${Math.round(p.lumens / p.watts)} lm/W` : '-',
        `${Math.round(p.maxCd / p.lumens * 1000)} cd/klm`, `${p.rotate || 0} deg`]),
    });
    for (const p of used) {
      if (p.generic) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(179, 38, 30);
        doc.text(t(`${p.name}: generic distribution for feasibility — not a real product.`), M, next(4));
        doc.lastAutoTable.finalY = next(4);
      }
    }

    // ── Appendix: grid values ──
    doc.addPage();
    doc.lastAutoTable = null;
    y = heading('Appendix — calculation grid values', M + 4);
    for (const a of r.areas) {
      const g = a.gridL || a.gridE;
      if (!g) continue;
      const unit = a.gridL ? `luminance cd/m², observer in lane ${g.observerLane}` : 'illuminance lx';
      y = heading(`${a.name} — ${unit}`, next(6), 40);
      const dp = a.gridL ? 3 : 1;
      tbl({
        startY: y + 1, head: [['y \\ x (m)', ...g.x.map(x => x.toFixed(1))]],
        body: g.y.map((yy, j) => [yy.toFixed(2), ...g.x.map((_, i) => (+g.v[i][j]).toFixed(dp))]),
        styles: { fontSize: 6.5, cellPadding: 0.8, halign: 'right' }, headStyles: { fillColor: blue, textColor: 255, fontSize: 6.5, halign: 'right' },
      });
    }

    // ── Footer ──
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(130);
      doc.text(t(`ProtectionPro — road lighting · ${des.name}`), M, 297 - 8);
      doc.text(`Page ${i} of ${pages}`, 210 - M, 297 - 8, { align: 'right' });
    }
    const safe = (s) => String(s || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
    doc.save(`${safe(AppState.projectName) || 'project'}_${safe(des.name) || 'road'}_lighting.pdf`);
  },
};
