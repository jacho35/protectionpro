/* ProtectionPro — Project Save/Load & Export */

const Project = {
  init() {
    document.getElementById('btn-new').addEventListener('click', () => this.newProject());
    document.getElementById('btn-save').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open').addEventListener('click', () => this.openProject());
  },

  newProject() {
    if (AppState.dirty) {
      if (!confirm('You have unsaved changes. Create new project?')) return;
    }
    AppState.reset();
    Canvas.updateTransform();
    Canvas.render();
    Properties.clear();
    document.title = 'ProtectionPro — New Project';
  },

  async saveProject() {
    try {
      const result = await API.saveProject();
      AppState.projectId = result.id;
      AppState.dirty = false;
      document.getElementById('status-info').textContent = 'Project saved.';
      setTimeout(() => {
        document.getElementById('status-info').textContent = '';
      }, 3000);
    } catch (e) {
      // Fallback: save as local JSON file
      this.saveAsJSON();
    }
  },

  saveAsJSON() {
    const data = AppState.toJSON();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppState.projectName || 'project'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    AppState.dirty = false;
    document.getElementById('status-info').textContent = 'Saved as JSON file.';
  },

  async openProject() {
    // Try backend first, fallback to file picker
    try {
      const projects = await API.listProjects();
      if (projects && projects.length > 0) {
        this.showProjectPicker(projects);
        return;
      }
    } catch (e) {
      // Backend not available, use file picker
    }
    this.openFromFile();
  },

  openFromFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          AppState.fromJSON(data);
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          document.getElementById('status-info').textContent = 'Project loaded.';
        } catch (err) {
          alert('Invalid project file: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  showProjectPicker(projects) {
    // Simple project picker using a modal approach
    const html = projects.map(p => `
      <div class="project-item" data-id="${p.id}" style="padding:8px;cursor:pointer;border-bottom:1px solid #eee;">
        <strong>${p.name}</strong>
        <small style="color:#888;margin-left:8px;">${new Date(p.updated_at).toLocaleDateString()}</small>
      </div>
    `).join('');

    const modal = document.getElementById('settings-modal');
    modal.querySelector('h3').textContent = 'Open Project';
    modal.querySelector('.modal-body').innerHTML = `
      <div style="max-height:300px;overflow-y:auto;">${html}</div>
      <button onclick="Project.openFromFile(); document.getElementById('settings-modal').style.display='none';" class="btn-primary" style="margin-top:12px;">Open from file...</button>
    `;
    modal.style.display = '';

    modal.querySelectorAll('.project-item').forEach(el => {
      el.addEventListener('click', async () => {
        try {
          const data = await API.loadProject(el.dataset.id);
          AppState.fromJSON(data);
          AppState.projectId = el.dataset.id;
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
        modal.style.display = 'none';
      });
    });
  },
};
