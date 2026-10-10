# rc-web

River connectivity analysis (DCI, PCI and relatives, leave-one-out barrier
prioritisation) running **100 % in the browser**: a static site, no server, no R.
It reproduces the numbers of `rc2` (the R implementation) and of the original R package it
rewrites, to a relative tolerance of 1e-10.

Open the page, load a river layer and a barrier layer (or the bundled Ebro example),
step through the wizard and get maps, plain-language results and CSV/GeoJSON exports.
Your files are never uploaded.

## What the wizard does

1. **Data**: GeoPackage, GeoJSON, shapefile (+ sidecars), GeoParquet or CSV; rivers, dams and,
   optionally, a separate layer of **natural barriers** (waterfalls).
2. **Rivers** → 3. **Prune** (live: the map follows what you type) → 4. **Merge** chains →
5. **Barriers**: editable passabilities, **upstream ↑ and downstream ↓ separately**, for dams and
   for waterfalls; snapping → 6. **Split** at the barriers and build the network → 7. **Checks**.
8. **Indices**: presets (DCI, direction-aware DCI, PCI, threshold) with a plain-language
   explanation, a result card (index, comparison with the barrier-free river), the map coloured
   reach by reach and the distribution of the reaches.
9. **Prioritisation**: which dam, fixed alone, improves the index most (top 10, map, full ranking).
   Waterfalls reduce connectivity but are not ranked.
10. **Export**: one card per file, with its columns and a preview; hovering a card highlights it on the map.

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173 ; add ?debug=1 to check results against the golden values
npm test             # Vitest: parity with the references at 1e-10
npm run build        # static site in dist/ (any static host, no special headers)
npm run e2e          # real Chrome/Edge through the whole wizard (needs a dev or preview server)
```

`npm run dev` and `npm run build` first download the DuckDB extensions (spatial, json,
parquet; ~27 MB) into `public/duckdb-ext/`, so the app serves them itself and reaches no
CDN at run time. Their version must match the DuckDB inside the pinned
`@duckdb/duckdb-wasm` (1.32.0 ↔ DuckDB v1.4.3).

## Architecture

```
index.html (Vite + TypeScript)
 ├─ UI: wizard (10 steps) + MapLibre GL map + tables           src/ui/
 ├─ main thread: GeoPipeline + duckdb-wasm (own worker) + spatial   src/geo/
 └─ pool of N engine workers (Comlink)                          src/worker/
     ├─ rc_core.wasm (Emscripten, plain C API)                  core/ → src/engine/wasm/
     └─ engine/*.ts: network, spec, index, dindex, merge        src/engine/
```

* **core/** (C++17): `dp.h` copied from rc2; topology, Strahler, chains, the rerooting DP,
  leave-one-out scenarios and the bounded (threshold / leptokurtic) searches. The R bindings
  are gone, the loops are serial, the summation order is preserved, and R's `pnorm` became
  `0.5 * erfc(D / (sd * sqrt(2)))`. The wasm is embedded in `src/engine/wasm/rc_core.js`
  (32 KB, committed), so building the site does not need Emscripten. Rebuild it with
  `npm run build:wasm` (emsdk in `~/emsdk` or `$EMSDK`).
* **src/engine/**: TypeScript port of the R layer: network validation, specifications, indices
  (including the CAFI-like sum), the leave-one-out prioritisation with its O(1) shortcut and
  the closed form for dams on confluences, checks.
* **src/geo/pipeline.ts**: rivers → basin → prune → merge_chains → barriers (dams, then natural
  barriers) → snap → split → attach → build, as DuckDB spatial SQL.
* **Parallelism**: the prioritisation is split by dam over N workers (own wasm instance each)
  and merged (`engine/merge.ts`, identical to a single-worker run). No SharedArrayBuffer, no
  COOP/COEP, no Emscripten pthreads.

## Parity

`tools/make_golden.R` (the only use of R, development only) runs rc2 from its sources and
exports JSON to `test/golden/`. Vitest compares with 1e-10 relative tolerance, never exact equality:

| test | against |
|------|---------|
| `random-trees` | the original package: 25 random trees, 80 index cases + 25 leave-one-out cases |
| `ebro-tutorial` | the original package on the Ebro tutorial network: 8 reach indices, 9 prioritisations |
| `ebro-native` | rc2 on the Ebro pipeline network: every index type, kernel and leave-one-out path |
| `geo-ebro` | each geoprocessing stage (counts, ids, lengths, snapping, split, checks) |
| `ebro-e2e` | duckdb-wasm pipeline **and** engine together vs rc2, 30 cases at 1e-10 |
| `geo-formats` | GeoJSON, UTM shapefile (+ sidecars) and CSV inputs give the same network |
| `natural` | waterfalls: same DCI as dams with equal passabilities; outside the CAFI sum and the ranking |
| `merge`, `core`, `engine-misc` | pool merge is exact; topology; validation, checks, derived weights |

Regenerate: `RC2_DIR=/path/to/rc2/sources npm run golden` (needs R, `pkgload`, `jsonlite`),
then `npm run golden:ui`. Fixtures in other formats: `Rscript tools/make_fixtures.R`.
The debug mode of the UI (`?debug=1`, Ebro example) says whether the run on screen equals a golden case.

Known, harmless difference: duckdb-wasm ships spatial for DuckDB 1.4.3, the R package used
for the golden files has a newer DuckDB. `ST_LineSubstring` repeats a vertex at the cut in 8
of 652 split reaches (same line, same length); lengths and indices agree to 1e-10.

## Scope

Left out of v1: length `s2`, snap `method = "vertex"` and `topology = "geometry"`
(tutorial-compatibility modes), the PWA / offline mode. `attach` exists in the pipeline but
has no wizard step; use "Derived weights" in step 6 for weights computed from reach columns.

## Data and licences

`public/example/ebro.gpkg` contains **HydroRIVERS** reaches and dam points. HydroRIVERS is part of
HydroSHEDS: Lehner, B., Grill, G. (2013). Global river hydrography and network routing:
baseline data and new approaches to study the world's large river systems. *Hydrological
Processes*, 27(15), 2171–2186. Check the HydroSHEDS licence terms before hosting a public copy.

All code dependencies are MIT / Apache / BSD (duckdb-wasm, MapLibre GL, Comlink, Vite, Vitest).
First load is about 8 MB (duckdb-wasm, gzip) plus the spatial extension (~23 MB, cached by the
browser). Tested in Chrome and Edge; Firefox not tested here.
