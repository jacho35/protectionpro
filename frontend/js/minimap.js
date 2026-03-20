/* ProtectionPro — Mini-Map Overview Panel
 *
 * Renders a small overview of all components in the bottom-right corner.
 * Shows viewport rectangle. Click to navigate.
 */

const MiniMap = {
  canvas: null,
  ctx: null,
  width: 180,
  height: 130,
  _visible: true,

  init() {
    this.canvas = document.getElementById('minimap-canvas');
    if (!this.canvas) return;
    this.ctx = this.canvas.getContext('2d');
    this.canvas.width = this.width * 2;  // HiDPI
    this.canvas.height = this.height * 2;
    this.canvas.style.width = this.width + 'px';
    this.canvas.style.height = this.height + 'px';

    // Click to navigate
    this.canvas.addEventListener('mousedown', (e) => this._onClick(e));
    this.canvas.addEventListener('mousemove', (e) => {
      if (e.buttons === 1) this._onClick(e);
    });

    // Render after short delay to let the app load
    requestAnimationFrame(() => this.render());
  },

  toggle() {
    this._visible = !this._visible;
    const el = document.getElementById('minimap');
    if (el) el.style.display = this._visible ? '' : 'none';
    if (this._visible) this.render();
  },

  render() {
    if (!this.ctx || !this._visible) return;
    const ctx = this.ctx;
    const dpr = 2;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = document.body.classList.contains('dark-mode');
    ctx.fillStyle = isDark ? '#1e1e2e' : '#f8f9fa';
    ctx.fillRect(0, 0, this.width, this.height);

    // Calculate bounding box of all components
    const comps = [...AppState.components.values()];
    if (comps.length === 0) {
      ctx.fillStyle = isDark ? '#555' : '#aaa';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No components', this.width / 2, this.height / 2);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of comps) {
      minX = Math.min(minX, c.x - 30);
      minY = Math.min(minY, c.y - 30);
      maxX = Math.max(maxX, c.x + 30);
      maxY = Math.max(maxY, c.y + 30);
    }
    const pad = 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const mapPad = 8;
    const mapW = this.width - mapPad * 2;
    const mapH = this.height - mapPad * 2;
    const scale = Math.min(mapW / worldW, mapH / worldH);

    const toMapX = (wx) => mapPad + (wx - minX) * scale;
    const toMapY = (wy) => mapPad + (wy - minY) * scale;

    // Draw wires
    ctx.strokeStyle = isDark ? '#555' : '#bbb';
    ctx.lineWidth = 0.8;
    for (const wire of AppState.wires.values()) {
      const fromComp = AppState.components.get(wire.fromComponent);
      const toComp = AppState.components.get(wire.toComponent);
      if (!fromComp || !toComp) continue;
      ctx.beginPath();
      ctx.moveTo(toMapX(fromComp.x), toMapY(fromComp.y));
      ctx.lineTo(toMapX(toComp.x), toMapY(toComp.y));
      ctx.stroke();
    }

    // Draw components as colored dots
    const typeColors = {
      bus: '#0078d7', transformer: '#f57c00', generator: '#2e7d32', utility: '#6a1b9a',
      cable: '#888', load: '#d32f2f', motor_induction: '#00838f', motor_synchronous: '#00838f',
      relay: '#c62828', fuse: '#795548', cb: '#283593', capacitor: '#e65100',
    };
    for (const c of comps) {
      const mx = toMapX(c.x);
      const my = toMapY(c.y);
      ctx.fillStyle = typeColors[c.type] || '#888';
      if (c.type === 'bus') {
        // Draw bus as short line
        ctx.fillRect(mx - 6, my - 1.5, 12, 3);
      } else {
        ctx.beginPath();
        ctx.arc(mx, my, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      // Highlight selected
      if (AppState.selectedIds.has(c.id)) {
        ctx.strokeStyle = '#ff0';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mx, my, 5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Draw viewport rectangle
    const svg = document.getElementById('sld-canvas');
    if (svg) {
      const rect = svg.getBoundingClientRect();
      // Viewport in world coords
      const vx1 = -AppState.panX / AppState.zoom;
      const vy1 = -AppState.panY / AppState.zoom;
      const vx2 = vx1 + rect.width / AppState.zoom;
      const vy2 = vy1 + rect.height / AppState.zoom;

      const rx = toMapX(vx1);
      const ry = toMapY(vy1);
      const rw = (vx2 - vx1) * scale;
      const rh = (vy2 - vy1) * scale;

      ctx.strokeStyle = isDark ? '#7aafff' : '#0078d7';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = isDark ? 'rgba(0,120,215,0.1)' : 'rgba(0,120,215,0.08)';
      ctx.fillRect(rx, ry, rw, rh);
    }
  },

  _onClick(e) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Reverse the mapping to get world coordinates
    const comps = [...AppState.components.values()];
    if (comps.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const c of comps) {
      minX = Math.min(minX, c.x - 30);
      minY = Math.min(minY, c.y - 30);
      maxX = Math.max(maxX, c.x + 30);
      maxY = Math.max(maxY, c.y + 30);
    }
    const pad = 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const worldW = maxX - minX;
    const worldH = maxY - minY;
    const mapPad = 8;
    const mapW = this.width - mapPad * 2;
    const mapH = this.height - mapPad * 2;
    const scale = Math.min(mapW / worldW, mapH / worldH);

    const worldX = minX + (mx - mapPad) / scale;
    const worldY = minY + (my - mapPad) / scale;

    // Center the viewport on this world point
    const svg = document.getElementById('sld-canvas');
    if (svg) {
      const rect2 = svg.getBoundingClientRect();
      AppState.panX = -worldX * AppState.zoom + rect2.width / 2;
      AppState.panY = -worldY * AppState.zoom + rect2.height / 2;
      Canvas.updateTransform();
      this.render();
    }
  },
};
