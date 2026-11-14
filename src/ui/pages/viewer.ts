// 模型查看页: 显隐/透明度/自动对齐/渲染参数
import { h, mount, slider, toast } from '../dom';
import { store } from '../../core/store';
import { Viewport3D } from '../viewport';
import { autoAlign, translateModel } from '../../core/alignment';
import { createDropZone, handleMeshFile } from './cases';
import type { Jaw } from '../../core/types';
import { boundingBox } from '../../core/meshParser';
import { m4 } from '../../core/math';

export function renderViewerPage(root: HTMLElement, caseId: string): void {
  const wrap = h('div', { class: 'page page-3d' });
  const stage = h('div', { class: 'stage' });
  const side = h('aside', { class: 'sidebar' });
  wrap.append(stage, side);
  mount(wrap, root);

  const vp = new Viewport3D(stage);
  if (store.state.activeCaseId !== caseId) {
    store.openCase(caseId).then(() => {
      vp.onStoreChange();
      requestAnimationFrame(() => vp.fitView());
    });
  } else {
    requestAnimationFrame(() => vp.fitView());
  }

  // ---------- 侧栏 ----------
  const infoEl = h('div', { class: 'card' });
  const renderInfo = () => {
    const s = store.state;
    infoEl.innerHTML = '';
    for (const jaw of ['upper', 'lower'] as Jaw[]) {
      const m = s.models.get(jaw);
      infoEl.appendChild(h('div', { class: 'jaw-block' },
        h('div', { class: 'jaw-title' }, jaw === 'upper' ? '上颌' : '下颌'),
        m
          ? h('div', { class: 'muted small' },
              `${m.mesh.sourceName}`,
              h('br'),
              `${m.mesh.vertexCount.toLocaleString()} 顶点 · ${m.mesh.triangleCount.toLocaleString()} 三角面`,
            )
          : h('div', { class: 'muted small' }, '未导入'),
      ));
    }
  };
  store.subscribe(renderInfo);
  renderInfo();

  // 导入区
  const importCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '模型导入'),
    h('div', { class: 'drop-row' },
      createDropZone(handleMeshFile, 'upper'),
      createDropZone(handleMeshFile, 'lower'),
    ),
  );

  // 显隐 / 透明度
  const controlCard = h('div', { class: 'card' });
  const renderControls = () => {
    controlCard.innerHTML = '';
    controlCard.appendChild(h('div', { class: 'card-title' }, '显示控制'));
    for (const jaw of ['upper', 'lower'] as Jaw[]) {
      const m = store.state.models.get(jaw);
      const row = h('div', { class: 'control-row' });
      row.appendChild(h('div', { class: 'control-label' }, jaw === 'upper' ? '上颌' : '下颌'));
      const visBtn = h('button', {
        class: `btn btn-sm ${m?.visible ? 'btn-primary' : ''}`,
        onclick: () => store.updateJaw(jaw, { visible: !(m?.visible ?? true) }),
      }, m?.visible ? '可见' : '隐藏');
      row.appendChild(visBtn);
      const opSlider = slider(m?.opacity ?? 1, 0.1, 1, 0.05, (v) => store.updateJaw(jaw, { opacity: v }));
      row.appendChild(h('div', { class: 'slider-wrap' }, opSlider, h('span', { class: 'muted small' }, `${Math.round((m?.opacity ?? 1) * 100)}%`)));
      controlCard.appendChild(row);
    }
    // 微调
    const nudge = h('div', { class: 'nudge-row' });
    const delta = 0.5;
    for (const [label, d] of [
      ['X+', [delta, 0, 0]], ['X-', [-delta, 0, 0]],
      ['Y+', [0, delta, 0]], ['Y-', [0, -delta, 0]],
      ['Z+', [0, 0, delta]], ['Z-', [0, 0, -delta]],
    ] as [string, [number, number, number]][]) {
      nudge.appendChild(h('button', {
        class: 'btn btn-sm',
        title: '移动下颌 0.5mm',
        onclick: () => {
          const lower = store.state.models.get('lower');
          if (lower) store.setTransform('lower', translateModel(lower.transform, d));
        },
      }, label));
    }
    controlCard.appendChild(h('div', { class: 'control-label', style: 'margin-top:8px' }, '下颌微调 (0.5mm)'));
    controlCard.appendChild(nudge);
  };
  store.subscribe(renderControls);
  renderControls();

  // 对齐
  const alignCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '咬合对齐'),
    h('p', { class: 'muted small' }, 'PCA 主成分定向 + 沿咬合轴平移至首次接触 (保留 0.02mm 微间隙)'),
    h('button', {
      class: 'btn btn-primary btn-block',
      onclick: () => {
        const upper = store.state.models.get('upper');
        const lower = store.state.models.get('lower');
        if (!upper || !lower) {
          toast('需要同时导入上下颌才能自动对齐', 'error');
          return;
        }
        store.setBusy(true, '正在自动对齐…');
        setTimeout(() => {
          try {
            const r = autoAlign(upper, lower);
            store.setTransform('upper', r.upper);
            store.setTransform('lower', r.lower);
            store.clearHeat();
            toast(`对齐完成, 接触间隙 ${r.gap.toFixed(2)}mm`, 'success');
            requestAnimationFrame(() => vp.fitView());
          } catch (e) {
            toast(`对齐失败: ${(e as Error).message}`, 'error');
          } finally {
            store.setBusy(false);
          }
        }, 30);
      },
    }, '自动对齐到咬合位'),
    h('button', {
      class: 'btn btn-block',
      style: 'margin-top:8px',
      onclick: () => {
        for (const jaw of ['upper', 'lower'] as Jaw[]) {
          const m = store.state.models.get(jaw);
          if (m) store.setTransform(jaw, m4.identity());
        }
        store.clearHeat();
        toast('变换已重置', 'info');
      },
    }, '重置变换'),
  );

  // 渲染设置
  const settingsCard = h('div', { class: 'card' });
  const renderSettings = () => {
    settingsCard.innerHTML = '';
    settingsCard.appendChild(h('div', { class: 'card-title' }, '渲染设置'));
    const s = store.state.settings;
    const toggle = (label: string, key: 'ssaoEnabled' | 'edgeEnabled') =>
      h('label', { class: 'chk-row' },
        Object.assign(h('input', { type: 'checkbox' }), { checked: s[key] }) as HTMLInputElement,
        ` ${label}`,
      );
    const ssaoChk = toggle('SSAO 环境光遮蔽', 'ssaoEnabled') as HTMLLabelElement;
    (ssaoChk.querySelector('input')!).addEventListener('change', (e) =>
      store.updateSettings({ ssaoEnabled: (e.target as HTMLInputElement).checked }));
    const edgeChk = toggle('边缘描线', 'edgeEnabled') as HTMLLabelElement;
    (edgeChk.querySelector('input')!).addEventListener('change', (e) =>
      store.updateSettings({ edgeEnabled: (e.target as HTMLInputElement).checked }));
    settingsCard.append(ssaoChk, edgeChk);
    settingsCard.append(
      sliderRow('SSAO 半径', s.ssaoRadius, 0.5, 10, 0.1, (v) => store.updateSettings({ ssaoRadius: v })),
      sliderRow('SSAO 强度', s.ssaoStrength, 0.5, 5, 0.1, (v) => store.updateSettings({ ssaoStrength: v })),
      sliderRow('描线强度', s.edgeStrength, 0.2, 5, 0.1, (v) => store.updateSettings({ edgeStrength: v })),
    );
  };
  store.subscribe(renderSettings);
  renderSettings();

  // 包围盒信息
  const bboxCard = h('div', { class: 'card' });
  const renderBbox = () => {
    bboxCard.innerHTML = '';
    bboxCard.appendChild(h('div', { class: 'card-title' }, '包围盒 (mm)'));
    for (const jaw of ['upper', 'lower'] as Jaw[]) {
      const m = store.state.models.get(jaw);
      if (!m) continue;
      const world = new Float32Array(m.mesh.positions.length);
      for (let i = 0; i < world.length; i += 3) {
        const p = m4.transformPoint(m.transform, [m.mesh.positions[i], m.mesh.positions[i + 1], m.mesh.positions[i + 2]]);
        world[i] = p[0]; world[i + 1] = p[1]; world[i + 2] = p[2];
      }
      const box = boundingBox(world);
      bboxCard.appendChild(h('div', { class: 'muted small bbox-line' },
        `${jaw === 'upper' ? '上颌' : '下颌'}: ${box.size.map((v) => v.toFixed(1)).join(' × ')}`));
    }
  };
  store.subscribe(renderBbox);
  renderBbox();

  side.append(infoEl, importCard, controlCard, alignCard, settingsCard, bboxCard);
}

function sliderRow(label: string, value: number, min: number, max: number, step: number, fn: (v: number) => void): HTMLElement {
  const s = slider(value, min, max, step, fn);
  return h('div', { class: 'slider-row' },
    h('span', { class: 'muted small' }, `${label} ${value.toFixed(1)}`),
    s,
  );
}
