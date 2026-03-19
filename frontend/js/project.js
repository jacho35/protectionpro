/* ProtectionPro — Project Save/Load & Export */

const Project = {
  init() {
    document.getElementById('btn-new').addEventListener('click', () => this.newProject());
    document.getElementById('btn-save').addEventListener('click', () => this.saveProject());
    document.getElementById('btn-open').addEventListener('click', () => this.openProject());
    document.getElementById('btn-export-json').addEventListener('click', () => this.exportJSON());
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

  // Save project — exports as JSON file (primary save action)
  saveProject() {
    if (AppState.projectName === 'Untitled Project') {
      const name = prompt('Project name:', AppState.projectName);
      if (!name) return;
      AppState.projectName = name;
    }
    this.exportJSON();
    AppState.dirty = false;
    document.title = `ProtectionPro — ${AppState.projectName}`;
  },

  // Export as JSON file (download)
  exportJSON() {
    const data = AppState.toJSON();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${AppState.projectName || 'project'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    document.getElementById('status-info').textContent = 'Exported as JSON file.';
    setTimeout(() => {
      document.getElementById('status-info').textContent = '';
    }, 3000);
  },

  // Import from JSON file
  importFromFile() {
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
          AppState.projectId = null; // imported files don't have a DB id
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          document.getElementById('status-info').textContent = 'Project imported from file.';
        } catch (err) {
          alert('Invalid project file: ' + err.message);
        }
      };
      reader.readAsText(file);
    });
    input.click();
  },

  // Open project from database, with option to import from file
  async openProject() {
    try {
      const projects = await API.listProjects();
      this.showProjectPicker(projects || []);
    } catch (e) {
      // Backend not available — show picker with just import option
      this.showProjectPicker([]);
    }
  },

  showProjectPicker(projects) {
    // Build project list HTML
    let listHtml = '';
    if (projects.length === 0) {
      listHtml = '<p style="color:#888;padding:12px;">No saved projects found.</p>';
    } else {
      listHtml = projects.map(p => `
        <div class="project-item" data-id="${p.id}">
          <div class="project-item-info">
            <strong>${p.name}</strong>
            <small>${new Date(p.updated_at).toLocaleDateString()}</small>
          </div>
          <button class="btn-delete-project" data-id="${p.id}" title="Delete project">&times;</button>
        </div>
      `).join('');
    }

    // Use a dedicated picker modal (reuse calc-modal structure)
    const modal = document.getElementById('calc-modal');
    modal.querySelector('#calc-modal-title').textContent = 'Open Project';
    modal.querySelector('#calc-modal-body').innerHTML = `
      <div class="project-list">${listHtml}</div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button id="picker-import-json" class="btn-primary">Import from JSON file...</button>
      </div>
    `;
    modal.style.display = '';

    // Bind import button
    document.getElementById('picker-import-json').addEventListener('click', () => {
      modal.style.display = 'none';
      this.importFromFile();
    });

    // Bind project items
    modal.querySelectorAll('.project-item').forEach(el => {
      el.querySelector('.project-item-info')?.addEventListener('click', async () => {
        try {
          const data = await API.loadProject(el.dataset.id);
          AppState.fromJSON(data);
          AppState.projectId = el.dataset.id;
          Canvas.updateTransform();
          Canvas.render();
          Properties.clear();
          document.title = `ProtectionPro — ${AppState.projectName}`;
          document.getElementById('status-info').textContent = 'Project loaded.';
        } catch (err) {
          alert('Failed to load project: ' + err.message);
        }
        modal.style.display = 'none';
      });
    });

    // Bind delete buttons
    modal.querySelectorAll('.btn-delete-project').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('Delete this project permanently?')) return;
        try {
          await API.deleteProject(id);
          // If we deleted the currently open project, clear the ID
          if (AppState.projectId === id) AppState.projectId = null;
          // Refresh the picker
          const updated = await API.listProjects();
          this.showProjectPicker(updated || []);
        } catch (err) {
          alert('Failed to delete: ' + err.message);
        }
      });
    });
  },
};
