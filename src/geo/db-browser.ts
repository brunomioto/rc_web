// Db over duckdb-wasm in the browser. DuckDB runs in its own worker (so the UI
// stays responsive); the wasm binaries and the spatial extension are served
// from this site (public/duckdb-ext, fetched by scripts/fetch-extension.mjs),
// so nothing is downloaded from a CDN at run time.
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbEhWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import duckdbMvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import { type Db, type Row, plain } from './db';

/** Must match the DuckDB version inside @duckdb/duckdb-wasm (see scripts/fetch-extension.mjs). */
export const DUCKDB_VERSION = 'v1.4.3';

export async function createBrowserDb(onStatus: (msg: string) => void = () => {}): Promise<Db> {
  onStatus('Starting DuckDB…');
  const bundle = await duckdb.selectBundle({
    mvp: { mainModule: duckdbMvpWasm, mainWorker: duckdbMvpWorker },
    eh: { mainModule: duckdbEhWasm, mainWorker: duckdbEhWorker },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();

  const run = async (sql: string) => conn.query(sql);
  onStatus('Loading the spatial extension…');
  const repo = new URL(`${import.meta.env.BASE_URL}duckdb-ext`, window.location.href).href;
  await run(`SET custom_extension_repository = '${repo}'`);
  for (const ext of ['json', 'spatial']) {
    await run(`INSTALL ${ext}`);
    await run(`LOAD ${ext}`);
  }
  onStatus('Ready');

  return {
    async query(sql: string): Promise<Row[]> {
      const table = await conn.query(sql);
      return table.toArray().map((r: any) => {
        const o = r.toJSON();
        for (const k of Object.keys(o)) o[k] = plain(o[k]);
        return o;
      });
    },
    async exec(sql: string) {
      await conn.query(sql);
    },
    async registerFile(name: string, data: Uint8Array) {
      await db.registerFileBuffer(name, data);
    },
    async registerText(name: string, text: string) {
      await db.registerFileText(name, text);
    },
    async dropFile(name: string) {
      await db.dropFile(name);
    },
  };
}
