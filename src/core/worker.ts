// Worker: 上下颌间隙距离场计算
// 算法: 在上颌三角形上构建 Uniform Grid, 对下颌每个顶点做带半径扩张的最近三角形查询
// 点-三角形距离使用 Ericson 实时碰撞检测标准算法

export interface DistanceRequest {
  type: 'compute';
  jobId: number;
  upperPositions: ArrayBuffer;
  upperIndices: ArrayBuffer;
  lowerPositions: ArrayBuffer;
  maxRange: number;
  bands: number;
  contactThreshold: number;
  /** 采样步长 (mm), 大于 0 时对下颌顶点抽样, 0 表示全顶点 */
  sampleStep: number;
}

export interface DistanceResponse {
  type: 'progress' | 'done' | 'error';
  jobId: number;
  progress?: number;
  message?: string;
  distances?: ArrayBuffer;
  normalized?: ArrayBuffer;
  min?: number;
  max?: number;
  mean?: number;
  histogram?: number[];
  elapsedMs?: number;
  sampleIndices?: ArrayBuffer;
}

interface UniformGrid {
  cellSize: number;
  origin: [number, number, number];
  nx: number;
  ny: number;
  nz: number;
  /** 每个 cell 包含的三角形 id 列表 (扁平存储) */
  cells: number[][];
}

function buildGrid(positions: Float32Array, indices: Uint32Array, triCount: number): UniformGrid {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  // 目标 cell 数量 ~ 三角形数的 1/4, 据此反推 cellSize
  const targetCells = Math.max(64, triCount / 4);
  const volume = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
  const cellSize = Math.max(0.5, Math.cbrt(volume / targetCells));
  const nx = Math.max(1, Math.ceil((maxX - minX) / cellSize) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cellSize) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cellSize) + 1);
  const cells: number[][] = new Array(nx * ny * nz);
  const cellOf = (x: number, y: number, z: number) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cellSize)));
    const iy = Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / cellSize)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / cellSize)));
    return iz * nx * ny + iy * nx + ix;
  };
  for (let t = 0; t < triCount; t++) {
    const ia = indices[t * 3] * 3, ib = indices[t * 3 + 1] * 3, ic = indices[t * 3 + 2] * 3;
    let tMinX = Math.min(positions[ia], positions[ib], positions[ic]);
    let tMaxX = Math.max(positions[ia], positions[ib], positions[ic]);
    let tMinY = Math.min(positions[ia + 1], positions[ib + 1], positions[ic + 1]);
    let tMaxY = Math.max(positions[ia + 1], positions[ib + 1], positions[ic + 1]);
    let tMinZ = Math.min(positions[ia + 2], positions[ib + 2], positions[ic + 2]);
    let tMaxZ = Math.max(positions[ia + 2], positions[ib + 2], positions[ic + 2]);
    const x0 = Math.floor((tMinX - minX) / cellSize), x1 = Math.floor((tMaxX - minX) / cellSize);
    const y0 = Math.floor((tMinY - minY) / cellSize), y1 = Math.floor((tMaxY - minY) / cellSize);
    const z0 = Math.floor((tMinZ - minZ) / cellSize), z1 = Math.floor((tMaxZ - minZ) / cellSize);
    for (let ix = Math.max(0, x0); ix <= Math.min(nx - 1, x1); ix++) {
      for (let iy = Math.max(0, y0); iy <= Math.min(ny - 1, y1); iy++) {
        for (let iz = Math.max(0, z0); iz <= Math.min(nz - 1, z1); iz++) {
          const id = iz * nx * ny + iy * nx + ix;
          (cells[id] ||= []).push(t);
        }
      }
    }
  }
  return { cellSize, origin: [minX, minY, minZ], nx, ny, nz, cells };
}

// Ericson: 点到三角形最近距离平方
function pointTriDist2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const dx = apx + v * abx, dy = apy + v * aby, dz = apz + v * abz;
    return dx * dx + dy * dy + dz * dz;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const dx = apx + w * acx, dy = apy + w * acy, dz = apz + w * acz;
    return dx * dx + dy * dy + dz * dz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    const dx = bpx + w * (cx - bx), dy = bpy + w * (cy - by), dz = bpz + w * (cz - bz);
    return dx * dx + dy * dy + dz * dz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const dx = apx + abx * v + acx * w;
  const dy = apy + aby * v + acy * w;
  const dz = apz + abz * v + acz * w;
  return dx * dx + dy * dy + dz * dz;
}

self.onmessage = (ev: MessageEvent<DistanceRequest>) => {
  const req = ev.data;
  if (req.type !== 'compute') return;
  const t0 = performance.now();
  try {
    const upPos = new Float32Array(req.upperPositions);
    const upIdx = new Uint32Array(req.upperIndices);
    const loPos = new Float32Array(req.lowerPositions);
    const triCount = upIdx.length / 3;
    const grid = buildGrid(upPos, upIdx, triCount);
    const { cellSize, origin, nx, ny, nz, cells } = grid;

    // 采样: 按空间步长抽稀下颌顶点
    const sampleStep = Math.max(0, req.sampleStep);
    const sampleIds: number[] = [];
    if (sampleStep <= 0) {
      for (let i = 0; i < loPos.length / 3; i++) sampleIds.push(i);
    } else {
      const seen = new Set<number>();
      const inv = 1 / sampleStep;
      for (let i = 0; i < loPos.length / 3; i++) {
        const key =
          Math.floor(loPos[i * 3] * inv) * 73856093 ^
          Math.floor(loPos[i * 3 + 2] * inv) * 19349663;
        if (!seen.has(key)) {
          seen.add(key);
          sampleIds.push(i);
        }
      }
    }

    const n = sampleIds.length;
    const distances = new Float32Array(n);
    const normalized = new Float32Array(n);
    const histogram = new Array(req.bands).fill(0);
    let min = Infinity, max = 0, sum = 0;
    let contactCount = 0;

    const query = (vx: number, vy: number, vz: number): number => {
      const gx = Math.floor((vx - origin[0]) / cellSize);
      const gy = Math.floor((vy - origin[1]) / cellSize);
      const gz = Math.floor((vz - origin[2]) / cellSize);
      let best = Infinity;
      // 环形扩张搜索: 限制最大环数, 命中后当环半径已超过当前最近距离即可停止
      const maxRing = 12;
      for (let ring = 0; ring <= maxRing; ring++) {
        let checkedAny = false;
        const x0 = Math.max(0, gx - ring), x1 = Math.min(nx - 1, gx + ring);
        const y0 = Math.max(0, gy - ring), y1 = Math.min(ny - 1, gy + ring);
        const z0 = Math.max(0, gz - ring), z1 = Math.min(nz - 1, gz + ring);
        // 只遍历环壳 (六个面), 避免重复扫描内部
        for (let ix = x0; ix <= x1; ix++) {
          for (let iy = y0; iy <= y1; iy++) {
            for (let iz = z0; iz <= z1; iz++) {
              if (ring > 0 && ix > x0 && ix < x1 && iy > y0 && iy < y1 && iz > z0 && iz < z1) continue;
              const list = cells[iz * nx * ny + iy * nx + ix];
              if (!list) continue;
              checkedAny = true;
              for (let k = 0; k < list.length; k++) {
                const t = list[k];
                const ia = upIdx[t * 3] * 3, ib = upIdx[t * 3 + 1] * 3, ic = upIdx[t * 3 + 2] * 3;
                const d2 = pointTriDist2(
                  vx, vy, vz,
                  upPos[ia], upPos[ia + 1], upPos[ia + 2],
                  upPos[ib], upPos[ib + 1], upPos[ib + 2],
                  upPos[ic], upPos[ic + 1], upPos[ic + 2],
                );
                if (d2 < best) best = d2;
              }
            }
          }
        }
        if (checkedAny && ring * cellSize >= Math.sqrt(best)) break;
        if (!checkedAny && ring > 4 && Number.isFinite(best)) break;
      }
      return Math.sqrt(best);
    };

    for (let s = 0; s < n; s++) {
      const vi = sampleIds[s];
      const vx = loPos[vi * 3], vy = loPos[vi * 3 + 1], vz = loPos[vi * 3 + 2];
      const d = query(vx, vy, vz);
      distances[s] = d;
      sum += d;
      if (d < min) min = d;
      if (d > max) max = d;
      if (d <= req.contactThreshold) contactCount++;
      const norm = Math.min(1, d / req.maxRange);
      normalized[s] = norm;
      const band = Math.min(req.bands - 1, Math.floor(norm * req.bands));
      histogram[band]++;
      if ((s & 4095) === 0) {
        const msg: DistanceResponse = { type: 'progress', jobId: req.jobId, progress: s / n };
        (self as unknown as Worker).postMessage(msg);
      }
    }

    const resp: DistanceResponse = {
      type: 'done',
      jobId: req.jobId,
      distances: distances.buffer,
      normalized: normalized.buffer,
      sampleIndices: Uint32Array.from(sampleIds).buffer,
      min: Number.isFinite(min) ? min : 0,
      max,
      mean: n ? sum / n : 0,
      histogram,
      elapsedMs: performance.now() - t0,
      message: `接触点采样 ${contactCount} 个 (阈值 ${req.contactThreshold}mm)`,
    };
    (self as unknown as Worker).postMessage(resp, [
      resp.distances!, resp.normalized!, resp.sampleIndices!,
    ]);
  } catch (e) {
    const resp: DistanceResponse = {
      type: 'error',
      jobId: req.jobId,
      message: e instanceof Error ? e.message : String(e),
    };
    (self as unknown as Worker).postMessage(resp);
  }
};
