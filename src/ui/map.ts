// MapLibre GL wrapper: no basemap (the app works offline); layers are GeoJSON
// sources styled by a fixed colour or by a numeric property. Tooltips are small
// cards: they follow the pointer on hover and pin on click; they never outlive
// the layer they describe.
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { h, fmt } from './dom';

export const VIRIDIS = ['#440154', '#414487', '#2a788e', '#22a884', '#7ad151', '#fde725'];

export interface ColorBy {
  prop: string;
  min: number;
  max: number;
  /** Colour ramp, low to high. */
  ramp?: string[];
  label?: string;
}

export interface LayerStyle {
  color?: string;
  colorBy?: ColorBy;
  width?: number;
  radius?: number;
  /** Radius scaled by a numeric property: [prop, min, max, rMin, rMax]. */
  radiusBy?: [string, number, number, number, number];
  opacity?: number;
  /** Categorical colours for a string property. */
  categories?: { prop: string; colors: Record<string, string>; fallback?: string };
}

/** What a tooltip shows: a title and a few label / value rows. */
export interface Tip {
  title: string;
  rows: [string, string][];
}
export type TipFn = (props: Record<string, any>) => Tip;

function colorExpr(c: ColorBy): maplibregl.ExpressionSpecification {
  const ramp = c.ramp ?? VIRIDIS;
  if (!(c.max > c.min)) return ramp[ramp.length - 1] as any;
  const stops: (number | string)[] = [];
  ramp.forEach((col, i) => stops.push(c.min + ((c.max - c.min) * i) / (ramp.length - 1), col));
  return ['interpolate', ['linear'], ['to-number', ['get', c.prop], c.min], ...stops] as any;
}

function tipEl(t: Tip): HTMLElement {
  return h(
    'div',
    { class: 'rc-tip-body' },
    h('div', { class: 'rc-tip-title' }, t.title),
    t.rows.length
      ? h('dl', {}, t.rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
      : null,
  );
}

interface Handlers {
  click: (e: any) => void;
  move: (e: any) => void;
  leave: () => void;
}

export class MapView {
  readonly map: maplibregl.Map;
  private legend: HTMLElement;
  private ready: Promise<void>;
  private kinds = new Map<string, 'line' | 'point'>();
  private handlers = new Map<string, Handlers>();
  private hover: maplibregl.Popup | null = null;
  private pinned: maplibregl.Popup | null = null;

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#eef2f5' } }],
      },
      center: [0, 20],
      zoom: 1.5,
      attributionControl: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.legend = h('div', { class: 'legend', hidden: true });
    container.append(this.legend);
    this.ready = new Promise((res) => this.map.once('load', () => res()));
  }

  /** Layers with a live tooltip (for tests: it must not grow when steps are revisited). */
  get tooltipCount(): number {
    return this.handlers.size;
  }

  async whenReady(): Promise<void> {
    await this.ready;
  }

  private closePopups(): void {
    this.hover?.remove();
    this.pinned?.remove();
    this.hover = this.pinned = null;
  }

  private bindTooltip(id: string, tip: TipFn): void {
    this.unbind(id);
    const m = this.map;
    const handlers: Handlers = {
      move: (e) => {
        const f = e.features?.[0];
        if (!f) return;
        m.getCanvas().style.cursor = 'pointer';
        if (!this.hover) {
          this.hover = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: 'rc-tip', offset: 10, maxWidth: '240px' });
        }
        this.hover.setLngLat(e.lngLat).setDOMContent(tipEl(tip(f.properties ?? {}))).addTo(m);
      },
      leave: () => {
        m.getCanvas().style.cursor = '';
        this.hover?.remove();
        this.hover = null;
      },
      click: (e) => {
        const f = e.features?.[0];
        if (!f) return;
        this.pinned?.remove();
        this.pinned = new maplibregl.Popup({ closeButton: true, closeOnClick: true, className: 'rc-tip pinned', offset: 10, maxWidth: '260px' })
          .setLngLat(e.lngLat)
          .setDOMContent(tipEl(tip(f.properties ?? {})))
          .addTo(m);
        this.hover?.remove();
        this.hover = null;
      },
    };
    m.on('mousemove', id, handlers.move);
    m.on('mouseleave', id, handlers.leave);
    m.on('click', id, handlers.click);
    this.handlers.set(id, handlers);
  }

  private unbind(id: string): void {
    const hd = this.handlers.get(id);
    if (!hd) return;
    this.map.off('mousemove', id, hd.move);
    this.map.off('mouseleave', id, hd.leave);
    this.map.off('click', id, hd.click);
    this.handlers.delete(id);
  }

  async setData(
    id: string,
    kind: 'line' | 'point',
    data: GeoJSON.FeatureCollection,
    style: LayerStyle = {},
    tooltip?: TipFn,
  ): Promise<void> {
    await this.ready;
    const src = this.map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else this.map.addSource(id, { type: 'geojson', data });
    this.unbind(id);
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    const color: any = style.categories
      ? ['match', ['get', style.categories.prop], ...Object.entries(style.categories.colors).flat(), style.categories.fallback ?? '#888']
      : style.colorBy
        ? colorExpr(style.colorBy)
        : (style.color ?? '#2a788e');
    if (kind === 'line') {
      this.map.addLayer({
        id,
        type: 'line',
        source: id,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': color, 'line-width': style.width ?? 1.2, 'line-opacity': style.opacity ?? 0.95 },
      });
    } else {
      const r: any = style.radiusBy
        ? ['interpolate', ['linear'], ['to-number', ['get', style.radiusBy[0]], style.radiusBy[1]], style.radiusBy[1], style.radiusBy[3], Math.max(style.radiusBy[2], style.radiusBy[1] + 1e-12), style.radiusBy[4]]
        : (style.radius ?? 4);
      this.map.addLayer({
        id,
        type: 'circle',
        source: id,
        paint: {
          'circle-color': color,
          'circle-radius': r,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-opacity': style.opacity ?? 0.95,
        },
      });
    }
    this.kinds.set(id, kind);
    if (tooltip) this.bindTooltip(id, tooltip);
  }

  async remove(id: string): Promise<void> {
    await this.ready;
    this.unbind(id);
    if (this.map.getLayer(id)) this.map.removeLayer(id);
    if (this.map.getSource(id)) this.map.removeSource(id);
    this.kinds.delete(id);
    this.closePopups();
  }

  /** Removes every data layer (and any open tooltip), except the listed ones. */
  async clear(except: string[] = []): Promise<void> {
    await this.ready;
    this.closePopups();
    for (const id of [...this.kinds.keys()]) if (!except.includes(id)) await this.remove(id);
  }

  /** Dims every layer but the listed ones (null restores them). */
  emphasize(ids: string[] | null): void {
    for (const [id, kind] of this.kinds) {
      if (!this.map.getLayer(id)) continue;
      const on = ids === null || ids.includes(id);
      this.map.setPaintProperty(id, kind === 'line' ? 'line-opacity' : 'circle-opacity', on ? 0.95 : 0.12);
      if (kind === 'point') this.map.setPaintProperty(id, 'circle-stroke-opacity', on ? 1 : 0.1);
    }
  }

  async fitTo(data: GeoJSON.FeatureCollection, padding = 40): Promise<void> {
    await this.ready;
    const b = new maplibregl.LngLatBounds();
    const add = (c: any) => {
      if (typeof c[0] === 'number') b.extend(c as [number, number]);
      else for (const x of c) add(x);
    };
    for (const f of data.features) add((f.geometry as any).coordinates);
    if (!b.isEmpty()) this.map.fitBounds(b, { padding, duration: 0, maxZoom: 14 });
  }

  /** Colour legend for a continuous scale (null hides it). */
  setLegend(c: ColorBy | null): void {
    this.legend.replaceChildren();
    if (!c) {
      this.legend.hidden = true;
      return;
    }
    const ramp = c.ramp ?? VIRIDIS;
    this.legend.hidden = false;
    this.legend.append(
      h('div', { class: 'legend-title' }, c.label ?? c.prop),
      h('div', { class: 'legend-bar', style: { background: `linear-gradient(to right, ${ramp.join(',')})` } }),
      h('div', { class: 'legend-range' }, h('span', {}, fmt(c.min, 4)), h('span', {}, fmt(c.max, 4))),
    );
  }

  resize(): void {
    this.map.resize();
  }
}
