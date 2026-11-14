// 咬合分析页: Worker 距离色谱 + 图例调节 + 接触点自动标注与面积列表
import { h, mount, slider, toast } from '../dom';
import { store } from '../../core/store';
import { Viewport3D } from '../viewport';
import { DistanceService, clusterContacts } from '../../core/distanceService';
import { autoAlign } from '../../core/alignment';
import { m4 } from '../../core/math';
import type { ContactPoint } from '../../core/types';

export function renderOcclusionPage(root: HTMLElement, caseId: string): void {
  const wrap = h('div', { class: 'page page-3d' });
  const stage = h('div', { class: 'stage' });
  const side = h('aside', { class: 'sidebar' });
  wrap.append(stage, side);
  mount(wrap, root);

  const vp = new Viewport3D(stage);
  vp.showContactMarkers = true;
  const service = new DistanceService();
  if (store.state.activeCaseId !== caseId) {
    store.openCase(caseId).then(() => requestAnimationFrame(() => vp.fitView()));
  } else {
    requestAnimationFrame(() => vp.fitView());
  }

  // ---------- 计算控制 ----------
  const progressEl = h('div', { class: 'progress-bar' }, h('div', { class: 'progress-fill' }));
  const progressText = h('div', { class: 'muted small' });
  const resultEl = h('div', { class: 'card' });
  let lastSamples: Uint32Array | null = null;

  const runCompute = (sampleStep: number) => {
    const upper = store.state.models.get('upper');
    const lower = store.state.models.get('lower');
    if (!upper || !lower) {
      toast('请先在模型查看页导入上下颌', 'error');
      return;
    }
    const btn = document.getElementById('compute-btn') as HTMLButtonElement | null;
    if (btn) btn.setAttribute('disabled', 'true');
    const fill = progressEl.querySelector('.progress-fill') as HTMLElement;
    fill.style.width = '0%';
    progressText.textContent = 'Worker 计算中…';
    const t0 = performance.now();
    service
      .compute(upper, lower, store.state.legend, sampleStep, (p) => {
        fill.style.width = `${(p * 100).toFixed(1)}%`;
      })
      .then(({ field, sampleIndices: si }) => {
        lastSamples = si;
        store.setDistanceResult(field, si);
        if (vp.renderer.getMeshVertexCount('lower') !== null) {
          vp.renderer.updateHeat('lower', lower.mesh.vertexCount, { normalized: field.normalized, sampleIndices: si });
        }

        // 接触点聚类
        const world = new Float32Array(lower.mesh.positions.length);
        for (let i = 0; i < world.length; i += 3) {
          const p = m4.transformPoint(lower.transform, [lower.mesh.positions[i], lower.mesh.positions[i + 1], lower.mesh.positions[i + 2]]);
          world[i] = p[0]; world[i + 1] = p[1]; world[i + 2] = p[2];
        }
        const clusters = clusterContacts(field, si, world, lower.mesh.indices, store.state.legend.contactThreshold);
        const contacts: ContactPoint[] = clusters.map((c, i) => ({
          id: i + 1,
          center: c.center,
          areaMm2: c.areaMm2,
          sampleCount: c.sampleCount,
          avgGap: c.avgGap,
        }));
        store.setContacts(contacts);
        const total = performance.now() - t0;
        progressText.textContent = `完成: ${field.elapsedMs.toFixed(0)}ms (Worker) / 端到端 ${total.toFixed(0)}ms, ${si.length.toLocaleString()} 采样点`;
        fill.style.width = '100%';
        if (total > 3000) toast(`计算耗时 ${total.toFixed(0)}ms, 超过 3 秒目标`, 'error', 5000);
        else toast(`色谱计算完成, 用时 ${total.toFixed(0)}ms`, 'success');
        if (btn) btn.removeAttribute('disabled');
        renderResult();
      })
      .catch((e: Error) => {
        progressText.textContent = `计算失败: ${e.message}`;
        toast(e.message, 'error');
        if (btn) btn.removeAttribute('disabled');
      });
  };

  const computeCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '间隙色谱计算'),
    h('p', { class: 'muted small' }, '在 Web Worker 中构建 Uniform Grid 加速结构, 逐采样点求到上颌三角面的最近距离, 主线程不阻塞。'),
    h('div', { class: 'btn-row' },
      h('button', {
        id: 'compute-btn', class: 'btn btn-primary',
        onclick: () => runCompute(1.2),
      }, '计算色谱 (采样 1.2mm)'),
      h('button', {
        class: 'btn btn-sm',
        onclick: () => runCompute(0),
      }, '全顶点精确计算'),
      h('button', {
        class: 'btn btn-sm',
        onclick: () => {
          store.clearHeat();
          vp.renderer.clearHeat('lower');
          progressText.textContent = '';
          renderResult();
          toast('已清除色谱', 'info');
        },
      }, '清除'),
    ),
    progressEl,
    progressText,
    h('button', {
      class: 'btn btn-sm btn-block',
      style: 'margin-top:8px',
      onclick: () => {
        const upper = store.state.models.get('upper');
        const lower = store.state.models.get('lower');
        if (!upper || !lower) return toast('需要上下颌模型', 'error');
        const r = autoAlign(upper, lower);
        store.setTransform('upper', r.upper);
        store.setTransform('lower', r.lower);
        store.clearHeat();
        vp.renderer.clearHeat('lower');
        toast('已重新对齐, 请重新计算色谱', 'success');
      },
    }, '重新自动对齐'),
  );

  // ---------- 图例调节 ----------
  const legendCard = h('div', { class: 'card' });
  const renderLegend = () => {
    legendCard.innerHTML = '';
    const lg = store.state.legend;
    legendCard.append(
      h('div', { class: 'card-title' }, '图例调节'),
      h('div', { class: 'slider-row' },
        h('span', { class: 'muted small' }, `最大范围 ${lg.maxRange.toFixed(2)} mm`),
        slider(lg.maxRange, 0.5, 5, 0.1, (v) => {
          store.updateLegend({ maxRange: v });
          // 即时重映射: 不重算距离, 只刷新归一化
          remapHeat();
        }),
      ),
      h('div', { class: 'slider-row' },
        h('span', { class: 'muted small' }, `分档数 ${lg.bands}`),
        slider(lg.bands, 4, 16, 1, (v) => {
          store.updateLegend({ bands: Math.round(v) });
          renderResult();
        }),
      ),
      h('div', { class: 'slider-row' },
        h('span', { class: 'muted small' }, `接触阈值 ${lg.contactThreshold.toFixed(2)} mm`),
        slider(lg.contactThreshold, 0.01, 0.3, 0.01, (v) => {
          store.updateLegend({ contactThreshold: v });
          renderResult();
        }),
      ),
      legendGradient(lg),
    );
  };
  store.subscribe(renderLegend);
  renderLegend();

  function remapHeat(): void {
    const field = store.state.distanceField;
    if (!field || !lastSamples) return;
    const normalized = new Float32Array(field.distances.length);
    for (let i = 0; i < normalized.length; i++) {
      normalized[i] = Math.min(1, field.distances[i] / store.state.legend.maxRange);
    }
    field.normalized = normalized;
    const lower = store.state.models.get('lower');
    if (lower) {
      vp.renderer.updateHeat('lower', lower.mesh.vertexCount, { normalized, sampleIndices: lastSamples });
    }
  }

  // ---------- 结果统计 + 接触点 ----------
  const renderResult = () => {
    resultEl.innerHTML = '';
    const field = store.state.distanceField;
    if (!field) {
      resultEl.appendChild(h('div', { class: 'card-title' }, '分析结果'));
      resultEl.appendChild(h('div', { class: 'muted small' }, '尚未计算'));
      return;
    }
    const lg = store.state.legend;
    resultEl.appendChild(h('div', { class: 'card-title' }, '分析结果'));
    const stat = h('div', { class: 'stat-grid' },
      statBox('最小间隙', `${field.min.toFixed(3)}`, 'mm'),
      statBox('平均间隙', `${field.mean.toFixed(3)}`, 'mm'),
      statBox('最大间隙', `${field.max.toFixed(3)}`, 'mm'),
      statBox('接触区数', `${store.state.contacts.length}`, '块'),
    );
    resultEl.appendChild(stat);

    // 直方图
    const histCard = h('div', { class: 'histogram' });
    const maxCount = Math.max(1, ...field.histogram);
    field.histogram.forEach((count, i) => {
      const lo = (i / lg.bands) * lg.maxRange;
      const hi = ((i + 1) / lg.bands) * lg.maxRange;
      const colors = ['#1e46c8', '#00a7dc', '#189b50', '#7fc23a', '#f0d228', '#f59a23', '#e85d2a', '#e12d28'];
      const color = colors[Math.min(colors.length - 1, Math.floor((i / lg.bands) * colors.length))];
      histCard.appendChild(h('div', { class: 'hist-col', title: `${lo.toFixed(2)}-${hi.toFixed(2)}mm: ${count} 点` },
        h('div', { class: 'hist-bar', style: `height:${(count / maxCount) * 100}%;background:${color}` }),
        h('span', { class: 'muted small' }, hi.toFixed(1)),
      ));
    });
    resultEl.appendChild(histCard);

    // 接触点表
    const contacts = store.state.contacts;
    resultEl.appendChild(h('div', { class: 'card-title', style: 'margin-top:12px' }, `接触点列表 (阈值 ${lg.contactThreshold.toFixed(2)}mm)`));
    if (!contacts.length) {
      resultEl.appendChild(h('div', { class: 'muted small' }, '未发现接触区, 可尝试调大接触阈值或重新对齐'));
    } else {
      const table = h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, '面积 mm²'), h('th', {}, '采样点'), h('th', {}, '均间隙 mm'),
        )),
        h('tbody', {},
          ...contacts.map((c) => h('tr', {},
            h('td', {}, String(c.id)),
            h('td', {}, c.areaMm2.toFixed(2)),
            h('td', {}, String(c.sampleCount)),
            h('td', {}, c.avgGap.toFixed(3)),
          )),
        ),
      );
      resultEl.appendChild(table);
      const totalArea = contacts.reduce((s, c) => s + c.areaMm2, 0);
      resultEl.appendChild(h('div', { class: 'muted small', style: 'margin-top:6px' },
        `接触总面积 ${totalArea.toFixed(2)} mm²`));
    }
  };
  store.subscribe(renderResult);
  renderResult();

  side.append(computeCard, legendCard, resultEl);

  // 页面销毁清理
  const cleanup = () => {
    service.dispose();
    vp.dispose();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });
}

function statBox(label: string, value: string, unit: string): HTMLElement {
  return h('div', { class: 'stat-box' },
    h('div', { class: 'stat-value' }, value, h('span', { class: 'stat-unit' }, ` ${unit}`)),
    h('div', { class: 'muted small' }, label),
  );
}

function legendGradient(lg: { maxRange: number; bands: number }): HTMLElement {
  const colors = ['#1e46c8', '#00a7dc', '#189b50', '#7fc23a', '#f0d228', '#f59a23', '#e85d2a', '#e12d28'];
  const steps: string[] = [];
  for (let i = 0; i < lg.bands; i++) {
    const c = colors[Math.min(colors.length - 1, Math.floor((i / lg.bands) * colors.length))];
    steps.push(`${c} ${(i / lg.bands) * 100}%, ${c} ${((i + 1) / lg.bands) * 100}%`);
  }
  return h('div', { class: 'legend-wrap' },
    h('div', { class: 'legend-gradient', style: `background: linear-gradient(90deg, ${steps.join(',')})` }),
    h('div', { class: 'legend-labels muted small' },
      h('span', {}, '0'),
      h('span', {}, `${lg.maxRange / 2}mm`),
      h('span', {}, `≥${lg.maxRange}mm`),
    ),
  );
}
