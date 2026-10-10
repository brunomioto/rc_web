// Validation, checks, passability updates and derived weights.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RcCore } from '../src/engine/core';
import { networkChecks } from '../src/engine/checks';
import { rcIndex } from '../src/engine/index';
import { createNetwork, setPassability } from '../src/engine/network';
import type { RcNetwork, Table } from '../src/engine/types';
import { applyDerived } from '../src/ui/steps-geo';
import { connectivity, dispersalExponential, dispersalLeptokurtic } from '../src/engine/spec';
import { core, toTable } from './helpers';

let c: RcCore;
beforeAll(async () => {
  c = await core();
});

const nodes = (names: string[], length = 1): Table => toTable({ name: names, length: names.map(() => length) });
const edges = (from: string[], to: string[]): Table => toTable({ from, to });

describe('createNetwork validation', () => {
  it('rejects several downstream edges, cycles, unknown reaches and duplicates', () => {
    const n = nodes(['A', 'B', 'C']);
    expect(() => createNetwork(c, n, edges(['A', 'A'], ['B', 'C']))).toThrow(/at most one downstream edge/);
    expect(() => createNetwork(c, n, edges(['A', 'B'], ['B', 'A']))).toThrow(/cycle/);
    expect(() => createNetwork(c, n, edges(['A'], ['Z']))).toThrow(/missing from nodes/);
    expect(() => createNetwork(c, n, edges(['A'], ['A']))).toThrow(/itself/);
    expect(() => createNetwork(c, nodes(['A', 'A']), edges(['A'], ['B']))).toThrow(/unique/);
  });

  it('computes one index per network on a forest', () => {
    const net = createNetwork(c, nodes(['a', 'b', 'x', 'y', 'z']), edges(['a', 'x', 'y'], ['b', 'z', 'z']));
    expect(net.netNames).toEqual(['b', 'z']);
    const res = rcIndex(c, net, { connectivity: connectivity('symmetric') });
    expect(Array.from(res.index as Float64Array)).toEqual([1, 1]);
  });
});

describe('barriers and checks', () => {
  const dam = (puv: number | null, pdv: number | null): RcNetwork =>
    createNetwork(
      c,
      nodes(['A', 'B', 'C']),
      toTable({ from: ['A', 'B'], to: ['B', 'C'], type: ['dam', 'joint'], id_barrier: ['d1', null], pass_u: [puv, null], pass_d: [pdv, null] }),
    );

  it('flags barrier edges without passabilities', () => {
    const chk = networkChecks(dam(null, 0.5));
    expect(chk.find((x) => x.check === 'passability_defined')).toMatchObject({ severity: 'warning', n: 1, ids: ['d1'] });
    expect(networkChecks(dam(0.1, 0.5)).find((x) => x.check === 'passability_defined')!.severity).toBe('ok');
  });

  it('setPassability replaces the values of the listed barriers', () => {
    const net = setPassability(dam(0.1, 0.5), { id: ['d1'], passU: Float64Array.of(1), passD: Float64Array.of(0.25) });
    expect(Array.from(net.edges.pass_u as Float64Array).slice(0, 1)).toEqual([1]);
    expect(Array.from(net.edges.pass_d as Float64Array).slice(0, 1)).toEqual([0.25]);
    expect(() => setPassability(net, { id: ['nope'], passU: Float64Array.of(1), passD: Float64Array.of(1) })).toThrow(/Unknown barrier/);
  });

  it('a fully passable barrier gives the barrier-free DCI', () => {
    const open = rcIndex(c, dam(1, 1), { connectivity: connectivity('symmetric') });
    const none = rcIndex(c, dam(0.1, 0.5), { connectivity: null, dispersal: dispersalExponential({ param: 1 }) });
    expect((open.index as Float64Array)[0]).toBeCloseTo(1, 14);
    expect((none.index as Float64Array)[0]).toBeCloseTo(1, 14);
  });
});

describe('kernel sanity', () => {
  it('leptokurtic with equal sigmas is a single half-normal tail', () => {
    // 2 reaches of length 1 and 2: pair value 2 * P(Z > d / sigma) with d = length of the upstream reach
    const net = createNetwork(c, toTable({ name: ['r1', 'r2'], length: [0, 2] }), edges(['r2'], ['r1']));
    const res = rcIndex(c, net, { type: 'reach', mode: 'to', connectivity: null, dispersal: dispersalLeptokurtic({ sigmaStat: 2, sigmaMob: 2, p: 0.5 }), weight: ['length'] });
    // reach r2 -> r1: d = 2, kernel = 2 * P(Z > 1) = 0.3173105...; weights (0, 2): sum_j A w_j = 0.3173 * 0 + 1 * 2
    const idx = res.index as Float64Array;
    expect(idx[1]).toBeCloseTo((2 * 1 + 0 * 0.3173105078629141) / 2, 12);
    expect(idx[0]).toBeCloseTo((0 * 1 + 2 * 0.3173105078629141) / 2, 12);
  });
});

describe('derived weights', () => {
  it('evaluates name = expression lines, in order, per reach', () => {
    const net = createNetwork(c, toTable({ name: ['a', 'b'], length: [2, 4], up: [100, 400] }), edges(['a'], ['b']));
    const out = applyDerived(net, 'hsi = Math.exp(-up / 100)\nwul = hsi * length');
    const hsi = out.nodes.hsi as Float64Array;
    expect(hsi[0]).toBeCloseTo(Math.exp(-1), 15);
    expect((out.nodes.wul as Float64Array)[1]).toBeCloseTo(Math.exp(-4) * 4, 15);
    expect(() => applyDerived(net, 'name = 1')).toThrow(/identifier/);
    expect(() => applyDerived(net, 'oops')).toThrow(/name = expression/);
    expect(applyDerived(net, '  \n// nothing')).toBe(net);
  });
});
