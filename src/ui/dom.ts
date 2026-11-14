// 极简 DOM 构建辅助, 替代框架

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | EventListener | undefined> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'class') {
      el.className = String(v);
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: HTMLElement, parent: HTMLElement): void {
  clear(parent);
  parent.appendChild(el);
}

export function toast(message: string, kind: 'info' | 'error' | 'success' = 'info', duration = 3200): void {
  const container = ensureToastContainer();
  const item = h('div', { class: `toast toast-${kind}` }, message);
  container.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => {
    item.classList.remove('show');
    setTimeout(() => item.remove(), 250);
  }, duration);
}

function ensureToastContainer(): HTMLElement {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = h('div', { id: 'toast-container', class: 'toast-container' });
    document.body.appendChild(c);
  }
  return c;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 数字输入框 */
export function numberInput(value: number, step: number, min: number, max: number, onChange: (v: number) => void): HTMLElement {
  const input = h('input', {
    type: 'number',
    value: String(value),
    step: String(step),
    min: String(min),
    max: String(max),
    class: 'num-input',
  }) as HTMLInputElement;
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
  });
  return input;
}

/** 滑杆 */
export function slider(value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLInputElement {
  const input = h('input', {
    type: 'range',
    min: String(min), max: String(max), step: String(step),
    value: String(value),
    class: 'slider',
  }) as HTMLInputElement;
  input.addEventListener('input', () => onChange(parseFloat(input.value)));
  return input;
}
