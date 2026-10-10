// Form for the index specification (weights, barriers, dispersal), shared by
// the "Indices" and "Prioritisation" steps. It edits an IndexCfg in place.
import type { IndexOptions } from '../engine/index';
import { connectivity, dispersalExponential, dispersalLeptokurtic, dispersalThreshold } from '../engine/spec';
import type { RcNetwork } from '../engine/types';
import type { IndexCfg } from './ctx';
import { field, h, numberInput, select } from './dom';

export function toOptions(c: IndexCfg): IndexOptions {
  const conn = c.useBarriers || c.type === 'sum' ? connectivity(c.direction, { passConfluence: c.passConfluence }) : null;
  let disp = null;
  if (c.type !== 'sum') {
    const common = { field: c.field, distance: c.distance };
    if (c.kernel === 'exponential') {
      disp = c.kernelDirection === 'symmetric' ? dispersalExponential({ param: c.param, ...common }) : dispersalExponential({ paramU: c.paramU, paramD: c.paramD, ...common });
    } else if (c.kernel === 'threshold') {
      disp = c.kernelDirection === 'symmetric' ? dispersalThreshold({ param: c.param, ...common }) : dispersalThreshold({ paramU: c.paramU, paramD: c.paramD, ...common });
    } else if (c.kernel === 'leptokurtic') {
      disp = dispersalLeptokurtic({ sigmaStat: c.sigmaStat, sigmaMob: c.sigmaMob, p: c.p, ...common });
    }
  }
  return { weight: c.weight, type: c.type, mode: c.mode, connectivity: conn, dispersal: disp };
}

export function describeOptions(c: IndexCfg): string {
  const o = toOptions(c);
  const conn = o.connectivity ? `${o.connectivity.direction} barriers` : 'no barriers';
  const d = o.dispersal ? `${o.dispersal.kernel} dispersal (${o.dispersal.par.join(', ')})` : 'no dispersal';
  return `${c.type}${c.type === 'reach' ? `/${c.mode}` : ''} · ${conn} · ${d} · weight: ${c.weight.join(', ')}`;
}

export interface IndexFormOptions {
  /** Index types offered. */
  types?: IndexCfg['type'][];
  /** Weight columns shown first (the rest go under "More columns"). */
  featured?: string[];
  /** Show the direction of the per-reach sum (used by the map) even for whole-network indices. */
  showMode?: boolean;
}

// columns the pipeline adds that make no sense as weights
const INTERNAL = new Set(['piece', 'f0', 'f1', 'n_reaches', 'chain_length_km', 'length_m', 'length_attr_km', 'fid', 'rc_down']);

export function indexForm(cfg: IndexCfg, net: RcNetwork | undefined, onChange: () => void, o: IndexFormOptions = {}): HTMLElement {
  const root = h('div', { class: 'form' });
  const redraw = () => {
    const f = build();
    root.replaceChildren(...f);
    onChange();
  };
  const num = (key: keyof IndexCfg, label: string, hint?: string, o2: { min?: number; max?: number } = {}) => {
    const inp = numberInput(cfg[key] as number, o2);
    inp.addEventListener('change', () => {
      cfg[key] = Number(inp.value) as never;
      onChange();
    });
    return field(label, inp, hint);
  };

  function build(): HTMLElement[] {
    const out: HTMLElement[] = [];
    // weights
    const numeric = net ? Object.keys(net.nodes).filter((k) => net.nodes[k] instanceof Float64Array && k !== net.id && !INTERNAL.has(k)) : ['length'];
    const featured = numeric.filter((k) => k === 'length' || (o.featured ?? []).includes(k));
    const others = numeric.filter((k) => !featured.includes(k));
    const box = (names: string[]) =>
      h(
        'div',
        { class: 'checks' },
        names.map((w) => {
          const cb = h('input', { type: 'checkbox', checked: cfg.weight.includes(w) });
          cb.addEventListener('change', () => {
            cfg.weight = cb.checked ? [...cfg.weight, w] : cfg.weight.filter((x) => x !== w);
            if (!cfg.weight.length) cfg.weight = ['length'];
            onChange();
          });
          return h('label', { class: 'check' }, cb, ' ', w);
        }),
      );
    const weights = h('div', {}, box(featured), others.length ? h('details', {}, h('summary', {}, `More columns (${others.length})`), box(others)) : null);
    out.push(field('Weights', weights, 'Reach columns weighting the index. Several are computed in a single pass.'));

    out.push(
      field(
        'Index type',
        select(
          (o.types ?? ['full', 'reach', 'sum']).map((t) => [t, { full: 'Whole network (one value per network)', reach: 'Per reach', sum: 'CAFI-like sum over barriers' }[t]!] as [string, string]),
          cfg.type,
          (v) => {
            cfg.type = v as IndexCfg['type'];
            redraw();
          },
        ),
      ),
    );
    if (cfg.type === 'reach' || (o.showMode && cfg.type !== 'sum')) {
      out.push(
        field(
          o.showMode ? 'Reach map shows' : 'Direction of the sum',
          select([['from', 'from: how reachable each reach is (paths arriving at it)'], ['to', 'to: how well each reach reaches the others (paths leaving it)']], cfg.mode, (v) => ((cfg.mode = v as 'to' | 'from'), onChange())),
        ),
      );
    }

    // barriers
    const ub = h('input', { type: 'checkbox', checked: cfg.useBarriers || cfg.type === 'sum', disabled: cfg.type === 'sum' });
    ub.addEventListener('change', () => {
      cfg.useBarriers = ub.checked;
      redraw();
    });
    out.push(field('Barriers', h('label', { class: 'check' }, ub, ' Barriers reduce connectivity (passabilities)')));
    if (cfg.useBarriers || cfg.type === 'sum') {
      out.push(
        field(
          'Passability model',
          select([['symmetric', 'Symmetric: pass_u × pass_d in both directions'], ['asymmetric', 'Asymmetric: pass_d downstream, pass_u upstream']], cfg.direction, (v) => ((cfg.direction = v as IndexCfg['direction']), onChange())),
        ),
      );
      out.push(num('passConfluence', 'Passability at confluences', 'Used where pass_u / pass_d are missing; 1 = fully passable.', { min: 0, max: 1 }));
    }

    // dispersal
    if (cfg.type !== 'sum') {
      out.push(
        field(
          'Dispersal kernel',
          select(
            [['none', 'None (DCI-like)'], ['exponential', 'Exponential (PCI)'], ['threshold', 'Threshold (IIC-like)'], ['leptokurtic', 'Leptokurtic (two Gaussians)']],
            cfg.kernel,
            (v) => {
              cfg.kernel = v as IndexCfg['kernel'];
              redraw();
            },
          ),
        ),
      );
      if (cfg.kernel === 'exponential' || cfg.kernel === 'threshold') {
        out.push(
          field(
            'Kernel parameters',
            select([['symmetric', 'One value'], ['asymmetric', 'Upstream / downstream values']], cfg.kernelDirection, (v) => {
              cfg.kernelDirection = v as IndexCfg['kernelDirection'];
              redraw();
            }),
          ),
        );
        if (cfg.kernelDirection === 'symmetric') {
          out.push(num('param', cfg.kernel === 'exponential' ? 'Base per unit of length (0–1)' : 'Threshold distance', undefined, cfg.kernel === 'exponential' ? { min: 0, max: 1 } : { min: 0 }));
        } else {
          out.push(num('paramU', 'Upstream parameter'), num('paramD', 'Downstream parameter'));
        }
      }
      if (cfg.kernel === 'leptokurtic') {
        out.push(num('sigmaStat', 'σ stationary', undefined, { min: 0 }), num('sigmaMob', 'σ mobile', undefined, { min: 0 }), num('p', 'Proportion stationary (0–1)', undefined, { min: 0, max: 1 }));
      }
      if (cfg.kernel !== 'none') {
        const lens = net ? Object.keys(net.nodes).filter((k) => net.nodes[k] instanceof Float64Array) : ['length'];
        out.push(
          field('Distance field', select(lens, cfg.field, (v) => ((cfg.field = v), onChange())), 'Reach column with the lengths used for distances.'),
          field(
            'Distance convention',
            select([['upstream', 'upstream: every link costs the length of the upstream reach'], ['midpoint', 'midpoint: from the middle of one reach to the middle of the other']], cfg.distance, (v) => ((cfg.distance = v as IndexCfg['distance']), onChange())),
          ),
        );
      }
    }
    return out;
  }
  root.replaceChildren(...build());
  return root;
}
