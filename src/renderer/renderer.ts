// WebGL2 渲染器: G-Buffer(MRT) -> 半分辨率 SSAO -> Sobel 描边 -> 合成
import type { ClipPlaneState, Jaw, JawModel, ViewerSettings } from '../core/types';
import { m4, type Mat4, type Vec3 } from '../core/math';
import * as SH from './shaders';

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error('着色器编译失败: ' + log);
  }
  return sh;
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error('着色器链接失败: ' + gl.getProgramInfoLog(p));
  }
  return p;
}

function uniformLocs(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Record<string, WebGLUniformLocation | null> {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
}

export interface RenderMesh {
  vao: WebGLVertexArrayObject;
  indexCount: number;
  vertexCount: number;
  /** 逐顶点色谱值 (可选), 独立 buffer 挂在 location=2 */
  heatBuffer: WebGLBuffer | null;
}

export interface HeatUpdate {
  normalized: Float32Array;
  sampleIndices: Uint32Array;
}

export class Renderer {
  gl: WebGL2RenderingContext;
  private progGbuf: WebGLProgram;
  private progGbufHeat: WebGLProgram;
  private progSsao: WebGLProgram;
  private progBlur: WebGLProgram;
  private progEdge: WebGLProgram;
  private progComposite: WebGLProgram;
  private progGizmo: WebGLProgram;
  private progCap: WebGLProgram;
  private locGbuf: Record<string, WebGLUniformLocation | null>;
  private locHeat: Record<string, WebGLUniformLocation | null>;
  private locSsao: Record<string, WebGLUniformLocation | null>;
  private locBlur: Record<string, WebGLUniformLocation | null>;
  private locEdge: Record<string, WebGLUniformLocation | null>;
  private locComp: Record<string, WebGLUniformLocation | null>;
  private locGizmo: Record<string, WebGLUniformLocation | null>;
  private locCap: Record<string, WebGLUniformLocation | null>;

  private quadVao: WebGLVertexArrayObject;
  private gbufFbo!: WebGLFramebuffer;
  private posTex!: WebGLTexture;
  private normalTex!: WebGLTexture;
  private albedoTex!: WebGLTexture;
  private depthTex!: WebGLTexture;
  private ssaoFbo!: WebGLFramebuffer;
  private ssaoTex!: WebGLTexture;
  private ssaoBlurTex!: WebGLTexture;
  private ssaoBlurFbo!: WebGLFramebuffer;
  private edgeFbo!: WebGLFramebuffer;
  private edgeTex!: WebGLTexture;
  private heatLutTex!: WebGLTexture;
  private noiseTex!: WebGLTexture;
  private samples: Vec3[] = [];
  private width = 1;
  private height = 1;
  private renderMeshes = new Map<Jaw, RenderMesh>();
  /** 场景世界包围盒, 用于位置纹理归一化编码 */
  sceneMin: Vec3 = [-150, -150, -150];
  sceneMax: Vec3 = [150, 150, 150];

  setSceneBounds(min: Vec3, max: Vec3): void {
    // 留 5% 余量, 避免边界点被 clamp
    const pad = 0.05;
    this.sceneMin = min.map((v, i) => v - (max[i] - v) * pad) as Vec3;
    this.sceneMax = max.map((v, i) => v + (v - min[i]) * pad) as Vec3;
  }

  private sceneInvSize(): Vec3 {
    return [
      1 / Math.max(1e-6, this.sceneMax[0] - this.sceneMin[0]),
      1 / Math.max(1e-6, this.sceneMax[1] - this.sceneMin[1]),
      1 / Math.max(1e-6, this.sceneMax[2] - this.sceneMin[2]),
    ];
  }

  settings: ViewerSettings = {
    ssaoEnabled: true,
    ssaoRadius: 3.2,
    ssaoStrength: 2.2,
    edgeEnabled: true,
    edgeStrength: 1.6,
    lightAzimuth: 35,
    lightElevation: 45,
  };

  clipPlane: ClipPlaneState | null = null;
  /** 剖面填充几何 (世界坐标三角形) */
  capGeometry: { vao: WebGLVertexArrayObject; count: number } | null = null;
  private capVbo: WebGLBuffer | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true, // 报告截图需要
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    this.progGbuf = program(gl, SH.GBUF_VS, SH.GBUF_FS);
    this.progGbufHeat = program(gl, SH.GBUF_VS_HEAT, SH.GBUF_FS_HEAT);
    this.progSsao = program(gl, SH.FULLSCREEN_VS, SH.SSAO_FS);
    this.progBlur = program(gl, SH.FULLSCREEN_VS, SH.SSAO_BLUR_FS);
    this.progEdge = program(gl, SH.FULLSCREEN_VS, SH.EDGE_FS);
    this.progComposite = program(gl, SH.FULLSCREEN_VS, SH.COMPOSITE_FS);
    this.progGizmo = program(gl, SH.GIZMO_VS, SH.GIZMO_FS);
    this.progCap = program(gl, SH.CAP_VS, SH.CAP_FS);

    this.locGbuf = uniformLocs(gl, this.progGbuf, ['uModel', 'uViewProj', 'uNormalMat', 'uClipPlane', 'uColor', 'uAlpha', 'uUseHeat', 'uHeatTex', 'uHeatValue', 'uSceneMin', 'uSceneInvSize']);
    this.locHeat = uniformLocs(gl, this.progGbufHeat, ['uModel', 'uViewProj', 'uNormalMat', 'uClipPlane', 'uHeatTex', 'uAlpha', 'uSceneMin', 'uSceneInvSize']);
    this.locSsao = uniformLocs(gl, this.progSsao, ['uNormalTex', 'uDepthTex', 'uNoiseTex', 'uInvViewProj', 'uProj', 'uSamples', 'uRadius', 'uStrength', 'uNoiseScale']);
    this.locBlur = uniformLocs(gl, this.progBlur, ['uSsao']);
    this.locEdge = uniformLocs(gl, this.progEdge, ['uDepthTex', 'uNormalTex', 'uStrength']);
    this.locComp = uniformLocs(gl, this.progComposite, ['uNormalTex', 'uAlbedoTex', 'uSsaoTex', 'uSsaoEnabled', 'uEdge', 'uLightDir', 'uEyePos']);
    this.locGizmo = uniformLocs(gl, this.progGizmo, ['uViewProj', 'uModel', 'uColor']);
    this.locCap = uniformLocs(gl, this.progCap, ['uViewProj', 'uColor']);

    this.quadVao = gl.createVertexArray()!;
    const qbo = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, qbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.heatLutTex = this.createHeatLut();
    this.noiseTex = this.createNoiseTexture();
    this.generateSamples();
  }

  private createHeatLut(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    // 蓝 -> 青 -> 绿 -> 黄 ->红 (冷=近, 热=远), 256 级
    const data = new Uint8Array(256 * 4);
    const stops: [number, [number, number, number]][] = [
      [0.0, [30, 70, 200]],
      [0.25, [0, 180, 220]],
      [0.5, [40, 190, 90]],
      [0.75, [240, 210, 40]],
      [1.0, [225, 45, 40]],
    ];
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let a = stops[0], b = stops[stops.length - 1];
      for (let s = 0; s < stops.length - 1; s++) {
        if (t >= stops[s][0] && t <= stops[s + 1][0]) { a = stops[s]; b = stops[s + 1]; break; }
      }
      const f = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
      data[i * 4] = a[1][0] + (b[1][0] - a[1][0]) * f;
      data[i * 4 + 1] = a[1][1] + (b[1][1] - a[1][1]) * f;
      data[i * 4 + 2] = a[1][2] + (b[1][2] - a[1][2]) * f;
      data[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private createNoiseTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    const data = new Uint8Array(16 * 16 * 4);
    let s = 12345;
    for (let i = 0; i < data.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      data[i] = s & 0xff;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 16, 16, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  private generateSamples(): void {
    let s = 987654321;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 32; i++) {
      const v: Vec3 = [rnd() * 2 - 1, rnd() * 2 - 1, rnd()];
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      v[0] /= l; v[1] /= l; v[2] /= l;
      const scale = i / 32;
      const k = 0.1 + scale * scale * 0.9;
      v[0] *= k; v[1] *= k; v[2] *= k;
      this.samples.push(v);
    }
  }

  getMeshVertexCount(jaw: Jaw): number | null {
    return this.renderMeshes.get(jaw)?.vertexCount ?? null;
  }

  uploadMesh(jaw: Jaw, model: JawModel): RenderMesh {
    const gl = this.gl;
    const existing = this.renderMeshes.get(jaw);
    if (existing) {
      gl.deleteVertexArray(existing.vao);
      if (existing.heatBuffer) gl.deleteBuffer(existing.heatBuffer);
    }
    const { mesh } = model;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, nbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const rm: RenderMesh = { vao, indexCount: mesh.indices.length, vertexCount: mesh.vertexCount, heatBuffer: null };
    this.renderMeshes.set(jaw, rm);
    return rm;
  }

  /** 上传/更新色谱逐顶点数据 (只覆盖被采样的顶点, 其余默认 0) */
  updateHeat(jaw: Jaw, vertexCount: number, update: HeatUpdate): void {
    const gl = this.gl;
    const rm = this.renderMeshes.get(jaw);
    if (!rm) return;
    const heat = new Float32Array(vertexCount);
    for (let i = 0; i < update.sampleIndices.length; i++) {
      heat[update.sampleIndices[i]] = update.normalized[i];
    }
    gl.bindVertexArray(rm.vao);
    if (!rm.heatBuffer) {
      rm.heatBuffer = gl.createBuffer();
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, rm.heatBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, heat, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  clearHeat(jaw: Jaw): void {
    const gl = this.gl;
    const rm = this.renderMeshes.get(jaw);
    if (!rm || !rm.heatBuffer) return;
    gl.deleteBuffer(rm.heatBuffer);
    rm.heatBuffer = null;
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(2, width);
    this.height = Math.max(2, height);
    const gl = this.gl;
    const w = this.width, h = this.height;
    const hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));

    const makeTex = (internal: number, fmt: number, type: number, tw: number, th: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, fmt, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };

    // 位置纹理用 RGBA8 打包编码 (SwiftShader 等软件渲染器不支持浮点颜色附件)
    this.posTex = makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h);
    this.normalTex = makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h);
    this.albedoTex = makeTex(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h);
    this.depthTex = makeTex(gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, w, h);

    this.gbufFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.posTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.normalTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.albedoTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.depthTex, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);

    this.ssaoTex = makeTex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, hw, hh);
    this.ssaoFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ssaoTex, 0);

    this.ssaoBlurTex = makeTex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, hw, hh);
    this.ssaoBlurFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoBlurFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.ssaoBlurTex, 0);

    this.edgeTex = makeTex(gl.R8, gl.RED, gl.UNSIGNED_BYTE, w, h);
    this.edgeFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgeFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.edgeTex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private clipPlaneVec(): Vec3 | [number, number, number, number] {
    // 禁用时给极大正偏移: 着色器中 vClip = dot(n,p) + w < 0 才 discard,
    // 法线为 0 且 w=+1e9 时所有片元都通过
    if (!this.clipPlane || !this.clipPlane.enabled) return [0, 0, 0, 1e9];
    const { point, normal } = this.clipPlane;
    return [normal[0], normal[1], normal[2], -(normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2])];
  }

  private drawGbuffer(viewProj: Mat4, models: Map<Jaw, JawModel>, heatJaw: Jaw | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // 防止 feedback loop: 解绑前序通道残留在纹理单元上的 G-Buffer 纹理
    for (let unit = 0; unit < 8; unit++) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    const clip = this.clipPlaneVec();

    const drawOne = (jaw: Jaw, color: Vec3) => {
      const model = models.get(jaw);
      const rm = this.renderMeshes.get(jaw);
      if (!model || !rm || !model.visible) return;
      const nmat = m4.normalMatrix(model.transform);
      gl.bindVertexArray(rm.vao);
      const useHeat = heatJaw === jaw && rm.heatBuffer;
      const prog = useHeat ? this.progGbufHeat : this.progGbuf;
      gl.useProgram(prog);
      if (useHeat) {
        gl.uniformMatrix4fv(this.locHeat.uModel, false, model.transform);
        gl.uniformMatrix4fv(this.locHeat.uViewProj, false, viewProj);
        gl.uniformMatrix3fv(this.locHeat.uNormalMat, false, nmat);
        gl.uniform4fv(this.locHeat.uClipPlane, clip as number[]);
        gl.uniform1f(this.locHeat.uAlpha, model.opacity);
        gl.uniform3fv(this.locHeat.uSceneMin, this.sceneMin);
        gl.uniform3fv(this.locHeat.uSceneInvSize, this.sceneInvSize());
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.heatLutTex);
        gl.uniform1i(this.locHeat.uHeatTex, 0);
      } else {
        gl.uniformMatrix4fv(this.locGbuf.uModel, false, model.transform);
        gl.uniformMatrix4fv(this.locGbuf.uViewProj, false, viewProj);
        gl.uniformMatrix3fv(this.locGbuf.uNormalMat, false, nmat);
        gl.uniform4fv(this.locGbuf.uClipPlane, clip as number[]);
        gl.uniform3fv(this.locGbuf.uColor, color);
        gl.uniform1f(this.locGbuf.uAlpha, model.opacity);
        gl.uniform1f(this.locGbuf.uUseHeat, 0);
        gl.uniform3fv(this.locGbuf.uSceneMin, this.sceneMin);
        gl.uniform3fv(this.locGbuf.uSceneInvSize, this.sceneInvSize());
        // 非色谱通道: 采样器指向无附件的 LUT, 避免采样到当前 FBO 的附件
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.heatLutTex);
        gl.uniform1i(this.locGbuf.uHeatTex, 0);
      }
      // 半透明: 关闭深度写入, 开启混合
      if (model.opacity < 0.999) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      }
      gl.drawElements(gl.TRIANGLES, rm.indexCount, gl.UNSIGNED_INT, 0);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    };

    drawOne('upper', [0.93, 0.88, 0.78]);
    drawOne('lower', [0.86, 0.8, 0.72]);
    gl.bindVertexArray(null);
  }

  private drawSsao(proj: Mat4, invViewProj: Mat4): void {
    const gl = this.gl;
    const hw = Math.max(1, Math.floor(this.width / 2)), hh = Math.max(1, Math.floor(this.height / 2));
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoFbo);
    gl.viewport(0, 0, hw, hh);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.progSsao);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.uniform1i(this.locSsao.uNormalTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(this.locSsao.uDepthTex, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.uniform1i(this.locSsao.uNoiseTex, 2);
    gl.uniformMatrix4fv(this.locSsao.uProj, false, proj);
    gl.uniformMatrix4fv(this.locSsao.uInvViewProj, false, invViewProj);
    for (let i = 0; i < 32; i++) gl.uniform3fv(gl.getUniformLocation(this.progSsao, `uSamples[${i}]`), this.samples[i]);
    gl.uniform1f(this.locSsao.uRadius, this.settings.ssaoRadius);
    gl.uniform1f(this.locSsao.uStrength, this.settings.ssaoStrength);
    gl.uniform2f(this.locSsao.uNoiseScale, hw / 16, hh / 16);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ssaoBlurFbo);
    gl.useProgram(this.progBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.ssaoTex);
    gl.uniform1i(this.locBlur.uSsao, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawEdge(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.edgeFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.progEdge);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.uniform1i(this.locEdge.uDepthTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.uniform1i(this.locEdge.uNormalTex, 1);
    gl.uniform1f(this.locEdge.uStrength, this.settings.edgeStrength);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private drawCaps(viewProj: Mat4): void {
    if (!this.capGeometry || !this.clipPlane?.fillCap) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gbufFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.progCap);
    gl.bindVertexArray(this.capGeometry.vao);
    gl.uniformMatrix4fv(this.locCap.uViewProj, false, viewProj);
    gl.uniform4f(this.locCap.uColor, 0.95, 0.55, 0.35, 0.9);
    gl.drawArrays(gl.TRIANGLES, 0, this.capGeometry.count);
    gl.bindVertexArray(null);
  }

  /** 更新剖面填充几何 (三角形顶点, 世界坐标) */
  updateCapGeometry(triangles: Float32Array): void {
    const gl = this.gl;
    if (this.capGeometry) {
      gl.deleteVertexArray(this.capGeometry.vao);
      gl.deleteBuffer(this.capVbo);
      this.capGeometry = null;
      this.capVbo = null;
    }
    if (triangles.length === 0) return;
    const vao = gl.createVertexArray()!;
    this.capVbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.capVbo);
    gl.bufferData(gl.ARRAY_BUFFER, triangles, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.capGeometry = { vao, count: triangles.length / 3 };
  }

  /** 平面 gizmo: 半透明四边形 + 边框线 */
  drawPlaneGizmo(viewProj: Mat4, center: Vec3, u: Vec3, v: Vec3, halfSize: number): void {
    const gl = this.gl;
    const corners = [
      [center[0] + (u[0] - v[0]) * halfSize, center[1] + (u[1] - v[1]) * halfSize, center[2] + (u[2] - v[2]) * halfSize],
      [center[0] + (u[0] + v[0]) * halfSize, center[1] + (u[1] + v[1]) * halfSize, center[2] + (u[2] + v[2]) * halfSize],
      [center[0] + (-u[0] + v[0]) * halfSize, center[1] + (-u[1] + v[1]) * halfSize, center[2] + (-u[2] + v[2]) * halfSize],
      [center[0] + (-u[0] - v[0]) * halfSize, center[1] + (-u[1] - v[1]) * halfSize, center[2] + (-u[2] - v[2]) * halfSize],
    ];
    const verts = new Float32Array([
      ...corners[0], ...corners[1], ...corners[2],
      ...corners[0], ...corners[2], ...corners[3],
    ]);
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(this.progGizmo);
    gl.uniformMatrix4fv(this.locGizmo.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.locGizmo.uModel, false, m4.identity());
    gl.uniform4f(this.locGizmo.uColor, 0.25, 0.6, 0.95, 0.12);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.deleteVertexArray(vao);
    gl.deleteBuffer(vbo);
  }

  render(viewProj: Mat4, proj: Mat4, view: Mat4, eye: Vec3, models: Map<Jaw, JawModel>, heatJaw: Jaw | null, showGizmo: boolean, gizmoFrame?: { center: Vec3; u: Vec3; v: Vec3; half: number }): void {
    const gl = this.gl;
    this.drawGbuffer(viewProj, models, heatJaw);
    this.drawCaps(viewProj);
    const invViewProj = m4.invert(viewProj);
    if (this.settings.ssaoEnabled) this.drawSsao(proj, invViewProj);
    if (this.settings.edgeEnabled) this.drawEdge();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.12, 0.13, 0.15, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progComposite);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.uniform1i(this.locComp.uNormalTex, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.uniform1i(this.locComp.uAlbedoTex, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.settings.ssaoEnabled ? this.ssaoBlurTex : this.ssaoTex);
    gl.uniform1i(this.locComp.uSsaoTex, 2);
    gl.uniform1f(this.locComp.uSsaoEnabled, this.settings.ssaoEnabled ? 1 : 0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.edgeTex);
    gl.uniform1f(this.locComp.uEdge, this.settings.edgeEnabled ? 1 : 0);
    const az = (this.settings.lightAzimuth * Math.PI) / 180;
    const el = (this.settings.lightElevation * Math.PI) / 180;
    gl.uniform3f(this.locComp.uLightDir, Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
    gl.uniform3fv(this.locComp.uEyePos, eye);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);

    if (showGizmo && gizmoFrame) {
      this.drawPlaneGizmo(viewProj, gizmoFrame.center, gizmoFrame.u, gizmoFrame.v, gizmoFrame.half);
    }
  }

  screenshot(): string {
    const gl = this.gl;
    const canvas = gl.canvas as HTMLCanvasElement;
    return canvas.toDataURL('image/png');
  }

  dispose(): void {
    const gl = this.gl;
    for (const rm of this.renderMeshes.values()) {
      gl.deleteVertexArray(rm.vao);
      if (rm.heatBuffer) gl.deleteBuffer(rm.heatBuffer);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
