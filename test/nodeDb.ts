// Db over the duckdb-wasm Node blocking build, for the Vitest geo tests.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type Db, type Row, plain } from '../src/geo/db';

const require = createRequire(import.meta.url);

export async function createNodeDb(): Promise<Db> {
  const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
  const dist = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
  const bundles = {
    mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: join(dist, 'duckdb-node-eh.worker.cjs') },
  };
  const db = await duckdb.createDuckDB(bundles, new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), duckdb.NODE_RUNTIME);
  await db.instantiate(() => {});
  const conn = db.connect();
  conn.query('INSTALL spatial');
  conn.query('LOAD spatial');
  return {
    async query(sql: string): Promise<Row[]> {
      return conn
        .query(sql)
        .toArray()
        .map((r: any) => {
          const o = r.toJSON();
          for (const k of Object.keys(o)) o[k] = plain(o[k]);
          return o;
        });
    },
    async exec(sql: string) {
      conn.query(sql);
    },
    async registerFile(name: string, data: Uint8Array) {
      db.registerFileBuffer(name, data);
    },
    async registerText(name: string, text: string) {
      db.registerFileText(name, text);
    },
    async dropFile(name: string) {
      db.dropFile(name);
    },
  };
}
