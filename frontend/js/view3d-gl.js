/* V3DGL — the WebGL2 backend of View3D.
 *
 * View3D keeps the camera, the owner's draw callback (face / line / glow / label), input and the 2D painter. When a view is
 * created with { gl: true } and WebGL2 is available, View3D hands every frame to this class instead of painting polygons far to near:
 *   - a real depth buffer (no painter ordering errors, no `hidden()` ray tests), 4x MSAA
 *   - two-sided lighting (ambient + hemisphere + one directional light) per face, optional real shadows from a shadow map
 *   - thick, dashed lines drawn as screen-space quads
 *   - picking from an ID buffer: the front-most pickable item under the pointer, exact
 * Vertices are projected on the CPU by View3D (it already does, for labels and picking), so this class needs no matrices except the
 * light's. `layer` keeps its meaning for callers: a layer below 3 is depth tested and pulled toward the viewer by `layer` (so a module
 * on a roof plane, or a marking on a floor, always wins the tie); a layer of 3 or more (handles, gizmo, tool strips) is drawn last
 * with no depth test. A face with alpha below 1 is drawn after the opaque ones, far to near, without writing depth.
 *
 * If the context is lost or a shader will not compile, `ok` turns false and View3D falls back to the 2D painter.
 */
class V3DGL {
  static create(canvas) {
    let gl = null;
    try { gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, depth: true, stencil: false }); } catch (_) { gl = null; }
    if (!gl) return null;
    try { return new V3DGL(canvas, gl); } catch (e) { return null; }
  }

  constructor(canvas, gl) {
    this.canvas = canvas; this.gl = gl; this.ok = true;
    this.shadowSize = 2048;
    this.progs = {};
    this._buf = {};
    const defs = (extra) => '#version 300 es\n' + (extra || '');
    this.progs.face = this._prog(defs(), V3DGL.VS_FACE, V3DGL.FS_FACE);
    this.progs.line = this._prog(defs(), V3DGL.VS_LINE, V3DGL.FS_LINE);
    this.progs.idFace = this._prog(defs('#define ID\n'), V3DGL.VS_FACE, V3DGL.FS_FACE);
    this.progs.idLine = this._prog(defs('#define ID\n'), V3DGL.VS_LINE, V3DGL.FS_LINE);
    this.progs.tex = this._prog(defs('#define TEX\n'), V3DGL.VS_FACE, V3DGL.FS_FACE);
    this.progs.shadow = this._prog(defs(), V3DGL.VS_SHADOW, V3DGL.FS_SHADOW);
    this._tex = new WeakMap();
    this.vao = gl.createVertexArray();
    this._shadowTex = null; this._shadowFbo = null;
    this._idFbo = null; this._idW = 0; this._idH = 0;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; if (this.onLost) this.onLost(); });
  }

  _prog(prefix, vsSrc, fsSrc) {
    const gl = this.gl, mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, prefix + src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
    p.u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); p.u[a.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, a.name); }
    return p;
  }

  // One interleaved dynamic buffer per kind; attributes are described by [location, size] in order.
  _upload(kind, data, attrs, stride) {
    const gl = this.gl;
    let b = this._buf[kind]; if (!b) b = this._buf[kind] = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    let off = 0;
    attrs.forEach(([loc, size]) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4); off += size; });
  }

  // ─── Geometry builders (CPU → interleaved floats) ──────────────────────
  // Face vertex: screen x, y, depth(-1..1) | world xyz | normal xyz | rgba | lit | uv
  static faceVerts(faces, W, H) {
    let n = 0; for (const f of faces) n += f.tris.length * 3;
    const out = new Float32Array(n * 16); let o = 0;
    for (const f of faces) {
      const c = f.rgba, lit = f.lit ? 1 : 0, nm = f.n || [0, 0, 1], uv = f.tex ? f.tex.uv : null;
      for (const t of f.tris) for (let k = 0; k < 3; k++) {
        const i = t[k], s = f.sp[i], w = f.pts[i];
        out[o++] = s[0]; out[o++] = s[1]; out[o++] = s.z;
        out[o++] = w[0]; out[o++] = w[1]; out[o++] = w[2];
        out[o++] = nm[0]; out[o++] = nm[1]; out[o++] = nm[2];
        out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2]; out[o++] = c[3]; out[o++] = lit;
        out[o++] = uv ? uv[i][0] : 0; out[o++] = uv ? uv[i][1] : 0;
      }
    }
    return { data: out, count: n };
  }

  // Line vertex: screen x, y, depth | rgba | length along the line (px) | dash on, off (px, 0 = solid) | across (-1..1)
  static lineVerts(lines, minW) {
    let segs = 0; for (const l of lines) segs += Math.max(0, l.sp.length - 1);
    const out = new Float32Array(segs * 6 * 11); let o = 0;
    const put = (x, y, z, c, s, d0, d1, e) => { out[o++] = x; out[o++] = y; out[o++] = z; out[o++] = c[0]; out[o++] = c[1]; out[o++] = c[2]; out[o++] = c[3]; out[o++] = s; out[o++] = d0; out[o++] = d1; out[o++] = e; };
    for (const l of lines) {
      const half = Math.max(minW || 0, l.lw || 1) / 2 + 0.25, dash = l.dash && l.dash.length ? l.dash : null, d0 = dash ? dash[0] : 0, d1 = dash ? (dash[1] != null ? dash[1] : dash[0]) : 0;
      let acc = 0;
      for (let i = 0; i + 1 < l.sp.length; i++) {
        const a = l.sp[i], b = l.sp[i + 1];
        let dx = b[0] - a[0], dy = b[1] - a[1]; const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;
        dx /= len; dy /= len;
        const nx = -dy * half, ny = dx * half, ex = dx * half, ey = dy * half;
        const ax = a[0] - ex, ay = a[1] - ey, bx = b[0] + ex, by = b[1] + ey;
        const s0 = acc - half, s1 = acc + len + half, c = l.rgba;
        put(ax - nx, ay - ny, a.z, c, s0, d0, d1, -1); put(ax + nx, ay + ny, a.z, c, s0, d0, d1, 1); put(bx + nx, by + ny, b.z, c, s1, d0, d1, 1);
        put(ax - nx, ay - ny, a.z, c, s0, d0, d1, -1); put(bx + nx, by + ny, b.z, c, s1, d0, d1, 1); put(bx - nx, by - ny, b.z, c, s1, d0, d1, -1);
        acc += len;
      }
    }
    return { data: out.subarray(0, o), count: o / 11 };
  }

  // ─── Drawing ───────────────────────────────────────────────────────────
  _faceAttrs() { return [[0, 3], [1, 3], [2, 3], [3, 4], [4, 1], [5, 2]]; }
  _lineAttrs() { return [[0, 3], [1, 4], [2, 1], [3, 2], [4, 1]]; }
  _clearAttribs() { const gl = this.gl; for (let i = 0; i < 7; i++) gl.disableVertexAttribArray(i); }

  _drawFaces(prog, list, W, H, frame, idMode) {
    if (!list.length) return;
    const gl = this.gl, v = V3DGL.faceVerts(list, W, H);
    if (!v.count) return;
    gl.useProgram(prog); gl.bindVertexArray(this.vao);
    this._upload('face', v.data, this._faceAttrs(), 16);
    gl.uniform2f(prog.u.uSize, W, H);
    if (!idMode) this._lightUniforms(prog, frame);
    gl.drawArrays(gl.TRIANGLES, 0, v.count);
    this._clearAttribs();
  }
  _drawLines(prog, list, W, H, idMode) {
    if (!list.length) return;
    const gl = this.gl, v = V3DGL.lineVerts(list, idMode ? 10 : 0);
    if (!v.count) return;
    gl.useProgram(prog); gl.bindVertexArray(this.vao);
    this._upload('line', v.data, this._lineAttrs(), 11);
    gl.uniform2f(prog.u.uSize, W, H);
    gl.drawArrays(gl.TRIANGLES, 0, v.count);
    this._clearAttribs();
  }
  // A picture as a texture (cached per image; shrunk when it is bigger than the GPU takes or 4096 px).
  _texture(img) {
    const gl = this.gl; let t = this._tex.get(img);
    if (t) return t;
    let src = img; const lim = Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE)), w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (w > lim || h > lim) { const k = lim / Math.max(w, h), c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); src = c; }
    t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this._tex.set(img, t);
    return t;
  }
  // Textured faces (the plan picture on the ground), lit and shadowed like any face, one draw per picture.
  _drawTex(list, W, H, frame) {
    if (!list.length) return;
    const gl = this.gl, by = new Map();
    for (const f of list) { if (!by.has(f.tex.img)) by.set(f.tex.img, []); by.get(f.tex.img).push(f); }
    for (const [img, fs] of by) {
      const v = V3DGL.faceVerts(fs, W, H); if (!v.count) continue;
      const tex = this._texture(img), prog = this.progs.tex;
      gl.useProgram(prog); gl.bindVertexArray(this.vao);
      this._upload('face', v.data, this._faceAttrs(), 16);
      gl.uniform2f(prog.u.uSize, W, H);
      this._lightUniforms(prog, frame);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u.uTex, 1); gl.activeTexture(gl.TEXTURE0);
      gl.drawArrays(gl.TRIANGLES, 0, v.count);
      this._clearAttribs();
    }
  }
  _lightUniforms(prog, fr) {
    const gl = this.gl, L = fr.light, d = L.dir, m = Math.hypot(d[0], d[1], d[2]) || 1;
    gl.uniform3f(prog.u.uLight, d[0] / m, d[1] / m, d[2] / m);
    gl.uniform3f(prog.u.uLp, L.ambient, L.sun, L.sky);
    gl.uniform3f(prog.u.uViewDir, fr.viewDir[0], fr.viewDir[1], fr.viewDir[2]);
    gl.uniform1f(prog.u.uShadowOn, fr.shadow ? 1 : 0);
    if (fr.shadow) {
      gl.uniformMatrix4fv(prog.u.uLightVP, false, fr.shadow.vp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._shadowTex);
      gl.uniform1i(prog.u.uShadow, 0);
      gl.uniform1f(prog.u.uTexel, 1 / this.shadowSize);
    }
  }

  _size(W, H, dpr) {
    const c = this.canvas, w = Math.round(W * dpr), h = Math.round(H * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  // frame: { W, H, dpr, bg:[r,g,b,a], faces:[{sp,pts,tris,rgba,lit,n,layer,pick,noShadow}], lines:[{sp,rgba,lw,dash,layer,pick}],
  //          light:{dir,ambient,sun,sky}, viewDir, sunOn (use light.dir as a sun with shadows) }
  render(fr) {
    if (!this.ok) return false;
    const gl = this.gl, W = fr.W, H = fr.H;
    this._size(W, H, fr.dpr);
    fr.shadow = fr.sunOn ? this._shadowPass(fr) : null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(fr.bg[0] * fr.bg[3], fr.bg[1] * fr.bg[3], fr.bg[2] * fr.bg[3], fr.bg[3]);
    gl.clearDepth(1);
    gl.depthMask(true); gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const split = (arr) => {
      const op = [], tr = [], top = [];
      for (const x of arr) (x.layer >= 3 ? top : x.rgba[3] < 0.999 ? tr : op).push(x);
      return { op, tr, top };
    };
    const F = split(fr.faces), Ln = split(fr.lines);
    const byLayer = (list) => { const m = new Map(); for (const x of list) { const k = x.layer; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return [...m.entries()].sort((a, b) => a[0] - b[0]); };
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.enable(gl.POLYGON_OFFSET_FILL);
    for (const [layer, list] of byLayer(F.op)) { gl.polygonOffset(-layer * 1.5, -layer * 3); this._drawFaces(this.progs.face, list.filter(f => !f.tex), W, H, fr, false); this._drawTex(list.filter(f => f.tex), W, H, fr); }
    gl.depthMask(false); gl.depthFunc(gl.LEQUAL);                                       // lines test against the faces but do not write depth: two lines on one edge never z-fight
    for (const [layer, list] of byLayer(Ln.op)) { gl.polygonOffset(-3 - layer * 1.5, -14 - layer * 3); this._drawLines(this.progs.line, list, W, H, false); }
    gl.depthFunc(gl.LESS);                                                               // transparent: far to near, no depth write                                                                 // transparent: far to near, no depth write
    for (const [layer, list] of byLayer(F.tr)) { gl.polygonOffset(-layer * 1.5, -layer * 3); this._drawFaces(this.progs.face, list.sort((a, b) => a.d - b.d), W, H, fr, false); }
    for (const [layer, list] of byLayer(Ln.tr)) { gl.polygonOffset(-3 - layer * 1.5, -14 - layer * 3); this._drawLines(this.progs.line, list.sort((a, b) => a.d - b.d), W, H, false); }
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.DEPTH_TEST);                       // tool overlays on top
    for (const [, list] of byLayer(F.top)) this._drawFaces(this.progs.face, list.sort((a, b) => a.d - b.d), W, H, fr, false);
    for (const [, list] of byLayer(Ln.top)) this._drawLines(this.progs.line, list.sort((a, b) => a.d - b.d), W, H, false);
    gl.depthMask(true);
    return true;
  }

  // ─── Shadow map ────────────────────────────────────────────────────────
  _shadowPass(fr) {
    const gl = this.gl, S = this.shadowSize;
    const casters = fr.faces.filter(f => f.layer < 3 && f.rgba[3] > 0.5 && f.lit && !f.noShadow);
    if (!casters.length) return null;
    // light basis: z toward the light, x / y spanning the casters' box
    const d = fr.light.dir, m = Math.hypot(d[0], d[1], d[2]) || 1, z = [d[0] / m, d[1] / m, d[2] / m];
    const ref = Math.abs(z[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
    let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]]; const xm = Math.hypot(...x); x = x.map(v => v / xm);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const f of casters) for (const p of f.pts) {
      const a = p[0] * x[0] + p[1] * x[1] + p[2] * x[2], b = p[0] * y[0] + p[1] * y[1] + p[2] * y[2], c = p[0] * z[0] + p[1] * z[1] + p[2] * z[2];
      x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); z0 = Math.min(z0, c); z1 = Math.max(z1, c);
    }
    const pad = 0.5; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad; z0 -= pad; z1 += pad;
    // column-major: ndc_x / ndc_y from the light's x / y axes, ndc_z = -2c / (z1 - z0) + (z1 + z0) / (z1 - z0) (nearer the light = smaller)
    const sx = 2 / (x1 - x0), sy = 2 / (y1 - y0), sz = -2 / (z1 - z0);
    const vp = new Float32Array([
      x[0] * sx, y[0] * sy, z[0] * sz, 0,
      x[1] * sx, y[1] * sy, z[1] * sz, 0,
      x[2] * sx, y[2] * sy, z[2] * sz, 0,
      -(x1 + x0) / (x1 - x0), -(y1 + y0) / (y1 - y0), (z1 + z0) / (z1 - z0), 1]);
    if (!this._shadowTex) {
      this._shadowTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._shadowTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, S, S);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
      this._shadowFbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadowFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this._shadowTex, 0);
      gl.drawBuffers([gl.NONE]); gl.readBuffer(gl.NONE);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._shadowFbo);
    gl.viewport(0, 0, S, S);
    gl.colorMask(false, false, false, false); gl.depthMask(true);
    gl.clearDepth(1); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.disable(gl.BLEND);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(2.5, 6);
    let n = 0; for (const f of casters) n += f.tris.length * 3;
    const data = new Float32Array(n * 3); let o = 0;
    for (const f of casters) for (const t of f.tris) for (let k = 0; k < 3; k++) { const p = f.pts[t[k]]; data[o++] = p[0]; data[o++] = p[1]; data[o++] = p[2]; }
    gl.useProgram(this.progs.shadow); gl.bindVertexArray(this.vao);
    this._upload('shadow', data, [[0, 3]], 3);
    gl.uniformMatrix4fv(this.progs.shadow.u.uLightVP, false, vp);
    gl.drawArrays(gl.TRIANGLES, 0, n);
    this._clearAttribs();
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.colorMask(true, true, true, true);
    gl.enable(gl.BLEND);
    return { vp };
  }

  // ─── Picking ───────────────────────────────────────────────────────────
  // Draw the pickable items with flat id colours and read the pixel under (sx, sy) (CSS px). Returns the item's pick key or null.
  pick(fr, sx, sy) {
    if (!this.ok) return null;
    const gl = this.gl, W = Math.max(1, Math.round(fr.W)), H = Math.max(1, Math.round(fr.H));
    if (!this._idFbo || this._idW !== W || this._idH !== H) {
      if (this._idFbo) { gl.deleteFramebuffer(this._idFbo); gl.deleteTexture(this._idTex); gl.deleteRenderbuffer(this._idDepth); }
      this._idTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this._idTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._idDepth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, this._idDepth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H);
      this._idFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this._idFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._idTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this._idDepth);
      this._idW = W; this._idH = H;
    }
    const keys = [];
    const idOf = (key) => { keys.push(key); const id = keys.length, c = [(id & 255) / 255, ((id >> 8) & 255) / 255, ((id >> 16) & 255) / 255, 1]; return c; };
    const faces = fr.faces.filter(f => f.pick != null).map(f => Object.assign({}, f, { rgba: idOf(f.pick), lit: false }));
    const lines = fr.lines.filter(l => l.pick != null).map(l => Object.assign({}, l, { rgba: idOf(l.pick) }));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._idFbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    const byLayer = (list) => { const m = new Map(); for (const x of list) { if (!m.has(x.layer)) m.set(x.layer, []); m.get(x.layer).push(x); } return [...m.entries()].sort((a, b) => a[0] - b[0]); };
    const lo = (a) => a.filter(x => x.layer < 3), hi = (a) => a.filter(x => x.layer >= 3);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.enable(gl.POLYGON_OFFSET_FILL);
    for (const [layer, list] of byLayer(lo(faces))) { gl.polygonOffset(-layer * 1.5, -layer * 3); this._drawFaces(this.progs.idFace, list, W, H, fr, true); }
    gl.depthMask(false); gl.depthFunc(gl.LEQUAL);
    for (const [layer, list] of byLayer(lo(lines))) { gl.polygonOffset(-3 - layer * 1.5, -14 - layer * 3); this._drawLines(this.progs.idLine, list, W, H, true); }
    gl.depthMask(true); gl.depthFunc(gl.LESS);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.disable(gl.DEPTH_TEST);
    for (const [, list] of byLayer(hi(faces))) this._drawFaces(this.progs.idFace, list.sort((a, b) => a.d - b.d), W, H, fr, true);
    for (const [, list] of byLayer(hi(lines))) this._drawLines(this.progs.idLine, list.sort((a, b) => a.d - b.d), W, H, true);
    const px = new Uint8Array(4), x = Math.max(0, Math.min(W - 1, Math.floor(sx))), y = Math.max(0, Math.min(H - 1, H - 1 - Math.floor(sy)));
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.enable(gl.BLEND);
    const id = px[0] | (px[1] << 8) | (px[2] << 16);
    return id > 0 && id <= keys.length ? keys[id - 1] : null;
  }

  destroy() {
    try { const e = this.gl.getExtension('WEBGL_lose_context'); if (e) e.loseContext(); } catch (_) { /* gone */ }
    this.ok = false;
  }
}

V3DGL.VS_FACE = `
precision highp float;
layout(location=0) in vec3 aScr; layout(location=1) in vec3 aWorld; layout(location=2) in vec3 aNorm;
layout(location=3) in vec4 aCol; layout(location=4) in float aLit; layout(location=5) in vec2 aUV;
uniform vec2 uSize;
out vec3 vWorld; out vec3 vNorm; out vec4 vCol; out float vLit; out vec2 vUV;
void main() {
  vWorld = aWorld; vNorm = aNorm; vCol = aCol; vLit = aLit; vUV = aUV;
  gl_Position = vec4(aScr.x / uSize.x * 2.0 - 1.0, 1.0 - aScr.y / uSize.y * 2.0, aScr.z, 1.0);
}`;
V3DGL.FS_FACE = `
precision highp float; precision highp sampler2DShadow;
in vec3 vWorld; in vec3 vNorm; in vec4 vCol; in float vLit; in vec2 vUV;
out vec4 outColor;
#ifdef TEX
uniform sampler2D uTex;
#endif
#ifndef ID
uniform vec3 uLight; uniform vec3 uLp; uniform vec3 uViewDir; uniform float uShadowOn;
uniform mat4 uLightVP; uniform sampler2DShadow uShadow; uniform float uTexel;
float shadowAt(vec3 wp) {
  vec4 lp = uLightVP * vec4(wp, 1.0);
  vec3 c = lp.xyz / lp.w * 0.5 + 0.5;
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  float s = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) s += texture(uShadow, vec3(c.xy + vec2(float(i), float(j)) * uTexel, c.z - 0.0016));
  return s / 9.0;
}
#endif
void main() {
#ifdef ID
  outColor = vec4(vCol.rgb, 1.0);
#else
  vec4 col = vCol;
#ifdef TEX
  col = texture(uTex, vUV); col.a *= vCol.a;
#endif
  if (vLit > 0.5) {
    vec3 n = normalize(vNorm);
    if (dot(n, uViewDir) < 0.0) n = -n;
    float ndl = max(0.0, dot(n, uLight));
    float sh = 1.0;
    if (uShadowOn > 0.5 && ndl > 0.0) sh = shadowAt(vWorld + n * 0.07);
    float f = max(0.18, uLp.x + uLp.y * ndl * sh + uLp.z * (0.5 + 0.5 * n.z));
    col.rgb *= f;
  }
  outColor = vec4(col.rgb * col.a, col.a);
#endif
}`;
V3DGL.VS_LINE = `
precision highp float;
layout(location=0) in vec3 aScr; layout(location=1) in vec4 aCol; layout(location=2) in float aS; layout(location=3) in vec2 aDash; layout(location=4) in float aEdge;
uniform vec2 uSize;
out vec4 vCol; out float vS; out vec2 vDash;
void main() { vCol = aCol; vS = aS; vDash = aDash; gl_Position = vec4(aScr.x / uSize.x * 2.0 - 1.0, 1.0 - aScr.y / uSize.y * 2.0, aScr.z, 1.0); }`;
V3DGL.FS_LINE = `
precision highp float;
in vec4 vCol; in float vS; in vec2 vDash;
out vec4 outColor;
void main() {
  if (vDash.x > 0.0) { float p = mod(vS, vDash.x + vDash.y); if (p > vDash.x) discard; }
#ifdef ID
  outColor = vec4(vCol.rgb, 1.0);
#else
  outColor = vec4(vCol.rgb * vCol.a, vCol.a);
#endif
}`;
V3DGL.VS_SHADOW = `
precision highp float;
layout(location=0) in vec3 aWorld;
uniform mat4 uLightVP;
void main() { gl_Position = uLightVP * vec4(aWorld, 1.0); }`;
V3DGL.FS_SHADOW = `
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

if (typeof module !== 'undefined' && module.exports) module.exports = V3DGL;
