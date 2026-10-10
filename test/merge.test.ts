// The worker pool splits a prioritisation by barrier and merges the partial
// tables: the result must be identical to the single-worker one.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RcCore } from '../src/engine/core';
import { rcDindex, type Barriers } from '../src/engine/dindex';
import { connectivity, dispersalExponential, dispersalLeptokurtic, dispersalThreshold } from '../src/engine/spec';
import { mergeDindex } from '../src/engine/merge';
import type { RcNetwork, Table } from '../src/engine/types';
import { core, loadGolden, netFromGolden } from './helpers';

let c: RcCore;
let net: RcNetwork;
let barriers: Barriers;

beforeAll(async () => {
  c = await core();
  const g = loadGolden('ebro_tutorial.json');
  net = netFromGolden(c, g.nodes, g.edges);
  const b = g.barriers;
  barriers = { id: b.id_barrier, passU: Float64Array.from(b.pass_u_updated), passD: Float64Array.from(b.pass_d_updated) };
  barriers.passU.fill(0.4);
});

function interleave(n: number, w: number): Barriers[] {
  return Array.from({ length: w }, (_, k) => {
    const idx = barriers.id.map((_, b) => b).filter((b) => b % w === k);
    return { id: idx.map((b) => barriers.id[b]), passU: Float64Array.from(idx, (b) => barriers.passU[b]), passD: Float64Array.from(idx, (b) => barriers.passD[b]) };
  });
}

function same(a: Table, b: Table) {
  expect(Object.keys(a)).toEqual(Object.keys(b));
  for (const k of Object.keys(a)) {
    expect(Array.from(a[k] as any), k).toEqual(Array.from(b[k] as any));
  }
}

const cases = [
  { name: 'full, DCI', o: { type: 'full' as const, weight: ['length', 'WUL_low'], connectivity: connectivity('asymmetric'), dispersal: null } },
  { name: 'full, exponential', o: { type: 'full' as const, weight: ['length'], connectivity: connectivity('symmetric'), dispersal: dispersalExponential({ param: 0.9 }) } },
  { name: 'full, threshold', o: { type: 'full' as const, weight: ['length', 'WUL_high'], connectivity: connectivity('symmetric'), dispersal: dispersalThreshold({ param: 4 }) } },
  { name: 'reach, leptokurtic', o: { type: 'reach' as const, mode: 'from' as const, weight: ['length'], connectivity: connectivity('asymmetric'), dispersal: dispersalLeptokurtic({ sigmaStat: 1, sigmaMob: 5, p: 0.6 }) } },
  { name: 'sum', o: { type: 'sum' as const, weight: ['length', 'WUL_low'], connectivity: connectivity('symmetric'), dispersal: null } },
];

describe('mergeDindex', () => {
  for (const { name, o } of cases) {
    it(`split by barrier and merged equals the whole run: ${name}`, () => {
      const sub = o.type === 'reach' ? { ...barriers, id: barriers.id.slice(0, 12), passU: barriers.passU.slice(0, 12), passD: barriers.passD.slice(0, 12) } : barriers;
      const orig = barriers;
      barriers = sub;
      try {
        const whole = rcDindex(c, net, sub, o);
        for (const w of [2, 3, 5]) {
          const parts = interleave(sub.id.length, w).map((s) => rcDindex(c, net, s, o));
          same(mergeDindex(parts, sub.id, o.weight, o.type), whole);
        }
      } finally {
        barriers = orig;
      }
    });
  }
});
