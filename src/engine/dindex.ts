// Port of rc2/R/dindex.R (rc_dindex): leave-one-out barrier prioritisation.
import type { RcCore } from './core';
import {
  boundedKernel,
  cafiIndex,
  checkSpec,
  connectivityFactors,
  defaultConnectivity,
  edgeCost,
  isMult,
  multFactors,
  normaliseMode,
  rowsumByNetwork,
  mulArr,
  weightMatrix,
  type IndexOptions,
} from './index';
import { type Table, type RcNetwork, numCol, strCol } from './types';

export interface Barriers {
  /** Barrier identifiers; they match the id_barrier edge column. */
  id: string[];
  /** Updated upstream passabilities (pass_u_updated). */
  passU: Float64Array;
  /** Updated downstream passabilities (pass_d_updated). */
  passD: Float64Array;
}

export interface DindexOptions extends IndexOptions {
  method?: 'auto' | 'recompute';
  onProgress?: (done: number, total: number) => void;
}

/** Barrier scenarios in CSR form: scenario b covers edges ptr[b]..ptr[b+1]. */
export interface Scenarios {
  n: number;
  id: string[];
  ptr: Int32Array;
  /** Child node of each scenario edge (0-based). */
  node: Int32Array;
  firstNode: Int32Array;
  newCu: Float64Array;
  newCd: Float64Array;
  newFu?: Float64Array;
  newFd?: Float64Array;
}

export function barrierScenarios(
  net: RcNetwork,
  barriers: Barriers,
  symmetric: boolean,
): Scenarios {
  const { id, passU, passD } = barriers;
  const dup = id.filter((x, i) => id.indexOf(x) !== i);
  if (dup.length) throw new Error(`Barrier identifiers must be unique; duplicated: ${[...new Set(dup)].join(', ')}.`);
  for (let i = 0; i < id.length; i++) {
    if (Number.isNaN(passU[i]) || Number.isNaN(passD[i])) throw new Error('Updated passabilities must not be missing.');
    if (passU[i] < 0 || passU[i] > 1 || passD[i] < 0 || passD[i] > 1) {
      throw new Error('Updated passabilities must be within [0, 1].');
    }
  }
  const edgeBid = strCol(net.edges, 'id_barrier');
  const byId = new Map<string, number[]>();
  edgeBid.forEach((b, e) => {
    if (b === null) return;
    const l = byId.get(b);
    if (l) l.push(e);
    else byId.set(b, [e]);
  });
  const missing = id.filter((b) => !byId.has(b));
  if (missing.length) {
    throw new Error(`Barriers not found in the network id_barrier column. Unknown: ${missing.slice(0, 10).join(', ')}.`);
  }
  const n = id.length;
  const ptr = new Int32Array(n + 1);
  id.forEach((b, i) => (ptr[i + 1] = ptr[i] + byId.get(b)!.length));
  const total = ptr[n];
  const node = new Int32Array(total);
  const newCu = new Float64Array(total);
  const newCd = new Float64Array(total);
  const firstNode = new Int32Array(n);
  id.forEach((b, i) => {
    const edges = byId.get(b)!;
    firstNode[i] = net.child[edges[0]];
    edges.forEach((e, j) => {
      const p = ptr[i] + j;
      node[p] = net.child[e];
      newCu[p] = symmetric ? passU[i] * passD[i] : passU[i];
      newCd[p] = symmetric ? passU[i] * passD[i] : passD[i];
    });
  });
  return { n, id: [...id], ptr, node, firstNode, newCu, newCd };
}

/** Scenarios `idx` of a barrierScenarios() object. */
export function scSubset(sc: Scenarios, idx: number[]): Scenarios {
  const ptr = new Int32Array(idx.length + 1);
  idx.forEach((b, i) => (ptr[i + 1] = ptr[i] + (sc.ptr[b + 1] - sc.ptr[b])));
  const take = (src: Float64Array | undefined) => {
    if (!src) return undefined;
    const out = new Float64Array(ptr[idx.length]);
    idx.forEach((b, i) => out.set(src.subarray(sc.ptr[b], sc.ptr[b + 1]), ptr[i]));
    return out;
  };
  const node = new Int32Array(ptr[idx.length]);
  idx.forEach((b, i) => node.set(sc.node.subarray(sc.ptr[b], sc.ptr[b + 1]), ptr[i]));
  return {
    n: idx.length,
    id: idx.map((b) => sc.id[b]),
    ptr,
    node,
    firstNode: Int32Array.from(idx, (b) => sc.firstNode[b]),
    newCu: take(sc.newCu)!,
    newCd: take(sc.newCd)!,
    newFu: take(sc.newFu),
    newFd: take(sc.newFd),
  };
}

/**
 * Leave-one-out barrier prioritisation. Returns a columnar table:
 *  - full:  id_barrier, network, weight, num, den, index, index_bl, d_index
 *  - reach: id_barrier, <id>, network, weight, num, den, index, index_bl, d_index
 *  - sum:   id_barrier, network, weight, index, index_bl, d_index
 */
export function rcDindex(core: RcCore, net: RcNetwork, barriers: Barriers, o: DindexOptions = {}): Table {
  const weight = o.weight ?? ['length'];
  const type = o.type ?? 'full';
  const mode = normaliseMode(o.mode);
  const method = o.method ?? 'auto';
  const connectivity = o.connectivity === undefined ? defaultConnectivity() : o.connectivity;
  const dispersal = o.dispersal ?? null;
  checkSpec(connectivity, dispersal);
  if (!connectivity) throw new Error('Barrier prioritisation needs a connectivity specification.');
  const k = weight.length;
  const n = net.ids.length;
  const W = weightMatrix(net, weight);
  const sc = barrierScenarios(net, barriers, connectivity.direction === 'symmetric');

  if (type === 'sum') return dindexSum(net, W, weight, connectivity, mode, sc);

  const to = type === 'full' || mode === 'to';
  const tp = net.topo;
  const mult = isMult(dispersal);
  const denNet = rowsumByNetwork(net, W, k);
  const g = net.netNames.length;

  let scenarioSums: (s: Scenarios) => Float64Array;
  let fast: boolean[];
  let siblings: boolean[];
  let sBl: Float64Array;
  let base: ReturnType<RcCore['dpMult']> | ReturnType<RcCore['bounded']>;
  let f: ReturnType<typeof multFactors> | undefined;

  if (mult) {
    f = multFactors(net, connectivity, dispersal);
    const nE = sc.node.length;
    sc.newFu = new Float64Array(nE);
    sc.newFd = new Float64Array(nE);
    for (let e = 0; e < nE; e++) {
      sc.newFu[e] = sc.newCu[e] * f.bu[sc.node[e]];
      sc.newFd[e] = sc.newCd[e] * f.bd[sc.node[e]];
    }
    const ff = f;
    scenarioSums = (s) => core.looMult(tp, ff.fu, ff.fd, W, k, s.ptr, s.node, s.newFu!, s.newFd!, 0, s.n, to);
    fast = Array.from({ length: sc.n }, (_, b) => type === 'full' && method === 'auto' && sc.ptr[b + 1] - sc.ptr[b] === 1);
    // barriers spanning several links that all enter the same reach (a dam
    // on a confluence) also have a closed form
    siblings = Array.from({ length: sc.n }, (_, b) => {
      if (type !== 'full' || method !== 'auto' || fast[b]) return false;
      const ps = new Set<number>();
      for (let e = sc.ptr[b]; e < sc.ptr[b + 1]; e++) ps.add(tp.parent[sc.node[e]]);
      return ps.size === 1;
    });
    base = core.dpMult(tp, f.fu, f.fd, W, k, fast.some(Boolean) || siblings.some(Boolean));
    sBl = to ? base.sTo : base.sFrom;
  } else {
    const cf = connectivityFactors(net, connectivity);
    const cost = edgeCost(net, dispersal!);
    const kern = boundedKernel(dispersal!);
    const par = Float64Array.from(dispersal!.par);
    const run = (cu: Float64Array, cd: Float64Array) => core.bounded(tp, cu, cd, cost, kern, par, W, k, to, !to);
    scenarioSums = (s) => {
      const out = new Float64Array(n * k * s.n);
      for (let b = 0; b < s.n; b++) {
        const cu = Float64Array.from(cf.cu);
        const cd = Float64Array.from(cf.cd);
        for (let e = s.ptr[b]; e < s.ptr[b + 1]; e++) {
          cu[s.node[e]] = s.newCu[e];
          cd[s.node[e]] = s.newCd[e];
        }
        const res = run(cu, cd);
        out.set(to ? res.sTo : res.sFrom, b * k * n);
      }
      return out;
    };
    fast = new Array(sc.n).fill(false);
    siblings = new Array(sc.n).fill(false);
    base = run(cf.cu, cf.cd);
    sBl = to ? base.sTo : base.sFrom;
  }

  const barNet = (b: number) => net.netIdx[sc.firstNode[b]];
  let done = 0;
  const tick = (m: number) => {
    done += m;
    o.onProgress?.(done, sc.n);
  };

  // scenarios per chunk: bounded by memory for the linear-time kernels; a few at a time
  // for threshold / leptokurtic kernels, where every scenario is a full search
  const chunk = mult ? Math.max(1, Math.floor(8e6 / (n * k))) : 2;

  if (type === 'reach') {
    return dindexReach(net, sc, W, k, weight, scenarioSums, sBl, denNet, tick, chunk);
  }

  // Full index: O(1) per single-edge barrier from the baseline DP; the other
  // scenarios are recomputed in chunks that keep memory bounded.
  const B = sc.n;
  const out = {
    id_barrier: new Array<string>(B * k),
    network: new Array<string>(B * k),
    weight: new Array<string>(B * k),
    num: new Float64Array(B * k),
    den: new Float64Array(B * k),
    index: new Float64Array(B * k),
    index_bl: new Float64Array(B * k),
    d_index: new Float64Array(B * k),
  };
  // numerator of the baseline per network and weight
  const numBl = rowsumByNetwork(net, mulArr(W, base.sTo), k);
  // writes one (barrier, weight) cell: num = num_bl + delta (dindex_full_tbl)
  const put = (b: number, c: number, nb: number, delta: number) => {
    const gi = barNet(b);
    const i = c * B + b;
    const dn = denNet[c * g + gi];
    const den = dn * dn;
    const num = nb + delta;
    out.id_barrier[i] = sc.id[b];
    out.network[i] = net.netNames[gi];
    out.weight[i] = weight[c];
    out.num[i] = num;
    out.den[i] = den;
    out.index[i] = num / den;
    out.index_bl[i] = nb / den;
    out.d_index[i] = (delta / nb) * 100;
  };

  const fastIdx = fast.flatMap((x, b) => (x ? [b] : []));
  if (fastIdx.length) {
    const b0 = base as ReturnType<RcCore['dpMult']>;
    const ff = f!;
    for (const b of fastIdx) {
      const u = sc.node[sc.ptr[b]];
      for (let c = 0; c < k; c++) {
        const at = c * n + u;
        const delta =
          (sc.newFd![sc.ptr[b]] - ff.fd[u]) * b0.din![at] * b0.uout![at] +
          (sc.newFu![sc.ptr[b]] - ff.fu[u]) * b0.uin![at] * b0.dout![at];
        put(b, c, numBl[c * g + net.netIdx[u]], delta);
      }
    }
    tick(fastIdx.length);
  }

  const sibIdx = siblings.flatMap((x, b) => (x ? [b] : []));
  if (sibIdx.length) {
    const b0 = base as ReturnType<RcCore['dpMult']>;
    for (const b of sibIdx) {
      const nodes = Array.from(sc.node.subarray(sc.ptr[b], sc.ptr[b + 1]));
      const nfu = Array.from(sc.newFu!.subarray(sc.ptr[b], sc.ptr[b + 1]));
      const nfd = Array.from(sc.newFd!.subarray(sc.ptr[b], sc.ptr[b + 1]));
      const delta = siblingDelta(net, f!, b0, W, n, k, nodes, nfu, nfd);
      for (let c = 0; c < k; c++) put(b, c, numBl[c * g + net.netIdx[sc.firstNode[b]]], delta[c]);
    }
    tick(sibIdx.length);
  }

  const slow = fast.flatMap((x, b) => (!x && !siblings[b] ? [b] : []));
  if (slow.length) {
    for (let a = 0; a < slow.length; a += chunk) {
      const idx = slow.slice(a, a + chunk);
      const s = scSubset(sc, idx);
      const S = scenarioSums(s);
      idx.forEach((b, j) => {
        const nodes = net.netNodes[barNet(b)];
        for (let c = 0; c < k; c++) {
          let num = 0;
          const col = (j * k + c) * n;
          for (const v of nodes) num += W[c * n + v] * S[col + v];
          const nb = numBl[c * g + barNet(b)];
          put(b, c, nb, num - nb);
        }
      });
      tick(idx.length);
    }
  }
  return out;
}

function dindexReach(
  net: RcNetwork,
  sc: Scenarios,
  W: Float64Array,
  k: number,
  weight: string[],
  scenarioSums: (s: Scenarios) => Float64Array,
  sBl: Float64Array,
  denNet: Float64Array,
  tick: (m: number) => void,
  size: number,
): Table {
  const n = net.ids.length;
  const g = net.netNames.length;
  const idv: string[] = [];
  const cols = {
    id_barrier: [] as string[],
    network: [] as string[],
    weight: [] as string[],
    num: [] as number[],
    den: [] as number[],
    index: [] as number[],
    index_bl: [] as number[],
    d_index: [] as number[],
  };
  for (let a = 0; a < sc.n; a += size) {
    const idx = Array.from({ length: Math.min(size, sc.n - a) }, (_, i) => a + i);
    const s = scSubset(sc, idx);
    const S = scenarioSums(s);
    idx.forEach((b, j) => {
      const gi = net.netIdx[sc.firstNode[b]];
      const nodes = net.netNodes[gi];
      for (let c = 0; c < k; c++) {
        for (const v of nodes) {
          const num = S[(j * k + c) * n + v];
          const nb = sBl[c * n + v];
          const den = denNet[c * g + gi];
          cols.id_barrier.push(sc.id[b]);
          idv.push(net.ids[v]);
          cols.network.push(net.netNames[gi]);
          cols.weight.push(weight[c]);
          cols.num.push(num);
          cols.den.push(den);
          cols.index.push(num / den);
          cols.index_bl.push(nb / den);
          cols.d_index.push(((num - nb) / nb) * 100);
        }
      }
    });
    tick(idx.length);
  }
  return {
    id_barrier: cols.id_barrier,
    [net.id]: idv,
    network: cols.network,
    weight: cols.weight,
    num: Float64Array.from(cols.num),
    den: Float64Array.from(cols.den),
    index: Float64Array.from(cols.index),
    index_bl: Float64Array.from(cols.index_bl),
    d_index: Float64Array.from(cols.d_index),
  };
}

/**
 * Change of the full-index numerator when the links of the sibling reaches `a`
 * (all draining into the same reach v) get factors newFu / newFd. See the
 * derivation in rc2/R/dindex.R.
 */
function siblingDelta(
  net: RcNetwork,
  f: ReturnType<typeof multFactors>,
  base: ReturnType<RcCore['dpMult']>,
  W: Float64Array,
  n: number,
  k: number,
  a: number[],
  newFu: number[],
  newFd: number[],
): Float64Array {
  const tp = net.topo;
  const v = tp.parent[a[0]];
  const aSet = new Set(a);
  const others: number[] = [];
  for (let t = tp.childPtr[v]; t < tp.childPtr[v + 1]; t++) {
    const c = tp.childIdx[t];
    if (!aSet.has(c) && !others.includes(c)) others.push(c);
  }
  const root = tp.parent[v] < 0;
  const din = base.din!;
  const dout = base.dout!;
  const uin = base.uin!;
  const uout = base.uout!;
  const res = new Float64Array(k);
  for (let c = 0; c < k; c++) {
    const o = c * n;
    let sOut = 0;
    let sIn = 0;
    for (const s of others) {
      sOut += f.fu[s] * dout[o + s];
      sIn += f.fd[s] * din[o + s];
    }
    const wv = W[o + v];
    const rOut = wv + (root ? 0 : f.fd[v] * uout[o + v]) + sOut;
    const rIn = wv + (root ? 0 : f.fu[v] * uin[o + v]) + sIn;
    let s1 = 0; // sum (new_fd - fd) din
    let s2 = 0; // sum (new_fu - fu) dout
    let nFdDin = 0;
    let nFuDout = 0;
    let nBoth = 0;
    let oFdDin = 0;
    let oFuDout = 0;
    let oBoth = 0;
    a.forEach((x, j) => {
      const di = din[o + x];
      const dou = dout[o + x];
      s1 += (newFd[j] - f.fd[x]) * di;
      s2 += (newFu[j] - f.fu[x]) * dou;
      nFdDin += newFd[j] * di;
      nFuDout += newFu[j] * dou;
      nBoth += newFd[j] * newFu[j] * di * dou;
      oFdDin += f.fd[x] * di;
      oFuDout += f.fu[x] * dou;
      oBoth += f.fd[x] * f.fu[x] * di * dou;
    });
    const one = s1 * rOut + s2 * rIn;
    const crossNew = nFdDin * nFuDout - nBoth;
    const crossOld = oFdDin * oFuDout - oBoth;
    res[c] = one + crossNew - crossOld;
  }
  return res;
}

function dindexSum(
  net: RcNetwork,
  W: Float64Array,
  weight: string[],
  connectivity: NonNullable<IndexOptions['connectivity']>,
  mode: 'to' | 'from',
  sc: Scenarios,
): Table {
  const baseTbl = cafiIndex(net, W, weight, connectivity, mode);
  const baseIdx = baseTbl.index as Float64Array;
  const baseNet = baseTbl.network as string[];
  const edgeOfChild = new Map<number, number>();
  net.child.forEach((c, e) => edgeOfChild.set(c, e));
  const k = weight.length;
  const cols = {
    id_barrier: [] as string[],
    network: [] as string[],
    weight: [] as string[],
    index: [] as number[],
    index_bl: [] as number[],
    d_index: [] as number[],
  };
  const symmetric = connectivity.direction === 'symmetric';
  const pu0 = numCol(net.edges, connectivity.passU);
  const pd0 = numCol(net.edges, connectivity.passD);
  for (let b = 0; b < sc.n; b++) {
    const pu = Float64Array.from(pu0);
    const pd = Float64Array.from(pd0);
    for (let e = sc.ptr[b]; e < sc.ptr[b + 1]; e++) {
      const row = edgeOfChild.get(sc.node[e])!;
      if (symmetric) {
        // only the product matters for symmetric CAFI
        pu[row] = sc.newCu[e];
        pd[row] = 1;
      } else {
        pu[row] = sc.newCu[e];
        pd[row] = sc.newCd[e];
      }
    }
    const upd: RcNetwork = { ...net, edges: { ...net.edges, [connectivity.passU]: pu, [connectivity.passD]: pd } };
    const res = cafiIndex(upd, W, weight, connectivity, mode);
    const name = net.networkOf[sc.firstNode[b]];
    const resIdx = res.index as Float64Array;
    for (let c = 0; c < k; c++) {
      for (let i = 0; i < baseNet.length; i++) {
        if (baseNet[i] !== name || (res.weight as string[])[i] !== weight[c]) continue;
        cols.id_barrier.push(sc.id[b]);
        cols.network.push(name);
        cols.weight.push(weight[c]);
        cols.index.push(resIdx[i]);
        cols.index_bl.push(baseIdx[i]);
        cols.d_index.push(((resIdx[i] - baseIdx[i]) / baseIdx[i]) * 100);
      }
    }
  }
  return {
    id_barrier: cols.id_barrier,
    network: cols.network,
    weight: cols.weight,
    index: Float64Array.from(cols.index),
    index_bl: Float64Array.from(cols.index_bl),
    d_index: Float64Array.from(cols.d_index),
  };
}
