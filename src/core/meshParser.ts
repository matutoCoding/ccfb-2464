// STL / PLY 解析器, 带完整性校验, 坏文件抛出中文错误

import type { MeshData } from './types';

export class MeshParseError extends Error {}

/** 计算平滑顶点法线 (按面法线面积加权累加) */
export function computeNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i] * 3, ib = indices[i + 1] * 3, ic = indices[i + 2] * 3;
    const ux = positions[ib] - positions[ia];
    const uy = positions[ib + 1] - positions[ia + 1];
    const uz = positions[ib + 2] - positions[ia + 2];
    const vx = positions[ic] - positions[ia];
    const vy = positions[ic + 1] - positions[ia + 1];
    const vz = positions[ic + 2] - positions[ia + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
    normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
    normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]);
    if (l > 1e-12) {
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    } else {
      normals[i] = 0; normals[i + 1] = 1; normals[i + 2] = 0;
    }
  }
  return normals;
}

export function boundingBox(positions: Float32Array): { min: [number, number, number]; max: [number, number, number]; center: [number, number, number]; size: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return {
    min, max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

function validateFinite(mesh: MeshData): void {
  const { positions, indices } = mesh;
  if (positions.length < 9) throw new MeshParseError('顶点数量不足, 无法构成三角网格');
  if (indices.length < 3 || indices.length % 3 !== 0) {
    throw new MeshParseError('三角形索引数量异常 (必须为 3 的倍数)');
  }
  const vcount = positions.length / 3;
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) throw new MeshParseError('顶点坐标包含 NaN 或无穷大, 文件可能已损坏');
  }
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vcount) throw new MeshParseError(`索引越界 (第 ${i} 个索引指向不存在的顶点 ${indices[i]})`);
  }
  // 退化三角形比例检查
  let degenerate = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const area = Math.abs(
      (positions[b] - positions[a]) * (positions[c + 1] - positions[a + 1]) -
      (positions[b + 1] - positions[a + 1]) * (positions[c] - positions[a]),
    );
    if (area < 1e-12) degenerate++;
  }
  if (degenerate / (indices.length / 3) > 0.5) {
    throw new MeshParseError('超过一半的三角形为退化三角形, 文件可能已损坏');
  }
}

// ---------------- STL ----------------

export function parseBinarySTL(buffer: ArrayBuffer, name: string): MeshData {
  if (buffer.byteLength < 84) throw new MeshParseError('STL 文件长度不足, 可能已损坏');
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const expected = 84 + triCount * 50;
  if (buffer.byteLength !== expected) {
    throw new MeshParseError(`二进制 STL 长度不匹配: 头信息声明 ${triCount} 个三角形, 应占 ${expected} 字节, 实际 ${buffer.byteLength} 字节`);
  }
  if (triCount === 0) throw new MeshParseError('STL 不包含任何三角形');
  if (triCount > 5_000_000) throw new MeshParseError(`三角形数量 ${triCount} 超出上限 500 万`);
  const positions = new Float32Array(triCount * 9);
  const faceNormals = new Float32Array(triCount * 9);
  const indices = new Uint32Array(triCount * 3);
  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    const nxo = view.getFloat32(offset, true);
    const nyo = view.getFloat32(offset + 4, true);
    const nzo = view.getFloat32(offset + 8, true);
    offset += 12;
    const base = t * 9;
    for (let k = 0; k < 3; k++) {
      positions[base + k * 3] = view.getFloat32(offset, true);
      positions[base + k * 3 + 1] = view.getFloat32(offset + 4, true);
      positions[base + k * 3 + 2] = view.getFloat32(offset + 8, true);
      faceNormals[base + k * 3] = nxo;
      faceNormals[base + k * 3 + 1] = nyo;
      faceNormals[base + k * 3 + 2] = nzo;
      offset += 12;
    }
    indices[t * 3] = t * 3;
    indices[t * 3 + 1] = t * 3 + 1;
    indices[t * 3 + 2] = t * 3 + 2;
    offset += 2; // attribute byte count
  }
  const normals = computeNormals(positions, indices);
  const mesh: MeshData = {
    positions, normals, indices,
    triangleCount: triCount,
    vertexCount: triCount * 3,
    sourceName: name,
  };
  validateFinite(mesh);
  return mesh;
}

function parseAsciiSTL(text: string, name: string): MeshData {
  if (!/^\s*solid[\s\S]*/.test(text)) throw new MeshParseError('ASCII STL 缺少 solid 头部');
  const vertexRe = /vertex\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/g;
  const nums: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    nums.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  }
  const facetCount = (text.match(/facet\s+normal/g) || []).length;
  if (nums.length === 0) throw new MeshParseError('ASCII STL 中未找到任何 vertex 数据');
  if (nums.length % 9 !== 0) throw new MeshParseError('ASCII STL 顶点数据不完整 (数量不是 9 的倍数)');
  if (facetCount > 0 && nums.length / 9 !== facetCount) {
    throw new MeshParseError(`ASCII STL 数据不完整: 声明 ${facetCount} 个面, 实际只解析出 ${nums.length / 9} 个`);
  }
  const positions = Float32Array.from(nums);
  const triCount = positions.length / 9;
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const normals = computeNormals(positions, indices);
  const mesh: MeshData = {
    positions, normals, indices,
    triangleCount: triCount,
    vertexCount: triCount * 3,
    sourceName: name,
  };
  validateFinite(mesh);
  return mesh;
}

// ---------------- PLY ----------------

interface PlyProperty { name: string; type: string; isList: boolean; countType?: string; itemType?: string; }
interface PlyElement { name: string; count: number; properties: PlyProperty[]; }

const PLY_TYPE_SIZES: Record<string, number> = {
  char: 1, int8: 1, uchar: 1, uint8: 1,
  short: 2, int16: 2, ushort: 2, uint16: 2,
  int: 4, int32: 4, uint: 4, uint32: 4,
  float: 4, float32: 4, double: 8, float64: 8,
};

function parsePlyHeader(text: string): { elements: PlyElement[]; headerLength: number; format: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0].trim() !== 'ply') throw new MeshParseError('PLY 文件缺少 ply 头部标识');
  const elements: PlyElement[] = [];
  let format = 'ascii';
  let i = 1;
  for (; i < lines.length; i++) {
    const tokens = lines[i].trim().split(/\s+/);
    if (tokens[0] === 'format') {
      format = tokens[1];
      if (format !== 'ascii' && format !== 'binary_little_endian' && format !== 'binary_big_endian') {
        throw new MeshParseError(`不支持的 PLY 格式: ${format}`);
      }
    } else if (tokens[0] === 'element') {
      elements.push({ name: tokens[1], count: parseInt(tokens[2], 10), properties: [] });
    } else if (tokens[0] === 'property') {
      const el = elements[elements.length - 1];
      if (!el) throw new MeshParseError('PLY 头部 property 出现在 element 之前');
      if (tokens[1] === 'list') {
        el.properties.push({ name: tokens[4], type: 'list', isList: true, countType: tokens[2], itemType: tokens[3] });
      } else {
        el.properties.push({ name: tokens[2], type: tokens[1], isList: false });
      }
    } else if (tokens[0] === 'end_header') {
      i++;
      break;
    }
    if (i > 200) throw new MeshParseError('PLY 头部过长或缺少 end_header');
  }
  const headerLength = lines.slice(0, i).reduce((acc, ln, idx) => acc + ln.length + (idx < i - 1 ? 1 : 0), 0) + (text.startsWith('\n') ? 0 : 0);
  return { elements, headerLength: text.indexOf('end_header') + 'end_header'.length + 1, format };
}

function readPlyScalar(view: DataView, offset: number, type: string, little: boolean): number {
  switch (type) {
    case 'char': case 'int8': return view.getInt8(offset);
    case 'uchar': case 'uint8': return view.getUint8(offset);
    case 'short': case 'int16': return view.getInt16(offset, little);
    case 'ushort': case 'uint16': return view.getUint16(offset, little);
    case 'int': case 'int32': return view.getInt32(offset, little);
    case 'uint': case 'uint32': return view.getUint32(offset, little);
    case 'float': case 'float32': return view.getFloat32(offset, little);
    case 'double': case 'float64': return view.getFloat64(offset, little);
    default: throw new MeshParseError(`PLY 未知数据类型: ${type}`);
  }
}

function parsePly(buffer: ArrayBuffer, textHead: string, name: string): MeshData {
  const { elements, headerLength, format } = parsePlyHeader(textHead);
  const vertexEl = elements.find((e) => e.name === 'vertex');
  const faceEl = elements.find((e) => e.name === 'face');
  if (!vertexEl) throw new MeshParseError('PLY 缺少 vertex 元素');
  if (!faceEl) throw new MeshParseError('PLY 缺少 face 元素, 点云数据暂不支持');
  const xIdx = vertexEl.properties.findIndex((p) => p.name === 'x');
  const yIdx = vertexEl.properties.findIndex((p) => p.name === 'y');
  const zIdx = vertexEl.properties.findIndex((p) => p.name === 'z');
  if (xIdx < 0 || yIdx < 0 || zIdx < 0) throw new MeshParseError('PLY vertex 缺少 x/y/z 属性');
  const nxIdx = vertexEl.properties.findIndex((p) => p.name === 'nx');
  const nyIdx = vertexEl.properties.findIndex((p) => p.name === 'ny');
  const nzIdx = vertexEl.properties.findIndex((p) => p.name === 'nz');

  const positions = new Float32Array(vertexEl.count * 3);
  const srcNormals = nxIdx >= 0 ? new Float32Array(vertexEl.count * 3) : null;
  const indexLists: number[][] = [];

  if (format === 'ascii') {
    const body = new TextDecoder().decode(buffer).slice(headerLength);
    const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
    let lineNo = 0;
    try {
      for (let v = 0; v < vertexEl.count; v++, lineNo++) {
        const tok = lines[lineNo].trim().split(/\s+/);
        positions[v * 3] = parseFloat(tok[xIdx]);
        positions[v * 3 + 1] = parseFloat(tok[yIdx]);
        positions[v * 3 + 2] = parseFloat(tok[zIdx]);
        if (srcNormals) {
          srcNormals[v * 3] = parseFloat(tok[nxIdx]);
          srcNormals[v * 3 + 1] = parseFloat(tok[nyIdx]);
          srcNormals[v * 3 + 2] = parseFloat(tok[nzIdx]);
        }
      }
      for (let f = 0; f < faceEl.count; f++, lineNo++) {
        const tok = lines[lineNo].trim().split(/\s+/);
        const listProp = faceEl.properties.find((p) => p.isList)!;
        const cnt = parseInt(tok[0], 10);
        if (tok.length < cnt + 1) throw new MeshParseError(`第 ${f} 个面顶点数据不完整`);
        const row: number[] = [];
        for (let k = 0; k < cnt; k++) row.push(parseInt(tok[1 + k], 10));
        indexLists.push(row);
        void listProp;
      }
    } catch (e) {
      if (e instanceof MeshParseError) throw e;
      throw new MeshParseError('PLY ASCII 数据行解析失败, 文件可能被截断');
    }
  } else {
    const little = format === 'binary_little_endian';
    const view = new DataView(buffer);
    let offset = headerLength;
    const stride = vertexEl.properties.reduce((s, p) => s + (PLY_TYPE_SIZES[p.type] || 0), 0);
    if (offset + stride * vertexEl.count > buffer.byteLength) {
      throw new MeshParseError('PLY 二进制顶点区超出文件长度, 文件可能已损坏');
    }
    for (let v = 0; v < vertexEl.count; v++) {
      const rowStart = offset;
      let cursor = rowStart;
      vertexEl.properties.forEach((p, pi) => {
        const val = readPlyScalar(view, cursor, p.type, little);
        if (pi === xIdx) positions[v * 3] = val;
        if (pi === yIdx) positions[v * 3 + 1] = val;
        if (pi === zIdx) positions[v * 3 + 2] = val;
        if (srcNormals) {
          if (pi === nxIdx) srcNormals[v * 3] = val;
          if (pi === nyIdx) srcNormals[v * 3 + 1] = val;
          if (pi === nzIdx) srcNormals[v * 3 + 2] = val;
        }
        cursor += PLY_TYPE_SIZES[p.type];
      });
      offset = rowStart + stride;
    }
    try {
      for (let f = 0; f < faceEl.count; f++) {
        const listProp = faceEl.properties.find((p) => p.isList);
        if (!listProp) throw new MeshParseError('PLY face 缺少顶点索引列表');
        const cnt = readPlyScalar(view, offset, listProp.countType!, little);
        offset += PLY_TYPE_SIZES[listProp.countType!];
        const row: number[] = [];
        for (let k = 0; k < cnt; k++) {
          row.push(readPlyScalar(view, offset, listProp.itemType!, little));
          offset += PLY_TYPE_SIZES[listProp.itemType!];
        }
        indexLists.push(row);
      }
    } catch (e) {
      if (e instanceof MeshParseError) throw e;
      throw new MeshParseError('PLY 二进制面数据解析失败, 文件可能已损坏');
    }
    if (offset > buffer.byteLength) throw new MeshParseError('PLY 二进制面区超出文件长度, 文件可能已损坏');
  }

  // 扇形拆分 (支持非三角面)
  const totalTris = indexLists.reduce((s, row) => s + Math.max(0, row.length - 2), 0);
  if (totalTris === 0) throw new MeshParseError('PLY 面数据未产生任何三角形');
  const indices = new Uint32Array(totalTris * 3);
  let w = 0;
  for (const row of indexLists) {
    for (let k = 1; k < row.length - 1; k++) {
      indices[w++] = row[0];
      indices[w++] = row[k];
      indices[w++] = row[k + 1];
    }
  }
  const normals = srcNormals && srcNormals.some((n) => n !== 0) ? srcNormals : computeNormals(positions, indices);
  const mesh: MeshData = {
    positions, normals, indices,
    triangleCount: totalTris,
    vertexCount: vertexEl.count,
    sourceName: name,
  };
  validateFinite(mesh);
  return mesh;
}

// ---------------- 入口 ----------------

export async function parseMeshFile(file: File): Promise<MeshData> {
  const lower = file.name.toLowerCase();
  const buffer = await file.arrayBuffer();
  if (lower.endsWith('.stl')) {
    // 二进制 STL 与 ASCII STL 判别: ASCII 以 solid 开头, 但二进制也可能, 用长度校验二次确认
    const head = new TextDecoder().decode(buffer.slice(0, Math.min(512, buffer.byteLength)));
    if (head.trimStart().startsWith('solid') && /vertex|facet/.test(head)) {
      try {
        return parseAsciiSTL(new TextDecoder().decode(buffer), file.name);
      } catch (e) {
        if (e instanceof MeshParseError) return parseBinarySTL(buffer, file.name);
        throw e;
      }
    }
    return parseBinarySTL(buffer, file.name);
  }
  if (lower.endsWith('.ply')) {
    const head = new TextDecoder().decode(buffer.slice(0, Math.min(4096, buffer.byteLength)));
    return parsePly(buffer, head, file.name);
  }
  throw new MeshParseError(`不支持的文件格式: ${file.name} (仅支持 .stl / .ply)`);
}
