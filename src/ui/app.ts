// 应用外壳: 侧边导航 + 路由分发
import { h, mount, toast } from './dom';
import { onRouteChange, parseHash, navigate, type Route } from './router';
import { store } from '../core/store';
import { renderCasesPage } from './pages/cases';
import { renderViewerPage } from './pages/viewer';
import { renderOcclusionPage } from './pages/occlusion';
import { renderSectionPage } from './pages/section';
import { renderReportPage } from './pages/report';

const NAV: { route: string; label: string; icon: string; needCase: boolean }[] = [
  { route: 'cases', label: '病例列表', icon: '▦', needCase: false },
  { route: 'viewer', label: '模型查看', icon: '◈', needCase: true },
  { route: 'occlusion', label: '咬合分析', icon: '◉', needCase: true },
  { route: 'section', label: '剖面测量', icon: '✂', needCase: true },
  { route: 'report', label: '报告导出', icon: '▤', needCase: true },
];

export function startApp(): void {
  const root = document.getElementById('app')!;
  const navEl = h('nav', { class: 'side-nav' });
  const content = h('main', { class: 'content' });
  const busyEl = h('div', { class: 'busy-mask', hidden: '' },
    h('div', { class: 'busy-box' },
      h('div', { class: 'spinner' }),
      h('div', { id: 'busy-text', class: 'busy-text' }, '处理中…'),
    ),
  );
  const shell = h('div', { class: 'shell' }, navEl, content, busyEl);
  mount(shell, root);

  store.subscribe((s) => {
    busyEl.hidden = !s.busy;
    const t = busyEl.querySelector('#busy-text');
    if (t) t.textContent = s.busyText || '处理中…';
  });

  const renderNav = (route: Route) => {
    navEl.innerHTML = '';
    navEl.appendChild(h('div', { class: 'brand' },
      h('div', { class: 'brand-mark' }, '🦷'),
      h('div', { class: 'brand-text' }, '咬合分析', h('br'), '工作室'),
    ));
    const activeId = store.state.activeCaseId ?? (route.page !== 'cases' ? route.id : null);
    for (const item of NAV) {
      const page = item.needCase && activeId ? item.route : item.route === 'cases' ? 'cases' : null;
      const href = page === 'cases' ? '#/cases' : page ? `#/${page}/${activeId}` : null;
      const active = route.page === item.route;
      const btn = h('a', {
        class: `nav-item ${active ? 'active' : ''} ${!href ? 'disabled' : ''}`,
        href: href ?? '#',
        onclick: (e: Event) => {
          if (!href) {
            e.preventDefault();
            toast('请先在病例列表打开一个病例', 'info');
          }
        },
      }, h('span', { class: 'nav-icon' }, item.icon), item.label);
      navEl.appendChild(btn);
    }
    if (activeId) {
      const rec = store.state.cases.find((c) => c.id === activeId);
      navEl.appendChild(h('div', { class: 'nav-case muted small' }, '当前病例', h('br'), rec?.name ?? activeId));
    }
  };

  const renderRoute = (route: Route) => {
    if (route.page === 'cases') {
      renderCasesPage(content);
    } else {
      // 保证病例已加载
      const ensure = store.state.activeCaseId === route.id
        ? Promise.resolve()
        : store.openCase(route.id);
      ensure.then(() => {
        switch (route.page) {
          case 'viewer': renderViewerPage(content, route.id); break;
          case 'occlusion': renderOcclusionPage(content, route.id); break;
          case 'section': renderSectionPage(content, route.id); break;
          case 'report': renderReportPage(content, route.id); break;
        }
      }).catch((e) => {
        toast(`打开病例失败: ${(e as Error).message}`, 'error');
        navigate('cases');
      });
    }
    renderNav(route);
  };

  onRouteChange((r) => renderRoute(r));
  store.refreshCases().then(() => {
    renderRoute(parseHash());
  });
}
