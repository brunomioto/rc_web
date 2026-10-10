// Port of rc2/R/network.R (rc_network) and convert.R (rc_set_*).
import type { RcCore } from './core';
import { type Col, type Table, nrow, numCol, strCol, type RcNetwork } from './types';

export interface NetworkOptions {
  id?: string;
  from?: string;
  to?: string;
}

function head(xs: string[], n = 10): string {
  return [...new Set(xs)].slice(0, n).join(', ');
}

/** Builds and validates a network from reach and edge tables. */
export function createNetwork(core: RcCore, nodes: Table, edges: Table, opts: NetworkOptions = {}): RcNetwork {
  const idCol = opts.id ?? 'name';
  const fromCol = opts.from ?? 'from';
  const toCol = opts.to ?? 'to';
  const ids = strCol(nodes, idCol, 'nodes').map((x) => {
    if (x === null) throw new Error(`Reach identifiers in ${idCol} must not be missing.`);
    return x;
  });
  const n = ids.length;
  const index = new Map<string, number>();
  const dup: string[] = [];
  ids.forEach((x, i) => {
    if (index.has(x)) dup.push(x);
    else index.set(x, i);
  });
  if (dup.length) throw new Error(`Reach identifiers must be unique. Duplicated: ${head(dup)}.`);

  const from = strCol(edges, fromCol, 'edges');
  const to = strCol(edges, toCol, 'edges');
  const m = from.length;
  const child = new Int32Array(m);
  const parent = new Int32Array(m);
  const unknown: string[] = [];
  for (let e = 0; e < m; e++) {
    const c = from[e] === null ? undefined : index.get(from[e]!);
    const p = to[e] === null ? undefined : index.get(to[e]!);
    if (c === undefined) unknown.push(String(from[e]));
    if (p === undefined) unknown.push(String(to[e]));
    child[e] = c ?? -1;
    parent[e] = p ?? -1;
  }
  if (unknown.length) throw new Error(`Edges refer to reaches missing from nodes. Unknown: ${head(unknown)}.`);
  for (let e = 0; e < m; e++) {
    if (child[e] === parent[e]) throw new Error('Edges must not connect a reach to itself.');
  }
  const seen = new Set<number>();
  const multi: string[] = [];
  for (let e = 0; e < m; e++) {
    if (seen.has(child[e])) multi.push(ids[child[e]]);
    seen.add(child[e]);
  }
  if (multi.length) {
    throw new Error(
      'Every reach must have at most one downstream edge (the network must be a tree). ' +
        `Reaches with several downstream edges: ${head(multi)}. Braided channels and bifurcations are not supported.`,
    );
  }

  const par0 = new Int32Array(n).fill(-1);
  for (let e = 0; e < m; e++) par0[child[e]] = parent[e];
  const topo = core.topology(par0);
  if (topo.nReached < n) throw new Error('The network contains a cycle. Every reach must drain to an outlet.');

  const E: Table = { ...edges };
  E.from = from;
  E.to = to;
  if (!E.type) E.type = new Array<string | null>(m).fill('joint');
  if (!E.pass_u) E.pass_u = new Float64Array(m).fill(NaN);
  if (!E.pass_d) E.pass_d = new Float64Array(m).fill(NaN);
  if (!E.id_barrier) E.id_barrier = new Array<string | null>(m).fill(null);

  return finishNetwork(idCol, ids, nodes, E, child, parent, topo);
}

export function finishNetwork(
  id: string,
  ids: string[],
  nodes: Table,
  edges: Table,
  child: Int32Array,
  parent: Int32Array,
  topo: RcNetwork['topo'],
): RcNetwork {
  const n = ids.length;
  const networkOf = new Array<string>(n);
  const netNames: string[] = [];
  const netPos = new Map<string, number>();
  const netIdx = new Int32Array(n);
  const netNodes: number[][] = [];
  for (let v = 0; v < n; v++) {
    const name = ids[topo.rootOf[v]];
    networkOf[v] = name;
    let g = netPos.get(name);
    if (g === undefined) {
      g = netNames.length;
      netPos.set(name, g);
      netNames.push(name);
      netNodes.push([]);
    }
    netIdx[v] = g;
    netNodes[g].push(v);
  }
  return { id, ids, nodes, edges, child, parent, topo, networkOf, netNames, netIdx, netNodes };
}

/** Per-node vector (indexed by the child node of each edge) of an edge column. */
export function edgeVector(net: RcNetwork, col: string, fill = NaN): Float64Array {
  const src = numCol(net.edges, col, 'the edge table');
  const out = new Float64Array(net.ids.length).fill(fill);
  for (let e = 0; e < src.length; e++) out[net.child[e]] = src[e];
  return out;
}

/** Adds or replaces reach columns (rc_set_weights). `fn` gets the current table. */
export function setWeights(net: RcNetwork, fn: (nodes: Table) => Record<string, Col>): RcNetwork {
  const add = fn(net.nodes);
  if (net.id in add) throw new Error('The reach identifier column cannot be changed.');
  return { ...net, nodes: { ...net.nodes, ...add } };
}

/** Replaces the passabilities of the listed barriers (rc_set_passability). */
export function setPassability(
  net: RcNetwork,
  values: { id: string[]; passU: Float64Array; passD: Float64Array },
): RcNetwork {
  for (const arr of [values.passU, values.passD]) {
    for (const x of arr) if (!Number.isNaN(x) && (x < 0 || x > 1)) throw new Error('Passabilities must be within [0, 1].');
  }
  const bar = strCol(net.edges, 'id_barrier');
  const where = new Map<string, number>();
  values.id.forEach((x, i) => where.set(x, i));
  const known = new Set(bar.filter((x): x is string => x !== null));
  const unknown = values.id.filter((x) => !known.has(x));
  if (unknown.length) throw new Error(`Unknown barrier(s): ${unknown.join(', ')}.`);
  const pu = Float64Array.from(numCol(net.edges, 'pass_u'));
  const pd = Float64Array.from(numCol(net.edges, 'pass_d'));
  bar.forEach((b, e) => {
    const k = b === null ? undefined : where.get(b);
    if (k !== undefined) {
      pu[e] = values.passU[k];
      pd[e] = values.passD[k];
    }
  });
  return { ...net, edges: { ...net.edges, pass_u: pu, pass_d: pd } };
}

export { nrow };
