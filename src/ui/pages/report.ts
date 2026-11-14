// 报告页: 截图拼版 + 数据汇总 + PDF 导出
import { h, mount, toast, downloadBlob, formatDate } from '../dom';
import { store } from '../../core/store';
import { Viewport3D } from '../viewport';
import { PdfDocument, canvasToJpeg } from '../../core/pdf';
import type { CaseRecord } from '../../core/types';

interface Shot {
  dataUrl: string;
  title: string;
  note: string;
}

export function renderReportPage(root: HTMLElement, caseId: string): void {
  const wrap = h('div', { class: 'page page-report' });
  const stage = h('div', { class: 'stage report-stage' });
  const side = h('aside', { class: 'sidebar' });
  wrap.append(stage, side);
  mount(wrap, root);

  const vp = new Viewport3D(stage);
  if (store.state.activeCaseId !== caseId) {
    store.openCase(caseId).then(() => requestAnimationFrame(() => vp.fitView()));
  } else {
    requestAnimationFrame(() => vp.fitView());
  }

  const shots: Shot[] = [];
  const boardEl = h('div', { class: 'shot-board' });

  const titleInput = h('input', { class: 'text-input', placeholder: '截图标题' }) as HTMLInputElement;
  titleInput.value = '视角截图';

  const captureCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '截图拼版'),
    h('p', { class: 'muted small' }, '旋转到目标视角后截图, 已截图片可在拼版区排序、删除, 导出时自动排版到 A4 PDF。'),
    titleInput,
    h('div', { class: 'btn-row', style: 'margin-top:8px' },
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const dataUrl = await vp.screenshotWithOverlay();
          shots.push({ dataUrl, title: titleInput.value || `截图 ${shots.length + 1}`, note: '' });
          renderBoard();
          toast('已加入拼版', 'success');
        },
      }, '截取当前视角'),
      h('button', {
        class: 'btn btn-sm',
        onclick: async () => {
          // 自动三连: 正面 / 侧面 / 咬合面
          const angles: [string, number, number][] = [
            ['正面视图', Math.PI * 0.5, 0.05],
            ['侧面视图', 0, 0.05],
            ['咬合面视图', Math.PI * 0.25, Math.PI * 0.48],
          ];
          for (const [title, az, el] of angles) {
            vp.camera.targetAzimuth = az;
            vp.camera.targetElevation = el;
            const dataUrl = await vp.screenshotWithOverlay();
            shots.push({ dataUrl, title, note: '' });
          }
          renderBoard();
          toast('已自动截取 3 个标准视角', 'success');
        },
      }, '标准视角三连'),
    ),
  );

  function renderBoard(): void {
    boardEl.innerHTML = '';
    if (!shots.length) {
      boardEl.appendChild(h('div', { class: 'empty-hint' }, '拼版区为空, 先截取视角'));
      return;
    }
    shots.forEach((shot, idx) => {
      const noteInput = h('input', { class: 'text-input shot-note', placeholder: '备注 (可选)' }) as HTMLInputElement;
      noteInput.value = shot.note;
      noteInput.addEventListener('change', () => { shot.note = noteInput.value; });
      const card = h('div', { class: 'shot-card' },
        h('div', { class: 'shot-thumb' }, h('img', { src: shot.dataUrl, alt: shot.title })),
        h('div', { class: 'shot-body' },
          h('strong', {}, `${idx + 1}. ${shot.title}`),
          noteInput,
          h('div', { class: 'btn-row' },
            h('button', {
              class: 'btn btn-sm', disabled: idx === 0 ? 'true' : '',
              onclick: () => { [shots[idx - 1], shots[idx]] = [shots[idx], shots[idx - 1]]; renderBoard(); },
            }, '前移'),
            h('button', {
              class: 'btn btn-sm', disabled: idx === shots.length - 1 ? 'true' : '',
              onclick: () => { [shots[idx + 1], shots[idx]] = [shots[idx], shots[idx + 1]]; renderBoard(); },
            }, '后移'),
            h('button', {
              class: 'btn btn-sm btn-danger',
              onclick: () => { shots.splice(idx, 1); renderBoard(); },
            }, '删除'),
          ),
        ),
      );
      boardEl.appendChild(card);
    });
  }
  renderBoard();

  // ---------- 报告信息 ----------
  const infoCard = h('div', { class: 'card' });
  const renderInfo = () => {
    infoCard.innerHTML = '';
    const rec = store.state.cases.find((c) => c.id === caseId) as CaseRecord | undefined;
    const field = store.state.distanceField;
    const contacts = store.state.contacts;
    infoCard.append(
      h('div', { class: 'card-title' }, '报告数据汇总'),
      h('dl', { class: 'report-dl' },
        dlRow('病例名称', rec?.name ?? caseId),
        dlRow('创建时间', rec ? formatDate(rec.createdAt) : '-'),
        dlRow('上颌文件', rec?.upperFileName ?? '未导入'),
        dlRow('下颌文件', rec?.lowerFileName ?? '未导入'),
        dlRow('色谱状态', field ? `已计算 (${field.elapsedMs.toFixed(0)}ms)` : '未计算'),
        dlRow('间隙 min/mean/max', field ? `${field.min.toFixed(3)} / ${field.mean.toFixed(3)} / ${field.max.toFixed(3)} mm` : '-'),
        dlRow('接触区数量', String(contacts.length)),
        dlRow('接触总面积', `${contacts.reduce((s, c) => s + c.areaMm2, 0).toFixed(2)} mm²`),
        dlRow('剖面标注数', String(store.state.clip.measures.length)),
      ),
    );
  };
  store.subscribe(renderInfo);
  renderInfo();

  // ---------- 导出 ----------
  const exportCard = h('div', { class: 'card' },
    h('div', { class: 'card-title' }, '导出 PDF'),
    h('p', { class: 'muted small' }, 'A4 纵向: 首页封面+汇总, 之后每页 2 张截图及标题备注。中文内容随图片光栅化嵌入, 任意阅读器均可正常显示。'),
    h('button', {
      class: 'btn btn-primary btn-block',
      onclick: async () => {
        if (!shots.length) return toast('请至少截取一张图片', 'error');
        try {
          await exportPdf(caseId, shots);
          toast('PDF 已生成并开始下载', 'success');
        } catch (e) {
          toast(`PDF 生成失败: ${(e as Error).message}`, 'error');
        }
      },
    }, '导出 PDF'),
  );

  side.append(captureCard, infoCard, exportCard);
  wrap.appendChild(h('div', { class: 'board-wrap card' }, h('div', { class: 'card-title' }, '拼版预览'), boardEl));

  const cleanup = () => {
    vp.dispose();
    window.removeEventListener('hashchange', cleanup);
  };
  window.addEventListener('hashchange', cleanup, { once: true });
}

function dlRow(k: string, v: string): HTMLElement {
  return h('div', { class: 'dl-row' }, h('dt', {}, k), h('dd', {}, v));
}

async function exportPdf(caseId: string, shots: Shot[]): Promise<void> {
  const pdf = new PdfDocument();
  const rec = store.state.cases.find((c) => c.id === caseId);
  const field = store.state.distanceField;
  const contacts = store.state.contacts;

  // 封面: 用 canvas 绘制 (保证中文显示)
  const cover = document.createElement('canvas');
  cover.width = 1240; cover.height = 1754; // A4 @150dpi
  const ctx = cover.getContext('2d')!;
  ctx.fillStyle = '#f7f8fa';
  ctx.fillRect(0, 0, cover.width, cover.height);
  ctx.fillStyle = '#1c2430';
  ctx.font = 'bold 56px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillText('口腔咬合分析报告', 90, 150);
  ctx.font = '32px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#44505f';
  const lines = [
    `病例: ${rec?.name ?? caseId}`,
    `生成时间: ${formatDate(Date.now())}`,
    `上颌: ${rec?.upperFileName ?? '未导入'}`,
    `下颌: ${rec?.lowerFileName ?? '未导入'}`,
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, 90, 260 + i * 56));

  ctx.font = 'bold 36px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#1c2430';
  ctx.fillText('分析摘要', 90, 560);
  ctx.font = '28px system-ui, "Microsoft YaHei", sans-serif';
  ctx.fillStyle = '#44505f';
  const summary = field
    ? [
        `间隙距离: 最小 ${field.min.toFixed(3)}mm / 平均 ${field.mean.toFixed(3)}mm / 最大 ${field.max.toFixed(3)}mm`,
        `接触区域: ${contacts.length} 块, 接触总面积 ${contacts.reduce((s, c) => s + c.areaMm2, 0).toFixed(2)}mm²`,
        `色谱范围: 0 - ${store.state.legend.maxRange}mm, 分档 ${store.state.legend.bands} 档`,
        `计算耗时: ${field.elapsedMs.toFixed(0)}ms (Web Worker)`,
      ]
    : ['本次报告未包含间隙色谱计算结果'];
  summary.forEach((ln, i) => ctx.fillText(ln, 90, 630 + i * 50));

  if (contacts.length) {
    ctx.font = 'bold 32px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#1c2430';
    ctx.fillText('接触区明细', 90, 900);
    ctx.font = '26px system-ui, "Microsoft YaHei", sans-serif';
    contacts.slice(0, 12).forEach((c, i) => {
      ctx.fillStyle = '#44505f';
      ctx.fillText(
        `#${c.id}  面积 ${c.areaMm2.toFixed(2)}mm²  采样点 ${c.sampleCount}  均间隙 ${c.avgGap.toFixed(3)}mm`,
        90, 960 + i * 44,
      );
    });
  }
  // 剖面测量
  const measures = store.state.clip.measures;
  if (measures.length) {
    const baseY = 900 + Math.min(12, contacts.length + 1) * 44 + 60;
    ctx.font = 'bold 32px system-ui, "Microsoft YaHei", sans-serif';
    ctx.fillStyle = '#1c2430';
    ctx.fillText('剖面测量', 90, baseY);
    ctx.font = '26px system-ui, "Microsoft YaHei", sans-serif';
    measures.forEach((m, i) => {
      ctx.fillStyle = '#44505f';
      ctx.fillText(`#${m.id} ${m.kind === 'distance' ? '距离' : '角度'}: ${m.label}`, 90, baseY + 60 + i * 44);
    });
  }
  ctx.fillStyle = '#8a94a3';
  ctx.font = '22px system-ui, sans-serif';
  ctx.fillText('Generated by Dental Occlusion Studio (WebGL2 + TypeScript)', 90, 1680);

  pdf.addPage();
  pdf.addImage(0, 0, 595.28, 841.89, canvasToJpeg(cover, 0.9));

  // 内容页: 每页 2 图
  for (let i = 0; i < shots.length; i += 2) {
    pdf.addPage();
    const pair = shots.slice(i, i + 2);
    for (let j = 0; j < pair.length; j++) {
      const shot = pair[j];
      const top = 40 + j * 400;
      pdf.addTextTop(36, top, 14, `${i + j + 1}. ${shot.title}`);
      const jpeg = shot.dataUrl.startsWith('data:image/jpeg') ? shot.dataUrl : await pngToJpegDataUrl(shot.dataUrl);
      pdf.addImage(36, top + 22, 523, 300, jpeg);
      if (shot.note) pdf.addTextTop(36, top + 332, 10, `Note: ${shot.note.slice(0, 90)}`);
    }
  }

  const blob = pdf.build();
  downloadBlob(blob, `occlusion-report-${caseId}.pdf`);
}

/** PNG dataURL -> JPEG dataURL (PDF 写入器只收 JPEG) */
async function pngToJpegDataUrl(pngUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('图像加载失败'));
    im.src = pngUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.width || 1024;
  canvas.height = img.height || 768;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.88);
}
