// Extracts the small golden subset used by the debug mode of the UI
// (public/example/ebro_golden.json) from test/golden/ebro_pipeline.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const g = JSON.parse(readFileSync(join(root, 'test', 'golden', 'ebro_pipeline.json'), 'utf8'));
const lengthOnly = (c) => c.weight.length === 1 && c.weight[0] === 'length';
const allOnes = (c) => c.barriers.pass_u_updated.every((x) => x === 1) && c.barriers.pass_d_updated.every((x) => x === 1);
const keep = (c) => ({ case: c.case, weight: c.weight, type: c.type, mode: c.mode, spec: c.spec, expected: c.expected, barriers: c.barriers });
const out = {
  note: 'rc2 results on the Ebro network built by the default pipeline (tools/make_golden.R).',
  index: g.index.filter((c) => lengthOnly(c) && c.type !== 'reach').map(keep),
  dindex: g.dindex.filter((c) => lengthOnly(c) && c.type !== 'reach' && allOnes(c)).map(keep),
};
mkdirSync(join(root, 'public', 'example'), { recursive: true });
const file = join(root, 'public', 'example', 'ebro_golden.json');
writeFileSync(file, JSON.stringify(out));
console.log(`wrote ${file}: ${out.index.length} index and ${out.dindex.length} prioritisation cases`);
