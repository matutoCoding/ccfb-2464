// 自动咬合对齐: PCA 定向 + 沿咬合轴平移到首次接触
import type { JawModel } from './types';
import { m4, pca, v3, type Vec3 } from './math';
import { boundingBox } from './meshParser';

/**
 * 用 PCA 把单颌重新定向: 最大特征轴 -> 牙弓横向 X, 次轴 -> 前后 Z, 最小轴 -> 垂直 Y
 * PCA 返回的轴是 "新基向量在旧坐标系中的表示", 坐标变换矩阵为其转置 (正交矩阵的逆)
 * 返回新的模型矩阵 (仅含旋转+平移到原点), 不修改入参
 */
export function orientJaw(mesh: JawModel['mesh'], jaw: 'upper' | 'lower'): Float32Array {
  const { center, axes } = pca(mesh.positions);
  // 统一 X 轴朝向 (正向朝右)
  let ax = axes[0];
  if (ax[0] < 0) ax = v3.scale(ax, -1);
  // 取第二轴, 去掉在 X 上的投影后重新归一化 (Gram-Schmidt), 保证严格正交
  let az = v3.sub(axes[1], v3.scale(ax, v3.dot(axes[1], ax)));
  az = v3.norm(az);
  if (az[2] < 0) az = v3.scale(az, -1);
  // 第三轴由前两轴叉积得到, 保证右手系
  let ay = v3.norm(v3.cross(az, ax));
  // 上下颌模型在生成时咬合面朝向相同 (都朝 -Y), 下颌需要绕横轴翻转 180°
  // 使下颌咬合面朝上: 强制下颌的 ay 与上颌相反
  const wantAyUp = jaw === 'lower'; // 上颌 ay 朝下, 下颌 ay 朝上
  const ayIsUp = ay[1] > 0;
  if (ayIsUp !== wantAyUp) ay = v3.scale(ay, -1);
  // 翻转 ay 后需重新保证右手系: ax × ay 应等于 az, 不等则翻 az
  if (v3.dot(v3.cross(ax, ay), az) < 0) az = v3.scale(az, -1);

  // 坐标变换: p_new = R p_old, R 的行 = 新基向量
  const rot = new Float32Array(16);
  rot[0] = ax[0]; rot[1] = ay[0]; rot[2] = az[0];
  rot[4] = ax[1]; rot[5] = ay[1]; rot[6] = az[1];
  rot[8] = ax[2]; rot[9] = ay[2]; rot[10] = az[2];
  rot[15] = 1;
  const trans = m4.translation(v3.scale(center, -1));
  return m4.mul(rot, trans);
}

/** 在给定模型矩阵下计算顶点世界坐标 */
function worldPositions(mesh: JawModel['mesh'], model: Float32Array): Float32Array {
  const out = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p = m4.transformPoint(model, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  return out;
}

/**
 * 自动对齐到咬合位:
 * 1) 两颌各自 PCA 定向
 * 2) XZ 平面质心对齐
 * 3) 下颌沿 +Y (上颌沿 -Y) 平移, 直到两颌表面首次接触 (留 0.02mm 微间隙防穿插)
 */
export function autoAlign(upper: JawModel, lower: JawModel): { upper: Float32Array; lower: Float32Array; gap: number } {
  const upOriented = orientJaw(upper.mesh, 'upper');
  const loOriented = orientJaw(lower.mesh, 'lower');
  const upWorld = worldPositions(upper.mesh, upOriented);
  const loWorld = worldPositions(lower.mesh, loOriented);

  const upBox = boundingBox(upWorld);
  const loBox = boundingBox(loWorld);
  // XZ 质心对齐
  const dx = upBox.center[0] - loBox.center[0];
  const dz = upBox.center[2] - loBox.center[2];
  const loShiftXZ = m4.translation([dx, 0, dz]);
  const loAligned = m4.mul(loShiftXZ, loOriented);
  const loWorld2 = worldPositions(lower.mesh, loAligned);

  // 沿 Y 求首次接触: 对每个 XZ 采样, 上颌最低点 vs 下颌最高点
  // 用分箱 (XZ 网格) 加速, 箱尺寸 ~1.5mm
  const cell = 1.5;
  const minX = Math.min(upBox.min[0], loBox.min[0]);
  const minZ = Math.min(upBox.min[2], loBox.min[2]);
  const nx = Math.ceil((Math.max(upBox.max[0], loBox.max[0]) - minX) / cell) + 1;
  const nz = Math.ceil((Math.max(upBox.max[2], loBox.max[2]) - minZ) / cell) + 1;
  const upLow = new Float64Array(nx * nz).fill(Infinity);
  const loHigh = new Float64Array(nx * nz).fill(-Infinity);
  const binOf = (x: number, z: number) => {
    const ix = Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cell)));
    const iz = Math.min(nz - 1, Math.max(0, Math.floor((z - minZ) / cell)));
    return iz * nx + ix;
  };
  for (let i = 0; i < upWorld.length; i += 3) {
    const b = binOf(upWorld[i], upWorld[i + 2]);
    if (upWorld[i + 1] < upLow[b]) upLow[b] = upWorld[i + 1];
  }
  for (let i = 0; i < loWorld2.length; i += 3) {
    const b = binOf(loWorld2[i], loWorld2[i + 2]);
    if (loWorld2[i + 1] > loHigh[b]) loHigh[b] = loWorld2[i + 1];
  }
  let minClearance = Infinity;
  for (let b = 0; b < nx * nz; b++) {
    if (Number.isFinite(upLow[b]) && Number.isFinite(loHigh[b])) {
      const clearance = upLow[b] - loHigh[b]; // 正值=有间隙
      if (clearance < minClearance) minClearance = clearance;
    }
  }
  if (!Number.isFinite(minClearance)) {
    // 两颌 XZ 投影无重叠, 退回到包围盒对齐
    minClearance = upBox.min[1] - loBox.max[1];
  }
  const contactGap = 0.02;
  // minClearance > 0 表示两颌间有间隙 (下颌需上移该距离), < 0 表示穿插 (需下移脱离)
  // 目标: 平移后最小间隙 = contactGap, 故 lift = contactGap - minClearance
  const lift = contactGap - minClearance; // 下颌沿 +Y 的移动量
  const loFinal = m4.mul(m4.translation([0, lift, 0]), loAligned);
  return { upper: upOriented, lower: loFinal, gap: contactGap };
}

/** 手动微调: 在当前变换上叠加平移 (mm) */
export function translateModel(model: Float32Array, delta: Vec3): Float32Array {
  return m4.mul(m4.translation(delta), model);
}
