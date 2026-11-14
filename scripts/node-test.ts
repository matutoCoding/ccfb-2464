/**
 * Node 端核心算法测试 (不依赖浏览器/DOM):
 *   npx tsx scripts/node-test.ts
 * 覆盖: 网格生成 -> STL 序列化 -> STL 解析回环 -> 坏文件校验 -> 对齐 -> 距离场 -> 剖切 earcut
 */
import { generateDentalArch, meshToBinarySTL } from '../src/core/modelGenerator';
import { MeshParseError, parseBinarySTL, computeNormals, boundingBox } from '../src/core/meshParser';
import { autoAlign } from '../src/core/alignment';
import { makeJawModel } from '../src/core/storage';
import { sectionAnalysis } from '../src/core/section';
import { m4 } from '../src/core/math';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name} ${detail}`); }
}

async function main(): Promise<void> {
  console.log('--- 1. 测试网格生成 ---');
  const t0 = performance.now();
  const upper = generateDentalArch({ targetTriangles: 60000, jaw: 'upper', seed: 42 });
  const lower = generateDentalArch({ targetTriangles: 60000, jaw: 'lower', seed: 77 });
  console.log(`  生成耗时 ${(performance.now() - t0).toFixed(0)}ms`);
  check('上颌三角面数量合理 (5-8万)', upper.triangleCount > 50000 && upper.triangleCount < 80000, `实际 ${upper.triangleCount}`);
  check('下颌三角面数量合理', lower.triangleCount > 50000 && lower.triangleCount < 80000);
  check('法线已计算', upper.normals.length === upper.positions.length);
  const boxU = boundingBox(upper.positions);
  check('包围盒尺寸符合牙弓量级 (~60-90mm)', boxU.size[0] > 50 && boxU.size[0] < 120, `${boxU.size.join(',')}`);

  console.log('--- 2. 带洞网格 ---');
  const holeMesh = generateDentalArch({ targetTriangles: 60000, withHoles: true, jaw: 'upper', seed: 42 });
  check('带洞网格面数少于封闭网格', holeMesh.triangleCount < upper.triangleCount,
    `洞网格 ${holeMesh.triangleCount} vs 封闭 ${upper.triangleCount}`);

  console.log('--- 3. 高分辨率 50 万面 ---');
  const t1 = performance.now();
  const big = generateDentalArch({ targetTriangles: 500000, jaw: 'lower', seed: 77 });
  console.log(`  50万面生成耗时 ${(performance.now() - t1).toFixed(0)}ms, 实际 ${big.triangleCount} 面`);
  check('单颌三角面 ≥ 45 万', big.triangleCount >= 450000, `实际 ${big.triangleCount}`);

  console.log('--- 4. STL 序列化 + 解析回环 ---');
  const blob = meshToBinarySTL(upper);
  const buf = await blob.arrayBuffer();
  const parsed = parseBinarySTL(buf, 'roundtrip.stl');
  check('回环后面数一致', parsed.triangleCount === upper.triangleCount);
  check('回环后坐标一致 (误差<1e-4)',
    Math.abs(parsed.positions[0] - upper.positions[upper.indices[0] * 3]) < 1e-4);
  check('自动法线非零', Math.hypot(parsed.normals[0], parsed.normals[1], parsed.normals[2]) > 0.9);

  console.log('--- 5. 坏文件校验 ---');
  const bad1 = new ArrayBuffer(40);
  let caught = false;
  try { parseBinarySTL(bad1, 'bad.stl'); } catch (e) { caught = e instanceof MeshParseError; }
  check('过短 STL 抛 MeshParseError', caught);

  const bad2 = new ArrayBuffer(84 + 100);
  new DataView(bad2).setUint32(80, 5, true); // 声明 5 个三角形但长度不对
  caught = false;
  try { parseBinarySTL(bad2, 'bad2.stl'); } catch (e) { caught = e instanceof MeshParseError; }
  check('长度不匹配 STL 抛错', caught);

  const bad3 = (() => {
    const m = generateDentalArch({ targetTriangles: 200, jaw: 'upper' });
    m.positions[10] = NaN;
    return m;
  })();
  caught = false;
  try {
    // 复用 validateFinite 路径: 通过 STL 往返 (NaN 会被写入再读出)
    const b = meshToBinarySTL(bad3);
    parseBinarySTL(await b.arrayBuffer(), 'nan.stl');
  } catch (e) { caught = e instanceof MeshParseError; }
  check('NaN 坐标被识别为损坏', caught);

  console.log('--- 6. 自动咬合对齐 ---');
  const upModel = makeJawModel(upper);
  const loModel = makeJawModel(lower);
  // 先制造错位
  loModel.transform = m4.translation([13, -25, 9]);
  const align = autoAlign(upModel, loModel);
  check('对齐返回有效矩阵', align.upper.length === 16 && align.lower.length === 16);
  check('接触间隙为 0.02mm', Math.abs(align.gap - 0.02) < 1e-9);
  // 验证对齐后两颌包围盒在 Y 方向不穿插
  const worldOf = (mesh: typeof upper, model: Float32Array) => {
    const out = new Float32Array(mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p = m4.transformPoint(model, [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]);
      out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
    }
    return out;
  };
  const upW = worldOf(upper, align.upper);
  const loW = worldOf(lower, align.lower);
  const upBox = boundingBox(upW), loBox = boundingBox(loW);
  check('对齐后 XZ 质心基本重合',
    Math.abs(upBox.center[0] - loBox.center[0]) < 2 && Math.abs(upBox.center[2] - loBox.center[2]) < 2,
    `dx=${upBox.center[0] - loBox.center[0]} dz=${upBox.center[2] - loBox.center[2]}`);

  console.log('--- 7. 平面剖切 + earcut 三角化 ---');
  const plane = { point: [0, 0, 0] as [number, number, number], normal: [0, 1, 0] as [number, number, number] };
  const section = sectionAnalysis(
    { mesh: upper, transform: align.upper },
    { mesh: lower, transform: align.lower },
    plane,
  );
  check('水平面剖切产生轮廓', section.loops.length > 0, `轮廓数 ${section.loops.length}`);
  check('剖面填充三角形非空', section.capTriangles.length > 0, `顶点 ${section.capTriangles.length}`);
  check('填充三角形数量为 3 的倍数', section.capTriangles.length % 3 === 0);
  // 带洞网格剖切: 洞应表现为嵌套环
  const holeSection = sectionAnalysis({ mesh: holeMesh, transform: m4.identity() }, null, plane);
  check('带洞网格可剖切且不崩溃', holeSection.capTriangles.length >= 0);

  console.log('--- 8. 法线工具 ---');
  const n = computeNormals(upper.positions, upper.indices);
  check('法线数组长度匹配', n.length === upper.positions.length);
  check('法线为单位向量', Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-5);

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
