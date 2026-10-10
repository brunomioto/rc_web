// Port of rc2/R/spec.R: connectivity and dispersal specifications.

export type Direction = 'symmetric' | 'asymmetric';
export type DistanceConvention = 'upstream' | 'midpoint';

export interface Connectivity {
  direction: Direction;
  passU: string;
  passD: string;
  passConfluence: number;
}

export interface Dispersal {
  kernel: 'exponential' | 'threshold' | 'leptokurtic';
  direction: Direction;
  /** symmetric: [param]; asymmetric: [param_u, param_d]; leptokurtic: [sigma_stat, sigma_mob, p]. */
  par: number[];
  field: string;
  distance: DistanceConvention;
}

function checkProb(x: number | number[], arg: string): void {
  for (const v of Array.isArray(x) ? x : [x]) {
    if (!Number.isNaN(v) && (v < 0 || v > 1)) throw new Error(`${arg} must be within [0, 1].`);
  }
}

export function connectivity(
  direction: Direction = 'symmetric',
  o: { passU?: string; passD?: string; passConfluence?: number } = {},
): Connectivity {
  const passConfluence = o.passConfluence ?? 1;
  checkProb(passConfluence, 'pass_confluence');
  return { direction, passU: o.passU ?? 'pass_u', passD: o.passD ?? 'pass_d', passConfluence };
}

interface Common {
  field?: string;
  distance?: DistanceConvention;
}

function newDispersal(
  kernel: 'exponential' | 'threshold',
  p: { param?: number; paramU?: number; paramD?: number } & Common,
): Dispersal {
  const field = p.field ?? 'length';
  const distance = p.distance ?? 'upstream';
  let direction: Direction;
  let par: number[];
  if (p.param !== undefined && p.param !== null) {
    if (p.paramU != null || p.paramD != null) throw new Error('Use either param or param_u/param_d, not both.');
    direction = 'symmetric';
    par = [p.param];
  } else {
    if (p.paramU == null || p.paramD == null) throw new Error('Supply param, or both param_u and param_d.');
    direction = 'asymmetric';
    par = [p.paramU, p.paramD];
  }
  if (par.some((x) => typeof x !== 'number' || Number.isNaN(x))) throw new Error('Kernel parameters must be single numbers.');
  if (kernel === 'exponential') checkProb(par, 'param');
  if (kernel === 'threshold' && par.some((x) => x < 0)) throw new Error('Threshold distances must be non-negative.');
  return { kernel, direction, par, field, distance };
}

export const dispersalExponential = (p: { param?: number; paramU?: number; paramD?: number } & Common): Dispersal =>
  newDispersal('exponential', p);

export const dispersalThreshold = (p: { param?: number; paramU?: number; paramD?: number } & Common): Dispersal =>
  newDispersal('threshold', p);

export function dispersalLeptokurtic(p: { sigmaStat: number; sigmaMob: number; p: number } & Common): Dispersal {
  if (!(p.sigmaStat > 0) || !(p.sigmaMob > 0)) throw new Error('sigma_stat and sigma_mob must be positive numbers.');
  checkProb(p.p, 'p');
  return {
    kernel: 'leptokurtic',
    direction: 'symmetric',
    par: [p.sigmaStat, p.sigmaMob, p.p],
    field: p.field ?? 'length',
    distance: p.distance ?? 'upstream',
  };
}

/** JSON form used by the golden files and the UI state. */
export interface SpecJson {
  connectivity: { direction: Direction; pass_u: string; pass_d: string; pass_confluence: number } | null;
  dispersal: { kernel: Dispersal['kernel']; direction: Direction; par: number[]; field: string; distance: DistanceConvention } | null;
}

export function specFromJson(j: SpecJson): { connectivity: Connectivity | null; dispersal: Dispersal | null } {
  return {
    connectivity: j.connectivity
      ? {
          direction: j.connectivity.direction,
          passU: j.connectivity.pass_u,
          passD: j.connectivity.pass_d,
          passConfluence: j.connectivity.pass_confluence,
        }
      : null,
    dispersal: j.dispersal ? { ...j.dispersal } : null,
  };
}
