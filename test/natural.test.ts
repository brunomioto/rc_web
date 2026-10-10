// Natural barriers (waterfalls): a second barrier layer that reduces connectivity
// like dams do but is not a prioritisation candidate and not part of the CAFI sum.
import { beforeAll, describe, expect, it } from 'vitest';
import { getCore, type RcCore } from '../src/engine/core';
import { cafiIndex, rcIndex, weightMatrix } from '../src/engine/index';
import { connectivity } from '../src/engine/spec';
import { GeoPipeline } from '../src/geo/pipeline';
import type { RcNetwork } from '../src/engine/types';
import { networkChecks } from '../src/engine/checks';
import { runEbro, ebroSource } from './ebroPipeline';
import { createNodeDb } from './nodeDb';

let c: RcCore;
let ref: RcNetwork;
let split: RcNetwork;

const isNatural = (id: string) => Number(id) % 10 === 0;

beforeAll(async () => {
  c = await getCore();
  ref = (await runEbro()).net; // every dam is a dam
  const geo = GeoPipeline.create(await createNodeDb(), c);
  const src = ebroSource();
  await geo.rivers(src, { layer: 'rivers', adapter: 'hydrorivers_v1' });
  await geo.prune({ minUpland: 80 });
  await geo.mergeChains();
  await geo.barriers(src, { layer: 'dams', id: 'dam_id', passU: 0.1, passD: 0.8, where: 'dam_id % 10 <> 0', kind: 'dam' });
  // the same table again as the natural layer: ids clash with nothing, since the rows are disjoint
  await geo.barriers(src, { layer: 'dams', id: 'dam_id', passU: 0.1, passD: 0.8, where: 'dam_id % 10 = 0', kind: 'natural', append: true });
  await geo.snap({ maxDist: 1000 });
  await geo.split();
  split = await geo.build();
}, 180_000);

describe('natural barriers', () => {
  it('give the same network topology as dams, with their own link type', () => {
    expect(new Set(split.ids)).toEqual(new Set(ref.ids));
    const key = (n: RcNetwork) =>
      new Set((n.edges.from as string[]).map((f, e) => `${f}|${(n.edges.to as string[])[e]}|${(n.edges.id_barrier as (string | null)[])[e]}`));
    expect(key(split)).toEqual(key(ref));
    const type = split.edges.type as string[];
    const bar = split.edges.id_barrier as (string | null)[];
    const naturals = bar.filter((b, e) => b !== null && type[e] === 'natural');
    expect(naturals.length).toBeGreaterThan(0);
    expect(naturals.every((b) => isNatural(b!))).toBe(true);
    expect(bar.filter((b, e) => b !== null && type[e] === 'dam').every((b) => !isNatural(b!))).toBe(true);
  });

  it('reduce connectivity exactly like dams with the same passabilities', () => {
    const o = { connectivity: connectivity('asymmetric') };
    const a = rcIndex(c, ref, o);
    const b = rcIndex(c, split, o);
    expect((b.index as Float64Array)[0]).toBeCloseTo((a.index as Float64Array)[0], 13);
  });

  it('are left out of the CAFI sum', () => {
    const all = cafiIndex(ref, weightMatrix(ref, ['length']), ['length'], connectivity('symmetric'), 'to');
    const dams = cafiIndex(split, weightMatrix(split, ['length']), ['length'], connectivity('symmetric'), 'to');
    expect((dams.index as Float64Array)[0]).toBeLessThan((all.index as Float64Array)[0]);
    expect((dams.index as Float64Array)[0]).toBeGreaterThan(0);
  });

  it('are checked for missing passabilities like dams', () => {
    const type = split.edges.type as string[];
    const e = type.indexOf('natural');
    const pu = Float64Array.from(split.edges.pass_u as Float64Array);
    pu[e] = NaN;
    const broken: RcNetwork = { ...split, edges: { ...split.edges, pass_u: pu } };
    const chk = networkChecks(broken).find((x) => x.check === 'passability_defined')!;
    expect(chk.severity).toBe('warning');
    expect(chk.n).toBe(1);
  });

  it('get a prefix when their ids clash with dam ids', async () => {
    const geo = GeoPipeline.create(await createNodeDb(), c);
    const src = ebroSource();
    await geo.rivers(src, { layer: 'rivers', adapter: 'hydrorivers_v1' });
    await geo.mergeChains();
    await geo.barriers(src, { layer: 'dams', id: 'dam_id', passU: 0.1, passD: 0.8, where: 'dam_id <= 3', kind: 'dam' });
    await geo.barriers(src, { layer: 'dams', id: 'dam_id', passU: 0, passD: 1, where: 'dam_id <= 2', kind: 'natural', append: true });
    const ids = (await geo.db.query('SELECT bar_id, rc_kind FROM rc_barriers ORDER BY bar_id')).map((r) => `${r.bar_id}:${r.rc_kind}`);
    expect(ids).toEqual(['1:dam', '2:dam', '3:dam', 'nat_1:natural', 'nat_2:natural']);
    expect(geo.checks.find((x) => x.check === 'unique_ids')!.severity).toBe('ok');
  });
});
