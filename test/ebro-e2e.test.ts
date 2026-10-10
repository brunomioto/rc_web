// End to end: the Ebro network built in the browser stack (duckdb-wasm spatial
// pipeline) feeds the engine, and every index / leave-one-out case of the
// rc2 golden file is reproduced to 1e-10.
import { beforeAll, describe, it } from 'vitest';
import { getCore, type RcCore } from '../src/engine/core';
import { rcIndex } from '../src/engine/index';
import { rcDindex } from '../src/engine/dindex';
import { setWeights } from '../src/engine/network';
import type { RcNetwork } from '../src/engine/types';
import { compareTables, loadGolden, specFromJson } from './helpers';
import { runEbro } from './ebroPipeline';

const TOL = 1e-10;
let c: RcCore;
let net: RcNetwork;

beforeAll(async () => {
  c = await getCore();
  const run = await runEbro();
  // the vignette weights: illustrative habitat suitability from the upstream area
  net = setWeights(run.net, (nodes) => {
    const up = nodes.rc_upland as Float64Array;
    const len = nodes.length as Float64Array;
    const n = len.length;
    const hsiLow = new Float64Array(n);
    const hsiHigh = new Float64Array(n);
    const wulLow = new Float64Array(n);
    const wulHigh = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      hsiLow[i] = Math.exp(-up[i] / 50000);
      hsiHigh[i] = 1 - Math.exp(-up[i] / 50000);
      wulLow[i] = hsiLow[i] * len[i];
      wulHigh[i] = hsiHigh[i] * len[i];
    }
    return { hsi_low: hsiLow, hsi_high: hsiHigh, wul_low: wulLow, wul_high: wulHigh };
  });
}, 180_000);

describe('Ebro: duckdb-wasm pipeline + engine vs rc2', () => {
  for (const cs of loadGolden('ebro_pipeline.json').index) {
    it(`rc_index ${cs.case}`, () => {
      const res = rcIndex(c, net, { weight: cs.weight, type: cs.type, mode: cs.mode, ...specFromJson(cs.spec) });
      const keys = cs.type === 'reach' ? ['node_id', 'weight'] : ['network', 'weight'];
      // the whole chain (wasm spatial pipeline + engine) holds the 1e-10 tolerance
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
