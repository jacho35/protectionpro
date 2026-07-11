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

  // ─── Import ───
  async importFile(file) {
    if (!file) return;
    const mime = (file.type || '').toLowerCase();
    if (mime === 'application/pdf') {
      UI.toast ? UI.toast('PDF import arrives in the next phase — use PNG/JPEG for now.')
        : alert('PDF import arrives in the next phase — use PNG/JPEG for now.');
      return;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(mime)) {
      alert('Unsupported file type. Use PNG, JPEG or WebP (PDF support is coming).');
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

  async _upload(blob, mime, name, w, h) {
    const fd = new FormData();
    fd.append('file', new File([blob], name || 'plan.png', { type: mime }));
    fd.append('kind', 'raster');
    fd.append('name', name || '');
    fd.append('width', String(w));
    fd.append('height', String(h));
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
