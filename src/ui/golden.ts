// Debug mode (?debug=1): compares what the browser computes on the Ebro example
// with the rc2 golden values shipped in public/example/ebro_golden.json.
import type { IndexOptions } from '../engine/index';
import type { Table } from '../engine/types';

interface GoldenCase {
  case: string;
  weight: string[];
  type: string;
  mode: string;
  spec: any;
  expected: Record<string, any[]>;
  barriers?: { id_barrier: string[]; pass_u_updated: number[]; pass_d_updated: number[] };
}

interface GoldenFile {
  index: GoldenCase[];
  dindex: GoldenCase[];
}

let cache: Promise<GoldenFile | null> | null = null;

function load(): Promise<GoldenFile | null> {
  cache ??= fetch(`${import.meta.env.BASE_URL}example/ebro_golden.json`)
    .then((r) => (r.ok ? (r.json() as Promise<GoldenFile>) : null))
    .catch(() => null);
  return cache;
}

function specJson(o: IndexOptions) {
  return {
    connectivity: o.connectivity
      ? { direction: o.connectivity.direction, pass_u: o.connectivity.passU, pass_d: o.connectivity.passD, pass_confluence: o.connectivity.passConfluence }
      : null,
    dispersal: o.dispersal ? { kernel: o.dispersal.kernel, direction: o.dispersal.direction, par: o.dispersal.par, field: o.dispersal.field, distance: o.dispersal.distance } : null,
  };
}

const NUM = ['num', 'den', 'index', 'index_bl', 'd_index'];

function compare(got: Table, want: Record<string, any[]>, keys: string[]): { rows: number; maxDiff: number } | string {
  const n = (want[keys[0]] as any[]).length;
  if ((got[keys[0]] as any[]).length !== n) return `row count differs (${(got[keys[0]] as any[]).length} vs ${n})`;
  const idx = new Map<string, number>();
  for (let i = 0; i < n; i++) idx.set(keys.map((k) => String((got[k] as any)[i])).join('|'), i);
  let maxDiff = 0;
  for (let j = 0; j < n; j++) {
    const i = idx.get(keys.map((k) => String(want[k][j])).join('|'));
    if (i === undefined) return `row ${keys.map((k) => want[k][j]).join('/')} missing`;
    for (const c of NUM) {
      if (!(c in want) || !(got[c] instanceof Float64Array)) continue;
      const a = (got[c] as Float64Array)[i];
      const b = want[c][j] === null ? NaN : (want[c][j] as number);
      if (Number.isNaN(a) && Number.isNaN(b)) continue;
      maxDiff = Math.max(maxDiff, Math.abs(a - b) / Math.max(1, Math.abs(b)));
    }
  }
  return { rows: n, maxDiff };
}

/** Returns a one-line verdict when the run matches a golden case, otherwise null. */
export async function checkGolden(
  kind: 'index' | 'dindex',
  o: IndexOptions,
  table: Table,
  idCol: string,
  barriers?: { passU: number; passD: number },
): Promise<string | null> {
  const g = await load();
  if (!g) return null;
  const spec = JSON.stringify(specJson(o));
  const cases = kind === 'index' ? g.index : g.dindex;
  const hit = cases.find(
    (c) =>
      JSON.stringify(c.weight) === JSON.stringify(o.weight) &&
      c.type === (o.type ?? 'full') &&
      (c.type !== 'reach' || c.mode === o.mode) &&
      JSON.stringify(c.spec) === spec &&
      (kind === 'index' || (barriers && c.barriers!.pass_u_updated.every((x) => x === barriers.passU) && c.barriers!.pass_d_updated.every((x) => x === barriers.passD))),
  );
  if (!hit) return 'No rc2 golden case with these exact settings (the golden file covers a few of them).';
  const keys = kind === 'dindex' ? (hit.type === 'reach' ? ['id_barrier', idCol, 'weight'] : ['id_barrier', 'weight']) : hit.type === 'reach' ? [idCol, 'weight'] : ['network', 'weight'];
  const r = compare(table, hit.expected, keys);
  if (typeof r === 'string') return `golden case ${hit.case}: MISMATCH, ${r}`;
  return `golden case ${hit.case}: ${r.maxDiff <= 1e-10 ? 'OK' : 'MISMATCH'}, ${r.rows} values compared, max relative difference ${r.maxDiff.toExponential(2)}`;
}
