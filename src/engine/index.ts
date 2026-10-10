// Port of rc2/R/index.R (rc_index and its helpers).
import { KERNEL, type DpResult, type RcCore } from './core';
import { edgeVector } from './network';
import type { Connectivity, Dispersal } from './spec';
import { type Table, type RcNetwork, numCol, strCol } from './types';

export type IndexType = 'full' | 'reach' | 'sum';
export type IndexMode = 'to' | 'from' | 'outgoing' | 'incoming';

export interface IndexOptions {
  weight?: string[];
  type?: IndexType;
  mode?: IndexMode;
  /** Pass null to ignore barriers. */
  connectivity?: Connectivity | null;
  /** Pass null for no distance decay. */
  dispersal?: Dispersal | null;
}

export function normaliseMode(mode: IndexMode = 'to'): 'to' | 'from' {
  return mode === 'to' || mode === 'outgoing' ? 'to' : 'from';
}

/** n x k column-major weight matrix from reach columns. */
export function weightMatrix(net: RcNetwork, weight: string[]): Float64Array {
  if (!weight.length) throw new Error('weight must be a non-empty list of reach columns.');
  const n = net.ids.length;
  const W = new Float64Array(n * weight.length);
  weight.forEach((w, c) => W.set(numCol(net.nodes, w, 'the reach table'), c * n));
  return W;
}

export function checkSpec(connectivity: Connectivity | null, dispersal: Dispersal | null): void {
  if (!connectivity && !dispersal) throw new Error('At least one of connectivity and dispersal must be given.');
}

function checkProbArr(x: Float64Array, name: string): void {
  for (const v of x) {
    if (!Number.isNaN(v) && (v < 0 || v > 1)) throw new Error(`${name} must be within [0, 1].`);
  }
}

/** Per-edge passability factors, indexed by the child node of each edge. */
export function connectivityFactors(
  net: RcNetwork,
  connectivity: Connectivity | null,
): { cu: Float64Array; cd: Float64Array } {
  const n = net.ids.length;
  if (!connectivity) return { cu: new Float64Array(n).fill(1), cd: new Float64Array(n).fill(1) };
  const pu = edgeVector(net, connectivity.passU);
  const pd = edgeVector(net, connectivity.passD);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(pu[i])) pu[i] = connectivity.passConfluence;
    if (Number.isNaN(pd[i])) pd[i] = connectivity.passConfluence;
  }
  checkProbArr(pu, connectivity.passU);
  checkProbArr(pd, connectivity.passD);
  if (connectivity.direction === 'symmetric') {
    const c = new Float64Array(n);
    for (let i = 0; i < n; i++) c[i] = pu[i] * pd[i];
    return { cu: c, cd: Float64Array.from(c) };
  }
  return { cu: pu, cd: pd };
}

/** Per-edge distance cost, indexed by the child node of each edge. */
export function edgeCost(net: RcNetwork, dispersal: Dispersal): Float64Array {
  const L = numCol(net.nodes, dispersal.field, 'the reach table');
  const n = L.length;
  for (const x of L) {
    if (Number.isNaN(x) || x < 0) throw new Error(`Distance field ${dispersal.field} must be non-negative and complete.`);
  }
  const parent = net.topo.parent;
  const cost = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    if (parent[v] < 0) cost[v] = 0;
    else cost[v] = dispersal.distance === 'upstream' ? L[v] : (L[v] + L[parent[v]]) / 2;
  }
  return cost;
}

export interface MultFactors {
  fu: Float64Array;
  fd: Float64Array;
  bu: Float64Array;
  bd: Float64Array;
}

export function multFactors(
  net: RcNetwork,
  connectivity: Connectivity | null,
  dispersal: Dispersal | null,
): MultFactors {
  const cf = connectivityFactors(net, connectivity);
  const n = net.ids.length;
  const bu = new Float64Array(n).fill(1);
  const bd = new Float64Array(n).fill(1);
  if (dispersal) {
    const cost = edgeCost(net, dispersal);
    const [p0, p1] = dispersal.par;
    const pd = dispersal.direction === 'symmetric' ? p0 : p1;
    for (let v = 0; v < n; v++) {
      bu[v] = Math.pow(p0, cost[v]);
      bd[v] = Math.pow(pd, cost[v]);
    }
  }
  const fu = new Float64Array(n);
  const fd = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    fu[v] = cf.cu[v] * bu[v];
    fd[v] = cf.cd[v] * bd[v];
  }
  return { fu, fd, bu, bd };
}

export function boundedKernel(d: Dispersal): number {
  if (d.kernel === 'threshold') return d.direction === 'symmetric' ? KERNEL.thresholdSym : KERNEL.thresholdAsym;
  if (d.kernel === 'leptokurtic') return KERNEL.leptokurtic;
  throw new Error(`${d.kernel} is not a bounded kernel`);
}

export const isMult = (d: Dispersal | null): boolean => !d || d.kernel === 'exponential';

/** Reach sums S_to (outgoing) and S_from (incoming) for every weight column. */
export function pairSums(
  core: RcCore,
  net: RcNetwork,
  W: Float64Array,
  k: number,
  connectivity: Connectivity | null,
  dispersal: Dispersal | null,
  needTo = true,
  needFrom = true,
  keep = false,
): DpResult {
  const tp = net.topo;
  if (isMult(dispersal)) {
    const f = multFactors(net, connectivity, dispersal);
    return core.dpMult(tp, f.fu, f.fd, W, k, keep);
  }
  const cf = connectivityFactors(net, connectivity);
  return core.bounded(
    tp,
    cf.cu,
    cf.cd,
    edgeCost(net, dispersal!),
    boundedKernel(dispersal!),
    Float64Array.from(dispersal!.par),
    W,
    k,
    needTo,
    needFrom,
  );
}

/** Sum of v[node] * w[node] ... per network (R rowsum, reorder = FALSE), column by column. */
export function rowsumByNetwork(net: RcNetwork, M: Float64Array, k: number): Float64Array {
  const n = net.ids.length;
  const g = net.netNames.length;
  const out = new Float64Array(g * k);
  for (let c = 0; c < k; c++) {
    for (let v = 0; v < n; v++) out[c * g + net.netIdx[v]] += M[c * n + v];
  }
  return out;
}

/** Elementwise product of two same-size arrays. */
export function mulArr(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

/**
 * Connectivity indices on a river network. Returns a columnar table:
 *  - full:  network, weight, num, den, index
 *  - reach: <id>, network, weight, num, den, index
 *  - sum:   network, weight, index
 */
export function rcIndex(core: RcCore, net: RcNetwork, o: IndexOptions = {}): Table {
  const weight = o.weight ?? ['length'];
  const type = o.type ?? 'full';
  const mode = normaliseMode(o.mode);
  const connectivity = o.connectivity === undefined ? defaultConnectivity() : o.connectivity;
  const dispersal = o.dispersal ?? null;
  checkSpec(connectivity, dispersal);
  const n = net.ids.length;
  const k = weight.length;
  const W = weightMatrix(net, weight);

  if (type === 'sum') return cafiIndex(net, W, weight, connectivity, mode);

  const S = pairSums(core, net, W, k, connectivity, dispersal, type === 'full' || mode === 'to', type === 'reach' && mode === 'from');
  const g = net.netNames.length;
  const denNet = rowsumByNetwork(net, W, k);

  if (type === 'full') {
    const num = rowsumByNetwork(net, mulArr(W, S.sTo), k);
    const network: string[] = [];
    const wcol: string[] = [];
    const den = new Float64Array(g * k);
    const index = new Float64Array(g * k);
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < g; j++) {
        const i = c * g + j;
        network.push(net.netNames[j]);
        wcol.push(weight[c]);
        den[i] = denNet[i] * denNet[i];
        index[i] = num[i] / den[i];
      }
    }
    return { network, weight: wcol, num, den, index };
  }

  const numM = mode === 'to' ? S.sTo : S.sFrom;
  const total = n * k;
  const idc: (string | null)[] = [];
  const network: string[] = [];
  const wcol: string[] = [];
  const den = new Float64Array(total);
  const index = new Float64Array(total);
  const num = Float64Array.from(numM);
  for (let c = 0; c < k; c++) {
    for (let v = 0; v < n; v++) {
      const i = c * n + v;
      idc.push(net.ids[v]);
      network.push(net.networkOf[v]);
      wcol.push(weight[c]);
      den[i] = denNet[c * g + net.netIdx[v]];
      index[i] = num[i] / den[i];
    }
  }
  return { [net.id]: idc, network, weight: wcol, num, den, index };
}

export const defaultConnectivity = (): Connectivity => ({
  direction: 'symmetric',
  passU: 'pass_u',
  passD: 'pass_d',
  passConfluence: 1,
});

/** Catchment Area Fragmentation Index-like sum over barrier edges. */
export function cafiIndex(
  net: RcNetwork,
  W: Float64Array,
  weight: string[],
  connectivity: Connectivity | null,
  mode: 'to' | 'from',
): Table {
  if (!connectivity) throw new Error('type = "sum" needs a connectivity specification.');
  const n = net.ids.length;
  const k = weight.length;
  const e = net.edges;
  const pu0 = numCol(e, connectivity.passU, 'the edge table');
  const pd0 = numCol(e, connectivity.passD, 'the edge table');
  const m = pu0.length;
  const pass = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const pu = Number.isNaN(pu0[i]) ? connectivity.passConfluence : pu0[i];
    const pd = Number.isNaN(pd0[i]) ? connectivity.passConfluence : pd0[i];
    pass[i] = connectivity.direction === 'symmetric' ? pu * pd : mode === 'to' ? pd : pu;
  }
  const g = net.netNames.length;
  const type = strCol(e, 'type');
  // maximum weight per network
  const wMax = new Float64Array(g * k).fill(-Infinity);
  for (let c = 0; c < k; c++) {
    for (let v = 0; v < n; v++) {
      const i = c * g + net.netIdx[v];
      const x = W[c * n + v];
      wMax[i] = Number.isNaN(x) || Number.isNaN(wMax[i]) ? NaN : Math.max(wMax[i], x);
    }
  }
  const tot = new Float64Array(g * k);
  for (let i = 0; i < m; i++) {
    if (type[i] !== 'dam') continue;
    const v = net.child[i];
    const gi = net.netIdx[v];
    for (let c = 0; c < k; c++) tot[c * g + gi] += ((1 - pass[i]) * W[c * n + v]) / wMax[c * g + gi];
  }
  const network: string[] = [];
  const wcol: string[] = [];
  for (let c = 0; c < k; c++) {
    for (let j = 0; j < g; j++) {
      network.push(net.netNames[j]);
      wcol.push(weight[c]);
    }
  }
  return { network, weight: wcol, index: tot };
}
