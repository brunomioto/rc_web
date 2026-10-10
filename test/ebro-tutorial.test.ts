// Parity with rc on the Ebro tutorial network (648 reaches, 95 dams):
// 8 reach-scale indices and 9 leave-one-out prioritisations. Tolerance 1e-10.
import { beforeAll, describe, expect, it } from 'vitest';
import type { RcCore } from '../src/engine/core';
import { rcIndex } from '../src/engine/index';
import { rcDindex } from '../src/engine/dindex';
import type { RcNetwork } from '../src/engine/types';
import { compareTables, core, loadGolden, netFromGolden, specFromJson } from './helpers';

const TOL = 1e-10;
let c: RcCore;
let g: any;
let net: RcNetwork;

beforeAll(async () => {
  c = await core();
  g = loadGolden('ebro_tutorial.json');
  net = netFromGolden(c, g.nodes, g.edges);
});

describe('Ebro tutorial network', () => {
  it('has the published shape', () => {
    expect(net.ids.length).toBe(648);
    expect(net.edges.from.length).toBe(647);
    expect((net.edges.type as string[]).filter((t) => t === 'dam').length).toBe(95);
    expect(net.netNames.length).toBe(1);
  });

  for (const cs of loadGolden('ebro_tutorial.json').reach) {
    it(`reach index ${cs.case} matches rc`, () => {
      const res = rcIndex(c, net, { weight: cs.weight, type: cs.type, mode: cs.mode, ...specFromJson(cs.spec) });
      compareTables(res, cs.expected, ['name'], TOL, `reach ${cs.case}`);
    });
  }

  for (const cs of loadGolden('ebro_tutorial.json').prior) {
    it(`prioritisation ${cs.case} matches rc`, () => {
      const b = g.barriers;
      const res = rcDindex(
        c,
        net,
        { id: b.id_barrier, passU: Float64Array.from(b.pass_u_updated), passD: Float64Array.from(b.pass_d_updated) },
        { weight: cs.weight, type: cs.type, mode: cs.mode, ...specFromJson(cs.spec) },
      );
      const keys = cs.type === 'reach' ? ['id_barrier', 'name'] : ['id_barrier'];
      compareTables(res, cs.expected, keys, TOL, `prior ${cs.case}`);
    });
  }
});
