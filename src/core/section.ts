// 平面剖切: 求网格与平面的交线段 -> 连成闭合轮廓 -> earcut 三角化 (用于剖面填色)
import type { MeshData } from './types';
import { m4, v3, type Vec3 } from './math';

export interface Plane {
  point: Vec3;
  normal: Vec3;
}

export interface SectionLoop {
  /** 轮廓点 (世界坐标, 已闭合排序) */
  points: Vec3[];
  /** 平面局部 2D 坐标, 与 points 一一对应 */
  points2d: [number, number][];
  basisU: Vec3;
  basisV: Vec3;
}

export interface SectionResult {
  loops: SectionLoop[];
  /** 所有轮廓三角化后的世界坐标三角形 (xyz 交错), 直接喂渲染器 */
  capTriangles: Float32Array;
  /** 平面基向量 (拖拽 gizmo 与测量共用) */
  basisU: Vec3;
  basisV: Vec3;
}

function planeBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const ref: Vec3 = Math.abs(normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = v3.norm(v3.cross(ref, normal));
  const v = v3.norm(v3.cross(normal, u));
  return { u, v };
}

/** 求一个网格与平面的交线段 (世界坐标) */
export function intersectMeshPlane(mesh: MeshData, model: Float32Array, plane: Plane): Vec3[][] {
  const { positions, indices } = mesh;
  const d = (p: Vec3) => v3.dot(v3.sub(p, plane.point), plane.normal);
  const segments: Vec3[][] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const ids = [indices[t], indices[t + 1], indices[t + 2]];
    const world = ids.map((i) => m4.transformPoint(model, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]));
    const ds = world.map(d);
    const hits: Vec3[] = [];
    for (let e = 0; e < 3; e++) {
      const a = world[e], b = world[(e + 1) % 3];
      const da = ds[e], db = ds[(e + 1) % 3];
      if ((da > 0 && db <= 0) || (da < 0 && db >= 0) || (da === 0 && db !== 0)) {
        const denom = da - db;
        const tt = Math.abs(denom) < 1e-12 ? 0 : da / denom;
        hits.push(v3.lerp(a, b, tt));
      } else if (da === 0) {
        hits.push(a);
      }
    }
    if (hits.length >= 2) {
      segments.push([hits[0], hits[1]]);
    }
  }
  return segments;
}

/** 把无序线段串成有序闭合轮廓 */
function chainSegments(segments: Vec3[][], tolerance: number): Vec3[][] {
  const tol2 = tolerance * tolerance;
  const remaining = segments.map((s) => [s[0], s[1]] as [Vec3, Vec3]);
  const loops: Vec3[][] = [];
  while (remaining.length) {
    const [firstA, firstB] = remaining.pop()!;
    const loop = [firstA, firstB];
    let closed = false;
    let guard = 0;
    while (!closed && guard++ < remaining.length + 2) {
      const tail = loop[loop.length - 1];
      let found = -1;
      let reverse = false;
      for (let i = 0; i < remaining.length; i++) {
        const [a, b] = remaining[i];
        if (v3.len(v3.sub(a, tail)) ** 2 < tol2) { found = i; reverse = false; break; }
        if (v3.len(v3.sub(b, tail)) ** 2 < tol2) { found = i; reverse = true; break; }
      }
      if (found < 0) break;
      const [a, b] = remaining.splice(found, 1)[0];
      const next = reverse ? a : b;
      // 闭合: 下一点回到起点
      if (v3.len(v3.sub(next, loop[0])) ** 2 < tol2) {
        closed = true;
        break;
      }
      loop.push(next);
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// ---------------- 精简版 earcut (2D 多边形三角化, 支持带洞) ----------------
interface EarNode {
  x: number; y: number;
  prev: EarNode | null; next: EarNode | null;
  zIndex: number;
  steiner: boolean;
}

function linkedList(points: [number, number][]): EarNode | null {
  if (!points.length) return null;
  const nodes: EarNode[] = points.map((p, i) => ({
    x: p[0], y: p[1], prev: null, next: null, zIndex: i, steiner: false,
  }));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].prev = nodes[(i - 1 + nodes.length) % nodes.length];
    nodes[i].next = nodes[(i + 1) % nodes.length];
  }
  return nodes[0];
}

function area2(ring: [number, number][]): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    s += ax * by - bx * ay;
  }
  return s / 2;
}

function earcutFlat(outer: [number, number][], holes: [number, number][][]): number[] {
  // 消除孔: 用桥接把孔合并进外环 (标准 earcut 简化实现)
  let ring = outer.slice();
  for (const hole of holes) {
    if (area2(hole) > 0) hole.reverse();
    // 找孔上最靠右的点, 连到外环中其右侧可见点
    let hi = 0;
    for (let i = 1; i < hole.length; i++) if (hole[i][0] > hole[hi][0]) hi = i;
    const hp = hole[hi];
    let oi = -1;
    for (let i = 0; i < ring.length; i++) {
      if (ring[i][0] >= hp[0] && (oi < 0 || ring[i][0] < ring[oi][0])) oi = i;
    }
    if (oi < 0) {
      let bd = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const dd = (ring[i][0] - hp[0]) ** 2 + (ring[i][1] - hp[1]) ** 2;
        if (dd < bd) { bd = dd; oi = i; }
      }
    }
    const merged: [number, number][] = [];
    merged.push(...ring.slice(0, oi + 1));
    merged.push(hp);
    for (let k = 1; k <= hole.length; k++) merged.push(hole[(hi + k) % hole.length]);
    merged.push(hp);
    merged.push(...ring.slice(oi + 1));
    ring = merged;
  }
  if (area2(ring) < 0) ring.reverse();

  const head = linkedList(ring);
  if (!head) return [];
  const triangles: number[] = [];
  const sign = (p1: EarNode, p2: EarNode, p3: EarNode) =>
    (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  const pointInTri = (p: EarNode, a: EarNode, b: EarNode, c: EarNode) =>
    sign(a, b, p) >= 0 && sign(b, c, p) >= 0 && sign(c, a, p) >= 0;

  let guard = ring.length * ring.length + 10;
  let ear = head;
  let count = ring.length;
  while (count > 2 && guard-- > 0) {
    const a = ear.prev!, b = ear, c = ear.next!;
    let isEar = sign(a, b, c) > 0;
    if (isEar) {
      let p = c.next!;
      while (p !== a) {
        if (pointInTri(p, a, b, c)) { isEar = false; break; }
        p = p.next!;
      }
    }
    if (isEar) {
      triangles.push(a.zIndex, b.zIndex, c.zIndex);
      b.prev!.next = c;
      c.prev = b.prev;
      ear = c;
      count--;
    } else {
      ear = c;
    }
  }
  return triangles;
}

/** 完整剖面分析 (上下颌合并) */
export function sectionAnalysis(
  upper: { mesh: MeshData; transform: Float32Array } | null,
  lower: { mesh: MeshData; transform: Float32Array } | null,
  plane: Plane,
): SectionResult {
  const { u, v } = planeBasis(plane.normal);
  const allSegs: Vec3[][] = [];
  if (upper) allSegs.push(...intersectMeshPlane(upper.mesh, upper.transform, plane));
  if (lower) allSegs.push(...intersectMeshPlane(lower.mesh, lower.transform, plane));

  const bboxTol = 0.05;
  const loops3d = chainSegments(allSegs, bboxTol);
  const loops: SectionLoop[] = loops3d.map((pts) => {
    const points2d = pts.map((p) => {
      const rel = v3.sub(p, plane.point);
      return [v3.dot(rel, u), v3.dot(rel, v)] as [number, number];
    });
    return { points: pts, points2d, basisU: u, basisV: v };
  });

  // 每个外环独立三角化; 嵌套环作为洞处理 (用包围盒包含关系判断)
  const capVerts: number[] = [];
  for (let i = 0; i < loops.length; i++) {
    const outer = loops[i];
    const holes: [number, number][][] = [];
    const oc = centroid2(outer.points2d);
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue;
      const hc = centroid2(loops[j].points2d);
      if (pointInPolygon(hc, outer.points2d) && !pointInPolygon(oc, loops[j].points2d)) {
        holes.push(loops[j].points2d);
      }
    }
    const tris = earcutFlat(outer.points2d, holes);
    for (const idx of tris) {
      const p2 = outer.points2d[idx];
      if (!p2) continue; // 退化多边形下 earcut 可能产生越界索引, 跳过
      const wp: Vec3 = [
        plane.point[0] + u[0] * p2[0] + v[0] * p2[1],
        plane.point[1] + u[1] * p2[0] + v[1] * p2[1],
        plane.point[2] + u[2] * p2[0] + v[2] * p2[1],
      ];
      capVerts.push(wp[0], wp[1], wp[2]);
    }
  }
  return { loops, capTriangles: Float32Array.from(capVerts), basisU: u, basisV: v };
}

function centroid2(pts: [number, number][]): [number, number] {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}

function pointInPolygon(p: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 平面局部 2D 点 -> 世界坐标 */
export function localToWorld(plane: Plane, u: Vec3, v: Vec3, p2: [number, number]): Vec3 {
  return [
    plane.point[0] + u[0] * p2[0] + v[0] * p2[1],
    plane.point[1] + u[1] * p2[0] + v[1] * p2[1],
    plane.point[2] + u[2] * p2[0] + v[2] * p2[1],
  ];
}

/** 世界坐标 -> 平面局部 2D */
export function worldToLocal(plane: Plane, u: Vec3, v: Vec3, p: Vec3): [number, number] {
  const rel = v3.sub(p, plane.point);
  return [v3.dot(rel, u), v3.dot(rel, v)];
}

/** 射线与平面求交 */
export function rayPlane(origin: Vec3, dir: Vec3, plane: Plane): Vec3 | null {
  const denom = v3.dot(dir, plane.normal);
  if (Math.abs(denom) < 1e-9) return null;
  const t = v3.dot(v3.sub(plane.point, origin), plane.normal) / denom;
  if (t < 0) return null;
  return v3.add(origin, v3.scale(dir, t));
}
