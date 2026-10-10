// Geoprocessing pipeline: river layer -> river network, in DuckDB spatial.
// Port of rc2/R/geo.R and geo_duckdb.R. Same SQL, same order:
//   rivers -> basin -> prune -> merge_chains -> barriers -> snap -> split
//   -> (attach) -> build
// Topology comes from the downstream identifiers (not from geometry). Left out
// of v1: topology = "geometry", snap method = "vertex" and length = "s2".
import type { RcCore } from '../engine/core';
import { createNetwork } from '../engine/network';
import type { RcNetwork, Table } from '../engine/types';
import { type Db, type Row, type SqlType, loadTable, sqlId, sqlNum, sqlStr } from './db';

// ---- sources ---------------------------------------------------------------

/** A user file (or the bundled example) plus its sidecars (.dbf, .shx, ...). */
export interface Source {
  /** Virtual file name of the main file, e.g. "ebro.gpkg" or "rivers.shp". */
  name: string;
  /** All files to register (main + sidecars). */
  files: { name: string; data: Uint8Array }[];
}

export interface ReadOptions {
  /** EPSG code of the source when it cannot be read from the file. */
  crs?: number;
  layer?: string;
  /** For CSV-like sources: the x (lon) and y (lat) columns. */
  coords?: [string, string];
  bbox?: [number, number, number, number];
  where?: string;
  /** Reduce non-point geometries to their centroid (before reprojection). */
  points?: boolean;
}

let sourceCounter = 0;
const registered = new WeakMap<Db, WeakMap<Source, string>>();

/** Registers the files of a source once per database; returns the path of the main file. */
export async function registerSource(db: Db, src: Source): Promise<string> {
  let perDb = registered.get(db);
  if (!perDb) registered.set(db, (perDb = new WeakMap()));
  const known = perDb.get(src);
  if (known) return known;
  // flat names: sidecar files (.dbf, .shx, ...) must share the basename of the main file
  const prefix = `src${++sourceCounter}_`;
  for (const f of src.files) await db.registerFile(prefix + f.name, f.data);
  perDb.set(src, prefix + src.name);
  return prefix + src.name;
}

export interface LayerInfo {
  name: string;
  geometry: string;
  columns: string[];
}

/** Layers of a vector file (GeoPackage, GeoJSON, shapefile, ...) with their columns. */
export async function listLayers(db: Db, src: Source): Promise<LayerInfo[]> {
  const ext = src.name.toLowerCase().split('.').pop() ?? '';
  const path = await registerSource(db, src);
  if (ext === 'parquet' || ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    const from = ext === 'parquet' ? `read_parquet(${sqlStr(path)})` : `read_csv_auto(${sqlStr(path)})`;
    const d = await db.query(`DESCRIBE SELECT * FROM ${from}`);
    return [{ name: src.name, geometry: ext === 'parquet' ? 'GEOMETRY' : 'POINT (coords)', columns: d.map((r) => String(r.column_name)) }];
  }
  const meta = await db.query(
    `SELECT l.name AS name, l.geometry_fields[1].type AS geometry FROM (SELECT unnest(layers) AS l FROM ST_Read_Meta(${sqlStr(path)}))`,
  );
  const out: LayerInfo[] = [];
  for (const m of meta) {
    const d = await db.query(`DESCRIBE SELECT * FROM ST_Read(${sqlStr(path)}, layer = ${sqlStr(m.name)})`);
    out.push({
      name: String(m.name),
      geometry: String(m.geometry ?? ''),
      columns: d.filter((r) => !String(r.column_type).toUpperCase().startsWith('GEOMETRY')).map((r) => String(r.column_name)),
    });
  }
  return out;
}

// ---- checks ----------------------------------------------------------------

export type Severity = 'ok' | 'info' | 'warning' | 'error';

export interface Check {
  stage: string;
  check: string;
  severity: Severity;
  n: number;
  ids: string[];
  message: string;
  hint: string | null;
}

function checkRow(
  stage: string,
  check: string,
  ids: string[],
  message: string,
  hint: string | null,
  fail: Severity = 'warning',
): Check {
  const failed = ids.length > 0;
  return {
    stage,
    check,
    severity: failed ? fail : 'ok',
    n: ids.length,
    ids,
    message: failed ? message : 'passed',
    hint: failed ? hint : null,
  };
}

// ---- helpers ---------------------------------------------------------------

/** Identifiers as text; integral numbers lose their decimal part ("12", not "12.0"). */
function idExpr(col: string): string {
  const x = sqlId(col);
  return `CASE WHEN TRY_CAST(${x} AS BIGINT) = TRY_CAST(${x} AS DOUBLE)
           THEN TRY_CAST(${x} AS BIGINT)::VARCHAR ELSE ${x}::VARCHAR END`;
}

const col = <T = any>(rows: Row[], name: string): T[] => rows.map((r) => r[name] as T);

export interface AdapterMapping {
  id: string;
  down_id: string;
  length_km?: string;
  upland?: string;
  order?: string;
}

export const ADAPTERS: Record<string, AdapterMapping> = {
  hydrorivers_v1: { id: 'HYRIV_ID', down_id: 'NEXT_DOWN', length_km: 'LENGTH_KM', upland: 'UPLAND_SKM', order: 'ORD_STRA' },
  hydrosheds_v2: { id: 'STRM_ID', down_id: 'STRM_DN', length_km: 'LENGTH_KM', upland: 'UPLAND_SKM', order: 'ORD_STRAH' },
};

export interface SnapRow {
  bar_id: string;
  chain_id: string;
  rc_upland: number | null;
  dist_m: number;
  len_m: number;
  vtx: number | null;
  frac: number;
  frac_ll: number;
  along: number;
  position: 'upstream_end' | 'downstream_end' | 'interior';
  n_up: number;
  status: 'ok' | 'headwater' | 'outlet' | 'duplicate' | 'confluence';
  down_chain: string | null;
}

export interface BuildOptions {
  /** "geodesic" (default) or "attribute" (the length_km column, split proportionally). */
  length?: 'geodesic' | 'attribute';
  /** Unit of the `length` column of the network. */
  lengthUnit?: 'km' | 'm' | '10km';
}

// ---- pipeline --------------------------------------------------------------

export class GeoPipeline {
  checks: Check[] = [];
  crsM = 32631;
  adapter = 'generic';
  /** Tables created so far, by stage, for check_geo. */
  private tables = new Set<string>();

  private constructor(
    readonly db: Db,
    readonly core: RcCore,
  ) {}

  static create(db: Db, core: RcCore): GeoPipeline {
    return new GeoPipeline(db, core);
  }

  // -- checks --
  private addCheck(row: Check): void {
    this.checks = this.checks.filter((c) => !(c.stage === row.stage && c.check === row.check));
    this.checks.push(row);
  }

  private need(...tables: string[]): void {
    const steps: Record<string, string> = {
      rc_chains: 'merge_chains',
      rc_barriers: 'barriers',
      rc_snap: 'snap',
      rc_nodes: 'split',
    };
    for (const t of tables) if (!this.tables.has(t)) throw new Error(`Run ${steps[t] ?? t} first.`);
  }

  // -- reading --

  /** Loads a layer into `table` with a lon/lat (EPSG:4326) column `geom`. */
  async readLayer(src: Source, table: string, o: ReadOptions = {}): Promise<number> {
    const { db } = this;
    const path = await registerSource(db, src);
    const ext = src.name.toLowerCase().split('.').pop() ?? '';
    let from: string;
    let crs = o.crs;
    if (ext === 'parquet') {
      from = await this.geomAsGeom(`read_parquet(${sqlStr(path)})`, src.name);
    } else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
      if (!o.coords) throw new Error('For a CSV file, give the x and y columns in coords.');
      from = `(SELECT *, ST_Point(${sqlId(o.coords[0])}::DOUBLE, ${sqlId(o.coords[1])}::DOUBLE) AS geom FROM read_csv_auto(${sqlStr(path)}))`;
      crs = crs ?? 4326;
    } else {
      const lay = o.layer ? `, layer = ${sqlStr(o.layer)}` : '';
      from = await this.geomAsGeom(`ST_Read(${sqlStr(path)}${lay})`, src.name);
      if (crs === undefined) {
        try {
          const meta = await db.query(
            `SELECT layers[1].geometry_fields[1].crs.auth_code AS code FROM ST_Read_Meta(${sqlStr(path)})`,
          );
          const code = meta[0]?.code;
          if (code !== null && code !== undefined && !Number.isNaN(Number(code))) crs = Number(code);
        } catch {
          /* no CRS in the file */
        }
      }
    }
    crs = crs ?? 4326;
    const g = o.points
      ? `CASE WHEN ST_GeometryType(geom::GEOMETRY) = 'POINT' THEN geom::GEOMETRY ELSE ST_Centroid(geom::GEOMETRY) END`
      : 'geom::GEOMETRY';
    const geom = crs === 4326 ? g : `ST_Transform(${g}, 'EPSG:${crs}', 'EPSG:4326', always_xy := true)`;
    await db.exec(
      `CREATE OR REPLACE TABLE ${table} AS SELECT * EXCLUDE (geom), ${geom} AS geom FROM ${this.filterClause(from, o)}`,
    );
    const ext4 = (
      await db.query(
        `SELECT min(ST_XMin(geom)) AS xmin, max(ST_XMax(geom)) AS xmax, min(ST_YMin(geom)) AS ymin, max(ST_YMax(geom)) AS ymax, count(*) AS n FROM ${table}`,
      )
    )[0];
    if (
      ext4.n > 0 &&
      [ext4.xmin, ext4.xmax, ext4.ymin, ext4.ymax].every((x) => x !== null) &&
      (ext4.xmin < -180 || ext4.xmax > 180 || ext4.ymin < -90 || ext4.ymax > 90)
    ) {
      throw new Error(
        `Coordinates are outside the longitude/latitude range (x ${ext4.xmin} to ${ext4.xmax}, y ${ext4.ymin} to ${ext4.ymax}). ` +
          'The layer is probably projected; give its EPSG code.',
      );
    }
    return Number(ext4.n);
  }

  private async geomAsGeom(from: string, name: string): Promise<string> {
    const d = await this.db.query(`DESCRIBE SELECT * FROM ${from}`);
    let gcol = d.find((r) => String(r.column_type).toUpperCase().startsWith('GEOMETRY'))?.column_name as string | undefined;
    if (!gcol) gcol = ['geom', 'geometry'].find((c) => d.some((r) => r.column_name === c));
    if (!gcol) throw new Error(`No geometry column in ${name}.`);
    if (gcol === 'geom') return from;
    return `(SELECT * EXCLUDE (${sqlId(gcol)}), ${sqlId(gcol)} AS geom FROM ${from})`;
  }

  private filterClause(from: string, o: ReadOptions): string {
    const cond: string[] = [];
    if (o.where) cond.push(o.where);
    if (o.bbox) {
      const [a, b, c, d] = o.bbox;
      cond.push(`geom::GEOMETRY && ST_MakeEnvelope(${a}, ${b}, ${c}, ${d})`);
    }
    return cond.length ? `(SELECT * FROM ${from} WHERE ${cond.map((c) => `(${c})`).join(' AND ')})` : from;
  }

  private toM(expr: string): string {
    return `ST_Transform(${expr}, 'EPSG:4326', 'EPSG:${this.crsM}', always_xy := true)`;
  }

  private fromM(expr: string): string {
    return `ST_Transform(${expr}, 'EPSG:${this.crsM}', 'EPSG:4326', always_xy := true)`;
  }

  private tableTopology(table: string, idCol = 'rc_id', downCol = 'rc_down') {
    return this.db.query(`SELECT ${idCol} AS id, ${downCol} AS down FROM ${table}`).then((rows) => {
      const ids = col<string>(rows, 'id');
      const index = new Map(ids.map((x, i) => [x, i]));
      const parent = Int32Array.from(rows, (r) => (r.down === null ? -1 : (index.get(r.down) ?? -1)));
      return { ids, parent, topo: this.core.topology(parent) };
    });
  }

  private async keepIds(table: string, ids: string[]): Promise<void> {
    await loadTable(this.db, 'rc_keep', { id: ids }, { id: 'VARCHAR' });
    await this.db.exec(`CREATE OR REPLACE TABLE ${table} AS SELECT * FROM ${table} WHERE rc_id IN (SELECT id FROM rc_keep)`);
    await this.db.exec(`UPDATE ${table} SET rc_down = NULL WHERE rc_down NOT IN (SELECT rc_id FROM ${table})`);
    await this.db.exec('DROP TABLE rc_keep');
  }

  // -- 1. rivers --

  /** Reads a river layer and maps it to the common schema with an adapter. */
  async rivers(
    src: Source,
    o: ReadOptions & { adapter?: string; mapping?: AdapterMapping; crsM?: number } = {},
  ): Promise<void> {
    const { db } = this;
    const adapter = o.adapter ?? 'hydrorivers_v1';
    const m = adapter === 'generic' ? o.mapping : ADAPTERS[adapter];
    if (!m || !m.id || !m.down_id) throw new Error('mapping must name at least id and down_id.');
    await this.readLayer(src, 'rc_raw', o);
    const cols = (await db.query('DESCRIBE rc_raw')).map((r) => String(r.column_name));
    const has = (c?: string) => !!c && cols.some((x) => x.toLowerCase() === c.toLowerCase());
    const real = (c: string) => cols.find((x) => x.toLowerCase() === c.toLowerCase())!;
    const miss = [m.id, m.down_id].filter((c) => !has(c));
    if (miss.length) {
      throw new Error(`Columns required by the ${adapter} adapter are missing: ${miss.join(', ')}. Available: ${cols.join(', ')}.`);
    }
    const opt = (c: string | undefined, cast = 'DOUBLE') => (has(c) ? `${sqlId(real(c!))}::${cast}` : `NULL::${cast}`);
    const id = idExpr(real(m.id));
    const down = idExpr(real(m.down_id));
    await db.exec(
      `CREATE OR REPLACE TABLE rc_reaches AS
       SELECT ${id} AS rc_id,
              CASE WHEN ${down} IN (SELECT ${id} FROM rc_raw) THEN ${down} END AS rc_down,
              ${opt(m.length_km)} AS rc_length_km, ${opt(m.upland)} AS rc_upland, ${opt(m.order, 'INTEGER')} AS rc_order,
              * EXCLUDE (geom), geom
       FROM rc_raw`,
    );
    await db.exec('DROP TABLE rc_raw');
    // single-part multi-lines (HydroSHEDS v2) become LINESTRINGs; disjoint parts stay multi and fail the check below
    await db.exec(
      `UPDATE rc_reaches SET geom = ST_LineMerge(geom) WHERE ST_GeometryType(geom) = 'MULTILINESTRING'`,
    );
    this.tables = new Set(['rc_reaches']);
    await db.exec('DROP TABLE IF EXISTS rc_reaches_pre_prune');
    this.adapter = adapter;
    this.checks = [];
    this.crsM = o.crsM ?? (await this.utmEpsg('rc_reaches'));

    const dup = col<string>(
      await db.query('SELECT rc_id FROM rc_reaches GROUP BY rc_id HAVING count(*) > 1'),
      'rc_id',
    );
    this.addCheck(
      checkRow('input', 'unique_ids', dup, `${dup.length} duplicated reach identifiers.`, 'Reach identifiers must be unique.', 'error'),
    );
    const bad = col<string>(
      await db.query(`SELECT rc_id FROM rc_reaches WHERE geom IS NULL OR ST_GeometryType(geom) <> 'LINESTRING'`),
      'rc_id',
    );
    this.addCheck(
      checkRow(
        'input',
        'linestring_geometry',
        bad,
        `${bad.length} reaches are not simple LINESTRINGs.`,
        'Fix or explode multi-part geometries before running the workflow.',
        'error',
      ),
    );
    await this.checkEndpoints();
  }

  private async utmEpsg(table: string): Promise<number> {
    const r = (
      await this.db.query(
        `SELECT avg(ST_X(ST_Centroid(geom))) AS x, avg(ST_Y(ST_Centroid(geom))) AS y FROM ${table}`,
      )
    )[0];
    const zone = (Math.floor((r.x + 180) / 6) % 60) + 1;
    return (r.y >= 0 ? 32600 : 32700) + zone;
  }

  /** Downstream end of each reach should touch the upstream end of its down reach. */
  private async checkEndpoints(table = 'rc_reaches', tol = 1e-6): Promise<void> {
    const bad = col<string>(
      await this.db.query(
        `SELECT a.rc_id FROM ${table} a JOIN ${table} b ON a.rc_down = b.rc_id
         WHERE ST_Distance(ST_EndPoint(a.geom), ST_StartPoint(b.geom)) > ${tol}`,
      ),
      'rc_id',
    );
    this.addCheck(
      checkRow(
        'topology',
        'endpoint_continuity',
        bad,
        `${bad.length} reaches do not end where their downstream reach starts.`,
        'Downstream identifiers and geometry disagree (manual edits or digitisation errors); topology follows the identifiers.',
      ),
    );
  }

  // -- 2. basin --

  /** Keeps the reaches draining to the given outlets (ids), or intersecting a polygon. */
  async basin(o: { outlet?: string[]; polygon?: Source; polygonOptions?: ReadOptions }): Promise<void> {
    const { db } = this;
    this.need('rc_reaches');
    if ((o.outlet === undefined) === (o.polygon === undefined)) throw new Error('Give exactly one of outlet and polygon.');
    if (o.outlet) {
      const tp = await this.tableTopology('rc_reaches');
      const outI = o.outlet.map((x) => tp.ids.indexOf(String(x)));
      const miss = o.outlet.filter((_, i) => outI[i] < 0);
      if (miss.length) throw new Error(`Outlet reach(es) ${miss.join(', ')} not found.`);
      const parent = Int32Array.from(tp.parent);
      for (const i of outI) parent[i] = -1;
      const root = this.core.topology(parent).rootOf;
      const outSet = new Set(outI);
      await this.keepIds('rc_reaches', tp.ids.filter((_, i) => outSet.has(root[i])));
    } else {
      await this.readLayer(o.polygon!, 'rc_polygon', o.polygonOptions);
      await db.exec(
        `CREATE OR REPLACE TABLE rc_reaches AS SELECT * FROM rc_reaches
         WHERE rc_id IN (SELECT r.rc_id FROM rc_reaches r, rc_polygon p WHERE ST_Intersects(r.geom, p.geom))`,
      );
      await db.exec('UPDATE rc_reaches SET rc_down = NULL WHERE rc_down NOT IN (SELECT rc_id FROM rc_reaches)');
    }
    // later stages restart from this basin
    await db.exec('DROP TABLE IF EXISTS rc_reaches_pre_prune');
    this.tables.delete('rc_reaches_pre_prune');
  }

  // -- 3. prune --

  /** Drops small streams: upstream area > minUpland and/or Strahler order >= minOrder. */
  async prune(o: { minUpland?: number; minOrder?: number; where?: string }): Promise<void> {
    const { db } = this;
    this.need('rc_reaches');
    // always prune from the unpruned reaches, so the thresholds can be changed and the step re-run
    if (this.tables.has('rc_reaches_pre_prune')) {
      await db.exec('CREATE OR REPLACE TABLE rc_reaches AS SELECT * FROM rc_reaches_pre_prune');
    } else {
      await db.exec('CREATE OR REPLACE TABLE rc_reaches_pre_prune AS SELECT * FROM rc_reaches');
      this.tables.add('rc_reaches_pre_prune');
    }
    if (o.minOrder !== undefined) {
      if (typeof o.minOrder !== 'number' || Number.isNaN(o.minOrder)) throw new Error('min_order must be a single number.');
      const n = (await db.query('SELECT count(rc_order) AS n FROM rc_reaches'))[0].n;
      if (Number(n) === 0) {
        const tp = await this.tableTopology('rc_reaches');
        const so = this.core.strahler(tp.topo);
        await loadTable(db, 'rc_strahler', { id: tp.ids, so: Array.from(so, (x) => (x < 0 ? null : x)) }, { id: 'VARCHAR', so: 'INTEGER' });
        await db.exec('UPDATE rc_reaches SET rc_order = s.so FROM rc_strahler s WHERE rc_reaches.rc_id = s.id');
        await db.exec('DROP TABLE rc_strahler');
      }
    }
    const cond: string[] = [];
    if (o.minUpland !== undefined) cond.push(`rc_upland > ${o.minUpland}`);
    if (o.minOrder !== undefined) cond.push(`rc_order >= ${o.minOrder}`);
    if (o.where) cond.push(o.where);
    if (!cond.length) throw new Error('Give min_upland, min_order and/or where.');
    const before = Number((await db.query('SELECT count(*) AS n FROM rc_reaches WHERE rc_down IS NULL'))[0].n);
    await db.exec(`CREATE OR REPLACE TABLE rc_reaches AS SELECT * FROM rc_reaches WHERE ${cond.map((c) => `(${c})`).join(' AND ')}`);
    const newOut = col<string>(
      await db.query(
        `SELECT rc_id FROM rc_reaches WHERE rc_down IS NOT NULL AND rc_down NOT IN (SELECT rc_id FROM rc_reaches)`,
      ),
      'rc_id',
    );
    await db.exec('UPDATE rc_reaches SET rc_down = NULL WHERE rc_down NOT IN (SELECT rc_id FROM rc_reaches)');
    this.addCheck(
      checkRow(
        'topology',
        'prune_keeps_connectivity',
        newOut,
        `Pruning disconnected ${newOut.length} reaches from their downstream reach (${before} outlets before).`,
        'The pruning rule removed reaches inside the network; use a rule that is monotone downstream.',
      ),
    );
    // downstream tables are now stale
    for (const t of ['rc_chains', 'rc_snap', 'rc_nodes']) this.tables.delete(t);
  }

  // -- 4. merge chains --

  /** Merges unbranched sequences of reaches between confluences into single reaches. */
  async mergeChains(o: { merge?: boolean } = {}): Promise<void> {
    const { db } = this;
    this.need('rc_reaches');
    const merge = o.merge ?? true;
    const tp = await this.tableTopology('rc_reaches');
    const n = tp.ids.length;
    let chain: Int32Array;
    let pos: Int32Array;
    if (merge) ({ chain, pos } = this.core.chains(tp.topo));
    else {
      chain = Int32Array.from({ length: n }, (_, i) => i);
      pos = new Int32Array(n);
    }
    await loadTable(
      db,
      'rc_chainmap',
      { rc_id: tp.ids, chain_id: Array.from(chain, (c) => tp.ids[c]), pos: Array.from(pos) },
      { rc_id: 'VARCHAR', chain_id: 'VARCHAR', pos: 'INTEGER' },
    );
    await db.exec(
      `CREATE OR REPLACE TABLE rc_chains AS
       WITH cnt AS (SELECT chain_id, count(*) AS n FROM rc_chainmap GROUP BY chain_id),
       g AS (
         -- single-reach chains (most of them) keep their geometry as is
         SELECT m.chain_id, r.geom, r.rc_length_km AS chain_length_km, 1 AS n_reaches
         FROM rc_reaches r JOIN rc_chainmap m USING (rc_id) JOIN cnt USING (chain_id)
         WHERE cnt.n = 1
         UNION ALL
         SELECT m.chain_id,
                ST_LineMerge(ST_Collect(list(r.geom ORDER BY m.pos DESC))) AS geom,
                sum(r.rc_length_km) AS chain_length_km,
                count(*) AS n_reaches
         FROM rc_reaches r JOIN rc_chainmap m USING (rc_id) JOIN cnt USING (chain_id)
         WHERE cnt.n > 1
         GROUP BY m.chain_id
       )
       SELECT g.chain_id, cm.chain_id AS down_chain, g.n_reaches, g.chain_length_km,
              h.* EXCLUDE (geom, rc_length_km), ${this.toM('g.geom')} AS geom_m, g.geom
       FROM g
       JOIN rc_reaches h ON h.rc_id = g.chain_id
       LEFT JOIN rc_chainmap cm ON cm.rc_id = h.rc_down`,
    );
    await db.exec('DROP TABLE rc_chainmap');
    this.tables.add('rc_chains');
    for (const t of ['rc_snap', 'rc_nodes']) this.tables.delete(t);
    const gaps = col<string>(
      await db.query(`SELECT chain_id FROM rc_chains WHERE ST_GeometryType(geom) <> 'LINESTRING'`),
      'chain_id',
    );
    this.addCheck(
      checkRow(
        'topology',
        'merged_reaches_contiguous',
        gaps,
        `${gaps.length} merged reaches are not contiguous lines.`,
        'Gaps between consecutive reaches; check the endpoint_continuity check.',
      ),
    );
  }

  // -- 5. barriers --

  /**
   * Reads barriers (points, or polygons reduced to centroids) with their
   * passabilities: numbers applied to every barrier, or column names.
   * `kind` tells dams from natural barriers (waterfalls): both reduce
   * connectivity, but only dams can be prioritised. With `append`, the layer
   * is added to the barriers read before (ids that clash get a "nat_" prefix).
   */
  async barriers(
    src: Source,
    o: ReadOptions & {
      id?: string;
      passU?: number | string;
      passD?: number | string;
      kind?: 'dam' | 'natural';
      append?: boolean;
      /** Category table: `by` column of the barriers -> passabilities. */
      passability?: { by: string; values: { category: string; passU: number; passD: number }[] };
    } = {},
  ): Promise<void> {
    const { db } = this;
    this.need('rc_reaches');
    const kind = o.kind ?? 'dam';
    const append = (o.append ?? false) && this.tables.has('rc_barriers');
    await this.readLayer(src, 'rc_barriers_raw', { ...o, points: true });
    const val = (x: number | string | undefined, arg: string) => {
      const v = x ?? 0;
      if (typeof v === 'number') {
        if (v < 0 || v > 1) throw new Error(`${arg} must be within [0, 1].`);
        return sqlNum(v);
      }
      return `${sqlId(v)}::DOUBLE`;
    };
    const bid = o.id ? idExpr(o.id) : '(row_number() OVER ())::VARCHAR';
    await db.exec(
      `CREATE OR REPLACE TABLE rc_barriers_new AS
       SELECT ${bid} AS bar_id, ${sqlStr(kind)} AS rc_kind, ${val(o.passU, 'pass_u')} AS pass_u, ${val(o.passD, 'pass_d')} AS pass_d,
              * EXCLUDE (geom),
              CASE WHEN ST_GeometryType(geom) = 'POINT' THEN geom ELSE ST_Centroid(geom) END AS geom
       FROM rc_barriers_raw`,
    );
    await db.exec('DROP TABLE rc_barriers_raw');
    if (o.passability) {
      const p = o.passability;
      await loadTable(
        db,
        'rc_pass_tbl',
        { cat: p.values.map((v) => String(v.category)), pass_u: p.values.map((v) => v.passU), pass_d: p.values.map((v) => v.passD) },
        { cat: 'VARCHAR', pass_u: 'DOUBLE', pass_d: 'DOUBLE' },
      );
      await db.exec(
        `UPDATE rc_barriers_new SET pass_u = p.pass_u, pass_d = p.pass_d FROM rc_pass_tbl p
         WHERE rc_barriers_new.${sqlId(p.by)}::VARCHAR = p.cat`,
      );
      await db.exec('DROP TABLE rc_pass_tbl');
    }
    if (append) {
      await db.exec(`UPDATE rc_barriers_new SET bar_id = 'nat_' || bar_id WHERE bar_id IN (SELECT bar_id FROM rc_barriers)`);
      await db.exec(
        'CREATE OR REPLACE TABLE rc_barriers AS SELECT * FROM rc_barriers UNION ALL BY NAME SELECT * FROM rc_barriers_new',
      );
    } else {
      await db.exec('CREATE OR REPLACE TABLE rc_barriers AS SELECT * FROM rc_barriers_new');
    }
    await db.exec('DROP TABLE rc_barriers_new');
    const pb = col<string>(
      await db.query(
        `SELECT bar_id FROM rc_barriers WHERE pass_u IS NULL OR pass_d IS NULL OR pass_u NOT BETWEEN 0 AND 1 OR pass_d NOT BETWEEN 0 AND 1`,
      ),
      'bar_id',
    );
    const dup = col<string>(
      await db.query('SELECT bar_id FROM rc_barriers GROUP BY bar_id HAVING count(*) > 1'),
      'bar_id',
    );
    this.addCheck(
      checkRow('barriers', 'passability_range', pb, `${pb.length} barriers with missing or out-of-range passability.`, 'Passabilities must be within [0, 1].', 'error'),
    );
    this.addCheck(
      checkRow('barriers', 'unique_ids', dup, `${dup.length} duplicated barrier identifiers.`, 'Barrier identifiers must be unique.', 'error'),
    );
    this.tables.add('rc_barriers');
    for (const t of ['rc_snap', 'rc_nodes']) this.tables.delete(t);
  }

  // -- 6. snap --

  /**
   * Projects each barrier onto the nearest reach within maxDist metres and
   * classifies it (interior, at a reach end, headwater, outlet, duplicate).
   * Barriers on a confluence go on the links entering it ("links") or are
   * dropped ("drop").
   */
  async snap(o: { maxDist?: number; endpointTol?: number; atConfluence?: 'links' | 'drop' } = {}): Promise<SnapRow[]> {
    const { db } = this;
    this.need('rc_chains', 'rc_barriers');
    const maxDist = o.maxDist ?? 1000;
    const tol = o.endpointTol ?? 1;
    const atConfluence = o.atConfluence ?? 'links';
    await db.exec(
      `CREATE OR REPLACE TABLE rc_snap AS
       WITH b AS (SELECT bar_id, ${this.toM('geom')} AS g FROM rc_barriers),
       cand AS (
         SELECT b.bar_id, b.g, c.chain_id, c.rc_upland, ST_Distance(b.g, c.geom_m) AS dist_m,
                ST_Length(c.geom_m) AS len_m
         FROM b JOIN rc_chains c ON ST_DWithin(b.g, c.geom_m, ${sqlNum(maxDist)})
       ),
       best AS (
         SELECT * FROM cand
         QUALIFY row_number() OVER (PARTITION BY bar_id ORDER BY dist_m, rc_upland DESC NULLS LAST) = 1
       )
       SELECT best.bar_id, best.chain_id, best.rc_upland, best.dist_m, best.len_m,
              NULL::INTEGER AS vtx, ST_LineLocatePoint(c.geom_m, best.g) AS frac,
              ST_LineLocatePoint(c.geom, ${this.fromM('ST_LineInterpolatePoint(c.geom_m, ST_LineLocatePoint(c.geom_m, best.g))')}) AS frac_ll
       FROM best JOIN rc_chains c USING (chain_id)`,
    );
    const raw = await db.query(
      'SELECT s.*, c.down_chain FROM rc_snap s JOIN rc_chains c USING (chain_id)',
    );
    const allIds = col<string>(await db.query('SELECT bar_id FROM rc_barriers'), 'bar_id');
    const snappedIds = new Set(raw.map((r) => r.bar_id as string));
    const unsnapped = allIds.filter((x) => !snappedIds.has(x));
    const ups = new Map<string, number>();
    for (const r of await db.query(
      'SELECT down_chain AS chain_id, count(*) AS n FROM rc_chains WHERE down_chain IS NOT NULL GROUP BY 1',
    )) {
      ups.set(r.chain_id, Number(r.n));
    }
    const rows: SnapRow[] = raw.map((r) => {
      const along = r.frac * r.len_m;
      const position: SnapRow['position'] =
        along <= tol ? 'upstream_end' : r.len_m - along <= tol ? 'downstream_end' : 'interior';
      const nUp = ups.get(r.chain_id) ?? 0;
      const status: SnapRow['status'] =
        position === 'upstream_end' && nUp === 0 ? 'headwater' : position === 'downstream_end' && r.down_chain === null ? 'outlet' : 'ok';
      return {
        bar_id: r.bar_id,
        chain_id: r.chain_id,
        rc_upland: r.rc_upland,
        dist_m: r.dist_m,
        len_m: r.len_m,
        vtx: null,
        frac: r.frac,
        frac_ll: r.frac_ll,
        along,
        position,
        n_up: nUp,
        status,
        down_chain: r.down_chain,
      };
    });
    // arrange(chain_id, along, bar_id) in the C locale
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort((a, b) => cmp(a.chain_id, b.chain_id) || a.along - b.along || cmp(a.bar_id, b.bar_id));
    for (let i = 0; i < rows.length; i++) {
      const prev = i > 0 && rows[i - 1].chain_id === rows[i].chain_id ? rows[i - 1] : null;
      const gap = prev ? rows[i].along - prev.along : NaN;
      if (rows[i].status === 'ok' && prev && gap <= tol) rows[i].status = 'duplicate';
    }
    if (atConfluence === 'drop') {
      for (const r of rows) if (r.status === 'ok' && r.position !== 'interior') r.status = 'confluence';
    }
    await db.exec('DROP TABLE rc_snap');
    await loadTable(
      db,
      'rc_snap',
      {
        bar_id: rows.map((r) => r.bar_id),
        chain_id: rows.map((r) => r.chain_id),
        rc_upland: rows.map((r) => r.rc_upland),
        dist_m: rows.map((r) => r.dist_m),
        len_m: rows.map((r) => r.len_m),
        vtx: rows.map((r) => r.vtx),
        frac: rows.map((r) => r.frac),
        frac_ll: rows.map((r) => r.frac_ll),
        down_chain: rows.map((r) => r.down_chain),
        along: rows.map((r) => r.along),
        position: rows.map((r) => r.position),
        n_up: rows.map((r) => r.n_up),
        status: rows.map((r) => r.status),
      },
      {
        bar_id: 'VARCHAR', chain_id: 'VARCHAR', rc_upland: 'DOUBLE', dist_m: 'DOUBLE', len_m: 'DOUBLE', vtx: 'INTEGER',
        frac: 'DOUBLE', frac_ll: 'DOUBLE', down_chain: 'VARCHAR', along: 'DOUBLE', position: 'VARCHAR', n_up: 'DOUBLE', status: 'VARCHAR',
      },
    );
    this.tables.add('rc_snap');
    this.tables.delete('rc_nodes');
    const ids = (s: SnapRow['status']) => rows.filter((r) => r.status === s).map((r) => r.bar_id);
    this.addCheck(
      checkRow('barriers', 'snapped', unsnapped, `${unsnapped.length} barriers farther than ${maxDist} m from any reach were not snapped.`, 'Check their coordinates, or increase max_dist.'),
    );
    this.addCheck(checkRow('barriers', 'duplicates', ids('duplicate'), `${ids('duplicate').length} barriers duplicate another barrier at the same place and were dropped.`, 'Merge duplicated records in the barrier table.', 'info'));
    this.addCheck(checkRow('barriers', 'headwater', ids('headwater'), `${ids('headwater').length} barriers sit at the upstream end of headwater reaches and were dropped.`, 'They do not separate any reaches.', 'info'));
    this.addCheck(checkRow('barriers', 'outlet', ids('outlet'), `${ids('outlet').length} barriers sit at the network outlet and were dropped.`, 'They do not separate any reaches.', 'info'));
    this.addCheck(
      checkRow('barriers', 'confluence_dropped', ids('confluence'), `${ids('confluence').length} barriers on confluences were dropped (at_confluence = "drop").`, 'Use at_confluence = "links" to keep them.'),
    );
    return rows;
  }

  // -- 7. split --

  /** Splits reaches at the snapped barriers and builds the links. */
  async split(): Promise<void> {
    const { db } = this;
    this.need('rc_chains', 'rc_snap');
    const chains = (await db.query('SELECT chain_id, down_chain FROM rc_chains ORDER BY chain_id')) as {
      chain_id: string;
      down_chain: string | null;
    }[];
    const snapAll = await db.query(
      `SELECT s.*, b.pass_u, b.pass_d, b.rc_kind FROM rc_snap s LEFT JOIN rc_barriers b USING (bar_id) WHERE s.status = 'ok'`,
    );
    const chainIdx = new Map(chains.map((c, i) => [c.chain_id, i]));
    // interior barriers sorted by chain (table order), then upstream to downstream
    const inner: (Row & { ci: number })[] = snapAll
      .filter((r) => r.position === 'interior')
      .map((r): Row & { ci: number } => ({ ...r, ci: chainIdx.get(r.chain_id)! }))
      .sort((a, b) => a.ci - b.ci || a.frac - b.frac);
    const m = new Int32Array(chains.length); // cuts per chain
    for (const r of inner) m[r.ci]++;
    const firstCut = new Int32Array(chains.length);
    for (let i = 1; i < chains.length; i++) firstCut[i] = firstCut[i - 1] + m[i - 1];

    interface Piece {
      chain_id: string;
      piece: number;
      n_pieces: number;
      f0: number;
      f1: number;
      node_id: string;
    }
    const pieces: Piece[] = [];
    const firstNode: string[] = new Array(chains.length);
    const lastNode: string[] = new Array(chains.length);
    chains.forEach((c, ci) => {
      const np = m[ci] + 1;
      for (let k = 1; k <= np; k++) {
        const f0 = k === 1 ? 0 : inner[firstCut[ci] + k - 2].frac_ll;
        const f1 = k === np ? 1 : inner[firstCut[ci] + k - 1].frac_ll;
        const node_id = np === 1 ? c.chain_id : `${c.chain_id}_${k}`;
        pieces.push({ chain_id: c.chain_id, piece: k, n_pieces: np, f0, f1, node_id });
        if (k === 1) firstNode[ci] = node_id;
        if (k === np) lastNode[ci] = node_id;
      }
    });

    interface Edge {
      from: string;
      to: string;
      type: 'dam' | 'natural' | 'joint';
      id_barrier: string | null;
      pass_u: number | null;
      pass_d: number | null;
    }
    // links inside chains (barriers); pieces are ordered upstream to downstream
    const eIn: Edge[] = [];
    let cutNo = 0;
    for (let i = 0; i < pieces.length; i++) {
      if (pieces[i].piece < pieces[i].n_pieces) {
        const b = inner[cutNo++];
        eIn.push({ from: pieces[i].node_id, to: pieces[i + 1].node_id, type: b.rc_kind === 'natural' ? 'natural' : 'dam', id_barrier: b.bar_id, pass_u: b.pass_u, pass_d: b.pass_d });
      }
    }
    // links between chains (confluences, or barriers placed at reach ends)
    const eOut: (Edge & { child_chain: string })[] = [];
    chains.forEach((c, ci) => {
      if (c.down_chain === null) return;
      eOut.push({
        child_chain: c.chain_id,
        from: lastNode[ci],
        to: firstNode[chainIdx.get(c.down_chain)!],
        type: 'joint',
        id_barrier: null,
        pass_u: null,
        pass_d: null,
      });
    });
    // a barrier at the downstream end of a reach sits on the reach's outgoing
    // link; one at the upstream end sits on every link entering the reach
    const barAll = new Map<string, { pass_u: number; pass_d: number; kind: string }>();
    for (const r of await db.query('SELECT bar_id, pass_u, pass_d, rc_kind FROM rc_barriers')) {
      barAll.set(r.bar_id, { pass_u: r.pass_u, pass_d: r.pass_d, kind: r.rc_kind });
    }
    const endMap: { child_chain: string; bar: string }[] = [];
    for (const r of snapAll.filter((x) => x.position === 'downstream_end')) endMap.push({ child_chain: r.chain_id, bar: r.bar_id });
    for (const r of snapAll.filter((x) => x.position === 'upstream_end')) {
      for (const c of chains) if (c.down_chain === r.chain_id) endMap.push({ child_chain: c.chain_id, bar: r.bar_id });
    }
    const seenChild = new Set<string>();
    const conflict: string[] = [];
    const endUnique: typeof endMap = [];
    for (const e of endMap) {
      if (seenChild.has(e.child_chain)) conflict.push(e.bar);
      else {
        seenChild.add(e.child_chain);
        endUnique.push(e);
      }
    }
    const outIdx = new Map(eOut.map((e, i) => [e.child_chain, i]));
    for (const e of endUnique) {
      const k = outIdx.get(e.child_chain);
      if (k === undefined) continue;
      const b = barAll.get(e.bar)!;
      eOut[k].type = b.kind === 'natural' ? 'natural' : 'dam';
      eOut[k].id_barrier = e.bar;
      eOut[k].pass_u = b.pass_u;
      eOut[k].pass_d = b.pass_d;
    }
    const edges = [...eIn, ...eOut];

    await loadTable(
      db,
      'rc_pieces',
      {
        chain_id: pieces.map((p) => p.chain_id), node_id: pieces.map((p) => p.node_id), piece: pieces.map((p) => p.piece),
        n_pieces: pieces.map((p) => p.n_pieces), f0: pieces.map((p) => p.f0), f1: pieces.map((p) => p.f1),
      },
      { chain_id: 'VARCHAR', node_id: 'VARCHAR', piece: 'INTEGER', n_pieces: 'INTEGER', f0: 'DOUBLE', f1: 'DOUBLE' },
    );
    await db.exec(
      `CREATE OR REPLACE TABLE rc_nodes AS
       WITH p AS (
         SELECT p.node_id, p.piece, p.f0, p.f1,
                CASE WHEN p.n_pieces = 1 THEN c.geom ELSE ST_LineSubstring(c.geom, p.f0, p.f1) END AS geom,
                c.* EXCLUDE (geom, geom_m)
         FROM rc_pieces p JOIN rc_chains c USING (chain_id)
       )
       SELECT *, ST_Length_Spheroid(ST_FlipCoordinates(geom)) AS length_m, chain_length_km * (f1 - f0) AS length_attr_km FROM p`,
    );
    await db.exec('DROP TABLE rc_pieces');
    await loadTable(
      db,
      'rc_edges',
      {
        from: edges.map((e) => e.from), to: edges.map((e) => e.to), type: edges.map((e) => e.type),
        id_barrier: edges.map((e) => e.id_barrier), pass_u: edges.map((e) => e.pass_u), pass_d: edges.map((e) => e.pass_d),
      },
      { from: 'VARCHAR', to: 'VARCHAR', type: 'VARCHAR', id_barrier: 'VARCHAR', pass_u: 'DOUBLE', pass_d: 'DOUBLE' },
    );
    this.tables.add('rc_nodes');
    this.addCheck(
      checkRow(
        'barriers',
        'one_barrier_per_link',
        conflict,
        `${conflict.length} barriers fall on a link that already has a barrier and were dropped.`,
        'Two barriers at the same confluence; keep only one in the barrier table.',
        'info',
      ),
    );
  }

  // -- 8. attach --

  /**
   * Attaches point data (for example habitat suitability) to the nearest
   * reach: `columns` of `src` become reach columns.
   */
  async attach(
    src: Source,
    columns: string[],
    o: ReadOptions & { maxDist?: number; prefix?: string; at?: 'centroid' | 'line' } = {},
  ): Promise<void> {
    const { db } = this;
    this.need('rc_nodes');
    const maxDist = o.maxDist ?? 10000;
    const prefix = o.prefix ?? '';
    const at = o.at ?? 'centroid';
    await this.readLayer(src, 'rc_points', o);
    const sel = columns.map((c) => `p.${sqlId(c)} AS ${sqlId(prefix + c)}`).join(', ');
    await db.exec(
      `CREATE OR REPLACE TABLE rc_attach AS
       WITH n AS (SELECT node_id, ${this.toM(at === 'centroid' ? 'ST_Centroid(geom)' : 'geom')} AS g FROM rc_nodes),
       p AS (SELECT *, ${this.toM('geom')} AS g FROM rc_points)
       SELECT n.node_id, ST_Distance(n.g, p.g) AS attach_dist_m, ${sel}
       FROM n JOIN p ON ST_DWithin(n.g, p.g, ${sqlNum(maxDist)})
       QUALIFY row_number() OVER (PARTITION BY n.node_id ORDER BY ST_Distance(n.g, p.g)) = 1`,
    );
    const newCols = ['attach_dist_m', ...columns.map((c) => prefix + c)];
    const have = (await db.query('DESCRIBE rc_nodes')).map((r) => String(r.column_name));
    const existing = newCols.filter((c) => have.includes(c));
    const excl = existing.length ? `EXCLUDE (${existing.map(sqlId).join(', ')})` : '';
    await db.exec(
      `CREATE OR REPLACE TABLE rc_nodes AS
       SELECT n.* ${excl}, ${newCols.map((c) => `a.${sqlId(c)}`).join(', ')} FROM rc_nodes n LEFT JOIN rc_attach a USING (node_id)`,
    );
    const miss = col<string>(await db.query('SELECT node_id FROM rc_nodes WHERE attach_dist_m IS NULL'), 'node_id');
    this.addCheck(
      checkRow(
        'weights',
        `attach_${columns.join('_')}`,
        miss,
        `${miss.length} reaches have no point within ${maxDist} m; attached values are missing.`,
        'Increase max_dist or check the coverage of the point data.',
      ),
    );
  }

  // -- 9. build --

  /** Returns the river network. Aborts if any check has severity "error". */
  async build(o: BuildOptions = {}): Promise<RcNetwork> {
    const { db } = this;
    this.need('rc_nodes');
    const length = o.length ?? 'geodesic';
    const unit = o.lengthUnit ?? 'km';
    const errs = this.checks.filter((c) => c.severity === 'error');
    if (errs.length) throw new Error(`Geoprocessing checks failed: ${errs.map((e) => e.message).join(' ')}`);
    const rows = await db.query('SELECT * EXCLUDE (geom), ST_AsText(geom) AS ".wkt" FROM rc_nodes');
    const wkt = col<string>(rows, '.wkt');
    const f = { km: 1, m: 1000, '10km': 0.1 }[unit];
    const lengths = rows.map((r) => (length === 'geodesic' ? r.length_m / 1000 : r.length_attr_km) * f);
    const names = Object.keys(rows[0] ?? {}).filter((c) => c !== '.wkt');
    const nodes = rowsToTable(rows, names, ['node_id']);
    const ordered: Table = { node_id: nodes.node_id, length: Float64Array.from(lengths) };
    for (const c of names) if (c !== 'node_id') ordered[c] = nodes[c];
    const edgeRows = await db.query('SELECT * FROM rc_edges');
    const edges = rowsToTable(edgeRows, ['from', 'to', 'type', 'id_barrier', 'pass_u', 'pass_d'], ['from', 'to', 'type', 'id_barrier']);
    const net = createNetwork(this.core, ordered, edges, { id: 'node_id' });
    net.geometry = wkt;
    net.barrierGeometry = (
      await db.query(
        `SELECT e.id_barrier, e.type, ST_AsText(ST_EndPoint(n.geom)) AS wkt
         FROM rc_edges e JOIN rc_nodes n ON n.node_id = e."from" WHERE e.id_barrier IS NOT NULL`,
      )
    ).map((r) => ({ id_barrier: r.id_barrier as string, wkt: r.wkt as string, type: r.type as string }));
    return net;
  }

  // -- views for the map and the stage summaries --

  /** GeoJSON FeatureCollection of a table (lon/lat), with the given property columns. */
  async geojson(table: string, props: string[], where = ''): Promise<GeoJSON.FeatureCollection> {
    const sel = props.map((p) => sqlId(p)).join(', ');
    return this.featureCollection(`SELECT ${sel ? sel + ',' : ''} geom FROM ${table} ${where}`, props);
  }

  /** GeoJSON FeatureCollection of a query that returns a `geom` column plus `props`. */
  async featureCollection(sql: string, props: string[]): Promise<GeoJSON.FeatureCollection> {
    const rows = await this.db.query(`SELECT * EXCLUDE (geom), ST_AsGeoJSON(geom) AS "_g" FROM (${sql})`);
    return {
      type: 'FeatureCollection',
      features: rows.map((r) => ({
        type: 'Feature',
        geometry: JSON.parse(r._g),
        properties: Object.fromEntries(props.map((p) => [p, r[p]])),
      })),
    };
  }

  async count(table: string): Promise<number> {
    return Number((await this.db.query(`SELECT count(*) AS n FROM ${table}`))[0].n);
  }

  has(table: string): boolean {
    return this.tables.has(table);
  }
}

/** Rows -> columnar Table: numbers become Float64Array (null = NaN). */
export function rowsToTable(rows: Row[], names: string[], stringCols: string[] = []): Table {
  const t: Table = {};
  for (const name of names) {
    const vals = rows.map((r) => r[name]);
    const first = vals.find((x) => x !== null && x !== undefined);
    if (stringCols.includes(name) || typeof first === 'string') {
      t[name] = vals.map((x) => (x === null || x === undefined ? null : String(x)));
    } else {
      t[name] = Float64Array.from(vals, (x) => (x === null || x === undefined ? NaN : typeof x === 'boolean' ? Number(x) : Number(x)));
    }
  }
  return t;
}

export type { SqlType };
