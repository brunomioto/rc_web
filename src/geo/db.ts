// Minimal async database interface the geoprocessing pipeline talks to. It is
// implemented over duckdb-wasm (browser worker) and over the Node blocking
// build (tests), so the same SQL runs in both.

export type Row = Record<string, any>;

export interface Db {
  /** Runs a query and returns its rows (BigInt values become numbers). */
  query(sql: string): Promise<Row[]>;
  exec(sql: string): Promise<void>;
  /** Makes `data` readable by DuckDB / GDAL under the virtual path `name`. */
  registerFile(name: string, data: Uint8Array): Promise<void>;
  registerText(name: string, text: string): Promise<void>;
  dropFile(name: string): Promise<void>;
}

export const sqlStr = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export const sqlId = (s: string): string => `"${s.replace(/"/g, '""')}"`;
/** A DOUBLE literal that round-trips exactly (JS prints the shortest exact form). */
export const sqlNum = (x: number): string => {
  if (!Number.isFinite(x)) throw new Error(`cannot put ${x} in SQL`);
  return `${x}::DOUBLE`;
};

/** Converts query values: BigInt -> number, typed arrays -> arrays. */
export function plain(v: any): any {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && typeof v.toArray === 'function') return Array.from(v.toArray(), plain);
  if (Array.isArray(v)) return v.map(plain);
  return v;
}

export type SqlType = 'VARCHAR' | 'DOUBLE' | 'INTEGER' | 'BIGINT';

let fileCounter = 0;

/**
 * Creates (or replaces) a table from columns of JS values. Goes through a
 * temporary JSON file, which scales better than a giant VALUES list.
 */
export async function loadTable(
  db: Db,
  table: string,
  columns: Record<string, any[]>,
  types: Record<string, SqlType>,
): Promise<void> {
  const names = Object.keys(columns);
  const n = names.length ? columns[names[0]].length : 0;
  const cols = names.map((c) => `${sqlStr(c)}: ${sqlStr(types[c])}`).join(', ');
  if (n === 0) {
    await db.exec(
      `CREATE OR REPLACE TABLE ${table} AS SELECT ${names
        .map((c) => `NULL::${types[c]} AS ${sqlId(c)}`)
        .join(', ')} WHERE false`,
    );
    return;
  }
  const rows: string[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o: Record<string, any> = {};
    for (const c of names) {
      const v = columns[c][i];
      o[c] = typeof v === 'number' && !Number.isFinite(v) ? null : v;
    }
    rows[i] = JSON.stringify(o);
  }
  const file = `rc_tmp_${++fileCounter}.ndjson`;
  await db.registerText(file, rows.join('\n'));
  try {
    await db.exec(
      `CREATE OR REPLACE TABLE ${table} AS SELECT * FROM read_json(${sqlStr(file)}, format = 'newline_delimited', columns = {${cols}})`,
    );
  } finally {
    await db.dropFile(file);
  }
}
