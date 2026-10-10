// Tiny DOM helpers (no framework).
import type { Table } from '../engine/types';

type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, any> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function fmt(x: unknown, digits = 6): string {
  if (x === null || x === undefined) return '';
  if (typeof x === 'number') {
    if (Number.isNaN(x)) return 'NA';
    if (Number.isInteger(x)) return String(x);
    const a = Math.abs(x);
    return a !== 0 && (a < 1e-3 || a >= 1e7) ? x.toExponential(digits - 1) : Number(x.toPrecision(digits)).toString();
  }
  return String(x);
}

export interface TableOptions {
  limit?: number;
  digits?: number;
  /** Optional per-cell class (for example a severity colour). */
  cellClass?: (col: string, value: unknown, row: number) => string | undefined;
  onRowClick?: (row: number) => void;
  /** Do not print the "Showing N of M rows" note. */
  quiet?: boolean;
}

/** Renders rows of a columnar table (first `limit` rows). */
export function tableEl(t: Table, columns: string[], o: TableOptions = {}): HTMLElement {
  const n = columns.length ? t[columns[0]].length : 0;
  const limit = Math.min(n, o.limit ?? 200);
  const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c))));
  const tbody = h('tbody');
  for (let i = 0; i < limit; i++) {
    tbody.append(
      h(
        'tr',
        { onClick: o.onRowClick ? () => o.onRowClick!(i) : undefined, class: o.onRowClick ? 'clickable' : '' },
        columns.map((c) => {
          const v = (t[c] as any)[i];
          return h('td', { class: [typeof v === 'number' ? 'num' : '', o.cellClass?.(c, v, i) ?? ''].join(' ').trim() }, fmt(v, o.digits));
        }),
      ),
    );
  }
  const wrap = h('div', { class: 'table-wrap' }, h('table', {}, thead, tbody));
  if (n > limit && !o.quiet) wrap.append(h('p', { class: 'muted' }, `Showing ${limit} of ${n} rows. Export the CSV for all of them.`));
  return wrap;
}

export function toCsv(t: Table, columns = Object.keys(t)): string {
  const n = columns.length ? t[columns[0]].length : 0;
  const esc = (v: unknown) => {
    if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
    const s = typeof v === 'number' ? String(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (let i = 0; i < n; i++) lines.push(columns.map((c) => esc((t[c] as any)[i])).join(','));
  return lines.join('\n') + '\n';
}

export function download(filename: string, text: string, mime = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A labelled form row. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'label' }, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

export function option(value: string, text = value): HTMLOptionElement {
  return h('option', { value }, text);
}

export function select(values: [string, string][] | string[], selected?: string, onChange?: (v: string) => void): HTMLSelectElement {
  const el = h('select', {}, values.map((v) => (Array.isArray(v) ? option(v[0], v[1]) : option(v))));
  if (selected !== undefined) el.value = selected;
  if (onChange) el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function numberInput(value: number, o: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  return h('input', { type: 'number', value: String(value), min: o.min, max: o.max, step: o.step ?? 'any' });
}
