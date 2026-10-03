/* Thin WebGL2 layer: programs, meshes, textures, render targets. */
(function (root) {
  'use strict';

  function compileShader(gl, type, src, name) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = src.split('\n').map((l, i) => String(i + 1).padStart(4) + '| ' + l).join('\n');
      console.error('Shader compile failed [' + name + ']\n' + log + '\n' + numbered);
      throw new Error('Shader compile failed: ' + name + '\n' + log);
    }
    return s;
  }

  class Program {
    constructor(gl, vsSrc, fsSrc, name, defines) {
      this.gl = gl;
      this.name = name || 'prog';
      const head = '#version 300 es\n' +
        (defines ? Object.keys(defines).map(k => `#define ${k} ${defines[k]}\n`).join('') : '');
      const vs = compileShader(gl, gl.VERTEX_SHADER, head + vsSrc, this.name + '.vert');
      const fs = compileShader(gl, gl.FRAGMENT_SHADER, head + fsSrc, this.name + '.frag');
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error('Link failed ' + this.name + ': ' + gl.getProgramInfoLog(p));
      }
      gl.deleteShader(vs); gl.deleteShader(fs);
      this.p = p;
      this._u = new Map();
      this._unit = 0;
    }
    use() { this.gl.useProgram(this.p); this._unit = 0; return this; }
    loc(n) {
      if (!this._u.has(n)) this._u.set(n, this.gl.getUniformLocation(this.p, n));
      return this._u.get(n);
    }
    f(n, v) { const l = this.loc(n); if (l) this.gl.uniform1f(l, v); return this; }
    i(n, v) { const l = this.loc(n); if (l) this.gl.uniform1i(l, v); return this; }
    v2(n, x, y) { const l = this.loc(n); if (l) this.gl.uniform2f(l, x, y); return this; }
    v3(n, x, y, z) {
      const l = this.loc(n);
      if (l) { if (y === undefined) this.gl.uniform3fv(l, x); else this.gl.uniform3f(l, x, y, z); }
      return this;
    }
    v4(n, x, y, z, w) { const l = this.loc(n); if (l) this.gl.uniform4f(l, x, y, z, w); return this; }
    m4(n, m) { const l = this.loc(n); if (l) this.gl.uniformMatrix4fv(l, false, m); return this; }
    tex(n, t) {
      const l = this.loc(n);
      if (l && t) {
        const u = this._unit++;
        this.gl.activeTexture(this.gl.TEXTURE0 + u);
        this.gl.bindTexture(this.gl.TEXTURE_2D, t);
        this.gl.uniform1i(l, u);
      } else if (l) {
        this._unit++;
      }
      return this;
    }
  }

  /** Interleave-free mesh: one VBO per attribute, optional index buffer, optional instance buffers. */
  class Mesh {
    constructor(gl) {
      this.gl = gl;
      this.vao = gl.createVertexArray();
      this.buffers = {};
      this.count = 0;
      this.instances = 0;
      this.indexType = gl.UNSIGNED_INT;
      this.indexed = false;
      this.mode = gl.TRIANGLES;
    }
    attr(location, data, size, opts) {
      const gl = this.gl;
      const o = opts || {};
      gl.bindVertexArray(this.vao);
      let b = this.buffers[location];
      if (!b) { b = gl.createBuffer(); this.buffers[location] = b; }
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, o.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
      const type = o.type || gl.FLOAT;
      if (type === gl.FLOAT) {
        gl.vertexAttribPointer(location, size, type, !!o.normalized, o.stride || 0, o.offset || 0);
      } else {
        gl.vertexAttribIPointer(location, size, type, o.stride || 0, o.offset || 0);
      }
      gl.enableVertexAttribArray(location);
      if (o.divisor) gl.vertexAttribDivisor(location, o.divisor);
      gl.bindVertexArray(null);
      return this;
    }
    /** A mat4 instance attribute occupies 4 consecutive locations. */
    attrMat4(location, data) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      let b = this.buffers['m' + location];
      if (!b) { b = gl.createBuffer(); this.buffers['m' + location] = b; }
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      for (let i = 0; i < 4; i++) {
        gl.vertexAttribPointer(location + i, 4, gl.FLOAT, false, 64, i * 16);
        gl.enableVertexAttribArray(location + i);
        gl.vertexAttribDivisor(location + i, 1);
      }
      gl.bindVertexArray(null);
      return this;
    }
    index(data) {
      const gl = this.gl;
      gl.bindVertexArray(this.vao);
      if (!this.ib) this.ib = gl.createBuffer();
      gl.bindElementArrayBuffer ? 0 : 0;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.count = data.length;
      this.indexed = true;
      this.indexType = (data instanceof Uint16Array) ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
      return this;
    }
    draw() {
      const gl = this.gl;
      if (!this.count) return;
      gl.bindVertexArray(this.vao);
      if (this.instances > 0) {
        if (this.indexed) gl.drawElementsInstanced(this.mode, this.count, this.indexType, 0, this.instances);
        else gl.drawArraysInstanced(this.mode, 0, this.count, this.instances);
      } else if (this.indexed) {
        gl.drawElements(this.mode, this.count, this.indexType, 0);
      } else {
        gl.drawArrays(this.mode, 0, this.count);
      }
    }
    dispose() {
      const gl = this.gl;
      Object.values(this.buffers).forEach(b => gl.deleteBuffer(b));
      if (this.ib) gl.deleteBuffer(this.ib);
      gl.deleteVertexArray(this.vao);
      this.buffers = {}; this.ib = null; this.count = 0;
    }
  }

  function texFromCanvas(gl, canvas, opts) {
    const o = opts || {};
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, o.srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, o.wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, o.wrap || gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (o.mips === false) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    } else {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) {
        gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT,
          Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
    }
    return t;
  }

  function texFloat(gl, w, h, data, channels) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    const ifmt = channels === 1 ? gl.R16F : channels === 2 ? gl.RG16F : gl.RGBA16F;
    const fmt = channels === 1 ? gl.RED : channels === 2 ? gl.RG : gl.RGBA;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }

  class RenderTarget {
    constructor(gl, w, h, opts) {
      const o = opts || {};
      this.gl = gl; this.w = w; this.h = h;
      this.fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      if (o.color !== false) {
        this.color = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.color);
        const ifmt = o.float ? gl.RGBA16F : gl.RGBA8;
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, gl.RGBA, o.float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.color, 0);
      } else {
        gl.drawBuffers([gl.NONE]);
        gl.readBuffer(gl.NONE);
      }
      if (o.depthTexture) {
        this.depth = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.depth);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT32F, w, h, 0, gl.DEPTH_COMPONENT, gl.FLOAT, null);
        // Depth formats are not texture-filterable in WebGL2: asking for LINEAR
        // makes the texture incomplete and every sample reads 0. Take NEAREST
        // taps and do the filtering by hand in the PCF loop.
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        if (o.compare) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
        }
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depth, 0);
      } else if (o.depth !== false) {
        this.rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.rb);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rb);
      }
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) console.warn('FBO incomplete 0x' + st.toString(16));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    bind() {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, this.w, this.h);
    }
    dispose() {
      const gl = this.gl;
      if (this.color) gl.deleteTexture(this.color);
      if (this.depth) gl.deleteTexture(this.depth);
      if (this.rb) gl.deleteRenderbuffer(this.rb);
      gl.deleteFramebuffer(this.fbo);
    }
  }

  root.GLX = { Program, Mesh, RenderTarget, texFromCanvas, texFloat };
})(window);
