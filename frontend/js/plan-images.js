/* ProtectionPro — Plan Markup image manager.
 *
 * Background plan rasters (and, from Phase 2, the source PDFs) live on the
 * backend (/api/plan-images) — the project JSON only stores integer ids. This
 * module uploads imports, fetches + caches decoded <img> elements for the
 * engine, and claims orphan uploads for a project once it's first saved.
 *
 * Phase 1: raster import only (PNG/JPEG/WebP). PDF rasterization via pdf.js is
 * wired in Phase 2 (the vendored lib is already loaded; worker set below).
 */

const PlanImages = {
  _cache: new Map(),      // imageId -> HTMLImageElement (decoded)
  _pending: new Set(),    // imageId currently fetching
  MAX_DIM: 8192,          // downscale guard (mobile canvas + upload size)

  init() {
    if (typeof pdfjsLib !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/lib/pdf.worker.min.js';
    }
  },

  // Synchronous accessor for the engine's draw loop: returns a decoded image
  // or null, kicking off a fetch on a miss (no await in the draw path).
  getElementImage(imageId) {
    if (imageId == null) return null;
    if (this._cache.has(imageId)) return this._cache.get(imageId);
    this._fetch(imageId);
    return null;
  },

  _fetch(imageId) {
    if (this._pending.has(imageId) || this._cache.has(imageId)) return;
    this._pending.add(imageId);
    const img = new Image();
    img.onload = () => {
      this._cache.set(imageId, img);
      this._pending.delete(imageId);
      if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true });
    };
    img.onerror = () => { this._pending.delete(imageId); };
    img.src = `${API_BASE}/plan-images/${imageId}`;
  },

  // Ensure every referenced plan image is cached/fetching; drop the rest.
  syncCache() {
    const referenced = new Set();
    for (const p of AppState.planMarkup.plans) {
      if (p.imageId != null) referenced.add(p.imageId);
    }
    for (const id of referenced) this.getElementImage(id);
    for (const id of [...this._cache.keys()]) {
      if (!referenced.has(id)) this._cache.delete(id);
    }
  },

  PDF_SCALE: 3,           // high-DPI rasterization (Distribution Designer default)

  // ─── Import ───
  async importFile(file) {
    if (!file) return;
    const mime = (file.type || '').toLowerCase();
    if (mime === 'application/pdf') { await this._importPdf(file); return; }
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      alert('Unsupported file type. Use PNG, JPEG, WebP or PDF.');
      return;
    }
    try {
      const prepared = await this._prepareRaster(file);
      const meta = await this._upload(prepared.blob, prepared.mime, file.name, prepared.w, prepared.h);
      const plan = {
        id: AppState.planGenId('pmimg'),
        name: file.name || 'Plan',
        imageId: meta.id, sourcePdfId: null,
        pdfPage: null, pdfPages: null,
        imgW: prepared.w, imgH: prepared.h,
        opacity: 1, visible: true, offX: 0, offY: 0, rotation: 0, scaleAdj: 1,
      };
      AppState.planMarkup.plans.push(plan);
      // Prime the cache with the already-decoded bitmap.
      if (prepared.img) this._cache.set(meta.id, prepared.img);
      if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
      if (typeof PlanEngine !== 'undefined') { PlanEngine.zoomFit(); }
    } catch (e) {
      alert('Plan import failed: ' + (e && e.message ? e.message : e));
    }
  },

  // ─── PDF import (pdf.js) ───
  async _importPdf(file) {
    if (typeof pdfjsLib === 'undefined') { alert('PDF library not loaded.'); return; }
    try {
      const buf = await file.arrayBuffer();
      // Upload the original PDF once so pages can be re-rendered later; give
      // pdf.js its own copy (it detaches the buffer it's handed).
      const pdfMeta = await this._upload(file, 'application/pdf', file.name, 0, 0, 'pdf');
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0) }).promise;
      const numPages = pdf.numPages;
      let pages;
      if (numPages === 1) pages = [1];
      else { pages = await this._pdfPageModal(pdf, numPages); if (!pages || !pages.length) return; }

      let idx = 0;
      for (const pageNum of pages) {
        const r = await this._rasterizePdfPage(pdf, pageNum);
        const meta = await this._upload(r.blob, 'image/png', `${file.name} p${pageNum}`, r.w, r.h, 'raster');
        const plan = {
          id: AppState.planGenId('pmimg'),
          name: `${file.name} — p${pageNum}`,
          imageId: meta.id, sourcePdfId: pdfMeta.id,
          pdfPage: pageNum, pdfPages: pages.slice(), pdfPageCount: numPages,
          imgW: r.w, imgH: r.h,
          opacity: 1, visible: true, offX: idx * 40, offY: idx * 40, rotation: 0, scaleAdj: 1,
        };
        AppState.planMarkup.plans.push(plan);
        this._cache.set(meta.id, r.img);
        idx++;
      }
      if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
      if (typeof PlanEngine !== 'undefined') PlanEngine.zoomFit();
    } catch (e) {
      alert('PDF import failed: ' + (e && e.message ? e.message : e));
    }
  },

  // Rasterize one PDF page to a PNG blob at PDF_SCALE, capped at MAX_DIM.
  async _rasterizePdfPage(pdf, pageNum) {
    const page = await pdf.getPage(pageNum);
    let scale = this.PDF_SCALE;
    const base = page.getViewport({ scale: 1 });
    const longest = Math.max(base.width, base.height) * scale;
    if (longest > this.MAX_DIM) scale = this.MAX_DIM / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    const img = await this._loadImage(URL.createObjectURL(blob));
    return { blob, w: canvas.width, h: canvas.height, img };
  },

  // Re-render a different page of a plan's source PDF, swapping its raster.
  // (Wired to page-nav UI in a later phase; reusable now.)
  async renderPdfPage(plan, pageNum) {
    if (!plan.sourcePdfId) return;
    const buf = await (await fetch(`${API_BASE}/plan-images/${plan.sourcePdfId}`)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const r = await this._rasterizePdfPage(pdf, pageNum);
    const meta = await this._upload(r.blob, 'image/png', `${plan.name} p${pageNum}`, r.w, r.h, 'raster');
    plan.imageId = meta.id; plan.pdfPage = pageNum; plan.imgW = r.w; plan.imgH = r.h;
    this._cache.set(meta.id, r.img);
    if (typeof PlanMarkup !== 'undefined') { PlanMarkup.snapshot(); PlanMarkup.markDirty(); }
    if (typeof PlanEngine !== 'undefined') PlanEngine.requestDraw({ bg: true });
  },

  // Modal: thumbnails + All/None/range, returns selected page numbers (or null).
  _pdfPageModal(pdf, numPages) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal plan-pdf-modal';
      overlay.style.display = 'flex';
      overlay.style.zIndex = '3000';
      overlay.innerHTML = `
        <div class="modal-content plan-pdf-content">
          <div class="modal-header"><h3>Import PDF — ${numPages} pages</h3></div>
          <div class="modal-body">
            <div class="plan-pdf-controls">
              <button type="button" data-role="all">Select all</button>
              <button type="button" data-role="none">Clear</button>
              <span class="plan-pdf-hint">Click pages to include</span>
            </div>
            <div class="plan-pdf-grid" data-role="grid"></div>
            <div class="ui-dialog-actions">
              <button type="button" class="btn-small" data-role="cancel">Cancel</button>
              <button type="button" class="btn-primary" data-role="import">Import</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const grid = overlay.querySelector('[data-role="grid"]');
      const selected = new Set([1]);

      const cell = (n) => {
        const d = document.createElement('div');
        d.className = 'plan-pdf-cell' + (selected.has(n) ? ' sel' : '');
        d.dataset.page = String(n);
        d.innerHTML = `<canvas></canvas><div class="plan-pdf-num">${n}</div>`;
        d.addEventListener('click', () => {
          if (selected.has(n)) selected.delete(n); else selected.add(n);
          d.classList.toggle('sel', selected.has(n));
        });
        grid.appendChild(d);
        return d;
      };

      // Build cells + render thumbnails lazily (cap render to keep it snappy).
      const cap = Math.min(numPages, 60);
      const cells = [];
      for (let n = 1; n <= cap; n++) cells.push(cell(n));
      (async () => {
        for (let n = 1; n <= cap; n++) {
          try {
            const page = await pdf.getPage(n);
            const vp0 = page.getViewport({ scale: 1 });
            const scale = 140 / vp0.width;
            const vp = page.getViewport({ scale });
            const cv = cells[n - 1].querySelector('canvas');
            cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
          } catch (_) { /* skip a bad page thumbnail */ }
        }
      })();

      const close = (result) => { overlay.remove(); resolve(result); };
      overlay.querySelector('[data-role="all"]').addEventListener('click', () => {
        for (let n = 1; n <= cap; n++) selected.add(n);
        grid.querySelectorAll('.plan-pdf-cell').forEach(c => c.classList.add('sel'));
      });
      overlay.querySelector('[data-role="none"]').addEventListener('click', () => {
        selected.clear();
        grid.querySelectorAll('.plan-pdf-cell').forEach(c => c.classList.remove('sel'));
      });
      overlay.querySelector('[data-role="cancel"]').addEventListener('click', () => close(null));
      overlay.querySelector('[data-role="import"]').addEventListener('click', () =>
        close([...selected].sort((a, b) => a - b)));
    });
  },

  // Decode + downscale if the longest side exceeds MAX_DIM. Returns
  // {blob, mime, w, h, img}. Small images pass through untouched.
  async _prepareRaster(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await this._loadImage(url);
      const w0 = img.naturalWidth, h0 = img.naturalHeight;
      const longest = Math.max(w0, h0);
      if (longest <= this.MAX_DIM) {
        return { blob: file, mime: file.type, w: w0, h: h0, img };
      }
      const s = this.MAX_DIM / longest;
      const w = Math.round(w0 * s), h = Math.round(h0 * s);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const scaledImg = await this._loadImage(URL.createObjectURL(blob));
      return { blob, mime: 'image/png', w, h, img: scaledImg };
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  _loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = reject;
      im.src = url;
    });
  },

  async _upload(blob, mime, name, w, h, kind) {
    const fd = new FormData();
    const ext = mime === 'application/pdf' ? 'pdf' : 'png';
    fd.append('file', new File([blob], name || `plan.${ext}`, { type: mime }));
    fd.append('kind', kind || 'raster');
    fd.append('name', name || '');
    fd.append('width', String(w || 0));
    fd.append('height', String(h || 0));
    if (AppState.projectId) fd.append('project_id', String(AppState.projectId));
    const resp = await fetch(`${API_BASE}/plan-images`, { method: 'POST', body: fd });
    if (!resp.ok) {
      let detail = `HTTP ${resp.status}`;
      try { const j = await resp.json(); if (j.detail) detail = j.detail; } catch (_) {}
      throw new Error(detail);
    }
    return resp.json();
  },

  // Attach every not-yet-claimed referenced image to a project on first save.
  async claimOrphans(projectId) {
    if (!projectId) return;
    const ids = AppState.planMarkup.plans
      .flatMap(p => [p.imageId, p.sourcePdfId])
      .filter(id => id != null);
    for (const id of ids) {
      try {
        await fetch(`${API_BASE}/plan-images/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: Number(projectId) }),
        });
      } catch (_) { /* best-effort; cleanup sweep is the backstop */ }
    }
  },
};
