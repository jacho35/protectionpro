/* ProtectionPro — API Client (Backend Communication) */

const API = {
  // Abort in-flight requests after this many milliseconds
  REQUEST_TIMEOUT_MS: 60000,

  // ── Auth token (JWT bearer, persisted in localStorage) ──
  _tokenKey: 'protectionpro-token',
  getToken() {
    try { return localStorage.getItem(this._tokenKey); } catch (_) { return null; }
  },
  setToken(t) {
    try { t ? localStorage.setItem(this._tokenKey, t) : localStorage.removeItem(this._tokenKey); } catch (_) {}
  },
  clearToken() { this.setToken(null); },

  // Shared 401 handler: an expired/invalid token clears itself and re-shows
  // the login gate — but NOT for the /auth/* endpoints, where a 401 is a
  // legitimate result (bad login) whose real message the caller should see.
  _handleUnauthorized(endpoint) {
    if (endpoint.startsWith('/auth/')) return false;
    this.clearToken();
    if (typeof Auth !== 'undefined' && Auth.onUnauthorized) Auth.onUnauthorized(endpoint);
    return true;
  },

  async request(endpoint, method = 'GET', body = null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    const token = this.getToken();
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);

    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, opts);
      if (!resp.ok) {
        if (resp.status === 401 && this._handleUnauthorized(endpoint)) {
          throw new Error('Your session has expired — please sign in again.');
        }
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
    const opts = { method, headers: {}, signal: controller.signal };
    const token = this.getToken();
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    try {
      const resp = await fetch(`${API_BASE}${endpoint}`, opts);
      if (!resp.ok) {
        if (resp.status === 401 && this._handleUnauthorized(endpoint)) {
          throw new Error('Your session has expired — please sign in again.');
        }
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

  // [PS-3] Companion MINIMUM-current fault study (IEC 60909-0 §5.3.1):
  // c_min = 0.95 and hot-conductor cable resistance (default 70 °C operating
  // temperature). Used by the compliance engine to verify earth-fault
  // disconnection against the current that may ACTUALLY flow — checking
  // against the maximum-current study passes circuits the standard fails.
  async runFaultAnalysisMin(faultBusId = null, faultType = null, conductorTempC = 70) {
    const data = AppState.toJSON();
    if (faultBusId) data.faultBusId = faultBusId;
    if (faultType) data.faultType = faultType;
    data.voltageFactor = 0.95;
    data.conductorTemperatureC = conductorTempC;
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

  // Run DC load flow (resistive nodal solve on the DC bus network)
  async runDCLoadFlow() {
    const data = AppState.toJSON();
    return this.request('/analysis/dc-loadflow', 'POST', data);
  },

  // Run DC short circuit (IEC 61660-1) on the DC bus network
  async runDCShortCircuit(faultBusId = null) {
    const data = AppState.toJSON();
    if (faultBusId) data.faultBusId = faultBusId;
    return this.request('/analysis/dc-shortcircuit', 'POST', data);
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

  // Run dynamic motor starting (time-domain acceleration) analysis.
  // An explicit start-timeline schedule (from the config modal) overrides
  // whatever toJSON already carries; batch runs use the persisted schedule.
  async runDynamicMotorStarting(schedule) {
    const data = AppState.toJSON();
    if (schedule) data.dynamicMotorSchedule = schedule;
    return this.request('/analysis/dynamic-motor-starting', 'POST', data);
  },

  // Run load flow across several named study cases (Load Flow Study Manager).
  // The request body is the live project (the implicit "Current network" case)
  // plus the saved cases; each case carries its own full network snapshot.
  async runLoadFlowCases(cases, method = 'newton_raphson', includeCurrent = true) {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    data.cases = cases;
    data.includeCurrent = includeCurrent;
    return this.request('/analysis/loadflow-cases', 'POST', data);
  },

  // Run steady-state voltage stability (P-V nose curves + Q-V reactive margin).
  // opts: { qvBusId, step, lambdaMax, vFloor } — all optional (engine defaults).
  async runVoltageStability(opts = {}) {
    const data = AppState.toJSON();
    if (opts.qvBusId) data.qv_bus_id = opts.qvBusId;
    if (opts.step != null) data.step = opts.step;
    if (opts.lambdaMax != null) data.lambda_max = opts.lambdaMax;
    if (opts.vFloor != null) data.v_floor = opts.vFloor;
    return this.request('/analysis/voltage-stability', 'POST', data);
  },

  // Run passive filter sizing (single-tuned branches to meet IEEE 519).
  // opts: { filterBusId, totalKvar, qualityFactor, maxBranches } — optional.
  async runFilterSizing(opts = {}) {
    const data = AppState.toJSON();
    if (opts.filterBusId) data.filter_bus_id = opts.filterBusId;
    if (opts.totalKvar != null) data.total_kvar = opts.totalKvar;
    if (opts.qualityFactor != null) data.quality_factor = opts.qualityFactor;
    if (opts.maxBranches != null) data.max_branches = opts.maxBranches;
    return this.request('/analysis/filter-sizing', 'POST', data);
  },

  // Run the reliability assessment (SAIDI/SAIFI/MAIFI, IEEE 1366 FMEA).
  async runReliability() {
    const data = AppState.toJSON();
    return this.request('/analysis/reliability', 'POST', data);
  },

  // Run optimal power flow (economic dispatch + Volt/VAR).
  // opts: { objective, vMin, vMax, loadingLimitPct, useDispatch,
  //         useCapacitors, useTaps, useSetpoints, maxMoves } — optional.
  async runOPF(opts = {}) {
    const data = AppState.toJSON();
    if (opts.objective) data.objective = opts.objective;
    if (opts.vMin != null) data.v_min = opts.vMin;
    if (opts.vMax != null) data.v_max = opts.vMax;
    if (opts.loadingLimitPct != null) data.loading_limit_pct = opts.loadingLimitPct;
    if (opts.useDispatch != null) data.use_dispatch = opts.useDispatch;
    if (opts.useCapacitors != null) data.use_capacitors = opts.useCapacitors;
    if (opts.useTaps != null) data.use_taps = opts.useTaps;
    if (opts.useSetpoints != null) data.use_setpoints = opts.useSetpoints;
    if (opts.maxMoves != null) data.max_moves = opts.maxMoves;
    return this.request('/analysis/opf', 'POST', data);
  },

  // Run battery sizing & discharge simulation.
  // opts: { batteryId, dutyCycle, agingFactor, designMargin, temperatureC,
  //         autonomyTargetMin } — optional.
  async runBatterySizing(opts = {}) {
    const data = AppState.toJSON();
    if (opts.batteryId) data.battery_id = opts.batteryId;
    if (opts.dutyCycle) data.duty_cycle = opts.dutyCycle;
    if (opts.agingFactor != null) data.aging_factor = opts.agingFactor;
    if (opts.designMargin != null) data.design_margin = opts.designMargin;
    if (opts.temperatureC != null) data.temperature_c = opts.temperatureC;
    if (opts.autonomyTargetMin != null) data.autonomy_target_min = opts.autonomyTargetMin;
    return this.request('/analysis/battery-sizing', 'POST', data);
  },

  // Run the frequency scan (driving-point impedance vs frequency).
  // opts: { busIds, hMax, hStep } — optional.
  async runFrequencyScan(opts = {}) {
    const data = AppState.toJSON();
    if (opts.busIds && opts.busIds.length) data.scan_bus_ids = opts.busIds;
    if (opts.hMax != null) data.h_max = opts.hMax;
    if (opts.hStep != null) data.h_step = opts.hStep;
    return this.request('/analysis/frequency-scan', 'POST', data);
  },

  // Run N-1 / N-2 contingency screening.
  // opts: { includeN2, vMin, vMax, loadingLimitPct, maxContingencies } — optional.
  async runContingency(opts = {}) {
    const data = AppState.toJSON();
    if (opts.includeN2 != null) data.include_n2 = opts.includeN2;
    if (opts.vMin != null) data.v_min = opts.vMin;
    if (opts.vMax != null) data.v_max = opts.vMax;
    if (opts.loadingLimitPct != null) data.loading_limit_pct = opts.loadingLimitPct;
    if (opts.maxContingencies != null) data.max_contingencies = opts.maxContingencies;
    return this.request('/analysis/contingency', 'POST', data);
  },

  // Run harmonic penetration analysis (IEEE 519) — VFDs as current sources
  async runHarmonics(method = 'newton_raphson') {
    const data = AppState.toJSON();
    data.loadFlowMethod = method;
    return this.request('/analysis/harmonics', 'POST', data);
  },

  // Run classical transient stability (time-domain rotor angle)
  async runTransientStability(disturbance) {
    const data = AppState.toJSON();
    data.stabilityDisturbance = disturbance;
    return this.request('/analysis/transient-stability', 'POST', data);
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

  // Run grid-outage backup adequacy & battery autonomy study
  async runBackupAutonomy() {
    const data = AppState.toJSON();
    return this.request('/analysis/backup', 'POST', data);
  },

  // Run grounding system analysis (IEEE 80)
  async runGroundingAnalysis() {
    const data = AppState.toJSON();
    return this.request('/analysis/grounding', 'POST', data);
  },

  // Run lightning risk assessment (IEC 62305-2) — params form, not ProjectData
  async runLightningRisk(params) {
    return this.request('/analysis/lightning-risk', 'POST', params);
  },

  // Run raceway conduit-fill / grouping-derating analysis
  async runRacewayAnalysis(raceways) {
    return this.request('/analysis/raceway', 'POST', { raceways });
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

  // ── Auth ──
  async login(email, password) {
    return this.request('/auth/login', 'POST', { email, password });
  },
  async register(payload) {
    // payload: { email, password, name?, invite_code? }
    return this.request('/auth/register', 'POST', payload);
  },
  async me() {
    return this.request('/auth/me');
  },
  async logout() {
    return this.request('/auth/logout', 'POST');
  },

  // ── Admin invites ──
  async listInvites() {
    return this.request('/auth/invites');
  },
  async createInvite(opts = {}) {
    return this.request('/auth/invites', 'POST', opts);   // { email?, expires_at? }
  },
  async deleteInvite(id) {
    return this.request(`/auth/invites/${id}`, 'DELETE');
  },

  // ── Project sharing (grants keyed by the collaborator's user id) ──
  async listShares(projectId) {
    return this.request(`/projects/${projectId}/shares`);
  },
  async shareProject(projectId, email, role) {
    return this.request(`/projects/${projectId}/shares`, 'POST', { email, role });
  },
  async updateShare(projectId, userId, role) {
    return this.request(`/projects/${projectId}/shares/${userId}`, 'PATCH', { role });
  },
  async unshareProject(projectId, userId) {
    return this.request(`/projects/${projectId}/shares/${userId}`, 'DELETE');
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
      faultResults: AppState.freshResult('faultResults'),
      loadFlowResults: AppState.freshResult('loadFlowResults'),
      arcFlashResults: AppState.freshResult('arcFlashResults'),
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
      // Out-of-date results (computed on an older engine version) are sent as
      // null so they are excluded from the report until re-run.
      faultResults: AppState.freshResult('faultResults'),
      loadFlowResults: AppState.freshResult('loadFlowResults'),
      arcFlashResults: AppState.freshResult('arcFlashResults'),
      cableSizingResults: AppState.freshResult('cableSizingResults'),
      motorStartingResults: AppState.freshResult('motorStartingResults'),
      dynamicMotorResults: AppState.freshResult('dynamicMotorResults'),
      stabilityResults: AppState.freshResult('stabilityResults'),
      dutyCheckResults: AppState.freshResult('dutyCheckResults'),
      loadDiversityResults: AppState.freshResult('loadDiversityResults'),
      groundingResults: AppState.freshResult('groundingResults'),
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
      arcFlashResults: AppState.freshResult('arcFlashResults'),
      projectDetails: AppState.projectDetails || {},
    };
    return this.requestBlob('/reports/arcflash-labels', {
      method: 'POST', body, errorLabel: 'Arc flash labels export failed',
    });
  },
};
