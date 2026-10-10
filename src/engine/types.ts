import type { Topology } from './core';

/** A column: numbers (NaN is NA) or strings (null is NA). */
export type Col = Float64Array | (string | null)[];
/** Columnar table, the TS stand-in for an R data frame / tibble. */
export type Table = Record<string, Col>;

export function nrow(t: Table): number {
  const k = Object.keys(t)[0];
  return k === undefined ? 0 : t[k].length;
}

export function numCol(t: Table, name: string, what = 'table'): Float64Array {
  const c = t[name];
  if (c === undefined) {
    throw new Error(`Column ${name} not found in ${what}. Available columns: ${Object.keys(t).join(', ')}.`);
  }
  if (!(c instanceof Float64Array)) throw new Error(`Column ${name} in ${what} must be numeric.`);
  return c;
}

export function strCol(t: Table, name: string, what = 'table'): (string | null)[] {
  const c = t[name];
  if (c === undefined) {
    throw new Error(`Column ${name} not found in ${what}. Available columns: ${Object.keys(t).join(', ')}.`);
  }
  return Array.isArray(c) ? c : Array.from(c, (x) => (Number.isNaN(x) ? null : String(x)));
}

/** A river network: a forest where each reach has at most one downstream neighbour. */
export interface RcNetwork {
  /** Name of the reach identifier column. */
  id: string;
  ids: string[];
  nodes: Table;
  /** Edge table; always has from, to, type, id_barrier, pass_u, pass_d. */
  edges: Table;
  /** 0-based node index of the upstream (child) end of each edge. */
  child: Int32Array;
  /** 0-based node index of the downstream (parent) end of each edge. */
  parent: Int32Array;
  topo: Topology;
  /** Name of the network (its outlet reach id) each node belongs to. */
  networkOf: string[];
  /** Distinct network names in order of first appearance. */
  netNames: string[];
  /** Index into netNames for each node. */
  netIdx: Int32Array;
  /** Node indices of each network, ascending. */
  netNodes: number[][];
  /** Optional geometry (WKT, same order as ids) and barrier positions. */
  geometry?: string[];
  barrierGeometry?: { id_barrier: string; wkt: string; type: string }[];
}
