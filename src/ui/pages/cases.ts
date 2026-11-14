// 病例列表页: 新建/删除病例, STL/PLY 拖拽解析, 测试模型生成
import { h, toast, formatDate, formatBytes, mount, downloadBlob } from '../dom';
import { store } from '../../core/store';
import { parseMeshFile, MeshParseError } from '../../core/meshParser';
import { generateDentalArch, meshToBinarySTL } from '../../core/modelGenerator';
import { navigate } from '../router';
import { estimateStorage } from '../../core/storage';

export function renderCasesPage(root: HTMLElement): void {
  const wrap = h('div', { class: 'page page-cases' });
  const header = h('div', { class: 'page-head' },
    h('div', {},
      h('h2', {}, '病例列表'),
      h('p', { class: 'muted' }, '浏览器本地存储 (IndexedDB), 数据不上传服务器'),
    ),
  );

  const nameInput = h('input', { class: 'text-input', placeholder: '新病例名称, 如: 张某-术前', style: 'width:260px' }) as HTMLInputElement;
  const createBtn = h('button', { class: 'btn btn-primary', onclick: async () => {
    const name = nameInput.value.trim() || `病例 ${new Date().toLocaleString('zh-CN')}`;
    try {
      const id = await store.createCase(name);
      toast(`病例「${name}」已创建`, 'success');
      navigate(`viewer/${id}`);
    } catch (e) {
      toast(`创建失败: ${(e as Error).message}`, 'error');
    }
  } }, '新建病例');

  const genWrap = h('div', { class: 'gen-panel card' },
    h('div', { class: 'card-title' }, '生成测试模型'),
    h('p', { class: 'muted small' }, '程序化 U 形牙弓, 用于功能与性能测试 (生成后自动新建病例)'),
    genControls(),
  );

  const listEl = h('div', { class: 'case-grid' });
  const storageEl = h('div', { class: 'muted small storage-info' });

  wrap.append(
    header,
    h('div', { class: 'card create-bar' }, nameInput, createBtn),
    genWrap,
    h('h3', { class: 'section-title' }, '全部病例'),
    listEl,
    storageEl,
  );
  mount(wrap, root);

  const renderList = () => {
    listEl.innerHTML = '';
    const cases = store.state.cases;
    if (!cases.length) {
      listEl.appendChild(h('div', { class: 'empty-hint' }, '暂无病例, 先新建一个或生成测试模型'));
    }
    for (const rec of cases) {
      const card = h('div', { class: 'case-card card' },
        h('div', { class: 'case-card-head' },
          h('strong', {}, rec.name),
          h('span', { class: 'case-date muted small' }, formatDate(rec.updatedAt)),
        ),
        h('div', { class: 'case-meta' },
          metaLine('上颌', rec.upperFileName, rec.upperTriangleCount),
          metaLine('下颌', rec.lowerFileName, rec.lowerTriangleCount),
        ),
        h('div', { class: 'case-actions' },
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => navigate(`viewer/${rec.id}`) }, '打开'),
          h('button', { class: 'btn btn-sm', onclick: () => navigate(`occlusion/${rec.id}`) }, '咬合分析'),
          h('button', { class: 'btn btn-sm', onclick: () => navigate(`section/${rec.id}`) }, '剖面测量'),
          h('button', { class: 'btn btn-sm', onclick: () => navigate(`report/${rec.id}`) }, '报告'),
          h('button', { class: 'btn btn-danger btn-sm', onclick: async () => {
            if (!confirm(`确认删除病例「${rec.name}」? 该操作不可恢复, 网格数据将一并删除。`)) return;
            await store.removeCase(rec.id);
            toast('病例已删除', 'success');
            renderList();
          } }, '删除'),
        ),
      );
      listEl.appendChild(card);
    }
    estimateStorage().then((e) => {
      storageEl.textContent = `共 ${e.cases} 个病例, 本地占用 ${formatBytes(e.bytes)}`;
    });
  };
  store.subscribe(renderList);
  renderList();
}

function metaLine(label: string, fileName: string | undefined, tris: number | undefined): HTMLElement {
  return h('div', { class: 'meta-line' },
    h('span', { class: 'meta-tag' }, label),
    fileName
      ? h('span', { class: 'muted small', title: fileName }, `${fileName} · ${tris?.toLocaleString()} 三角面`)
      : h('span', { class: 'muted small' }, '未导入'),
  );
}

function genControls(): HTMLElement {
  const sizeSel = h('select', { class: 'text-input' },
    h('option', { value: '60000' }, '常规 (~6 万面/颌)'),
    h('option', { value: '200000' }, '精细 (~20 万面/颌)'),
    h('option', { value: '500000' }, '压力测试 (50 万面/颌)'),
  ) as HTMLSelectElement;
  const holeChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
  const btn = h('button', { class: 'btn btn-primary' }, '生成并新建病例');
  const status = h('span', { class: 'muted small gen-status' });

  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', 'true');
    const target = parseInt(sizeSel.value, 10);
    const withHoles = holeChk.checked;
    status.textContent = '正在生成网格…';
    const t0 = performance.now();
    try {
      // 让 UI 先刷新
      await new Promise((r) => setTimeout(r, 30));
      const upper = generateDentalArch({ targetTriangles: target, withHoles, jaw: 'upper', seed: 42 });
      const lower = generateDentalArch({ targetTriangles: target, withHoles, jaw: 'lower', seed: 77 });
      const id = await store.createCase(`测试病例-${target / 10000}万面${withHoles ? '-带洞' : ''}`);
      await store.openCase(id);
      status.textContent = '正在写入本地数据库…';
      await store.setJawMesh('upper', upper);
      await store.setJawMesh('lower', lower);
      const ms = Math.round(performance.now() - t0);
      toast(`生成完成: 上下颌各 ${upper.triangleCount.toLocaleString()} 三角面, 耗时 ${ms}ms`, 'success', 5000);
      navigate(`viewer/${id}`);
    } catch (e) {
      toast(`生成失败: ${(e as Error).message}`, 'error');
      status.textContent = '';
      btn.removeAttribute('disabled');
    }
  });

  return h('div', { class: 'gen-controls' },
    h('label', {}, '规模 ', sizeSel),
    h('label', { class: 'chk-label' }, holeChk, ' 带开放洞网格'),
    btn, status,
    h('div', { class: 'gen-downloads' },
      h('button', { class: 'btn btn-sm', onclick: () => {
        const m = generateDentalArch({ targetTriangles: 60000, jaw: 'upper', seed: 42 });
        downloadBlob(meshToBinarySTL(m), 'sample_upper.stl');
        toast('样例 STL 已下载', 'success');
      } }, '下载样例 STL'),
    ),
  );
}

/** 拖拽上传区 (viewer 页复用) */
export function createDropZone(onFile: (file: File, jaw: 'upper' | 'lower') => void, jaw: 'upper' | 'lower'): HTMLElement {
  const zone = h('div', { class: 'drop-zone', tabindex: '0' },
    h('div', { class: 'drop-icon' }, '⬇'),
    h('div', {}, jaw === 'upper' ? '拖入上颌 STL / PLY' : '拖入下颌 STL / PLY'),
    h('div', { class: 'muted small' }, '也可点击选择文件'),
  );
  const input = h('input', { type: 'file', accept: '.stl,.ply', style: 'display:none' }) as HTMLInputElement;
  zone.appendChild(input);
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files?.[0]) onFile(input.files[0], jaw);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (file) onFile(file, jaw);
  });
  return zone;
}

export async function handleMeshFile(file: File, jaw: 'upper' | 'lower'): Promise<boolean> {
  try {
    store.setBusy(true, `正在解析 ${file.name}…`);
    const mesh = await parseMeshFile(file);
    await store.setJawMesh(jaw, mesh);
    toast(`${jaw === 'upper' ? '上颌' : '下颌'}导入成功: ${mesh.vertexCount.toLocaleString()} 顶点 / ${mesh.triangleCount.toLocaleString()} 三角面`, 'success', 4500);
    return true;
  } catch (e) {
    if (e instanceof MeshParseError) {
      toast(`文件无法解析: ${e.message}`, 'error', 6000);
    } else {
      toast(`导入失败: ${(e as Error).message}`, 'error', 6000);
    }
    return false;
  } finally {
    store.setBusy(false);
  }
}
