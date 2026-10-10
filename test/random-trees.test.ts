// Parity with rc (reference values) on 25 random trees, 80 index cases
// and 25 leave-one-out cases. Tolerance 1e-10.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RcCore } from '../src/engine/core';
import { rcIndex } from '../src/engine/index';
import { rcDindex } from '../src/engine/dindex';
import type { RcNetwork } from '../src/engine/types';
import { alignRows, core, expectClose, loadGolden, netFromGolden, pick, specFromJson } from './helpers';

const TOL = 1e-10;
let c: RcCore;
let g: any;
let nets: RcNetwork[];

beforeAll(async () => {
  c = await core();
  g = loadGolden('random.json');
  nets = g.trees.map((t: any) => netFromGolden(c, t.nodes, t.edges));
});

describe('rc_index vs rc on random trees', () => {
  it('reproduces all index cases', () => {
    expect(g.index.length).toBe(2000);
    for (const [r, cs] of g.index.entries()) {
      const spec = specFromJson(cs.spec);
      const info = `tree ${cs.tree} case ${cs.case} (row ${r})`;
      const net = nets[cs.tree];
      const res = rcIndex(c, net, { weight: cs.weight, type: cs.type, mode: cs.mode, ...spec });
      const idx = res.index as Float64Array;
      if (cs.type === 'reach') {
        const ids = res[net.id] as string[];
        const by = new Map(ids.map((x, i) => [x, idx[i]]));
        expectClose(cs.expected.names.map((x: string) => by.get(x)!), cs.expected.values, TOL, info);
      } else {
        expect(idx.length, info).toBe(1);
        expectClose(idx, cs.expected.values, TOL, info);
      }
    }
  });
});

describe('rc_dindex vs rc on random trees', () => {
  it('reproduces all leave-one-out cases', () => {
    expect(g.dindex.length).toBe(25);
    for (const [r, cs] of g.dindex.entries()) {
      const spec = specFromJson(cs.spec);
      const info = `dindex row ${r} (tree ${cs.tree})`;
      const net = nets[cs.tree];
      const b = cs.barriers;
      const res = rcDindex(
        c,
        net,
        { id: b.id_barrier, passU: Float64Array.from(b.pass_u_updated), passD: Float64Array.from(b.pass_d_updated) },
        { weight: cs.weight, type: cs.type, mode: cs.mode, ...spec },
      );
      const keys = cs.type === 'reach' ? ['id_barrier', net.id] : ['id_barrier'];
      const rows = alignRows(res, cs.expected, keys);
      for (const col of ['num', 'den', 'index', 'index_bl', 'd_index']) {
        if (cs.type === 'sum' && (col === 'num' || col === 'den')) continue;
        if (!(col in cs.expected)) continue;
        expectClose(pick(res[col], rows), cs.expected[col], TOL, `${info} ${col}`);
      }
    }
  });
});
