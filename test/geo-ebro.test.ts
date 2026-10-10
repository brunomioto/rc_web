// Geoprocessing stages on the Ebro example vs the rc2 golden stages.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadGolden } from './helpers';
import { type EbroRun, runEbro } from './ebroPipeline';

let run: EbroRun;
let g: any;

const rel = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const byKey = (rows: Record<string, any[]>, key: string) => {
  const m = new Map<string, number>();
  rows[key].forEach((k, i) => m.set(String(k), i));
  return m;
};

beforeAll(async () => {
  g = loadGolden('ebro_pipeline.json').stages;
  run = await runEbro();
}, 180_000);

describe('geoprocessing stages on the Ebro example', () => {
  it('reads the rivers and picks the UTM zone', () => {
    expect(run.counts.rivers).toBe(g.rivers.n);
    expect(run.geo.crsM).toBe(g.rivers.crs_m);
  });

  it('prunes small streams (upland > 80 km2)', () => {
    expect(run.counts.prune).toBe(g.prune.n);
  });

  it('merges unbranched chains', async () => {
    const rows = await run.geo.db.query(
      `SELECT chain_id, down_chain, n_reaches, chain_length_km, ST_NPoints(geom) AS npoints,
              ST_Length_Spheroid(ST_FlipCoordinates(geom)) AS length_m FROM rc_chains`,
    );
    const want = g.merge.chains;
    expect(rows.length).toBe(want.chain_id.length);
    const idx = byKey(want, 'chain_id');
    for (const r of rows) {
      const i = idx.get(r.chain_id)!;
      expect(i, r.chain_id).toBeDefined();
      expect(r.down_chain ?? null).toBe(want.down_chain[i]);
      expect(r.n_reaches).toBe(want.n_reaches[i]);
      expect(rel(r.chain_length_km, want.chain_length_km[i], 1e-10), `${r.chain_id} length_km`).toBe(true);
      expect(r.npoints).toBe(want.npoints[i]);
      expect(rel(r.length_m, want.length_m[i], 1e-9), `${r.chain_id} length_m ${r.length_m} vs ${want.length_m[i]}`).toBe(true);
    }
  });

  it('reads the barriers', () => {
    expect(run.counts.barriers).toBe(g.barriers.n);
  });

  it('snaps and classifies barriers', () => {
    const want = g.snap.snap;
    expect(run.snap.length).toBe(want.bar_id.length);
    const idx = byKey(want, 'bar_id');
    for (const r of run.snap) {
      const i = idx.get(r.bar_id)!;
      expect(i, r.bar_id).toBeDefined();
      expect(r.chain_id, r.bar_id).toBe(want.chain_id[i]);
      expect(r.status, r.bar_id).toBe(want.status[i]);
      expect(r.position, r.bar_id).toBe(want.position[i]);
      expect(rel(r.dist_m, want.dist_m[i], 1e-7), `${r.bar_id} dist_m ${r.dist_m} vs ${want.dist_m[i]}`).toBe(true);
      expect(rel(r.len_m, want.len_m[i], 1e-9), `${r.bar_id} len_m`).toBe(true);
      expect(rel(r.frac, want.frac[i], 1e-9), `${r.bar_id} frac`).toBe(true);
      expect(rel(r.frac_ll, want.frac_ll[i], 1e-9), `${r.bar_id} frac_ll`).toBe(true);
    }
  });

  it('splits reaches at the barriers', async () => {
    const rows = await run.geo.db.query(
      `SELECT node_id, piece, f0, f1, length_m, length_attr_km, ST_NPoints(geom) AS npoints FROM rc_nodes`,
    );
    const want = g.split.nodes;
    expect(rows.length).toBe(want.node_id.length);
    const idx = byKey(want, 'node_id');
    const npointsDiff: number[] = [];
    for (const r of rows) {
      const i = idx.get(r.node_id)!;
      expect(i, r.node_id).toBeDefined();
      expect(r.piece).toBe(want.piece[i]);
      expect(rel(r.f0, want.f0[i], 1e-9)).toBe(true);
      expect(rel(r.f1, want.f1[i], 1e-9)).toBe(true);
      expect(rel(r.length_m, want.length_m[i], 1e-8), `${r.node_id} length_m ${r.length_m} vs ${want.length_m[i]}`).toBe(true);
      expect(rel(r.length_attr_km, want.length_attr_km[i], 1e-9)).toBe(true);
      // ST_LineSubstring differs between spatial versions by a repeated vertex at the cut
      // (8 of 652 pieces): the lengths above agree, so the geometry is the same line.
      if (r.npoints !== want.npoints[i]) npointsDiff.push(r.npoints - want.npoints[i]);
    }
    expect(npointsDiff.length).toBeLessThanOrEqual(Math.ceil(rows.length * 0.02));
    expect(npointsDiff.every((d) => Math.abs(d) === 1)).toBe(true);
    const e = await run.geo.db.query('SELECT "from", "to", type, id_barrier FROM rc_edges');
    const key = (f: string, t: string, ty: string, b: any) => `${f}|${t}|${ty}|${b}`;
    const got = new Set(e.map((r) => key(r.from, r.to, r.type, r.id_barrier)));
    const we = g.split.edges;
    const wantE = new Set(we.from.map((f: string, i: number) => key(f, we.to[i], we.type[i], we.id_barrier[i])));
    expect(got).toEqual(wantE);
  });

  it('records the same checks', () => {
    const got = run.geo.checks.map((c) => `${c.stage}/${c.check}:${c.severity}:${c.n}`).sort();
    const want = g.checks.map((c: any) => `${c.stage}/${c.check}:${c.severity}:${c.n}`).sort();
    expect(got).toEqual(want);
  });

  it('builds the network', () => {
    const b = g.build;
    expect(run.net.ids.length).toBe(b.n_nodes);
    expect(run.net.edges.from.length).toBe(b.n_edges);
    expect((run.net.edges.type as string[]).filter((t) => t === 'dam').length).toBe(b.n_dams);
    expect(run.net.netNames.length).toBe(b.n_networks);
    const len = run.net.nodes.length as Float64Array;
    expect(rel(len.reduce((a, x) => a + x, 0), b.total_length_km, 1e-9)).toBe(true);
    const idx = new Map(b.nodes.node_id.map((id: string, i: number) => [id, i]));
    run.net.ids.forEach((id, v) => {
      const i = idx.get(id) as number;
      expect(rel(len[v], b.nodes.length[i], 1e-9), `${id} length`).toBe(true);
      expect((run.net.nodes.rc_upland as Float64Array)[v]).toBe(b.nodes.rc_upland[i]);
    });
  });
});
