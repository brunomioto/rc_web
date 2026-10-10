// Other input formats and CRS: a UTM shapefile (with its sidecars), GeoJSON and a
// CSV of barrier coordinates must give the same network as the GeoPackage.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { getCore } from '../src/engine/core';
import { GeoPipeline, listLayers, type Source } from '../src/geo/pipeline';
import type { RcNetwork } from '../src/engine/types';
import { runEbro } from './ebroPipeline';
import { createNodeDb } from './nodeDb';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const file = (name: string) => ({ name, data: new Uint8Array(readFileSync(join(dir, name))) });

const shp: Source = { name: 'ebro_rivers_utm.shp', files: ['shp', 'dbf', 'shx', 'prj'].map((e) => file(`ebro_rivers_utm.${e}`)) };
const geojson: Source = { name: 'ebro_rivers.geojson', files: [file('ebro_rivers.geojson')] };
const dams: Source = { name: 'ebro_dams.csv', files: [file('ebro_dams.csv')] };

let ref: RcNetwork;

beforeAll(async () => {
  ref = (await runEbro()).net;
}, 120_000);

async function build(rivers: Source, crs?: number): Promise<RcNetwork> {
  const geo = GeoPipeline.create(await createNodeDb(), await getCore());
  await geo.rivers(rivers, { adapter: 'hydrorivers_v1', crs });
  await geo.mergeChains();
  await geo.barriers(dams, { id: 'dam_id', passU: 0.1, passD: 0.8, coords: ['lon', 'lat'] });
  await geo.snap({ maxDist: 1000 });
  await geo.split();
  return geo.build();
}

function expectSameNetwork(net: RcNetwork) {
  expect(net.ids.length).toBe(ref.ids.length);
  expect(new Set(net.ids)).toEqual(new Set(ref.ids));
  expect((net.edges.type as string[]).filter((t) => t === 'dam').length).toBe((ref.edges.type as string[]).filter((t) => t === 'dam').length);
  const key = (n: RcNetwork) => new Set((n.edges.from as string[]).map((f, e) => `${f}|${(n.edges.to as string[])[e]}|${(n.edges.id_barrier as (string | null)[])[e]}`));
  expect(key(net)).toEqual(key(ref));
  const sum = (n: RcNetwork) => (n.nodes.length as Float64Array).reduce((a, x) => a + x, 0);
  expect(Math.abs(sum(net) - sum(ref)) / sum(ref)).toBeLessThan(1e-6);
}

describe('input formats', () => {
  it('lists the layers of a shapefile and of a GeoJSON file', async () => {
    const db = await createNodeDb();
    const l1 = await listLayers(db, shp);
    expect(l1).toHaveLength(1);
    expect(l1[0].columns).toContain('HYRIV_ID');
    const l2 = await listLayers(db, geojson);
    expect(l2[0].columns).toContain('NEXT_DOWN');
    const l3 = await listLayers(db, dams);
    expect(l3[0].columns).toEqual(['dam_id', 'lon', 'lat']);
  });

  it('reports projected coordinates when the CRS is wrong', async () => {
    const geo = GeoPipeline.create(await createNodeDb(), await getCore());
    await expect(geo.rivers(shp, { adapter: 'hydrorivers_v1', crs: 4326 })).rejects.toThrow(/outside the longitude\/latitude range/);
  });

  it('builds the same network from a UTM shapefile (CRS read from the .prj) + CSV barriers', async () => {
    expectSameNetwork(await build(shp));
  });

  it('accepts the EPSG code explicitly', async () => {
    expectSameNetwork(await build(shp, 32630));
  });

  it('builds the same network from GeoJSON + CSV barriers', async () => {
    expectSameNetwork(await build(geojson));
  });

  it('requires the coordinate columns for a CSV', async () => {
    const geo = GeoPipeline.create(await createNodeDb(), await getCore());
    await geo.rivers(geojson, { adapter: 'hydrorivers_v1' });
    await geo.mergeChains();
    await expect(geo.barriers(dams, { passU: 0, passD: 0 })).rejects.toThrow(/coords/);
  });

  it('rejects a layer that lacks the adapter columns', async () => {
    const geo = GeoPipeline.create(await createNodeDb(), await getCore());
    await expect(geo.rivers(dams, { adapter: 'hydrorivers_v1', coords: ['lon', 'lat'] })).rejects.toThrow(/missing/);
  });
});
