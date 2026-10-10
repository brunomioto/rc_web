// The duckdb-wasm Node runtime lets GDAL probe for sidecar files (.aux, .cpg, ...)
// in the working directory and may create empty ones: run the tests from a
// scratch directory so the repository stays clean.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'rc-web-test-'));
process.chdir(dir);
process.on('exit', () => {
  try {
    process.chdir(tmpdir());
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
