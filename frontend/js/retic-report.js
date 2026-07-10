/* ProtectionPro — Reticulation Demand & Cable Schedule Report (PDF)
 * Uses jsPDF + autoTable (loaded globally as window.jspdf), matching reports.js.
 */

const ReticReport = {
  async export() {
    const res = AppState.reticResults;
    if (!res || !res.total || !res.kiosks.length) {
      await UI.alert('Nothing to report yet — add kiosks and erven first.');
      return;
    }
    if (!window.jspdf) { await UI.alert('PDF library not loaded.'); return; }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const margin = 12;
    const s = Retic.settings;
    const projName = AppState.projectName || 'Untitled Project';

    // ── Header ──
    doc.setFontSize(16); doc.setFont('helvetica', 'bold');
    doc.text('ProtectionPro — Reticulation Demand Report', margin, margin + 4);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text(`Project: ${projName}    Date: ${new Date().toLocaleDateString()}`, margin, margin + 11);
    doc.text(
      `Method: ${res.settings.estimationMethod}`
      + (res.settings.estimationMethod === 'Empirical' ? `  (correction: ${s.correctionMethod})` : '')
      + `    Default class: ${Retic._classLabel(s.loadClass)}    Standard: NRS 034-1 / CTEF100`,
      margin, margin + 16);

    // ── Summary line ──
    const t = res.total;
    const ndf = t.networkDiversity != null ? t.networkDiversity : 1;
    const sumTxt = (res.minisubs || []).length > 1 && t.sumKVA != null
      ? `Σ minisubs ${t.sumKVA} kVA × ${ndf} = ` : '';
    doc.setFont('helvetica', 'bold');
    doc.text(
      `Network total after diversity: ${sumTxt}${t.totalKVA} kVA  |  ${t.currentA} A  |  ${t.conns} connections  |  ${t.numKiosks} kiosks`,
      margin, margin + 23);
    doc.setFont('helvetica', 'normal');

    // ── Per-minisub demand & transformer sizing ──
    // Diversity is applied per minisub across all its downstream loads.
    if ((res.minisubs || []).length) {
      const msRows = res.minisubs.map(m => {
        const xf = m.totalKVA > 0 ? Retic._suggestTransformer(m.totalKVA) : null;
        return [
          m.name || m.minisubId,
          String(m.numKiosks),
          String(m.conns),
          m.totalKVA.toFixed(2),
          m.currentA.toFixed(1),
          xf ? `${xf.label} (${xf.util}%)` : '—',
        ];
      });
      doc.autoTable({
        startY: margin + 28,
        margin: { left: margin, right: margin },
        head: [['Minisub', 'Kiosks', 'Conns', 'Diversified kVA', 'Current (A)', 'Suggested Transformer']],
        body: msRows,
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' } },
      });
    }

    // ── Per-kiosk demand schedule ──
    const byId = {};
    for (const kr of res.kiosks) byId[kr.kioskId] = kr;
    const msName = {};
    for (const m of Retic.minisubs) msName[m.id] = m.name;
    const kioskRows = res.kiosks.map(kr => {
      const cum = Retic._cumulativeFeederVD(kr.kioskId, byId);
      return [
        kr.name || 'Kiosk',
        msName[Retic._rootOf(kr.kioskId)] || '',
        kr.cls || '',
        String(kr.conns),
        String(kr.admdKVA),
        kr.totalKVA.toFixed(2),
        (kr.feederKVA != null ? kr.feederKVA : kr.totalKVA).toFixed(2),
        (kr.streetLightKVA || 0).toFixed(2),
        cum == null ? '—' : cum.toFixed(2) + '%',
      ];
    });
    doc.autoTable({
      startY: doc.lastAutoTable ? doc.lastAutoTable.finalY + 4 : margin + 28,
      margin: { left: margin, right: margin },
      head: [['Kiosk', 'Minisub', 'Load Class', 'Conns', 'ADMD', 'Demand kVA', 'Feeder kVA', 'St.Light kVA', 'Cum. VD']],
      body: kioskRows,
      styles: { fontSize: 8, cellPadding: 1.5 },
      headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: { 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
    });

    // ── Erf / service cable schedule ──
    const erfRows = [];
    for (const k of Retic.kiosks) {
      for (const e of k.erfs) {
        if (!(e.length > 0)) continue;
        const is3ph = e.phase === '3 Phase';
        const vd = Retic._vdPercent(e.cableType, Retic._erfDesignAmps(k, e), e.length, is3ph);
        erfRows.push([
          k.name || 'Kiosk',
          e.erfNumber || '',
          e.phase || '',
          String(e.length || 0),
          e.cableType || '—',
          e.ampsOverride ? String(e.ampsOverride) : '—',
          vd == null ? '—' : vd.toFixed(2) + '%',
        ]);
      }
    }
    if (erfRows.length) {
      const startY = doc.lastAutoTable ? doc.lastAutoTable.finalY + 8 : margin + 60;
      doc.setFontSize(12); doc.setFont('helvetica', 'bold');
      doc.text('Erf / Service Cable Schedule', margin, startY);
      doc.autoTable({
        startY: startY + 3,
        margin: { left: margin, right: margin },
        head: [['Kiosk', 'Erf #', 'Phase', 'Length (m)', 'Service Cable', 'Amps Override', 'Service VD']],
        body: erfRows,
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [0, 120, 215], textColor: 255, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [245, 245, 245] },
        columnStyles: { 3: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } },
      });
    }

    const safe = projName.replace(/[^a-z0-9]+/gi, '_');
    doc.save(`${safe}_reticulation_demand.pdf`);
  },
};
