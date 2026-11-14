// 轻量数学库: vec3 / mat4 / quat (列优先 Float32Array, 适配 WebGL uniformMatrix4fv)

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;
export type Quat = [number, number, number, number];

export const v3 = {
  create: (x = 0, y = 0, z = 0): Vec3 => [x, y, z],
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  dist: (a: Vec3, b: Vec3): number => v3.len(v3.sub(a, b)),
  norm(a: Vec3): Vec3 {
    const l = v3.len(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  lerp: (a: Vec3, b: Vec3, t: number): Vec3 => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ],
  angle(a: Vec3, b: Vec3): number {
    const d = Math.min(1, Math.max(-1, v3.dot(v3.norm(a), v3.norm(b))));
    return Math.acos(d);
  },
  copy: (a: Vec3): Vec3 => [a[0], a[1], a[2]],
};

export const m4 = {
  identity(): Mat4 {
    const m = new Float32Array(16);
    m[0] = m[5] = m[10] = m[15] = 1;
    return m;
  },

  mul(a: Mat4, b: Mat4): Mat4 {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        out[c * 4 + r] =
          a[r] * b[c * 4] +
          a[4 + r] * b[c * 4 + 1] +
          a[8 + r] * b[c * 4 + 2] +
          a[12 + r] * b[c * 4 + 3];
      }
    }
    return out;
  },

  perspective(fovy: number, aspect: number, near: number, far: number): Mat4 {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const m = new Float32Array(16);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) * nf;
    m[11] = -1;
    m[14] = 2 * far * near * nf;
    return m;
  },

  lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
    const z = v3.norm(v3.sub(eye, target));
    const x = v3.norm(v3.cross(up, z));
    const y = v3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[1] = y[0]; m[2] = z[0]; m[3] = 0;
    m[4] = x[1]; m[5] = y[1]; m[6] = z[1]; m[7] = 0;
    m[8] = x[2]; m[9] = y[2]; m[10] = z[2]; m[11] = 0;
    m[12] = -v3.dot(x, eye);
    m[13] = -v3.dot(y, eye);
    m[14] = -v3.dot(z, eye);
    m[15] = 1;
    return m;
  },

  compose(pos: Vec3, q: Quat, scl: Vec3 = [1, 1, 1]): Mat4 {
    const [x, y, z, w] = q;
    const x2 = x + x, y2 = y + y, z2 = z + z;
    const xx = x * x2, xy = x * y2, xz = x * z2;
    const yy = y * y2, yz = y * z2, zz = z * z2;
    const wx = w * x2, wy = w * y2, wz = w * z2;
    const [sx, sy, sz] = scl;
    const m = new Float32Array(16);
    m[0] = (1 - (yy + zz)) * sx;
    m[1] = (xy + wz) * sx;
    m[2] = (xz - wy) * sx;
    m[4] = (xy - wz) * sy;
    m[5] = (1 - (xx + zz)) * sy;
    m[6] = (yz + wx) * sy;
    m[8] = (xz + wy) * sz;
    m[9] = (yz - wx) * sz;
    m[10] = (1 - (xx + yy)) * sz;
    m[12] = pos[0]; m[13] = pos[1]; m[14] = pos[2];
    m[15] = 1;
    return m;
  },

  translation(p: Vec3): Mat4 {
    const m = m4.identity();
    m[12] = p[0]; m[13] = p[1]; m[14] = p[2];
    return m;
  },

  invert(a: Mat4): Mat4 {
    const out = new Float32Array(16);
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return m4.identity();
    det = 1 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a22 * b01 + a21 * b00) * det;
    return out;
  },

  transformPoint(m: Mat4, p: Vec3): Vec3 {
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [
      (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
      (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
      (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
    ];
  },

  // 法向量矩阵 (逆转置的 3x3 部分)
  normalMatrix(m: Mat4): Float32Array {
    const inv = m4.invert(m);
    return new Float32Array([
      inv[0], inv[4], inv[8],
      inv[1], inv[5], inv[9],
      inv[2], inv[6], inv[10],
    ]);
  },
};

export const quat = {
  identity: (): Quat => [0, 0, 0, 1],
  fromAxisAngle(axis: Vec3, rad: number): Quat {
    const n = v3.norm(axis);
    const h = rad / 2;
    const s = Math.sin(h);
    return [n[0] * s, n[1] * s, n[2] * s, Math.cos(h)];
  },
  mul(a: Quat, b: Quat): Quat {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ];
  },
};

// 标准的 quat 旋转向量实现 (上面 rotateVec 写复杂了, 用这个)
export function rotateVec(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]];
  const w = q[3];
  const uv = v3.cross(u, v);
  const uuv = v3.cross(u, uv);
  return [
    v[0] + 2 * (w * uv[0] + uuv[0]),
    v[1] + 2 * (w * uv[1] + uuv[1]),
    v[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}

// 主成分分析: 返回质心 + 三个特征轴 (按特征值降序), 用于牙弓自动对齐
export function pca(points: Float32Array): { center: Vec3; axes: Vec3[]; values: number[] } {
  const n = points.length / 3;
  const center: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    center[0] += points[i * 3];
    center[1] += points[i * 3 + 1];
    center[2] += points[i * 3 + 2];
  }
  center[0] /= n; center[1] /= n; center[2] /= n;
  const cov = new Float64Array(9);
  for (let i = 0; i < n; i++) {
    const x = points[i * 3] - center[0];
    const y = points[i * 3 + 1] - center[1];
    const z = points[i * 3 + 2] - center[2];
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z;
    cov[4] += y * y; cov[5] += y * z;
    cov[8] += z * z;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  for (let i = 0; i < 9; i++) cov[i] /= n;
  // Jacobi 特征分解 (3x3 对称矩阵), 经典循环 Jacobi, 保证数值稳定
  const a = cov.slice(); // 长度 9, 行优先
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const rotate = (i: number, j: number) => {
    const app = a[i * 3 + i];
    const aqq = a[j * 3 + j];
    const apq = a[i * 3 + j];
    if (Math.abs(apq) < 1e-14) return;
    const tau = (aqq - app) / (2 * apq);
    let t: number;
    if (tau >= 0) t = 1 / (tau + Math.sqrt(1 + tau * tau));
    else t = -1 / (-tau + Math.sqrt(1 + tau * tau));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    // 更新 A = G^T A G
    for (let k = 0; k < 3; k++) {
      const aik = a[i * 3 + k];
      const ajk = a[j * 3 + k];
      a[i * 3 + k] = c * aik - s * ajk;
      a[j * 3 + k] = s * aik + c * ajk;
    }
    for (let k = 0; k < 3; k++) {
      const aki = a[k * 3 + i];
      const akj = a[k * 3 + j];
      a[k * 3 + i] = c * aki - s * akj;
      a[k * 3 + j] = s * aki + c * akj;
    }
    // 累积特征向量 V = V G
    for (let k = 0; k < 3; k++) {
      const vki = v[k * 3 + i];
      const vkj = v[k * 3 + j];
      v[k * 3 + i] = c * vki - s * vkj;
      v[k * 3 + j] = s * vki + c * vkj;
    }
  };
  for (let iter = 0; iter < 50; iter++) {
    const off = Math.hypot(a[1], a[2], a[5]);
    if (off < 1e-12) break;
    rotate(0, 1);
    rotate(0, 2);
    rotate(1, 2);
  }
  const vals: { value: number; axis: Vec3 }[] = [0, 1, 2].map((i) => ({
    value: a[i * 3 + i],
    axis: [v[i], v[3 + i], v[6 + i]] as Vec3,
  }));
  vals.sort((x, y) => y.value - x.value);
  return {
    center,
    axes: vals.map((e) => v3.norm(e.axis)),
    values: vals.map((e) => e.value),
  };
}
