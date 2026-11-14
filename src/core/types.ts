// 全局共享类型

export type Jaw = 'upper' | 'lower';

/** 解析后的三角网格 (世界坐标由模型矩阵另行管理, 这里存原始顶点) */
export interface MeshData {
  /** 顶点位置 xyz 交错 */
  positions: Float32Array;
  /** 顶点法线 xyz 交错 (解析时若文件无法线则自动计算) */
  normals: Float32Array;
  /** 三角形索引 */
  indices: Uint32Array;
  triangleCount: number;
  vertexCount: number;
  /** 数据来源文件名 */
  sourceName: string;
}

export interface JawModel {
  mesh: MeshData;
  /** 模型变换 (平移/旋转), 自动对齐与手动调整都写这里 */
  transform: Float32Array;
  visible: boolean;
  /** 0..1 不透明度 */
  opacity: number;
}

/** 距离色谱计算结果 */
export interface DistanceField {
  /** 与 lower 顶点一一对应的间隙距离 (mm), 沿咬合方向 */
  distances: Float32Array;
  /** 0..maxRange 归一化后的颜色索引值, 供着色器使用 */
  normalized: Float32Array;
  min: number;
  max: number;
  mean: number;
  /** 分档直方图 (8 档) */
  histogram: number[];
  /** 计算耗时 ms */
  elapsedMs: number;
}

export interface ContactPoint {
  id: number;
  /** 接触区中心 (世界坐标) */
  center: [number, number, number];
  /** 面积 mm² */
  areaMm2: number;
  /** 包含的采样顶点数 */
  sampleCount: number;
  /** 平均间隙 mm */
  avgGap: number;
}

export interface SectionMeasure {
  id: number;
  kind: 'distance' | 'angle';
  /** 剖面平面局部坐标下的点 (2D), 渲染时转回世界坐标 */
  points: [number, number][];
  /** 缓存的世界坐标点, 模型移动后需重算 */
  label: string;
  value: number;
  unit: string;
}

export interface ClipPlaneState {
  enabled: boolean;
  /** 平面经过的点 (世界坐标) */
  point: [number, number, number];
  /** 平面法线 (单位向量) */
  normal: [number, number, number];
  /** 是否填充剖面 */
  fillCap: boolean;
  measures: SectionMeasure[];
}

export interface CaseRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  upperFileName?: string;
  lowerFileName?: string;
  upperVertexCount?: number;
  lowerVertexCount?: number;
  upperTriangleCount?: number;
  lowerTriangleCount?: number;
  note?: string;
}

/** 色谱图例配置 */
export interface LegendConfig {
  maxRange: number; // mm, 默认 2
  bands: number;    // 分档数, 默认 8
  contactThreshold: number; // 小于该距离视为接触 mm, 默认 0.05
}

export interface ViewerSettings {
  ssaoEnabled: boolean;
  ssaoRadius: number;
  ssaoStrength: number;
  edgeEnabled: boolean;
  edgeStrength: number;
  lightAzimuth: number;
  lightElevation: number;
}
