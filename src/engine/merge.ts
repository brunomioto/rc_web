// Merges leave-one-out results computed on subsets of the barriers (one subset
// per worker) into the table rcDindex would return for all of them at once.
// Every barrier's rows depend only on the baseline and its own scenario, so the
// merged table is identical to the single-worker one.
import type { Col, Table } from './types';

export function mergeDindex(
  parts: Table[],
  barrierOrder: string[],
  weights: string[],
  type: 'full' | 'reach' | 'sum',
): Table {
  const live = parts.filter((p) => 'id_barrier' in p && (p.id_barrier as string[]).length > 0);
  if (!live.length) return parts[0] ?? {};
  const names = Object.keys(live[0]);
  const b = new Map(barrierOrder.map((id, i) => [id, i]));
  const w = new Map(weights.map((x, i) => [x, i]));
  const total = live.reduce((a, p) => a + (p.id_barrier as string[]).length, 0);
  // global row -> (part, row) and its sort key
  const where = new Int32Array(total * 2);
  const keyB = new Int32Array(total);
  const keyW = new Int32Array(total);
  let g = 0;
  live.forEach((p, pi) => {
    const ids = p.id_barrier as string[];
    const wc = p.weight as string[];
    for (let r = 0; r < ids.length; r++, g++) {
      where[2 * g] = pi;
      where[2 * g + 1] = r;
      keyB[g] = b.get(ids[r])!;
      keyW[g] = w.get(wc[r])!;
    }
  });
  const order = Array.from({ length: total }, (_, i) => i);
  // full: weight-major, then barrier; reach / sum: barrier-major, rows keep their order inside a barrier
  order.sort((x, y) =>
    type === 'full' ? keyW[x] - keyW[y] || keyB[x] - keyB[y] : keyB[x] - keyB[y] || where[2 * x] - where[2 * y] || where[2 * x + 1] - where[2 * y + 1],
  );
  const out: Table = {};
  for (const name of names) {
    const first = live[0][name];
    if (first instanceof Float64Array) {
      const col = new Float64Array(total);
      order.forEach((gi, i) => (col[i] = (live[where[2 * gi]][name] as Float64Array)[where[2 * gi + 1]]));
      out[name] = col;
    } else {
      const col: (string | null)[] = new Array(total);
      order.forEach((gi, i) => (col[i] = (live[where[2 * gi]][name] as (string | null)[])[where[2 * gi + 1]]));
      out[name] = col as Col;
    }
  }
  return out;
}
