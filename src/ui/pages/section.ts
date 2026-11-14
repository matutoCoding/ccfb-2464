// 剖面测量页: 任意平面剖切 + 剖面填色 + 平面拖拽 + 距离/角度测量 (标注跟随模型)
import { h, mount, slider, toast } from '../dom';
import { store } from '../../core/store';
import { Viewport3D } from '../viewport';
import { worldToLocal } from '../../core/section';
import { m4, v3, type Vec3 } from '../../core/math';
import type { SectionMeasure } from '../../core/types';

type MeasureMode = 'none' | 'distance' | 'angle';

export function renderSectionPage(root: HTMLElement, caseId: string): void {
  const wrap = h('div', { class: 'page page-3d' });
  const stage = h('div', { class: 'stage' });
  const side = h('aside', { class: 'sidebar' });
  wrap.append(stage, side);
  mount(wrap, root);

  const vp = new Viewport3D(stage);
  if (store.state.activeCaseId !== caseId) {
    store.openCase(caseId).then(() => requestAnimationFrame(() => vp.fitView()));
  } else {
    requestAnimationFrame(() => vp.fitView());
  }

  let mode: MeasureMode = 'none';
  let picked: [number, number][] = []; // 平面局部 2D 点

  // ---------- 平面控制 ----------
  const planeCard = h('div', { class: 'card' });
  const renderPlane = () => {
    planeCard.innerHTML = '';
    const clip = store.state.clip;
    const enableChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    enableChk.checked = clip.enabled;
    enableChk.addEventListener('change', () => {
      store.updateClip({ enabled: enableChk.checked });
      if (enableChk.checked) initDefaultPlane();
      vp.markSectionDirty();
    });
    planeCard.append(
      h('div', { class: 'card-title' }, '剖切平面'),
      h('label', { class: 'chk-row' }, enableChk, ' 启用剖切'),
    );
    if (!clip.enabled) return;

    const fillChk = h('input', { type: 'checkbox' }) as HTMLInputElement;
    fillChk.checked = clip.fillCap;
    fillChk.addEventListener('change', () => {
      store.updateClip({ fillCap: fillChk.checked });
      vp.markSectionDirty();
    });
    planeCard.appendChild(h('label', { class: 'chk-row' }, fillChk, ' 剖面填色'));

    // 法线方向预设
    const preset = (label: string, n: Vec3) =>
      h('button', {
        class: 'btn btn-sm',
        onclick: () => {
          store.updateClip({ normal: n });
          vp.markSectionDirty();
        },
      }, label);
    planeCard.append(
      h('div', { class: 'control-label', style: 'margin-top:8px' }, '平面朝向'),
      h('div', { class: 'btn-row' },
        preset('水平面', [0, 1, 0]),
        preset('冠状面', [0, 0, 1]),
        preset('矢状面', [1, 0, 0]),
      ),
    );

    // 法线分量微调
    const nrm = v3.norm(clip.normal);
    const axisRow = (axis: 0 | 1 | 2, name: string) =>
      h('div', { class: 'slider-row' },
        h('span', { class: 'muted small' }, `${name} ${nrm[axis].toFixed(2)}`),
        slider(nrm[axis], -1, 1, 0.05, (v) => {
          const cur = v3.norm(clip.normal);
          cur[axis] = v;
          const nn = v3.norm(cur);
          store.updateClip({ normal: nn });
          vp.markSectionDirty();
        }),
      );
    planeCard.append(axisRow(0, 'nx'), axisRow(1, 'ny'), axisRow(2, 'nz'));

    // 沿法线平移
    const offset = v3.dot(clip.point, clip.normal);
    planeCard.append(
      h('div', { class: 'slider-row' },
        h('span', { class: 'muted small' }, `平面位置 ${offset.toFixed(1)}mm`),
        slider(offset, -80, 80, 0.5, (v) => {
          const newPoint = v3.scale(clip.normal, v);
          store.updateClip({ point: newPoint });
          vp.markSectionDirty();
        }),
      ),
      h('p', { class: 'muted small hint' }, '提示: Shift + 鼠标左键在视口中直接拖动平面'),
    );
  };
  store.subscribe(renderPlane);
  renderPlane();

  function initDefaultPlane(): void {
    const clip = store.state.clip;
    // 默认水平面, 穿过两颌中点
    let cy = 0;
    const pts: number[] = [];
    for (const m of store.state.models.values()) {
      for (let i = 0; i < m.mesh.positions.length; i += 3) {
        const p = m4.transformPoint(m.transform, [m.mesh.positions[i], m.mesh.positions[i + 1], m.mesh.positions[i + 2]]);
        pts.push(p[1]);
      }
    }
    if (pts.length) cy = pts.reduce((a, b) => a + b, 0) / pts.length;
    store.updateClip({
      point: [clip.point[0], cy, clip.point[2]],
      normal: [0, 1, 0],
    });
  }

  // ---------- 测量 ----------
  const measureCard = h('div', { class: 'card' });
  const modeHint = h('div', { class: 'muted small' }, '选择工具后, 在剖切平面上点击取点');

  const renderMeasures = () => {
    measureCard.innerHTML = '';
    measureCard.appendChild(h('div', { class: 'card-title' }, '剖面测量'));
    const btn = (label: string, m: MeasureMode) =>
      h('button', {
        class: `btn btn-sm ${mode === m ? 'btn-primary' : ''}`,
        onclick: () => {
          mode = mode === m ? 'none' : m;
          picked = [];
          modeHint.textContent = mode === 'none'
            ? '选择工具后, 在剖切平面上点击取点'
            : mode === 'distance' ? '距离测量: 点击 2 个点' : '角度测量: 依次点击 3 个点 (顶点-交点-顶点)';
          renderMeasures();
        },
      }, label);
    measureCard.append(
      h('div', { class: 'btn-row' }, btn('距离测量', 'distance'), btn('角度测量', 'angle')),
      modeHint,
    );
    const clip = store.state.clip;
    if (clip.measures.length) {
      const table = h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '类型'), h('th', {}, '测量值'), h('th', {}, ''))),
        h('tbody', {},
          ...clip.measures.map((mm, idx) => h('tr', {},
            h('td', {}, String(mm.id)),
            h('td', {}, mm.kind === 'distance' ? '距离' : '角度'),
            h('td', {}, mm.label),
            h('td', {}, h('button', {
              class: 'btn btn-sm btn-danger',
              onclick: () => {
                store.updateClip({ measures: clip.measures.filter((x) => x.id !== mm.id) });
                renderMeasures();
              },
            }, '删')),
          )),
        ),
      );
      measureCard.appendChild(table);
      measureCard.appendChild(h('button', {
        class: 'btn btn-sm btn-block',
        style: 'margin-top:8px',
        onclick: () => {
          store.updateClip({ measures: [] });
          renderMeasures();
        },
      }, '清空全部标注'));
    }
  };
  renderMeasures();
  // 外部 (如 store 注入/页面恢复) 修改测量数据时同步表格
  store.subscribe((s) => {
    if (measureCard.dataset.measureSig !== JSON.stringify(s.clip.measures)) {
      measureCard.dataset.measureSig = JSON.stringify(s.clip.measures);
      renderMeasures();
    }
  });

  // 视口点击 -> 平面取点 (测量模式; 非测量模式不拦截相机)
  vp.canvas.addEventListener('pointerdown', (e) => {
    if (mode === 'none' || !store.state.clip.enabled || e.button !== 0 || e.shiftKey) return;
    // 等相机的 pointerdown 处理之后再判断, 用 setTimeout 错开
    setTimeout(() => {
      const hit = vp.pickPlane(e);
      if (!hit) return;
      const clip = store.state.clip;
      const ref: Vec3 = Math.abs(clip.normal[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      const u = v3.norm(v3.cross(ref, clip.normal));
      const v = v3.norm(v3.cross(clip.normal, u));
      const p2 = worldToLocal({ point: clip.point, normal: clip.normal }, u, v, hit);
      picked.push(p2);
      const need = mode === 'distance' ? 2 : 3;
      modeHint.textContent = `已取 ${picked.length}/${need} 点`;
      if (picked.length < need) return;

      const nextId = (clip.measures.reduce((mx, x) => Math.max(mx, x.id), 0) || 0) + 1;
      let measure: SectionMeasure;
      if (mode === 'distance') {
        const d = Math.hypot(picked[1][0] - picked[0][0], picked[1][1] - picked[0][1]);
        measure = {
          id: nextId, kind: 'distance', points: [picked[0], picked[1]],
          value: d, unit: 'mm', label: `${d.toFixed(2)} mm`,
        };
      } else {
        const a = v3.norm([picked[0][0] - picked[1][0], picked[0][1] - picked[1][1], 0]);
        const b = v3.norm([picked[2][0] - picked[1][0], picked[2][1] - picked[1][1], 0]);
        const cos = Math.min(1, Math.max(-1, v3.dot(a, b)));
        const ang = (Math.acos(cos) * 180) / Math.PI;
        measure = {
          id: nextId, kind: 'angle', points: [picked[0], picked[1], picked[2]],
          value: ang, unit: '°', label: `${ang.toFixed(1)}°`,
        };
      }
      // 标注存的是平面局部坐标, 模型/平面移动时自动跟随重投影
      store.updateClip({ measures: [...clip.measures, measure] });
      picked = [];
      modeHint.textContent = '继续取点, 或切换工具';
      toast(`已记录: ${measure.label}`, 'success');
      renderMeasures();
    }, 0);
  });

  // 平面变化后标注依然有效 (局部坐标自动跟随), 仅刷新提示
  vp.hooks.onSectionPlaneChanged = () => {
    modeHint.textContent = '平面已移动, 既有标注按局部坐标自动跟随';
  };

  side.append(planeCard, measureCard);

  const cleanup = () => {
    vp.dispose();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });
}
