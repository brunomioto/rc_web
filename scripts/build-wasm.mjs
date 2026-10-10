// Compiles core/rc_core.cpp to src/engine/wasm/rc_core.js (wasm embedded,
// SINGLE_FILE) with Emscripten. Looks for emsdk in $EMSDK or ~/emsdk.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const emsdk = process.env.EMSDK || join(homedir(), 'emsdk');
const win = process.platform === 'win32';
const emcc = join(emsdk, 'upstream', 'emscripten', win ? 'em++.exe' : 'em++');
if (!existsSync(emcc)) {
  console.error(`em++ not found at ${emcc}. Install emsdk (https://emscripten.org) or set EMSDK.`);
  process.exit(1);
}

const sub = (dir, pre) => {
  const d = join(emsdk, dir);
  if (!existsSync(d)) return null;
  const hit = readdirSync(d).find((x) => x.startsWith(pre));
  return hit ? join(d, hit) : null;
};
const py = sub('python', '');
const nodeDir = sub('node', '');
const sep = win ? ';' : ':';
const env = {
  ...process.env,
  EM_CONFIG: join(emsdk, '.emscripten'),
  PATH: [join(emsdk, 'upstream', 'emscripten'), py, nodeDir && join(nodeDir, 'bin'), process.env.PATH]
    .filter(Boolean)
    .join(sep),
};

const exported = [
  'rc_alloc', 'rc_free', 'rc_smoke', 'rc_topology', 'rc_chains', 'rc_strahler',
  'rc_dp_mult', 'rc_loo_mult', 'rc_bounded',
].map((f) => `_${f}`);

const outDir = join(root, 'src', 'engine', 'wasm');
mkdirSync(outDir, { recursive: true });
const args = [
  join(root, 'core', 'rc_core.cpp'),
  '-std=c++17', '-O3', '-ffp-contract=off',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createRcCore',
  '-sSINGLE_FILE=1', '-sALLOW_MEMORY_GROWTH=1', '-sFILESYSTEM=0',
  '-sENVIRONMENT=web,worker,node',
  `-sEXPORTED_FUNCTIONS=${exported.join(',')}`,
  '-sEXPORTED_RUNTIME_METHODS=HEAPF64,HEAP32',
  '-o', join(outDir, 'rc_core.js'),
];
const r = spawnSync(emcc, args, { env, stdio: 'inherit' });
process.exit(r.status ?? 1);
