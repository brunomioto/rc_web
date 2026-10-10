import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { type RcCore, getCore } from '../src/engine/core';
import { createNetwork } from '../src/engine/network';
import { specFromJson, type SpecJson } from '../src/engine/spec';
import type { Col, RcNetwork, Table } from '../src/engine/types';

const here = dirname(fileURLToPath(import.meta.url));
export const goldenDir = resolve(here, 'golden');

export function loadGolden<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(goldenDir, name), 'utf8')) as T;
}

const STRING_COLS = new Set(['name', 'node_id', 'from', 'to', 'type', 'id_barrier', 'id', 'network', 'weight']);

/** JSON columns (arrays with nulls) -> Table: numbers become Float64Array (null = NaN). */
export function toTable(cols: Record<string, any[]>): Table {
  const t: Table = {};
  for (const [name, arr] of Object.entries(cols)) {
    const first = arr.find((x) => x !== null);
    const isStr = STRING_COLS.has(name) || typeof first === 'string';
    t[name] = isStr
      ? (arr.map((x) => (x === null ? null : String(x))) as Col)
      : Float64Array.from(arr, (x) => (x === null ? NaN : (x as number)));
  }
  return t;
}

export async function core(): Promise<RcCore> {
  return getCore();
}

export function netFromGolden(c: RcCore, nodes: Record<string, any[]>, edges: Record<string, any[]>, id = 'name'): RcNetwork {
  return createNetwork(c, toTable(nodes), toTable(edges), { id });
}

export { specFromJson, type SpecJson };

/** |a - b| <= tol * max(1, |b|); NaN equals NaN. */
export function close(a: number, b: number | null, tol: number): boolean {
  const bb = b === null ? NaN : b;
  if (Number.isNaN(a) || Number.isNaN(bb)) return Number.isNaN(a) && Number.isNaN(bb);
  if (a === bb) return true;
  return Math.abs(a - bb) <= tol * Math.max(1, Math.abs(bb));
}

export function expectClose(got: ArrayLike<number>, want: ArrayLike<number | null>, tol: number, info: string): void {
  expect(got.length, `${info}: length`).toBe(want.length);
  let worst = 0;
  let bad = -1;
  for (let i = 0; i < want.length; i++) {
    const b = want[i] === null ? NaN : (want[i] as number);
    if (!close(got[i], b, tol)) {
      const d = Math.abs(got[i] - b) / Math.max(1, Math.abs(b));
      if (bad < 0 || !(d <= worst)) {
        worst = d;
        bad = i;
      }
    }
  }
  if (bad >= 0) {
    throw new Error(`${info}: element ${bad}: got ${got[bad]}, want ${want[bad]} (rel diff ${worst})`);
  }
}

/** Rows of `got` reordered to follow the key columns of `want` (string keys). */
export function alignRows(got: Table, want: Record<string, any[]>, keys: string[]): number[] {
  const nGot = (got[keys[0]] as any[]).length;
  const index = new Map<string, number>();
  for (let i = 0; i < nGot; i++) {
    index.set(keys.map((k) => String((got[k] as any)[i])).join('\u0001'), i);
  }
  const nWant = want[keys[0]].length;
  expect(nGot, 'number of rows').toBe(nWant);
  const rows: number[] = [];
  for (let j = 0; j < nWant; j++) {
    const key = keys.map((k) => String(want[k][j])).join('\u0001');
    const i = index.get(key);
    if (i === undefined) throw new Error(`row not found for key ${key}`);
    rows.push(i);
  }
  return rows;
}

export const pick = (col: Col, rows: number[]): number[] => rows.map((i) => (col as Float64Array)[i]);

const NUM_COLS = ['num', 'den', 'index', 'index_bl', 'd_index'];

/** Compares a result table with an expected table (columns from R), aligned on `keys`. */
export function compareTables(got: Table, want: Record<string, any[]>, keys: string[], tol: number, info: string): void {
  const rows = alignRows(got, want, keys);
  for (const col of NUM_COLS) {
    if (!(col in want)) continue;
    expectClose(pick(got[col], rows), want[col], tol, `${info} ${col}`);
  }
}
