// 轨道相机: 左键旋转 / 右键平移 / 滚轮缩放, 阻尼插值保证 60fps 手感
import { m4, v3, type Vec3 } from '../core/math';

export class OrbitCamera {
  target: Vec3 = [0, 0, 0];
  distance = 120;
  azimuth = Math.PI * 0.25;
  elevation = Math.PI * 0.22;
  targetDistance = 120;
  targetAzimuth = this.azimuth;
  targetElevation = this.elevation;
  private targetPoint: Vec3 = [0, 0, 0];
  fov = 40 * (Math.PI / 180);
  near = 0.5;
  far = 2000;
  aspect = 1;

  attach(canvas: HTMLCanvasElement): () => void {
    let dragging: 'rotate' | 'pan' | null = null;
    let lastX = 0, lastY = 0;

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      dragging = e.button === 2 ? 'pan' : 'rotate';
      lastX = e.clientX; lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === 'rotate') {
        this.targetAzimuth -= dx * 0.008;
        this.targetElevation = Math.max(-Math.PI / 2 + 0.05, Math.min(Math.PI / 2 - 0.05, this.targetElevation + dy * 0.008));
      } else {
        const scale = this.targetDistance * 0.0012;
        const right: Vec3 = [Math.cos(this.targetAzimuth), 0, -Math.sin(this.targetAzimuth)];
        const up: Vec3 = [0, 1, 0];
        this.targetPoint = v3.add(this.targetPoint, v3.add(v3.scale(right, -dx * scale), v3.scale(up, dy * scale)));
      }
    };
    const onUp = (e: PointerEvent) => {
      dragging = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.targetDistance = Math.max(8, Math.min(800, this.targetDistance * Math.exp(e.deltaY * 0.001)));
    };
    const onCtx = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onCtx);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onCtx);
    };
  }

  /** 每帧阻尼逼近 */
  update(): void {
    const k = 0.18;
    this.azimuth += (this.targetAzimuth - this.azimuth) * k;
    this.elevation += (this.targetElevation - this.elevation) * k;
    this.distance += (this.targetDistance - this.distance) * k;
    this.target = v3.lerp(this.target, this.targetPoint, k);
  }

  eye(): Vec3 {
    const ce = Math.cos(this.elevation);
    return [
      this.target[0] + this.distance * ce * Math.sin(this.azimuth),
      this.target[1] + this.distance * Math.sin(this.elevation),
      this.target[2] + this.distance * ce * Math.cos(this.azimuth),
    ];
  }

  viewProj(): { viewProj: Float32Array; proj: Float32Array; view: Float32Array } {
    const proj = m4.perspective(this.fov, this.aspect, this.near, this.far);
    const view = m4.lookAt(this.eye(), this.target, [0, 1, 0]);
    return { viewProj: m4.mul(proj, view), proj, view };
  }

  fit(center: Vec3, radius: number): void {
    this.targetPoint = [...center] as Vec3;
    this.target = [...center] as Vec3;
    const halfFov = this.fov / 2;
    this.targetDistance = radius / Math.sin(halfFov) * 1.25;
    this.distance = this.targetDistance;
  }

  /** 屏幕坐标 -> 视线射线 (世界空间) */
  screenRay(ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
    const eye = this.eye();
    const ce = Math.cos(this.elevation);
    const forward = v3.norm(v3.sub(this.target, eye));
    const right: Vec3 = [Math.cos(this.azimuth), 0, -Math.sin(this.azimuth)];
    const up = v3.cross(right, forward);
    const tan = Math.tan(this.fov / 2);
    const dir = v3.norm(
      v3.add(
        forward,
        v3.add(v3.scale(right, ndcX * tan * this.aspect), v3.scale(up, ndcY * tan)),
      ),
    );
    void ce;
    return { origin: eye, dir };
  }
}
