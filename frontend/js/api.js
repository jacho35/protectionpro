/* ProtectionPro — API Client (Backend Communication) */

const API = {
  async request(endpoint, method = 'GET', body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
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
      console.error(`API error [${endpoint}]:`, e);
      throw e;
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

  // Run load flow
  async runLoadFlow(method = 'newton_raphson') {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    return this.request('/analysis/loadflow', 'POST', data);
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

  // Export project as JSON
  async exportJSON(id) {
    return this.request(`/projects/${id}/export/json`);
  },

  // Export report as CSV
  async exportCSV(id) {
    const resp = await fetch(`${API_BASE}/projects/${id}/export/csv`);
    if (!resp.ok) throw new Error('CSV export failed');
    return resp.blob();
  },

  // Export report as PDF
  async exportPDF(id) {
    const resp = await fetch(`${API_BASE}/projects/${id}/export/pdf`);
    if (!resp.ok) throw new Error('PDF export failed');
    return resp.blob();
  },

  // Server-side PDF report generation (from current app state)
  async generateReport(sections = null) {
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
    };
    if (sections) body.sections = sections;
    const resp = await fetch(`${API_BASE}/reports/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'PDF generation failed' }));
      throw new Error(err.detail || 'PDF generation failed');
    }
    return resp.blob();
  },

  // Server-side arc flash label PDF
  async generateArcFlashLabels() {
    const body = {
      projectName: AppState.projectName || 'Untitled Project',
      components: Array.from(AppState.components.values()).map(c => ({
        id: c.id, type: c.type, props: c.props,
      })),
      arcFlashResults: AppState.arcFlashResults || null,
    };
    const resp = await fetch(`${API_BASE}/reports/arcflash-labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: 'Arc flash labels export failed' }));
      throw new Error(err.detail || 'Arc flash labels export failed');
    }
    return resp.blob();
  },
};
