// Downloads the DuckDB extensions the app uses (wasm builds) into public/duckdb-ext
// so the site serves them itself instead of reaching extensions.duckdb.org at
// run time: spatial (geoprocessing), json (GeoJSON output; spatial depends on it)
// and parquet (GeoParquet input). The version must match the DuckDB inside
// @duckdb/duckdb-wasm.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.env.DUCKDB_VERSION || 'v1.4.3';
const EXTENSIONS = ['spatial', 'json', 'parquet'];
const out = join(root, 'public', 'duckdb-ext', VERSION, 'wasm_eh');
mkdirSync(out, { recursive: true });

const pkg = JSON.parse(readFileSync(join(root, 'node_modules', '@duckdb', 'duckdb-wasm', 'package.json'), 'utf8'));
for (const name of EXTENSIONS) {
  const file = join(out, `${name}.duckdb_extension.wasm`);
  if (existsSync(file) && statSync(file).size > 1e5) {
    console.log(`${name} extension already present (${VERSION}, duckdb-wasm ${pkg.version})`);
    continue;
  }
  const url = `https://extensions.duckdb.org/${VERSION}/wasm_eh/${name}.duckdb_extension.wasm`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`download failed: HTTP ${res.status}`);
    process.exit(1);
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`saved ${file} (${(statSync(file).size / 1e6).toFixed(1)} MB)`);
}
