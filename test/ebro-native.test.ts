// Parity with rc2 (native API) on the network built from ebro.gpkg by
// the default pipeline: every index type and kernel, and leave-one-out with
// the closed-form shortcut, sibling formula and recomputation paths.
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
  g = loadGolden('ebro_pipeline.json');
  net = netFromGolden(c, g.stages.build.nodes, g.stages.build.edges, 'node_id');
});

describe('Ebro pipeline network', () => {
  it('has the expected shape', () => {
    const b = g.stages.build;
    expect(net.ids.length).toBe(b.n_nodes);
    expect(net.edges.from.length).toBe(b.n_edges);
    expect(net.netNames.length).toBe(b.n_networks);
  });

  for (const cs of loadGolden('ebro_pipeline.json').index) {
    it(`rc_index ${cs.case}`, () => {
      const res = rcIndex(c, net, { weight: cs.weight, type: cs.type, mode: cs.mode, ...specFromJson(cs.spec) });
      const keys = cs.type === 'reach' ? ['node_id', 'weight'] : ['network', 'weight'];
      compareTables(res, cs.expected, keys, TOL, cs.case);
    });
  }

  for (const cs of loadGolden('ebro_pipeline.json').dindex) {
    it(`rc_dindex ${cs.case}`, () => {
      const b = cs.barriers;
      const res = rcDindex(
        c,
        net,
        { id: b.id_barrier, passU: Float64Array.from(b.pass_u_updated), passD: Float64Array.from(b.pass_d_updated) },
        { weight: cs.weight, type: cs.type, mode: cs.mode, ...specFromJson(cs.spec) },
      );
      const keys = cs.type === 'reach' ? ['id_barrier', 'node_id', 'weight'] : ['id_barrier', 'weight'];
      compareTables(res, cs.expected, keys, TOL, cs.case);
    });
  }
});
