/* ProtectionPro — API Client (Backend Communication) */

const API = {
  // Abort in-flight requests after this many milliseconds
  REQUEST_TIMEOUT_MS: 60000,

  async request(endpoint, method = 'GET', body = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, opts);
      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const err = await resp.json();
          // FastAPI returns {detail: "..."} for HTTPException
          // and {detail: [{msg: "...", ...}]} for validation errors
          if (typeof err.detail === 'string') {
            detail = err.detail;
          } else if (Array.isArray(err.detail)) {
            detail = err.detail.map(d => d.msg || d.message || JSON.stringify(d)).join('; ');
          } else if (err.message) {
            detail = err.message;
          }
        } catch (_) {
          // Response wasn't JSON — try reading as text
          try {
            const text = await resp.text();
            if (text.length < 300) detail = text;
          } catch (_2) { /* use default */ }
        }
        throw new Error(detail);
      }
      return await resp.json();
    } catch (e) {
      if (e.name === 'AbortError') {
        const err = new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS / 1000} s — the backend may be hung or unreachable.`);
        console.error(`API timeout [${endpoint}]:`, err);
        throw err;
      }
      console.error(`API error [${endpoint}]:`, e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  // Blob-response variant of request() for report/label/export downloads.
  // Same AbortController timeout, so a hung backend can't leave
  // "Generating PDF report..." spinning forever.
  async requestBlob(endpoint, { method = 'GET', body = null, errorLabel = 'Export failed' } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    const opts = { method, signal: controller.signal };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, opts);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: errorLabel }));
        throw new Error(typeof err.detail === 'string' ? err.detail : errorLabel);
      }
      return await resp.blob();
    } catch (e) {
      if (e.name === 'AbortError') {
        const timeoutErr = new Error(`Request timed out after ${this.REQUEST_TIMEOUT_MS / 1000} s — the backend may be hung or unreachable.`);
        console.error(`API timeout [${endpoint}]:`, timeoutErr);
        throw timeoutErr;
      }
      console.error(`API error [${endpoint}]:`, e);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },

  // Run fault analysis
  async runFaultAnalysis(faultBusId = null, faultType = null) {
    const data = AppState.toJSON();
    if (faultBusId) data.faultBusId = faultBusId;
    if (faultType) data.faultType = faultType;
    return this.request('/analysis/fault', 'POST', data);
  },

  // Run arc flash analysis
  async runArcFlash() {
    const data = AppState.toJSON();
    return this.request('/analysis/arcflash', 'POST', data);
  },

  // Run DC arc flash analysis
  async runDCArcFlash() {
    const data = AppState.toJSON();
    return this.request('/analysis/dc-arcflash', 'POST', data);
  },

  // Run load flow
  async runLoadFlow(method = 'newton_raphson') {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    return this.request('/analysis/loadflow', 'POST', data);
  },

  // Run unbalanced three-phase load flow
  async runUnbalancedLoadFlow(method = 'newton_raphson') {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    return this.request('/analysis/unbalanced-loadflow', 'POST', data);
  },

  // Run cable sizing analysis
  async runCableSizing(options = {}) {
    const data = { ...AppState.toJSON(), ...options };
    return this.request('/analysis/cable-sizing', 'POST', data);
  },

  // Run motor starting voltage dip analysis
  async runMotorStarting() {
    const data = AppState.toJSON();
    return this.request('/analysis/motor-starting', 'POST', data);
  },

  // Run equipment duty check
  async runDutyCheck() {
    const data = AppState.toJSON();
    return this.request('/analysis/duty-check', 'POST', data);
  },

  // Run load diversity analysis
  async runLoadDiversity() {
    const data = AppState.toJSON();
    return this.request('/analysis/load-diversity', 'POST', data);
  },

  // Run grounding system analysis (IEEE 80)
  async runGroundingAnalysis() {
    const data = AppState.toJSON();
    return this.request('/analysis/grounding', 'POST', data);
  },

  // Run ADMD reticulation demand estimation (NRS 034-1 / CTEF100).
  // Diversity is applied per minisub across its downstream kiosks.
  async runAdmd(settings, kiosks, minisubs = []) {
    return this.request('/analysis/admd', 'POST', { settings, kiosks, minisubs });
  },

  // Run study manager (batch all analyses)
  async runStudyManager(enabledStudies = null) {
    const data = AppState.toJSON();
    if (enabledStudies) data.enabled_studies = enabledStudies;
    return this.request('/analysis/study-manager', 'POST', data);
  },

  // Save project
  async saveProject() {
    const data = AppState.toJSON();
    if (AppState.projectId) {
      return this.request(`/projects/${AppState.projectId}`, 'PUT', data);
    } else {
      return this.request('/projects', 'POST', data);
    }
  },

  // Load project
  async loadProject(id) {
    return this.request(`/projects/${id}`);
  },

  // List projects
  async listProjects() {
    return this.request('/projects');
  },

  // Delete project
  async deleteProject(id) {
    return this.request(`/projects/${id}`, 'DELETE');
  },

  // Rename project
  async renameProject(id, name) {
    return this.request(`/projects/${id}/rename`, 'PATCH', { name });
  },

  // Move project to folder
  async moveProject(id, folderId) {
    return this.request(`/projects/${id}/move`, 'PATCH', { folder_id: folderId });
  },

  // Folder CRUD
  async listFolders() {
    return this.request('/projects/folders');
  },

  async createFolder(name, parentId = null) {
    return this.request('/projects/folders', 'POST', { name, parent_id: parentId });
  },

  async updateFolder(id, data) {
    return this.request(`/projects/folders/${id}`, 'PUT', data);
  },

  async deleteFolder(id) {
    return this.request(`/projects/folders/${id}`, 'DELETE');
  },

  // ── Revisions ──

  async listRevisions(projectId) {
    return this.request(`/projects/${projectId}/revisions`);
  },

  async createRevision(projectId, label = '') {
    return this.request(`/projects/${projectId}/revisions`, 'POST', { label });
  },

  async getRevision(projectId, revisionId) {
    return this.request(`/projects/${projectId}/revisions/${revisionId}`);
  },

  async deleteRevision(projectId, revisionId) {
    return this.request(`/projects/${projectId}/revisions/${revisionId}`, 'DELETE');
  },

  // Export project as JSON
  async exportJSON(id) {
    return this.request(`/projects/${id}/export/json`);
  },

  // Export report as CSV
  async exportCSV(id) {
    return this.requestBlob(`/projects/${id}/export/csv`, { errorLabel: 'CSV export failed' });
  },

  // Export report as PDF
  async exportPDF(id) {
    return this.requestBlob(`/projects/${id}/export/pdf`, { errorLabel: 'PDF export failed' });
  },

  // Server-side PDF report generation (from current app state)
  async generateReport(sections = null, diagramImage = null) {
    const body = {
      projectName: AppState.projectName || 'Untitled Project',
      baseMVA: AppState.baseMVA,
      frequency: AppState.frequency,
      components: Array.from(AppState.components.values()).map(c => ({
        id: c.id, type: c.type, props: c.props,
      })),
      faultResults: AppState.faultResults || null,
      loadFlowResults: AppState.loadFlowResults || null,
      arcFlashResults: AppState.arcFlashResults || null,
      projectDetails: AppState.projectDetails || {},
    };
    if (sections) body.sections = sections;
    if (diagramImage) body.diagramImage = diagramImage;
    return this.requestBlob('/reports/pdf', {
      method: 'POST', body, errorLabel: 'PDF generation failed',
    });
  },

  // Detailed calculations report PDF (all available analysis results)
  async generateCalculationsReport() {
    const body = {
      projectName: AppState.projectName || 'Untitled Project',
      baseMVA: AppState.baseMVA,
      frequency: AppState.frequency,
      components: Array.from(AppState.components.values()).map(c => ({
        id: c.id, type: c.type, props: c.props,
      })),
      faultResults: AppState.faultResults || null,
      loadFlowResults: AppState.loadFlowResults || null,
      arcFlashResults: AppState.arcFlashResults || null,
      cableSizingResults: AppState.cableSizingResults || null,
      motorStartingResults: AppState.motorStartingResults || null,
      dutyCheckResults: AppState.dutyCheckResults || null,
      loadDiversityResults: AppState.loadDiversityResults || null,
      groundingResults: AppState.groundingResults || null,
      projectDetails: AppState.projectDetails || {},
    };
    return this.requestBlob('/reports/calculations', {
      method: 'POST', body, errorLabel: 'Calculations report generation failed',
    });
  },

  // Server-side arc flash label PDF
  async generateArcFlashLabels() {
    const body = {
      projectName: AppState.projectName || 'Untitled Project',
      components: Array.from(AppState.components.values()).map(c => ({
        id: c.id, type: c.type, props: c.props,
      })),
      arcFlashResults: AppState.arcFlashResults || null,
      projectDetails: AppState.projectDetails || {},
    };
    return this.requestBlob('/reports/arcflash-labels', {
      method: 'POST', body, errorLabel: 'Arc flash labels export failed',
    });
  },
};
