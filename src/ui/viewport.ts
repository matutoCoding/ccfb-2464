// 共享 3D 视口: 渲染循环 + 相机 + 接触点标记 + 剖切平面 gizmo 拖拽 + FPS
import { Renderer } from '../renderer/renderer';
import { OrbitCamera } from '../renderer/orbitCamera';
import { store } from '../core/store';
import type { Jaw, JawModel } from '../core/types';
import { boundingBox } from '../core/meshParser';
import { m4, v3, type Vec3 } from '../core/math';
import { rayPlane, sectionAnalysis, worldToLocal } from '../core/section';
import * as SH from '../renderer/shaders';

export interface ViewportHooks {
  /** 每帧额外叠加 (2D canvas 标注由外部自行绘制) */
  onSectionPlaneChanged?: () => void;
  onPickPlane?: (worldPoint: Vec3) => void;
}

interface MarkerProgram {
  prog: WebGLProgram;
  vbo: WebGLBuffer;
  vao: WebGLVertexArrayObject;
  locs: Record<string, WebGLUniformLocation | null>;
}

export class Viewport3D {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  renderer: Renderer;
  camera = new OrbitCamera();
  private detachCam: () => void;
  private raf = 0;
  private running = true;
  private marker: MarkerProgram | null = null;
  private fpsEl: HTMLElement;
  private frameTimes: number[] = [];
  private lastFrame = performance.now();
  private sectionDirty = false;
  private draggingPlane = false;
  /** 已上传网格的 mesh 引用, 引用变化即重新上传 */
  private uploadedRefs = new Map<Jaw, JawModel['mesh']>();
  hooks: ViewportHooks = {};
  /** 是否绘制接触点标记 (咬合页开启, 其他页关闭) */
  showContactMarkers = false;
  /** 外部请求的截图回调钩子 */
  beforeScreenshot: (() => void) | null = null;
  private resizeObs: ResizeObserver;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-canvas';
    this.overlay = document.createElement('canvas');
    this.overlay.className = 'overlay-canvas';
    container.appendChild(this.canvas);
    container.appendChild(this.overlay);
    this.fpsEl = document.createElement('div');
    this.fpsEl.className = 'fps-badge';
    container.appendChild(this.fpsEl);

    this.renderer = new Renderer(this.canvas);
    this.renderer.settings = store.state.settings;
    this.detachCam = this.camera.attach(this.canvas);

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(container);
    this.resize();

    this.buildMarkerProgram();
    this.bindPlaneDrag();
    store.subscribe(() => this.onStoreChange());
    this.loop();
    if (import.meta.env.DEV) {
      (window as unknown as { __vp?: Viewport3D }).__vp = this;
    }
  }

  private buildMarkerProgram(): void {
    const gl = this.renderer.gl;
    const prog = (() => {
      const vs = SH.GIZMO_VS;
      const fs = `#version 300 es
        precision highp float;
        uniform vec4 uColor;
        out vec4 outColor;
        void main(){ outColor = uColor; }`;
      const p = gl.createProgram()!;
      const cv = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(cv, vs); gl.compileShader(cv);
      const cf = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(cf, fs); gl.compileShader(cf);
      gl.attachShader(p, cv); gl.attachShader(p, cf); gl.linkProgram(p);
      return p;
    })();
    const vao = gl.createVertexArray()!;
    const vbo = gl.createBuffer()!;
    this.marker = {
      prog, vbo, vao,
      locs: {
        uViewProj: gl.getUniformLocation(prog, 'uViewProj'),
        uModel: gl.getUniformLocation(prog, 'uModel'),
        uColor: gl.getUniformLocation(prog, 'uColor'),
      },
    };
  }

  private resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(2, Math.floor(rect.width * dpr));
    const h = Math.max(2, Math.floor(rect.height * dpr));
    this.canvas.width = w; this.canvas.height = h;
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.overlay.width = w; this.overlay.height = h;
    this.overlay.style.width = `${rect.width}px`;
    this.overlay.style.height = `${rect.height}px`;
    this.camera.aspect = w / h;
    this.renderer.resize(w, h);
  }

  onStoreChange(): void {
    const s = store.state;
    this.renderer.settings = s.settings;
  }

  /** 每帧检查: store 里的 mesh 与 GPU 上的是否一致, 不一致则 (重新)上传 */
  private syncMeshes(): void {
    const s = store.state;
    let changed = false;
    for (const jaw of ['upper', 'lower'] as Jaw[]) {
      const m = s.models.get(jaw);
      const uploaded = this.uploadedRefs.get(jaw);
      if (m && uploaded !== m.mesh) {
        this.renderer.uploadMesh(jaw, m);
        this.uploadedRefs.set(jaw, m.mesh);
        changed = true;
        if (!this.didInitialFit) {
          this.didInitialFit = true;
          requestAnimationFrame(() => this.fitView());
        }
      }
    }
    // 变换变化 (对齐/微调) 时刷新场景包围盒
    const sig = this.transformSignature();
    if (sig !== this.lastTransformSig) {
      this.lastTransformSig = sig;
      this.updateSceneBounds();
    }
    if (changed) this.updateSceneBounds();
  }
  private didInitialFit = false;
  private lastTransformSig = '';

  private transformSignature(): string {
    const parts: string[] = [];
    for (const jaw of ['upper', 'lower'] as Jaw[]) {
      const m = store.state.models.get(jaw);
      if (m) parts.push(jaw, Array.from(m.transform).map((v) => v.toFixed(3)).join(','));
    }
    return parts.join('|');
  }

  /** 计算所有可见模型的世界包围盒, 供位置纹理编码与相机取景 */
  private collectWorldPositions(): Float32Array {
    let allPos: number[] = [];
    for (const m of store.state.models.values()) {
      const world = new Float32Array(m.mesh.positions.length);
      for (let i = 0; i < m.mesh.positions.length; i += 3) {
        const p = m4.transformPoint(m.transform, [m.mesh.positions[i], m.mesh.positions[i + 1], m.mesh.positions[i + 2]]);
        world[i] = p[0]; world[i + 1] = p[1]; world[i + 2] = p[2];
      }
      allPos = allPos.concat(Array.from(world));
    }
    return Float32Array.from(allPos);
  }

  private updateSceneBounds(): void {
    const all = this.collectWorldPositions();
    if (!all.length) return;
    const box = boundingBox(all);
    this.renderer.setSceneBounds(box.min, box.max);
  }

  /** 初次载入后取景 */
  fitView(): void {
    const all = this.collectWorldPositions();
    if (!all.length) return;
    const box = boundingBox(all);
    const radius = Math.max(...box.size) * 0.6;
    this.camera.fit(box.center, radius);
  }

  private bindPlaneDrag(): void {
    this.canvas.addEventListener('pointerdown', (e) => {
      const clip = store.state.clip;
      if (!clip.enabled || e.button !== 0 || e.shiftKey === false) {
        // shift+左键拖拽平面; 普通左键交给相机
      }
      if (!clip.enabled || e.button !== 0 || !e.shiftKey) return;
      const hit = this.pickPlane(e);
      if (hit) {
        this.draggingPlane = true;
        this.canvas.setPointerCapture(e.pointerId);
        e.stopImmediatePropagation();
      }
    }, true);
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.draggingPlane) return;
      const hit = this.pickPlane(e);
      if (hit) {
        // 沿法线方向移动平面: 新平面经过 hit 点
        store.updateClip({ point: hit });
        this.sectionDirty = true;
        e.stopImmediatePropagation();
      }
    }, true);
    this.canvas.addEventListener('pointerup', () => {
      if (this.draggingPlane) {
        this.draggingPlane = false;
        this.hooks.onSectionPlaneChanged?.();
      }
    }, true);
  }

  pickPlane(e: PointerEvent): Vec3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    const ray = this.camera.screenRay(ndcX, ndcY);
    const clip = store.state.clip;
    return rayPlane(ray.origin, ray.dir, { point: clip.point, normal: clip.normal });
  }

  markSectionDirty(): void {
    this.sectionDirty = true;
  }

  private updateSection(): void {
    const s = store.state;
    if (!s.clip.enabled) {
      this.renderer.updateCapGeometry(new Float32Array(0));
      this.renderer.clipPlane = null;
      return;
    }
    this.renderer.clipPlane = s.clip;
    const upper = s.models.get('upper');
    const lower = s.models.get('lower');
    const result = sectionAnalysis(
      upper ? { mesh: upper.mesh, transform: upper.transform } : null,
      lower ? { mesh: lower.mesh, transform: lower.transform } : null,
      { point: s.clip.point, normal: s.clip.normal },
    );
    this.renderer.updateCapGeometry(s.clip.fillCap ? result.capTriangles : new Float32Array(0));
  }

  private drawMarkers(viewProj: Float32Array): void {
    const s = store.state;
    if (!this.showContactMarkers || !s.contacts.length || !this.marker) return;
    const gl = this.renderer.gl;
    const R = 0.9;
    // 八面体 (3 轴 6 顶点) 拼成小菱形标记
    const verts: number[] = [];
    const faces = [
      [0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1],
      [5, 2, 1], [5, 3, 2], [5, 4, 3], [5, 1, 4],
    ];
    const dirs: Vec3[] = [
      [R, 0, 0], [-R, 0, 0], [0, R, 0], [0, -R, 0], [0, 0, R], [0, 0, -R],
    ];
    for (const c of s.contacts) {
      const pts = dirs.map((d) => v3.add(c.center, d));
      for (const [a, b, cc] of faces) verts.push(...pts[a], ...pts[b], ...pts[cc]);
    }
    const { prog, vbo, vao, locs } = this.marker;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(locs.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(locs.uModel, false, m4.identity());
    gl.uniform4f(locs.uColor, 1, 0.25, 0.15, 0.95);
    gl.enable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, verts.length / 3);
    gl.bindVertexArray(null);
  }

  private drawOverlay2D(): void {
    const s = store.state;
    const ctx = this.overlay.getContext('2d')!;
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    const { view } = this.camera.viewProj();
    const proj = this.camera.viewProj().proj;
    const vp = m4.mul(proj, view);
    const project = (p: Vec3): [number, number, number] => {
      const c = m4.transformPoint(vp, p);
      return [
        (c[0] * 0.5 + 0.5) * this.overlay.width,
        (-c[1] * 0.5 + 0.5) * this.overlay.height,
        c[2],
      ];
    };
    const dpr = this.overlay.width / this.overlay.clientWidth;
    ctx.scale(dpr, dpr);
    const cssW = this.overlay.clientWidth, cssH = this.overlay.clientHeight;

    // 接触点编号
    if (this.showContactMarkers && s.contacts.length) {
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      s.contacts.forEach((c, i) => {
        const [x, y] = project(c.center);
        const cx = x / dpr, cy = y / dpr;
        if (cx < 0 || cx > cssW || cy < 0 || cy > cssH) return;
        ctx.beginPath();
        ctx.arc(cx + 10, cy - 10, 9, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,80,40,0.92)';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(String(i + 1), cx + 10, cy - 10 + 0.5);
      });
    }

    // 剖面测量标注
    if (s.clip.enabled && s.clip.measures.length) {
      const plane = { point: s.clip.point, normal: s.clip.normal };
      // 由当前 gizmo 基向量恢复: 用 sectionAnalysis 的基向量规则
      const ref: Vec3 = Math.abs(plane.normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = v3.norm(v3.cross(ref, plane.normal));
      const v = v3.norm(v3.cross(plane.normal, u));
      const toWorld = (p2: [number, number]): Vec3 => [
        plane.point[0] + u[0] * p2[0] + v[0] * p2[1],
        plane.point[1] + u[1] * p2[0] + v[1] * p2[1],
        plane.point[2] + u[2] * p2[0] + v[2] * p2[1],
      ];
      ctx.lineWidth = 1.6;
      for (const measure of s.clip.measures) {
        const ws = measure.points.map(toWorld);
        const sp = ws.map(project).map(([x, y]) => [x / dpr, y / dpr] as [number, number]);
        if (measure.kind === 'distance' && sp.length >= 2) {
          ctx.strokeStyle = '#ffd34d';
          ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]); ctx.lineTo(sp[1][0], sp[1][1]); ctx.stroke();
          for (const [x, y] of sp) {
            ctx.fillStyle = '#ffd34d';
            ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
          }
          this.label(ctx, (sp[0][0] + sp[1][0]) / 2, (sp[0][1] + sp[1][1]) / 2 - 10, measure.label);
        } else if (measure.kind === 'angle' && sp.length >= 3) {
          ctx.strokeStyle = '#57e3ff';
          ctx.beginPath();
          ctx.moveTo(sp[1][0], sp[1][1]); ctx.lineTo(sp[0][0], sp[0][1]);
          ctx.moveTo(sp[1][0], sp[1][1]); ctx.lineTo(sp[2][0], sp[2][1]);
          ctx.stroke();
          this.label(ctx, sp[1][0] + 14, sp[1][1] - 8, measure.label);
        }
      }
    }
  }

  private label(ctx: CanvasRenderingContext2D, x: number, y: number, text: string): void {
    ctx.font = '12px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(20,24,30,0.85)';
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 10, w, 18, 4);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    this.camera.update();
    this.syncMeshes();
    if (this.sectionDirty) {
      this.updateSection();
      this.sectionDirty = false;
    }
    const s = store.state;
    const { viewProj, proj, view } = this.camera.viewProj();
    const eye = this.camera.eye();
    const clip = s.clip;
    let gizmo: { center: Vec3; u: Vec3; v: Vec3; half: number } | undefined;
    if (clip.enabled) {
      const ref: Vec3 = Math.abs(clip.normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = v3.norm(v3.cross(ref, clip.normal));
      const v = v3.norm(v3.cross(clip.normal, u));
      gizmo = { center: clip.point, u, v, half: 45 };
    }
    this.renderer.render(viewProj, proj, view, eye, s.models, s.heatVisible ? 'lower' : null, clip.enabled, gizmo);
    this.drawMarkers(viewProj);
    this.drawOverlay2D();

    const now = performance.now();
    this.frameTimes.push(now - this.lastFrame);
    this.lastFrame = now;
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    if (this.frameTimes.length === 60 && now % 30 < 2) {
      const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
      this.fpsEl.textContent = `${Math.round(1000 / avg)} FPS`;
      this.fpsEl.classList.toggle('fps-warn', 1000 / avg < 50);
    }
  };

  screenshot(): string {
    this.beforeScreenshot?.();
    // 立刻同步渲染一帧保证 preserveDrawingBuffer 内容最新
    const s = store.state;
    const { viewProj, proj, view } = this.camera.viewProj();
    const clip = s.clip;
    let gizmo: { center: Vec3; u: Vec3; v: Vec3; half: number } | undefined;
    if (clip.enabled) {
      const ref: Vec3 = Math.abs(clip.normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = v3.norm(v3.cross(ref, clip.normal));
      const v = v3.norm(v3.cross(clip.normal, u));
      gizmo = { center: clip.point, u, v, half: 45 };
    }
    this.renderer.render(viewProj, proj, view, this.camera.eye(), s.models, s.heatVisible ? 'lower' : null, clip.enabled, gizmo);
    return this.renderer.screenshot();
  }

  /** 把 2D overlay 标注合成进截图 (报告页用) */
  async screenshotWithOverlay(): Promise<string> {
    const base = this.screenshot();
    const out = document.createElement('canvas');
    out.width = this.canvas.width;
    out.height = this.canvas.height;
    const ctx = out.getContext('2d')!;
    const img = await loadImage(base);
    ctx.drawImage(img, 0, 0);
    ctx.drawImage(this.overlay, 0, 0);
    return out.toDataURL('image/png');
  }

  dispose(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.detachCam();
    this.resizeObs.disconnect();
    this.renderer.dispose();
    this.canvas.remove();
    this.overlay.remove();
    this.fpsEl.remove();
  }
}

export { worldToLocal };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('截图图像解码失败'));
    img.src = src;
  });
}
