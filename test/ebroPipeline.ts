// Runs the default web pipeline on the bundled Ebro example (default settings
// of the wizard) and keeps the intermediate results.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCore } from '../src/engine/core';
import { GeoPipeline, type Source, type SnapRow } from '../src/geo/pipeline';
import type { RcNetwork } from '../src/engine/types';
import { createNodeDb } from './nodeDb';

const here = dirname(fileURLToPath(import.meta.url));

export function ebroSource(): Source {
  const data = new Uint8Array(readFileSync(join(here, '..', 'public', 'example', 'ebro.gpkg')));
  return { name: 'ebro.gpkg', files: [{ name: 'ebro.gpkg', data }] };
}

export interface EbroRun {
  geo: GeoPipeline;
  net: RcNetwork;
  snap: SnapRow[];
  counts: Record<string, number>;
}

export async function runEbro(): Promise<EbroRun> {
  const core = await getCore();
  const db = await createNodeDb();
  const geo = GeoPipeline.create(db, core);
  const src = ebroSource();
  const counts: Record<string, number> = {};
  await geo.rivers(src, { layer: 'rivers', adapter: 'hydrorivers_v1' });
  counts.rivers = await geo.count('rc_reaches');
  await geo.prune({ minUpland: 80 });
  counts.prune = await geo.count('rc_reaches');
  await geo.mergeChains();
  counts.chains = await geo.count('rc_chains');
  await geo.barriers(src, { layer: 'dams', id: 'dam_id', passU: 0.1, passD: 0.8 });
  counts.barriers = await geo.count('rc_barriers');
  const snap = await geo.snap({ maxDist: 1000 });
  await geo.split();
  counts.nodes = await geo.count('rc_nodes');
  const net = await geo.build();
  return { geo, net, snap, counts };
}
