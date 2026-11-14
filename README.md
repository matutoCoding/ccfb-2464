# 口腔咬合分析工作室 (Dental Occlusion Studio)

浏览器端的口扫模型咬合分析工具: STL/PLY 解析、上下颌自动对齐、间隙距离色谱、接触点检测、
任意平面剖切与测量、截图拼版 PDF 报告。纯 TypeScript + WebGL2, 零运行时框架依赖, 数据本地存储。

## 技术栈

- **语言/构建**: TypeScript 5 + Vite 5, 无 React/Vue 等运行时框架 (手写 ~400 行 DOM 辅助 + 发布订阅 store)
- **渲染**: 原生 WebGL2, 延迟着色管线
  - G-Buffer MRT (位置/法线/反照率, 全部 RGBA8 归一化编码, 兼容 SwiftShader 等无浮点附件的环境)
  - 半分辨率 SSAO (32 核采样 + 5x5 高斯模糊, 深度重建世界坐标)
  - Sobel 法线+深度边缘描线
  - Blinn-Phong 光照合成, 轨道相机阻尼插值
- **重计算**: Web Worker (Uniform Grid 空间加速 + Ericson 点-三角形距离), Transferable 零拷贝
- **存储**: IndexedDB (病例元数据 + 网格 ArrayBuffer)
- **PDF**: 手写极简 PDF 写入器 (整页光栅化 JPEG, 规避中文字体嵌入问题)

## 快速开始

```bash
npm install
npm run dev        # 开发服务器 http://localhost:5173
npm run build      # 类型检查 + 生产构建
npm run test       # Node 端核心算法测试 (21 + 4 项)
npm run typecheck  # 仅类型检查
```

## 功能与页面

| 页面 | 功能 |
| --- | --- |
| 病例列表 | 新建/删除病例, STL/PLY 拖拽或点击导入, 坏文件中文报错, 程序化测试模型生成 (6万/20万/50万面, 可选带洞) |
| 模型查看 | 上下颌独立显隐/透明度, PCA 自动咬合对齐, 0.5mm 微调, SSAO/描线参数, 包围盒 |
| 咬合分析 | Worker 距离色谱 (0-2mm 可调, 4-16 档), 图例滑杆即时重映射, 接触点聚类与每块面积, 直方图/统计 |
| 剖面测量 | 水平/冠状/矢状面及任意法向剖切, Shift+左键拖动平面, 剖面填色 (earcut 三角化, 支持带洞), 距离/角度标注随模型跟随 |
| 报告导出 | 视角截图拼版 (排序/备注/删除), 标准视角三连, A4 PDF 封面+汇总+截图 |

## 目录结构

```
src/
  core/           纯逻辑, 不依赖 DOM/WebGL
    math.ts           向量/矩阵/PCA (Jacobi 特征分解)
    meshParser.ts     STL(二进制/ASCII) + PLY(ASCII/二进制) 解析与校验
    modelGenerator.ts 程序化 U 形牙弓 + 二进制 STL 导出
    alignment.ts      PCA 定向 + XZ 分箱首次接触对齐
    worker.ts         距离场 Worker (Uniform Grid + 点三角形距离)
    distanceService.ts Worker 主线程封装 + 接触点图聚类
    section.ts        平面求交/轮廓成环/earcut 三角化/射线求交
    store.ts          单例状态管理
    storage.ts        IndexedDB 持久化
    pdf.ts            极简 PDF 生成器
  renderer/       WebGL2
    shaders.ts        GLSL ES 3.00 着色器
    renderer.ts       G-Buffer/SSAO/Edge/Composite/剖切/gizmo
    orbitCamera.ts    轨道相机
  ui/
    dom.ts router.ts  DOM 辅助与 hash 路由
    viewport.ts       3D 视口 (渲染循环/标注/平面拖拽/FPS)
    pages/            五个页面
scripts/          Node 端算法测试
```

## 关键设计决策

- **G-Buffer 用 RGBA8 而非浮点纹理**: 部分环境 (如无头浏览器的 SwiftShader) 的 16F/32F 颜色附件
  FBO 状态谎报 COMPLETE 却不实际写入。位置按场景包围盒归一化后拆高低字节存两通道, z 由 24 位
  深度纹理重建, 在所有 WebGL2 实现上均可渲染。
- **距离计算放 Worker**: 50 万三角面的 Uniform Grid 构建与最近三角形查询完全脱离主线程,
  Transferable 传递顶点/索引缓冲, 采样模式 (1.2mm 步长) 下端到端约 0.2-1.1s。
- **PDF 整页光栅化**: 中文文本随 Canvas 绘制为 JPEG 嵌入, PDF 内只放标准 Helvetica 拉丁字符,
  无需嵌入字体子集, 任意阅读器均可打开。

## 测试模型

病例列表页可一键生成程序化牙弓: U 形牙弓参数化网格, 含 14 颗牙的牙尖/中央沟起伏,
"带开放洞" 选项会在牙龈区挖 3 个洞用于验证剖切轮廓与 earcut 洞桥接。
