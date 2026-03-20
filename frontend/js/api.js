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
        const err = await resp.json().catch(() => ({ detail: resp.statusText }));
        throw new Error(err.detail || `HTTP ${resp.status}`);
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

  // Run load flow
  async runLoadFlow(method = 'newton_raphson') {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    return this.request('/analysis/loadflow', 'POST', data);
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
};
