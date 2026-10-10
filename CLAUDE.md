# rc-web

River connectivity analysis (DCI, PCI and relatives, leave-one-out barrier prioritisation) running 100 % in the browser: a static site (Vite + TypeScript) with no server and no R. Its numbers must equal those of the R reference (`rc2`) and of the original package it reimplements, to a relative tolerance of 1e-10.

## Naming rule
The word for the original R package must never appear in this repo (code, comments, docs, JSON, file names), because the repo goes public and must not be findable under that name. Say "rc2" or "the reference" instead. The "upstream" distance option is the value that package calls by its own name. Check before finishing any task:
`grep -rli "river""conn" --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude=CLAUDE.local.md .` (the pattern is split here only so this file does not match itself; it must print nothing).
The local folder name is not part of the repo content and does not count.

## Layout
- `core/`: C++17 (`dp.h`, `rc_core.cpp`), a plain C API over raw buffers; built to `src/engine/wasm/rc_core.js` (wasm embedded, committed).
- `src/engine/`: network, spec, index, dindex (leave-one-out), merge (pool results), checks, convert; `core.ts` wraps the wasm.
- `src/geo/`: `pipeline.ts` (rivers, basin, prune, merge_chains, barriers, snap, split, attach, build, as DuckDB spatial SQL), `db.ts` (interface), `db-browser.ts` (duckdb-wasm).
- `src/worker/`: engine workers (Comlink) and the pool (`client.ts`).
- `src/ui/`: wizard (10 steps in `steps-*.ts`), `map.ts` (MapLibre, tooltips), `indexForm.ts`, `charts.ts`, `golden.ts` (debug check).
- `test/`: Vitest. `test/golden/*.json` come from R (`tools/make_golden.R`); `test/fixtures/` hold other input formats (`tools/make_fixtures.R`).
- `scripts/`: wasm build, extension download, golden subset for the UI, browser end-to-end test.

## Commands
- `npm run dev` / `npm run build` (both fetch the DuckDB extensions into `public/duckdb-ext/` first), `npm run preview`
- `npm test`: all parity tests (about 20 s). `npm run typecheck`.
- `npm run e2e`: real Chrome/Edge through the wizard (needs a server, see the header of `scripts/e2e-browser.mjs`).
- `npm run build:wasm` (emsdk, uses `em++`), `npm run golden` (needs `RC2_DIR`), `npm run golden:ui`.

## Fixed decisions
- Compare numbers with a tolerance, never with exact equality; 1e-10 relative (with a floor of 1 on the magnitude).
- Distance convention default is `upstream` (an edge costs the length of the upstream reach); `midpoint` is the option.
- Reaches are cut exactly at the snapped barrier; indices are computed per network when there are several outlets.
- Natural barriers (waterfalls) are a separate layer: they reduce connectivity but are neither ranked nor part of the CAFI-like sum. Link types are `dam`, `natural` and `joint`.
- Pipeline left out of v1: `topology = "geometry"`, snap `method = "vertex"`, length `s2`.
- No GPL dependencies. Do not publish, deploy or push unless asked. Commit only when asked.
- The wasm core keeps the summation order of the reference (it matters for threshold ties); `erfc` replaces R's `pnorm`.

## Gotchas
- duckdb-wasm 1.32.0 is DuckDB v1.4.3, the R package used for the golden files is newer; `ST_LineSubstring` differs by a repeated vertex at cuts (lengths agree). The extensions (spatial, json, parquet) are served from this site; their version must match the wasm build.
- In Node the DuckDB runtime lets GDAL probe sidecar files in the working directory: tests run from a temp dir (`test/setup.ts`).
- The shell tool mangles heredocs with quotes or backslashes: write files with the editor tools.
- A step in the wizard owns its map layers: `MapView.clear()` removes layers and tooltips; tooltips are registered once per layer.
- `public/example/ebro.gpkg` is HydroRIVERS data (HydroSHEDS licence, attribution in the README and the UI): check the terms before hosting a public copy.

## Style
- Answer the user in Portuguese; code, comments, UI text and docs in English.
- Match the surrounding code; keep explanations short and concrete.
