/* ProtectionPro — Revision Timeline
 *
 * Keeps up to 20 project revisions (snapshots).
 * For saved projects (with projectId): persists to backend DB.
 * For unsaved projects: stores in localStorage.
 * Displays a compact horizontal timeline strip above the status bar.
 */

const RevisionTimeline = {
  _revisions: [],         // Array of {id, label, created_at, data?} (newest first)
  _selectedId: null,       // Currently previewed revision id
  _maxLocal: 20,
  _localKey: 'protectionpro-local-revisions',

  init() {
    const strip = document.getElementById('revision-timeline');
    const toggleBtn = document.getElementById('btn-revision-toggle');
    const restoreBtn = document.getElementById('btn-revision-restore');
    const cancelBtn = document.getElementById('btn-revision-cancel');

    toggleBtn.addEventListener('click', () => {
      strip.classList.toggle('expanded');
      const detail = document.getElementById('revision-detail');
      if (!strip.classList.contains('expanded')) {
        detail.style.display = 'none';
        this._selectedId = null;
        this._renderDots();
      }
    });

    restoreBtn.addEventListener('click', () => this._confirmRestore());
    cancelBtn.addEventListener('click', () => this._cancelPreview());
  },

  // Show the timeline strip (called when a project is loaded or saved)
  async show() {
    document.getElementById('revision-timeline').style.display = '';
    await this.refresh();
  },

  hide() {
    document.getElementById('revision-timeline').style.display = 'none';
    this._revisions = [];
    this._selectedId = null;
  },

  // Refresh the revision list from backend or localStorage
  async refresh() {
    if (AppState.projectId) {
      try {
        this._revisions = await API.listRevisions(AppState.projectId);
      } catch {
        this._revisions = [];
      }
    } else {
      this._loadLocal();
    }
    this._renderDots();
  },

  // Create a new revision snapshot
  async createRevision(label = 'Manual save') {
    if (AppState.projectId) {
      try {
        await API.createRevision(AppState.projectId, label);
      } catch (e) {
        console.error('Failed to create revision:', e);
        // Fall back to local
        this._saveLocal(label);
      }
    } else {
      this._saveLocal(label);
    }
    await this.refresh();
  },

  // ── localStorage fallback for unsaved projects ──

  _loadLocal() {
    try {
      const raw = localStorage.getItem(this._localKey);
      this._revisions = raw ? JSON.parse(raw) : [];
    } catch {
      this._revisions = [];
    }
  },

  _saveLocal(label) {
    this._loadLocal();
    const snapshot = {
      id: Date.now(),
      label: label || '',
      created_at: new Date().toISOString(),
      data: JSON.stringify(AppState.toJSON()),
    };
    this._revisions.unshift(snapshot);
    if (this._revisions.length > this._maxLocal) {
      this._revisions.length = this._maxLocal;
    }
    try {
      localStorage.setItem(this._localKey, JSON.stringify(this._revisions));
    } catch (e) {
      // localStorage full — drop oldest
      while (this._revisions.length > 1) {
        this._revisions.pop();
        try {
          localStorage.setItem(this._localKey, JSON.stringify(this._revisions));
          break;
        } catch { /* keep trimming */ }
      }
    }
  },

  clearLocal() {
    localStorage.removeItem(this._localKey);
    this._revisions = [];
  },

  // ── Rendering ──

  _renderDots() {
    const container = document.getElementById('revision-dots');
    container.innerHTML = '';
    if (this._revisions.length === 0) {
      container.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">No revisions yet</span>';
      return;
    }

    // Render in chronological order (oldest → newest, left → right)
    const chronological = [...this._revisions].reverse();

    chronological.forEach((rev, i) => {
      if (i > 0) {
        const line = document.createElement('span');
        line.className = 'revision-dot-line';
        container.appendChild(line);
      }

      const dot = document.createElement('button');
      const isAuto = (rev.label || '').toLowerCase().includes('auto');
      dot.className = 'revision-dot' + (isAuto ? ' auto-save' : '');
      if (rev.id === this._selectedId) dot.classList.add('active');
      dot.dataset.revId = rev.id;
      dot.title = '';

      // Tooltip on hover
      dot.addEventListener('mouseenter', (e) => {
        const existing = dot.querySelector('.revision-dot-tooltip');
        if (existing) existing.remove();
        const tip = document.createElement('div');
        tip.className = 'revision-dot-tooltip';
        tip.textContent = `${rev.label || 'Revision'} — ${this._formatTime(rev.created_at)}`;
        dot.appendChild(tip);
      });
      dot.addEventListener('mouseleave', () => {
        const tip = dot.querySelector('.revision-dot-tooltip');
        if (tip) tip.remove();
      });

      dot.addEventListener('click', () => this._selectRevision(rev));
      container.appendChild(dot);
    });
  },

  async _selectRevision(rev) {
    this._selectedId = rev.id;
    this._renderDots();

    // Fetch full revision data if needed (backend revisions don't include data in list)
    let revData;
    if (rev.data) {
      // Local revision — data is already embedded
      revData = typeof rev.data === 'string' ? JSON.parse(rev.data) : rev.data;
    } else if (AppState.projectId) {
      try {
        const full = await API.getRevision(AppState.projectId, rev.id);
        revData = JSON.parse(full.data);
      } catch (e) {
        console.error('Failed to load revision data:', e);
        return;
      }
    }

    this._showDetailPanel(rev, revData);
  },

  _showDetailPanel(rev, revData) {
    const detail = document.getElementById('revision-detail');
    const labelEl = document.getElementById('revision-detail-label');
    const timeEl = document.getElementById('revision-detail-time');
    const statsEl = document.getElementById('revision-detail-stats');

    labelEl.textContent = rev.label || 'Revision';
    timeEl.textContent = this._formatTime(rev.created_at);

    // Show diff stats comparing revision to current state
    const currentComps = AppState.components.size;
    const currentWires = AppState.wires.size;
    const revComps = revData?.components?.length ?? 0;
    const revWires = revData?.wires?.length ?? 0;
    const compDiff = currentComps - revComps;
    const wireDiff = currentWires - revWires;

    let stats = `Revision: ${revComps} component(s), ${revWires} wire(s)`;
    stats += ` · Current: ${currentComps} component(s), ${currentWires} wire(s)`;
    if (compDiff !== 0 || wireDiff !== 0) {
      const parts = [];
      if (compDiff !== 0) parts.push(`${compDiff > 0 ? '+' : ''}${compDiff} components`);
      if (wireDiff !== 0) parts.push(`${wireDiff > 0 ? '+' : ''}${wireDiff} wires`);
      stats += ` · Δ ${parts.join(', ')} since this revision`;
    }
    statsEl.textContent = stats;

    // Store for restore
    this._pendingRestoreData = revData;
    this._pendingRestoreRev = rev;

    detail.style.display = '';

    // Ensure timeline is expanded
    document.getElementById('revision-timeline').classList.add('expanded');
  },

  _cancelPreview() {
    document.getElementById('revision-detail').style.display = 'none';
    this._selectedId = null;
    this._pendingRestoreData = null;
    this._pendingRestoreRev = null;
    this._renderDots();
  },

  async _confirmRestore() {
    const revData = this._pendingRestoreData;
    if (!revData) return;

    // Save current state as a revision before restoring (so user can go back)
    await this.createRevision('Before restore');

    // Apply the revision data, preserving the current projectId
    const savedProjectId = AppState.projectId;
    AppState.fromJSON(revData);
    AppState.projectId = savedProjectId;
    AppState.dirty = true;

    Canvas.updateTransform();
    if (typeof renderPageTabs === 'function') renderPageTabs();
    Canvas.render();
    Properties.clear();
    document.title = `ProtectionPro — ${AppState.projectName}`;
    if (typeof updateProjectNameDisplay === 'function') updateProjectNameDisplay();

    // Close detail panel
    document.getElementById('revision-detail').style.display = 'none';
    this._selectedId = null;
    this._pendingRestoreData = null;
    this._pendingRestoreRev = null;

    // Refresh timeline
    await this.refresh();

    Project._statusMsg('Restored revision.');
  },

  // ── Helpers ──

  _formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMs / 3600000);

    if (diffMin < 1) return 'Just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;

    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  },
};
