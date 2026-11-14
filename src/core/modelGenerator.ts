// 程序化测试牙模生成器: U 形牙弓 + 牙尖起伏, 支持带洞网格与高分辨率 (单颌 50 万三角面)

import type { MeshData } from './types';
import { computeNormals } from './meshParser';

export interface GenerateOptions {
  /** 目标三角面数量 (近似) */
  targetTriangles?: number;
  /** 是否在牙龈区域生成开放洞 */
  withHoles?: boolean;
  /** 随机种子 (线性同余, 保证可复现) */
  seed?: number;
  /** 上领或下领, 影响牙尖形态与镜像 */
  jaw?: 'upper' | 'lower';
}

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 牙弓中心线: t ∈ [-1, 1], 返回 [x, z] */
function archCenter(t: number, R: number): [number, number] {
  const phi = t * Math.PI * 0.82;
  return [R * Math.sin(phi), R * (Math.cos(phi) - 1)];
}

/** 牙弓半宽 mm */
function archHalfWidth(t: number): number {
  // 磨牙区宽, 前牙区窄
  return 9.5 - 3.0 * Math.exp(-Math.abs(t) * 6) + 1.2 * Math.abs(t);
}

// 14 颗牙的中心位置 (t 坐标) 与相对高度
const TEETH = (() => {
  const centers: number[] = [];
  for (let i = 0; i < 14; i++) centers.push(-0.93 + (i * 1.86) / 13);
  return centers.map((t, i) => {
    const front = Math.exp(-Math.abs(t) * 5); // 前牙系数
    const molar = Math.min(1, Math.abs(t) * 1.6);
    return {
      t,
      // 前牙高而窄, 磨牙矮而宽
      height: 5.5 * front + 4.2 * molar + 1.5,
      sigmaT: 0.05 + 0.035 * Math.abs(t),
    };
  });
})();

function toothBump(t: number, v: number, jaw: 'upper' | 'lower'): number {
  let h = 0;
  for (const tooth of TEETH) {
    const dt = (t - tooth.t) / tooth.sigmaT;
    const envelope = Math.exp(-dt * dt);
    if (envelope < 0.02) continue;
    // 横向: 前牙单尖, 磨牙多尖 (颊尖/舌尖 + 中央沟)
    const molarness = Math.min(1, Math.abs(t) * 1.8);
    const cuspPattern =
      (1 - molarness) * Math.exp(-v * v * 6) +
      molarness *
        0.5 *
        (Math.exp(-((v - 0.55) ** 2) * 10) + Math.exp(-((v + 0.55) ** 2) * 10));
    // 牙尖上的细微起伏
    const ripple = 1 + 0.08 * Math.sin(t * 90 + (jaw === 'upper' ? 0 : 1.7)) * Math.cos(v * 12);
    h += tooth.height * envelope * Math.max(0, cuspPattern) * ripple;
  }
  return h;
}

export function generateDentalArch(opts: GenerateOptions = {}): MeshData {
  const target = opts.targetTriangles ?? 60000;
  const withHoles = opts.withHoles ?? false;
  const jaw = opts.jaw ?? 'upper';
  const rng = makeRng(opts.seed ?? (jaw === 'upper' ? 42 : 77));
  const R = 28; // 牙弓半径 mm

  // 反推网格分辨率: 上下两个面 + 侧面 ≈ 2*nu*nv*2 + 2*nu*2
  const aspect = 2.6; // nu/nv 大致比例
  const nv = Math.max(12, Math.round(Math.sqrt(target / (4 * aspect))));
  const nu = Math.max(20, Math.round(nv * aspect));

  const positions: number[] = [];
  const indices: number[] = [];
  const ySign = jaw === 'upper' ? 1 : -1;

  // 洞的位置 (t, v, 半径), 位于牙龈平坦处
  const holes = withHoles
    ? [
        { t: 0.55, v: 0.0, r: 2.6 },
        { t: -0.62, v: -0.15, r: 2.0 },
        { t: 0.05, v: 0.0, r: 1.6 },
      ]
    : [];

  const surfacePoint = (t: number, v: number, bottom: boolean): [number, number, number] => {
    const [cx, cz] = archCenter(t, R);
    const hw = archHalfWidth(t);
    // 横向方向 (近似垂直于中心线切线)
    const tx = Math.cos(t * Math.PI * 0.82) * Math.PI * 0.82 * R;
    const tz = -Math.sin(t * Math.PI * 0.82) * Math.PI * 0.82 * R;
    const tl = Math.hypot(tx, tz) || 1;
    const nx = -tz / tl, nz = tx / tl;
    const x = cx + nx * v * hw;
    const z = cz + nz * v * hw;
    const gumBase = 2.2 + 0.5 * Math.sin(t * 7 + 1) * (1 - Math.abs(v));
    const thickness = 6.5 + rng() * 0; // 恒定厚度, rng 保留接口
    if (bottom) {
      return [x, ySign * (gumBase - thickness), z];
    }
    const bump = toothBump(t, v, jaw);
    // 牙龈到牙冠的过渡基底
    const y = gumBase + bump * (0.55 + 0.45 * Math.min(1, Math.abs(v) * 2 + 0.6));
    return [x, ySign * y, z];
  };

  const inHole = (t: number, v: number): boolean => {
    if (!withHoles) return false;
    const [cx, cz] = archCenter(t, R);
    for (const h of holes) {
      const [hx, hz] = archCenter(h.t, R);
      const hw = archHalfWidth(h.t);
      const dx = cx - hx;
      const dz = cz - hz;
      const dv = v * archHalfWidth(t) - h.v * hw;
      if (Math.hypot(dx, dz, dv) < h.r) return true;
    }
    return false;
  };

  const buildSurface = (bottom: boolean): number => {
    const base = positions.length / 3;
    for (let i = 0; i <= nu; i++) {
      const t = -1 + (2 * i) / nu;
      for (let j = 0; j <= nv; j++) {
        const v = -1 + (2 * j) / nv;
        const p = surfacePoint(t, v, bottom);
        positions.push(p[0], p[1], p[2]);
      }
    }
    const row = nv + 1;
    for (let i = 0; i < nu; i++) {
      const t = -1 + (2 * (i + 0.5)) / nu;
      for (let j = 0; j < nv; j++) {
        const v = -1 + (2 * (j + 0.5)) / nv;
        if (inHole(t, v)) continue;
        const a = base + i * row + j;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        if (bottom) {
          indices.push(a, c, b, b, c, d);
        } else {
          indices.push(a, b, c, b, d, c);
        }
      }
    }
    return base;
  };

  const topBase = buildSurface(false);
  const bottomBase = buildSurface(true);

  // 侧面封边 (沿 t 两端与 v 两侧), 带洞处自然保持开放
  const stitch = (a: number, b: number) => {
    indices.push(a, b, topBase === undefined ? 0 : 0); // 占位, 下面重写
  };
  void stitch;
  const row = nv + 1;
  const sideQuad = (topA: number, topB: number, botA: number, botB: number) => {
    indices.push(topA, botA, topB, topB, botA, botB);
  };
  // v = -1 与 v = +1 两条长边
  for (let i = 0; i < nu; i++) {
    const t = -1 + (2 * (i + 0.5)) / nu;
    if (inHole(t, -1) || inHole(t, 1)) continue;
    sideQuad(topBase + i * row, topBase + (i + 1) * row, bottomBase + i * row, bottomBase + (i + 1) * row);
    sideQuad(topBase + i * row + nv, topBase + (i + 1) * row + nv, bottomBase + i * row + nv, bottomBase + (i + 1) * row + nv);
  }
  // t = -1 与 t = +1 两条短边
  for (let j = 0; j < nv; j++) {
    sideQuad(topBase + j, topBase + j + 1, bottomBase + j, bottomBase + j + 1);
    sideQuad(topBase + nu * row + j, topBase + nu * row + j + 1, bottomBase + nu * row + j, bottomBase + nu * row + j + 1);
  }

  const posArr = Float32Array.from(positions);
  const idxArr = Uint32Array.from(indices);
  const normals = computeNormals(posArr, idxArr);
  return {
    positions: posArr,
    normals,
    indices: idxArr,
    triangleCount: idxArr.length / 3,
    vertexCount: posArr.length / 3,
    sourceName: `generated_${jaw}${withHoles ? '_hole' : ''}.stl`,
  };
}

/** 导出为二进制 STL (Blob), 供端到端解析测试与下载 */
export function meshToBinarySTL(mesh: MeshData): Blob {
  const triCount = mesh.triangleCount;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  // 80 字节头
  const header = new TextEncoder().encode('binary STL generated by dental-occlusion-studio');
  new Uint8Array(buffer, 0, header.length).set(header);
  view.setUint32(80, triCount, true);
  let offset = 84;
  const { positions, normals, indices } = mesh;
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3], ib = indices[t * 3 + 1], ic = indices[t * 3 + 2];
    // 面法线
    const ux = positions[ib * 3] - positions[ia * 3];
    const uy = positions[ib * 3 + 1] - positions[ia * 3 + 1];
    const uz = positions[ib * 3 + 2] - positions[ia * 3 + 2];
    const vx = positions[ic * 3] - positions[ia * 3];
    const vy = positions[ic * 3 + 1] - positions[ia * 3 + 1];
    const vz = positions[ic * 3 + 2] - positions[ia * 3 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true);
    offset += 12;
    for (const idx of [ia, ib, ic]) {
      view.setFloat32(offset, positions[idx * 3], true);
      view.setFloat32(offset + 4, positions[idx * 3 + 1], true);
      view.setFloat32(offset + 8, positions[idx * 3 + 2], true);
      offset += 12;
    }
    view.setUint16(offset, 0, true);
    offset += 2;
  }
  void normals;
  return new Blob([buffer], { type: 'application/octet-stream' });
}
