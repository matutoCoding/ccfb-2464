// 距离色谱 Worker 的主线程封装 (Transferable, 单任务串行, 进度回调)
import type { DistanceField, JawModel, LegendConfig } from './types';
import type { DistanceRequest, DistanceResponse } from './worker';
import { m4 } from './math';

export interface DistanceResult {
  field: DistanceField;
  sampleIndices: Uint32Array;
}

export class DistanceService {
  private worker: Worker;
  private jobSeq = 0;
  private current: {
    jobId: number;
    resolve: (d: DistanceResult) => void;
    reject: (e: Error) => void;
    onProgress?: (p: number) => void;
  } | null = null;

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<DistanceResponse>) => {
      const msg = ev.data;
      if (!this.current || msg.jobId !== this.current.jobId) return;
      if (msg.type === 'progress') {
        this.current.onProgress?.(msg.progress ?? 0);
      } else if (msg.type === 'done') {
        const field: DistanceField = {
          distances: new Float32Array(msg.distances!),
          normalized: new Float32Array(msg.normalized!),
          min: msg.min!,
          max: msg.max!,
          mean: msg.mean!,
          histogram: msg.histogram!,
          elapsedMs: msg.elapsedMs!,
        };
        const cur = this.current;
        this.current = null;
        cur.resolve({ field, sampleIndices: new Uint32Array(msg.sampleIndices!) });
      } else {
        const cur = this.current;
        this.current = null;
        cur.reject(new Error(msg.message || 'Worker 计算失败'));
      }
    };
    this.worker.onerror = (e) => {
      this.current?.reject(new Error(e.message || 'Worker 崩溃'));
      this.current = null;
    };
  }

  /**
   * @param sampleStep 采样步长 mm; 0 = 全顶点
   */
  compute(
    upper: JawModel,
    lower: JawModel,
    legend: LegendConfig,
    sampleStep: number,
    onProgress?: (p: number) => void,
  ): Promise<DistanceResult> {
    return new Promise((resolve, reject) => {
      if (this.current) {
        reject(new Error('上一个距离计算任务尚未完成'));
        return;
      }
      const jobId = ++this.jobSeq;
      this.current = { jobId, resolve, reject, onProgress };

      // 转换到世界坐标后传给 Worker (对齐结果已写在 transform 里)
      const toWorld = (model: JawModel): Float32Array => {
        const src = model.mesh.positions;
        const out = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
          const p = m4.transformPoint(model.transform, [src[i], src[i + 1], src[i + 2]]);
          out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
        }
        return out;
      };
      const upWorld = toWorld(upper);
      const loWorld = toWorld(lower);
      const req: DistanceRequest = {
        type: 'compute',
        jobId,
        upperPositions: upWorld.buffer as ArrayBuffer,
        upperIndices: upper.mesh.indices.slice().buffer as ArrayBuffer,
        lowerPositions: loWorld.buffer as ArrayBuffer,
        maxRange: legend.maxRange,
        bands: legend.bands,
        contactThreshold: legend.contactThreshold,
        sampleStep,
      };
      this.worker.postMessage(req, [req.upperPositions, req.upperIndices, req.lowerPositions]);
    });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** 接触点聚类: 距离低于阈值的采样点按空间连通性聚类, 输出每块接触区面积 */
export function clusterContacts(
  field: DistanceField,
  sampleIndices: Uint32Array,
  lowerPositionsWorld: Float32Array,
  lowerIndices: Uint32Array,
  threshold: number,
): { center: [number, number, number]; areaMm2: number; sampleCount: number; avgGap: number }[] {
  // 1) 收集接触顶点
  const contactVerts = new Set<number>();
  for (let i = 0; i < field.distances.length; i++) {
    if (field.distances[i] <= threshold) contactVerts.add(sampleIndices[i]);
  }
  if (contactVerts.size === 0) return [];

  // 2) 按三角形邻接做 BFS 聚类
  const clusters: Set<number>[] = [];
  const visited = new Set<number>();
  const adjacency = new Map<number, number[]>();
  for (let t = 0; t < lowerIndices.length; t += 3) {
    const tri = [lowerIndices[t], lowerIndices[t + 1], lowerIndices[t + 2]];
    for (const v of tri) {
      if (!contactVerts.has(v)) continue;
      let list = adjacency.get(v);
      if (!list) { list = []; adjacency.set(v, list); }
      for (const o of tri) if (o !== v && contactVerts.has(o)) list.push(o);
    }
  }
  for (const start of contactVerts) {
    if (visited.has(start)) continue;
    const cluster = new Set<number>();
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const v = queue.pop()!;
      cluster.add(v);
      for (const nb of adjacency.get(v) || []) {
        if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
      }
    }
    clusters.push(cluster);
  }

  // 3) 每块: 质心 + 三角形面积 (只计三顶点都在簇内的三角形, 边缘按比例近似)
  const vertArea = new Float32Array(lowerPositionsWorld.length / 3);
  for (let t = 0; t < lowerIndices.length; t += 3) {
    const a = lowerIndices[t], b = lowerIndices[t + 1], c = lowerIndices[t + 2];
    const ax = lowerPositionsWorld[a * 3], ay = lowerPositionsWorld[a * 3 + 1], az = lowerPositionsWorld[a * 3 + 2];
    const bx = lowerPositionsWorld[b * 3], by = lowerPositionsWorld[b * 3 + 1], bz = lowerPositionsWorld[b * 3 + 2];
    const cx = lowerPositionsWorld[c * 3], cy = lowerPositionsWorld[c * 3 + 1], cz = lowerPositionsWorld[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    const inside = (a0: number) => (contactVerts.has(a0) ? 1 : 0);
    const share = (inside(a) + inside(b) + inside(c)) / 3;
    vertArea[a] += (area * share) / 3;
    vertArea[b] += (area * share) / 3;
    vertArea[c] += (area * share) / 3;
  }

  return clusters
    .map((cluster) => {
      let cx = 0, cy = 0, cz = 0, area = 0, gapSum = 0, gapN = 0;
      for (const v of cluster) {
        cx += lowerPositionsWorld[v * 3];
        cy += lowerPositionsWorld[v * 3 + 1];
        cz += lowerPositionsWorld[v * 3 + 2];
        area += vertArea[v];
      }
      // 平均间隙: 从 field 反查
      const idxToSample = new Map<number, number>();
      sampleIndices.forEach((sv, si) => idxToSample.set(sv, si));
      for (const v of cluster) {
        const si = idxToSample.get(v);
        if (si !== undefined) { gapSum += field.distances[si]; gapN++; }
      }
      return {
        center: [cx / cluster.size, cy / cluster.size, cz / cluster.size] as [number, number, number],
        areaMm2: area,
        sampleCount: cluster.size,
        avgGap: gapN ? gapSum / gapN : 0,
      };
    })
    .sort((a, b) => b.areaMm2 - a.areaMm2);
}
