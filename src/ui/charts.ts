// Small inline charts (SVG / CSS, no library) for the results screens.
import { h, fmt } from './dom';
import { VIRIDIS } from './map';

/** Colour of a ramp at t in [0, 1] (linear between the stops). */
export function rampColor(t: number, ramp: string[] = VIRIDIS): string {
  const x = Math.min(1, Math.max(0, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = ramp[i];
  const b = ramp[i + 1];
  const c = (s: string, k: number) => parseInt(s.slice(1 + 2 * k, 3 + 2 * k), 16);
  const mix = (k: number) => Math.round(c(a, k) + (c(b, k) - c(a, k)) * f);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

export interface Summary {
  n: number;
  min: number;
  max: number;
  median: number;
}

export function summarize(values: ArrayLike<number>): Summary {
  const v = Array.from(values).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: 0, max: 1, median: 0 };
  const mid = v.length >> 1;
  return { n: v.length, min: v[0], max: v[v.length - 1], median: v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2 };
}

/** Share of values strictly below `x`, in [0, 1] (sorted must be ascending). */
export function percentileOf(sorted: Float64Array, x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] < x) lo = m + 1;
    else hi = m;
  }
  return sorted.length ? lo / sorted.length : 0;
}

/** Histogram bars coloured with the same ramp as the map. `scale` converts values for the axis labels. */
export function histogram(values: ArrayLike<number>, o: { bins?: number; scale?: number; unit?: string; width?: number; height?: number } = {}): SVGElement {
  const bins = o.bins ?? 24;
  const W = o.width ?? 360;
  const H = o.height ?? 90;
  const scale = o.scale ?? 1;
  const s = summarize(values);
  const counts = new Array<number>(bins).fill(0);
  const span = s.max - s.min || 1;
  for (const x of Array.from(values)) {
    if (!Number.isFinite(x)) continue;
    counts[Math.min(bins - 1, Math.floor(((x - s.min) / span) * bins))]++;
  }
  const top = Math.max(1, ...counts);
  const bw = W / bins;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 18}`);
  svg.setAttribute('class', 'histogram');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Distribution of ${s.n} reaches from ${fmt(s.min * scale, 3)} to ${fmt(s.max * scale, 3)}`);
  counts.forEach((c, i) => {
    const r = document.createElementNS(ns, 'rect');
    const bh = (c / top) * H;
    r.setAttribute('x', String(i * bw + 0.5));
    r.setAttribute('y', String(H - bh));
    r.setAttribute('width', String(Math.max(1, bw - 1)));
    r.setAttribute('height', String(bh));
    r.setAttribute('fill', rampColor((i + 0.5) / bins));
    const t = document.createElementNS(ns, 'title');
    t.textContent = `${c} reaches between ${fmt((s.min + (span * i) / bins) * scale, 3)} and ${fmt((s.min + (span * (i + 1)) / bins) * scale, 3)}${o.unit ?? ''}`;
    r.append(t);
    svg.append(r);
  });
  const label = (x: number, anchor: string, text: string) => {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(H + 13));
    t.setAttribute('text-anchor', anchor);
    t.setAttribute('class', 'axis');
    t.textContent = text;
    svg.append(t);
  };
  label(0, 'start', `${fmt(s.min * scale, 3)}${o.unit ?? ''}`);
  label(W / 2, 'middle', `median ${fmt(s.median * scale, 3)}${o.unit ?? ''}`);
  label(W, 'end', `${fmt(s.max * scale, 3)}${o.unit ?? ''}`);
  return svg;
}

/** Horizontal bars: label, bar proportional to value, value text. */
export function hbars(items: { label: string; value: number; text: string; title?: string }[], o: { max?: number; color?: string } = {}): HTMLElement {
  const max = o.max ?? Math.max(1e-12, ...items.map((i) => i.value));
  return h(
    'div',
    { class: 'hbars' },
    items.map((it) =>
      h(
        'div',
        { class: 'hbar', title: it.title },
        h('span', { class: 'hbar-label' }, it.label),
        h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill', style: { width: `${Math.max(0.5, (it.value / max) * 100)}%`, background: o.color ?? 'var(--accent)' } })),
        h('span', { class: 'hbar-value' }, it.text),
      ),
    ),
  );
}
