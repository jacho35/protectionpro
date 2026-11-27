/* ProtectionPro — CCTV report (client-side PDF, jsPDF + autoTable, like the WiFi and Lighting reports).
 *
 * One document for the active plan: summary, the coverage map, compliance by area, camera schedule, mounting checks, storage
 * and bandwidth, cabling / PoE / fibre, bill-of-quantities lines and the assumptions the numbers rest on. It reports what the
 * CCTV tab shows now (CctvWS.calc()); nothing is recalculated here.
 */
const CctvReport = {
  _t(s) { return LightReport._t(s).replace(/−/g, '-').replace(/·/g, '|').replace(/×/g, 'x').replace(/²/g, '2').replace(/°/g, ' deg').replace(/≥/g, '>=').replace(/≤/g, '<='); },

  async export() {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const c = CctvWS.calc();
    if (c.error) { await UI.alert(c.error); return; }
    if (!c.m.cams.length) { await UI.alert('Place cameras first: the report needs a prediction to report.'); return; }
    const E = CctvEngine, S = CctvWS.S(), t = (s) => this._t(s), retic = c.m.dom === 'retic';
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const M = 14, W = 210 - 2 * M, PH = 297, blue = [0, 120, 215];
    const tbl = (o) => doc.autoTable(Object.assign({
      margin: { left: M, right: M }, styles: { fontSize: 8.5, cellPadding: 1.6, overflow: 'linebreak' },
      headStyles: { fillColor: blue, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [246, 247, 249] },
    }, o));
    let y = M + 4;
    const next = (gap = 7) => (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + gap;
    const heading = (txt, at, need = 40, size = 11) => {
      let yy = at;
      if (yy > PH - M - need) { doc.addPage(); yy = M + 4; doc.lastAutoTable = null; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(26, 26, 46);
      doc.text(t(txt), M, yy);
      return yy + 2;
    };
    const f0 = v => v == null ? '-' : Math.round(v), f1 = v => v == null ? '-' : Number(v).toFixed(1), pc = v => v == null ? '-' : Math.round(v * 100) + '%';
    const verdictColor = v => v === 'Pass' ? [46, 125, 50] : v === 'Fail' ? [179, 38, 30] : [120, 120, 120];
    const vtxt = ok => ok == null ? 'n/a' : ok ? 'Pass' : 'Fail';
    const colour = (idx) => (d) => { if (d.section === 'body' && d.column.index === idx) d.cell.styles.textColor = verdictColor(String(d.cell.raw)); };
    const af = (typeof AppState.planActiveFloor === 'function') && AppState.planActiveFloor();

    // ── Title and summary ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 26, 46);
    doc.text('CCTV Design Report', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    y += 6; doc.text(t(`${AppState.projectName || 'Untitled Project'}  |  ${af ? af.name + '  |  ' : ''}${new Date().toLocaleDateString()}`), M, y);
    y += 4.5; doc.text(t(`Pixel density at a ${S.targetH} m face (DORI, IEC 62676-4: Detect 25, Observe 62, Recognise 125, Identify 250 px/m). Predicted coverage, not a site test.`), M, y, { maxWidth: W });
    const pd = AppState.projectDetails || {};
    if (pd.engineer || pd.checkedBy) { y += 4.5; doc.text(t([pd.engineer && 'Prepared by ' + pd.engineer, pd.checkedBy && 'Checked by ' + pd.checkedBy].filter(Boolean).join('   ')), M, y); }
    const judged = c.stats.filter(r => r.verdict != null), failed = judged.filter(r => !r.verdict), chFail = c.checks.filter(x => !x.pass);
    y += 7;
    tbl({ startY: y, head: [['Areas passing', 'Detect or better', 'Cameras', 'Cameras to check', 'Storage', 'PoE and runs']],
      body: [[`${judged.length - failed.length} of ${judged.length}`, pc(c.cov.detect), String(c.m.cams.length), chFail.length ? String(chFail.length) : 'None', `${c.stor.tb.toFixed(2)} TB`, c.poe ? (c.poe.pass ? 'Pass' : 'Fail') : 'No recorder set']],
      styles: { fontSize: 10, cellPadding: 2.2, halign: 'center' } });

    // ── Coverage map ──
    let sec = 0;
    y = heading(`${++sec}. Coverage map`, next(9), 70);
    const png = (() => { try { return CctvWS.heatPng(1600, true); } catch (e) { return null; } })();
    if (png) {
      const im = new Image(); im.src = png; await new Promise(r => { im.onload = r; im.onerror = r; });
      const iw = im.naturalWidth || 1600, ih = im.naturalHeight || 900;
      let h = Math.min(W * ih / iw, 150), w = h * iw / ih; if (w > W) { w = W; h = W * ih / iw; }
      if (y + h + 12 > PH - M) { doc.addPage(); y = M + 4; }
      doc.addImage(png, 'JPEG', M, y + 2, w, h);
      y += h + 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
      doc.text(t('Colours: ' + E.DORI.map(([, n, p]) => `${n} >= ${p} px/m`).join(', ') + ', orange = below Detect or hidden. Dashed lines are each camera\'s field of view. A ringed figure marks the worst point of an area that fails.'), M, y, { maxWidth: W });
      doc.lastAutoTable = null; y += 3;
    }

    // ── Compliance ──
    y = heading(`${++sec}. Compliance by ${retic ? 'area' : 'room'}`, doc.lastAutoTable ? next(9) : y + 6, 40);
    tbl({ startY: y + 1, head: [[retic ? 'Area' : 'Room', 'Target', 'Level reached', 'Worst point', 'Area at target', 'Blind', 'Scene light', 'Verdict']],
      body: c.stats.map(r => [t(r.name), r.target == null ? 'Not covered' : t(E.USES[r.use].name), r.level || 'None', r.worst == null ? '-' : f0(r.worst) + ' px/m', pc(r.pct), pc(r.blind),
        r.lux == null ? 'unknown' : f1(r.lux) + ' lx' + (r.minLux != null ? ` (camera ${r.minLux})` : '') + (r.light === false ? ' too dark' : ''), vtxt(r.verdict)]),
      didParseCell: colour(7) });
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(t(`An area passes when ${Math.round(S.passPct * 100)}% of it reaches its target pixel density and its lowest scene light is not below the camera's minimum illumination (where both are known).`), M, next(4), { maxWidth: W });
    doc.setTextColor(26, 26, 46);

    // ── Camera schedule ──
    y = heading(`${++sec}. Camera schedule`, next(14), 40);
    tbl({ startY: y + 1, head: [['Camera', 'Model', 'Type', 'Resolution', 'FOV', 'Mount / tilt', 'Identify / Recognise / Observe', 'PoE']],
      body: c.m.cams.map((a, i) => { const r = c.checks[i].ranges; return [t(a.name), t(a.model), E.KINDS[a.kind] || a.kind, `${a.resW}x${a.resH}`, f0(a.hfov) + ' deg', `${f1(a.H)} m / ${f0(a.tilt)} deg`, `${f1(r.identify)} / ${f1(r.recognise)} / ${f1(r.observe)} m`, f1(a.watts) + ' W']; }) });

    // ── Mounting checks ──
    y = heading(`${++sec}. Mounting height and tilt`, next(9), 30);
    const notes = []; c.checks.forEach((ck, i) => ck.notes.forEach(n => notes.push(`${c.m.cams[i].name}: ${n}`)));
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    if (notes.length) { doc.setTextColor(179, 38, 30); let ny = y + 5; for (const n of notes) { const ls = doc.splitTextToSize('- ' + t(n), W); doc.text(ls, M, ny); ny += ls.length * 4.4 + 1.5; } y = ny; doc.setTextColor(26, 26, 46); }
    else { doc.setTextColor(90); doc.text(t(`Every camera is out of reach (>= ${E.DEFAULTS.reachH} m) and looks down no steeper than ${E.DEFAULTS.maxDepression} deg at its Identify range.`), M, y + 5, { maxWidth: W }); y += 9; }
    doc.lastAutoTable = null;

    // ── Storage and bandwidth ──
    y = heading(`${++sec}. Storage and bandwidth`, y + 4, 40);
    tbl({ startY: y + 1, head: [['Cameras', 'Total bitrate', 'Per day', `Storage, ${S.days} days`, 'Recorder link']],
      body: [[c.m.cams.length, f1(c.stor.total) + ' Mbps', f0(c.stor.gbDay.reduce((a, b) => a + b, 0)) + ' GB', c.stor.tb.toFixed(2) + ' TB', `${f0(c.stor.total)} of ${f0(c.stor.uplinkLimit)} Mbps (${c.stor.uplinkPass ? 'Pass' : 'Fail'})`]] });
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(t(`Bitrate = megapixels x frame rate x ${E.CODECS[S.codec].name} factor (${E.CODECS[S.codec].f} Mbps per megapixel per frame per second), recording ${Math.round(S.duty * 100)}% of the time, +${Math.round((S.overhead - 1) * 100)}% for overhead and RAID. The recorder link is limited to ${Math.round(E.DEFAULTS.uplinkUtil * 100)}% of ${E.DEFAULTS.uplinkMbps} Mbps.`), M, next(4), { maxWidth: W });
    doc.setTextColor(26, 26, 46);

    // ── Cabling ──
    y = heading(`${++sec}. Cabling, PoE${retic ? ' and fibre' : ''}`, next(14), 40);
    if (!c.poe) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90); doc.text('No recorder set on the plan: runs, ports and the PoE budget are not calculated.', M, y + 5); doc.lastAutoTable = null; }
    else {
      tbl({ startY: y + 1, head: [['Switch ports', 'PoE switches', 'PoE draw', 'PoE budget', 'Longest copper run', 'Limit'].concat(retic ? ['Fibre drops'] : [])],
        body: [[c.poe.ports, c.poe.switches, f1(c.poe.watts) + ' W', c.poe.budget + ' W', f1(c.poe.longest) + ' m', c.poe.limit + ' m'].concat(retic ? [`${c.poe.fibre} (${f0(c.poe.fibreM)} m)`] : [])] });
      tbl({ startY: next(4), head: [['Camera', 'Run to ' + t(c.m.rack.name), 'Medium', 'PoE']],
        body: c.items.map(i => { const fb = c.poe.fibreIds.includes(i.id); return [t(i.name), f1(i.run) + ' m' + (!fb && i.run > c.poe.limit ? ' (over the limit)' : ''), fb ? 'Fibre + local power' : 'Cat6A, PoE', fb ? '-' : f1(i.watts) + ' W']; }) });
    }

    // ── Bill of quantities ──
    let boq = []; try { const pm = AppState.planMarkup; boq = CctvWS.boqLines(pm.elements.filter(e => e.type === CctvWS.camType()), (pm.routes || []).filter(r => r.auto === 'cctv').length); } catch (_) { boq = []; }
    if (boq.length) {
      y = heading(`${++sec}. Bill of quantities lines`, next(9), 40);
      tbl({ startY: y + 1, head: [['Item', 'Qty', 'Unit']], body: boq.map(l => [t(l.desc), l.qty, l.unit]) });
    }

    // ── Assumptions and limits ──
    doc.addPage(); y = M + 4; doc.lastAutoTable = null;
    y = heading('Assumptions and limits of this report', y, 30, 13);
    const bullets = [
      'Pixel density at a point = sensor width in pixels / (2 x depth x tan(horizontal FOV / 2)), where depth is the distance along the camera axis to a face ' + S.targetH + ' m above the floor. A point is covered when it is inside the horizontal and vertical field of view.',
      (retic ? 'Buildings drawn on the site plan' : 'Room walls') + ' hide what is behind them; a wall set to glass or an opening does not. A wall without a type is ' + E.WALLS[S.defaultWall].name.toLowerCase() + '. Furniture, vehicles, trees and people are not modelled.',
      'DORI levels are the pixel densities of IEC 62676-4 (Detect 25, Observe 62, Recognise 125, Identify 250 px/m). They assume a sharp image: low light, glare, lens quality and compression reduce what is actually seen.',
      'Mounting checks: a camera lower than ' + E.DEFAULTS.reachH + ' m can be reached by hand; a camera that looks down more than ' + E.DEFAULTS.maxDepression + ' deg at its Identify range sees the top of a head, not a face. These limits are planning values.',
      'Manufacturer resolution and field of view are datasheet figures at the widest lens setting; a PTZ is checked at its wide end. Where a figure is not published the generic 4 MP, 100 deg camera or your entry is used.',
      'Bitrate per megapixel, recording share, overhead and the recorder link limit are typical planning values, not a measurement; use the camera\'s own bitrate where it is known.',
      'A prediction, not a site test. Check the coverage with test images on site before sign-off.',
    ];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    let by = y + 7;
    for (const b of bullets) { const lines = doc.splitTextToSize('- ' + t(b), W); doc.text(lines, M, by); by += lines.length * 4.6 + 2; }

    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(130);
      doc.text(`${t(AppState.projectName || 'CCTV report')}  |  page ${p} of ${pages}`, M, PH - 7);
    }
    doc.save(`${(AppState.projectName || 'project').replace(/[^\w-]+/g, '_')}_cctv_report.pdf`);
  },
};

if (typeof module !== 'undefined' && module.exports) module.exports = CctvReport;
