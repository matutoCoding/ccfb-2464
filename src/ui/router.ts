// Hash 路由
export type Route =
  | { page: 'cases' }
  | { page: 'viewer'; id: string }
  | { page: 'occlusion'; id: string }
  | { page: 'section'; id: string }
  | { page: 'report'; id: string };

export function parseHash(): Route {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, id] = hash.split('/');
  if ((page === 'viewer' || page === 'occlusion' || page === 'section' || page === 'report') && id) {
    return { page, id } as Route;
  }
  return { page: 'cases' };
}

export function navigate(route: string): void {
  location.hash = `#/${route}`;
}

export function onRouteChange(fn: (r: Route) => void): () => void {
  const handler = () => fn(parseHash());
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
}
