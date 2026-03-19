/* ProtectionPro — Sidebar Palette (Drag & Drop) */

const Sidebar = {
  paletteEl: null,
  searchEl: null,
  dragGhost: null,
  dragType: null,

  init() {
    this.paletteEl = document.getElementById('palette');
    this.searchEl = document.getElementById('component-search');
    this.renderPalette();
    this.bindEvents();
  },

  renderPalette(filter = '') {
    const lowerFilter = filter.toLowerCase();
    let html = '';

    for (const cat of COMPONENT_CATEGORIES) {
      const items = cat.items.filter(type => {
        const def = COMPONENT_DEFS[type];
        return def && def.name.toLowerCase().includes(lowerFilter);
      });
      if (items.length === 0) continue;

      html += `
        <div class="palette-category" data-cat="${cat.id}">
          <div class="palette-category-header" data-cat="${cat.id}">
            <span class="arrow">&#9660;</span>
            <span>${cat.name}</span>
          </div>
          <div class="palette-category-items" data-cat="${cat.id}">
            ${items.map(type => this.renderPaletteItem(type)).join('')}
          </div>
        </div>`;
    }

    this.paletteEl.innerHTML = html;
  },

  renderPaletteItem(type) {
    const def = COMPONENT_DEFS[type];
    const iconSvg = Symbols.renderPaletteIcon(type);
    return `
      <div class="palette-item" data-type="${type}" draggable="true">
        <div class="item-icon">${iconSvg}</div>
        <div class="item-label">${def.name}</div>
      </div>`;
  },

  bindEvents() {
    // Search filter
    this.searchEl.addEventListener('input', (e) => {
      this.renderPalette(e.target.value);
    });

    // Category collapse/expand
    this.paletteEl.addEventListener('click', (e) => {
      const header = e.target.closest('.palette-category-header');
      if (!header) return;
      const cat = header.dataset.cat;
      const items = this.paletteEl.querySelector(`.palette-category-items[data-cat="${cat}"]`);
      const arrow = header.querySelector('.arrow');
      if (items) {
        items.classList.toggle('collapsed');
        arrow.classList.toggle('collapsed');
      }
    });

    // Drag start from palette
    this.paletteEl.addEventListener('dragstart', (e) => {
      const item = e.target.closest('.palette-item');
      if (!item) return;
      this.dragType = item.dataset.type;
      e.dataTransfer.setData('text/plain', this.dragType);
      e.dataTransfer.effectAllowed = 'copy';

      // Create custom drag ghost
      this.dragGhost = document.createElement('div');
      this.dragGhost.className = 'drag-ghost';
      this.dragGhost.innerHTML = Symbols.renderPaletteIcon(this.dragType);
      document.body.appendChild(this.dragGhost);
      e.dataTransfer.setDragImage(this.dragGhost, 16, 16);
    });

    this.paletteEl.addEventListener('dragend', () => {
      if (this.dragGhost) {
        this.dragGhost.remove();
        this.dragGhost = null;
      }
      this.dragType = null;
    });

    // Drop target: the SVG canvas
    const canvasContainer = document.getElementById('canvas-container');
    canvasContainer.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    canvasContainer.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/plain');
      if (type && COMPONENT_DEFS[type]) {
        Canvas.placeComponent(type, e.clientX, e.clientY);
      }
    });

    // Sidebar resize
    const resizeHandle = document.getElementById('sidebar-resize');
    let resizing = false;
    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      resizeHandle.classList.add('active');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const sidebar = document.getElementById('sidebar');
      const newWidth = Math.max(200, Math.min(400, e.clientX));
      sidebar.style.width = newWidth + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (resizing) {
        resizing = false;
        resizeHandle.classList.remove('active');
      }
    });
  },
};
