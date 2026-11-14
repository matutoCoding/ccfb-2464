import { generateDentalArch } from '../src/core/modelGenerator';
import { parseMeshFile, MeshParseError } from '../src/core/meshParser';

async function main(): Promise<void> {
  const m = generateDentalArch({ targetTriangles: 200, jaw: 'upper' });
  let ply = 'ply\nformat ascii 1.0\n';
  ply += `element vertex ${m.vertexCount}\n`;
  ply += 'property float x\nproperty float y\nproperty float z\n';
  ply += `element face ${m.triangleCount}\n`;
  ply += 'property list uchar int vertex_indices\nend_header\n';
  for (let i = 0; i < m.positions.length; i += 3) {
    ply += `${m.positions[i]} ${m.positions[i + 1]} ${m.positions[i + 2]}\n`;
  }
  for (let t = 0; t < m.indices.length; t += 3) {
    ply += `3 ${m.indices[t]} ${m.indices[t + 1]} ${m.indices[t + 2]}\n`;
  }
  const parsed = await parseMeshFile(new File([new Blob([ply])], 'test.ply'));
  console.log(`ASCII PLY 解析: ${parsed.vertexCount} 顶点 / ${parsed.triangleCount} 三角面`);
  if (parsed.triangleCount !== m.triangleCount) throw new Error('PLY 面数不匹配');

  // 二进制 PLY (little endian)
  const head = `ply\nformat binary_little_endian 1.0\n` +
    `element vertex ${m.vertexCount}\nproperty float x\nproperty float y\nproperty float z\n` +
    `element face ${m.triangleCount}\nproperty list uchar int vertex_indices\nend_header\n`;
  const headBytes = new TextEncoder().encode(head);
  const body: number[] = [];
  for (let i = 0; i < m.positions.length; i++) body.push(m.positions[i]);
  const vBuf = new Float32Array(body);
  const indexBytes: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    indexBytes.push(3, m.indices[t], m.indices[t + 1], m.indices[t + 2]);
  }
  // 显式小端打包: count 为 uchar, 索引为 int32 (4 字节小端)
  const faceBytes: number[] = [];
  for (let t = 0; t < m.indices.length; t += 3) {
    faceBytes.push(3);
    for (let j = 0; j < 3; j++) {
      const v = m.indices[t + j];
      faceBytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    }
  }
  const vBytes = new Uint8Array(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength);
  const blob = new Blob([headBytes, vBytes, Uint8Array.from(faceBytes)]);
  const binParsed = await parseMeshFile(new File([blob], 'bin.ply'));
  console.log(`二进制 PLY 解析: ${binParsed.vertexCount} 顶点 / ${binParsed.triangleCount} 三角面`);
  if (binParsed.triangleCount !== m.triangleCount) throw new Error('二进制 PLY 面数不匹配');

  const bad = new File(['ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nend_header\n'], 'bad.ply');
  try {
    await parseMeshFile(bad);
    throw new Error('应当抛错');
  } catch (e) {
    if (!(e instanceof MeshParseError)) throw e;
    console.log(`坏 PLY 正确拒绝: ${e.message}`);
  }
  console.log('PLY 全部测试通过');
}

main().catch((e) => { console.error(e); process.exit(1); });
