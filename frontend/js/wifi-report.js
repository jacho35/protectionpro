/* ProtectionPro — WiFi report (client-side PDF, jsPDF + autoTable, like the Lighting report).
 *
 * One document for the active floor: summary, the signal map, compliance by room, capacity per access point, the access
 * point schedule (manufacturer model, Tx, gain, channel, PoE), channel plan, cabling and PoE, links, and the assumptions
 * the numbers rest on. It reports what the WiFi tab shows now (WifiWS.calc()); nothing is recalculated here.
 */
const WifiReport = {
  _t(s) { return LightReport._t(s).replace(/−/g, '-').replace(/·/g, '|').replace(/×/g, 'x').replace(/²/g, '2').replace(/°/g, ' deg'); },

  async export() {
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }
    const c = WifiWS.calc();
    if (c.error) { await UI.alert(c.error); return; }
    if (!c.aps.length) { await UI.alert('Place access points first: the report needs a prediction to report.'); return; }
    const E = WifiEngine, S = WifiWS.S(), t = (s) => this._t(s);
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
    const nm = id => (c.aps.find(a => a.id === id) || c.m.aps.find(a => a.id === id) || {}).name || id;

    // ── Title and summary ──
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(26, 26, 46);
    doc.text('WiFi Design Report', M, y);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
    y += 6; doc.text(t(`${AppState.projectName || 'Untitled Project'}  |  ${af ? af.name + '  |  ' : ''}${new Date().toLocaleDateString()}`), M, y);
    y += 4.5; doc.text(t(`${E.BANDS[S.band].label}, ${S.width} MHz channels. Predicted signal, not a site survey.`), M, y);
    const pd = AppState.projectDetails || {};
    if (pd.engineer || pd.checkedBy) { y += 4.5; doc.text(t([pd.engineer && 'Prepared by ' + pd.engineer, pd.checkedBy && 'Checked by ' + pd.checkedBy].filter(Boolean).join('   ')), M, y); }
    const judged = c.rooms.filter(r => r.pass != null), failRooms = judged.filter(r => !r.pass), capFail = c.cap.filter(x => !x.pass);
    y += 7;
    tbl({ startY: y, head: [['Rooms passing', 'Floor at -67 dBm', 'Access points', 'Capacity', 'PoE and runs']],
      body: [[`${judged.length - failRooms.length} of ${judged.length}`, pc(c.cov[0].pct), String(c.m.aps.length), capFail.length ? `${capFail.length} over` : 'Pass', c.poe ? (c.poe.pass ? 'Pass' : 'Fail') : 'No rack set']],
      styles: { fontSize: 10, cellPadding: 2.2, halign: 'center' } });

    // ── Signal map ──
    let sec = 0;
    y = heading(`${++sec}. Signal map`, next(9), 70);
    const png = (() => { try { return WifiWS.heatPng(1600, true); } catch (e) { return null; } })();
    if (png) {
      const im = new Image(); im.src = png; await new Promise(r => { im.onload = r; im.onerror = r; });
      const iw = im.naturalWidth || 1600, ih = im.naturalHeight || 900;
      let h = Math.min(W * ih / iw, 150), w = h * iw / ih; if (w > W) { w = W; h = W * ih / iw; }
      if (y + h + 12 > PH - M) { doc.addPage(); y = M + 4; }
      doc.addImage(png, 'JPEG', M, y + 2, w, h);
      y += h + 6;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(110);
      doc.text(t('Colours: ' + E.STEPS.map(([lv, , n]) => lv > -200 ? `${n} >= ${lv} dBm` : n).join(', ') + '. A ringed figure marks the worst point of a room that fails its target.'), M, y, { maxWidth: W });
      doc.lastAutoTable = null; y += 3;
    }

    // ── Compliance ──
    y = heading(`${++sec}. Compliance by room`, doc.lastAutoTable ? next(9) : y + 6, 40);
    tbl({ startY: y + 1, head: [['Room', 'Use', 'Target', 'Worst point', 'SNR', 'Area at target', 'Verdict']],
      body: c.rooms.map(r => [t(r.name), t((E.DEFAULTS.uses[r.use] || {}).name || r.use), r.target == null ? '-' : r.target + ' dBm', r.worst == null ? '-' : f0(r.worst) + ' dBm', r.snr == null ? '-' : f0(r.snr) + ' dB', pc(r.pct), vtxt(r.pass)]),
      didParseCell: colour(6) });

    // ── Capacity ──
    y = heading(`${++sec}. Capacity per access point`, next(9), 40);
    tbl({ startY: y + 1, head: [['AP', 'Area served', 'Clients', 'Demand', 'Median SNR', 'Capacity', 'Load', 'Verdict']],
      body: c.cap.map(x => [t(nm(x.id)), f0(x.area) + ' m2', f0(x.clients), f0(x.demand) + ' Mbps', x.snrMedian == null ? '-' : f0(x.snrMedian) + ' dB', f0(x.capacity) + ' Mbps', isFinite(x.load) ? pc(x.load) : 'inf', vtxt(x.pass)]),
      didParseCell: colour(7) });
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(t(`Clients = people x ${S.devices} devices (people from the room area at ${S.density} m2 each, or as entered). Demand = clients x ${S.mbps} Mbps x ${S.concurrency} concurrency. Capacity = 60% of the data rate at the median SNR of the AP's cells.`), M, next(4), { maxWidth: W });
    doc.setTextColor(26, 26, 46);

    // ── AP schedule ──
    y = heading(`${++sec}. Access point schedule`, next(14), 40);
    tbl({ startY: y + 1, head: [['AP', 'Model', 'Tx', 'Gain', 'Streams', 'Channel', 'PoE draw']],
      body: c.m.aps.map(a => [t(a.name), t(a.model), a.tx + ' dBm', a.gain + ' dBi', a.off ? 'no radio on this band' : (a.streams || '-'), a.off ? '-' : ((c.aps.find(x => x.id === a.id) || {}).channel || '-'), f1(a.watts) + ' W']) });
    if (c.ch.clash.length) { doc.setFontSize(8); doc.setTextColor(179, 38, 30); doc.text(t(c.ch.clash.map(p => `${nm(p.a)} and ${nm(p.b)} hear each other at ${f0(p.rssi)} dBm on the same channel`).join('; ') + '.'), M, next(4), { maxWidth: W }); doc.setTextColor(26, 26, 46); }

    // ── Cabling and PoE ──
    y = heading(`${++sec}. Cabling and PoE`, next(c.ch.clash.length ? 12 : 9), 40);
    if (!c.poe) { doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90); doc.text('No comms rack set on the plan: runs, ports and the PoE budget are not calculated.', M, y + 5); doc.lastAutoTable = null; }
    else {
      tbl({ startY: y + 1, head: [['Switch ports', 'Switches', 'PoE draw', 'PoE budget', 'Longest run', 'Limit']],
        body: [[c.poe.ports, c.poe.switches, f1(c.poe.watts) + ' W', c.poe.budget + ' W', f1(c.poe.longest) + ' m', c.poe.limit + ' m']] });
      tbl({ startY: next(4), head: [['Device', 'Type', 'Run to ' + t(c.m.rack.name), 'PoE']],
        body: c.items.map(i => [t(i.name), i.kind === 'ap' ? 'Access point' : 'Data outlet', f1(i.run) + ' m' + (i.run > c.poe.limit ? ' (over the limit)' : ''), i.kind === 'ap' ? f1(i.watts) + ' W' : '-']) });
    }

    // ── Links ──
    const pm = AppState.planMarkup;
    if (S.links.length) {
      y = heading(`${++sec}. Point-to-point links`, next(9), 40);
      tbl({ startY: y + 1, head: [['Link', 'Distance', 'GHz', 'Rx', 'Fade', 'Fresnel clear', 'Rate', 'Verdict']],
        body: S.links.map(l => {
          const A = pm.elements.find(e => e.id === l.a), B = pm.elements.find(e => e.id === l.b), d = A && B ? Math.hypot(A.x - B.x, A.y - B.y) * c.m.f : l.dist;
          const r = E.link({ dist: d || 1, freqGhz: l.freq, tx: l.tx, gainA: l.gainA, gainB: l.gainB, obstruct: l.obstruct === '' || l.obstruct == null ? undefined : l.obstruct });
          return [t(l.name), f0(d) + ' m', l.freq, f0(r.rx) + ' dBm', f0(r.fade) + ' dB', pc(r.clear) + ' of ' + f1(r.f1) + ' m', f0(r.rate) + ' Mbps', r.pass ? 'Pass' : 'Fail'];
        }), didParseCell: colour(7) });
    }

    // ── Assumptions and limits ──
    doc.addPage(); y = M + 4; doc.lastAutoTable = null;
    y = heading('Assumptions and limits of this report', y, 30, 13);
    const ix = { '2.4': 0, '5': 1, '6': 2 }[S.band];
    const used = {}; for (const w of c.pred.segs) used[w.mat] = (used[w.mat] || 0) + 1;
    tbl({ startY: y + 2, head: [['Wall material', 'Loss at ' + E.BANDS[S.band].label, 'Walls on this floor']],
      body: Object.keys(E.MATERIALS).filter(k => used[k]).map(k => [E.MATERIALS[k].name, E.MATERIALS[k].loss[ix] + ' dB', used[k]]) });
    const bullets = [
      'Signal = Tx power + antenna gain - (20 log10 f(MHz) - 27.55 + 10 n log10 d) - the loss of every wall the straight line crosses. Path-loss exponent n = ' + S.exponent + '; d is held at 1 m or more.',
      'The walls are the room outlines: an edge shared by two rooms is one wall. A wall without a material is ' + E.MATERIALS[S.defaultWall].name + '.',
      'Wall losses, the path-loss exponent, the SNR-to-rate steps (Wi-Fi 6) and the 60% airtime efficiency are typical planning values, not measurements of this building.',
      'Manufacturer Tx power and antenna gain are the datasheet maximums for the band; a regulator may allow less. Set the AP\'s own Tx where it must be lower.',
      'Not modelled: reflections, diffraction round corners, floors above and below, furniture and people, interference from outside the building.',
      'A prediction, not a site survey. Check the result on site before sign-off.',
    ];
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
    let by = next(7);
    for (const b of bullets) { const lines = doc.splitTextToSize('- ' + t(b), W); doc.text(lines, M, by); by += lines.length * 4.6 + 2; }

    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p); doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(130);
      doc.text(`${t(AppState.projectName || 'WiFi report')}  |  page ${p} of ${pages}`, M, PH - 7);
    }
    doc.save(`${(AppState.projectName || 'project').replace(/[^\w-]+/g, '_')}_wifi_report.pdf`);
  },
};
