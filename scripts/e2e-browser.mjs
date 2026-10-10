// Browser test: runs the wizard in a real Chrome/Edge (playwright-core, no browser
// download).
//   Pass A: the Ebro example end to end, with the debug mode checking every result
//           against the rc2 golden values; live pruning; presets; the heavy kernel.
//   Pass B: the user's own files (GeoJSON rivers + CSV dams + a CSV of waterfalls),
//           editable passabilities, natural barriers kept out of the ranking.
//
//   npm run dev -- --port 5199     (or: npm run build && python -m http.server 5198 -d dist)
//   node scripts/e2e-browser.mjs [url] [chrome|msedge]
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const url = process.argv[2] || 'http://localhost:5199/?debug=1';
const which = process.argv[3] || 'chrome';
const exe = {
  chrome: ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'],
  msedge: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/microsoft-edge'],
}[which].find(existsSync);
if (!exe) throw new Error(`${which} not found`);
mkdirSync('scratch', { recursive: true });

const browser = await chromium.launch({ executablePath: exe, headless: true });
const errors = [];
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('ready'), null, { timeout: 180_000 });
  return page;
}
const helpers = (page, tag) => ({
  click: (text) => page.getByRole('button', { name: text, exact: true }).first().click(),
  text: (text, timeout = 120_000) => page.getByText(text).first().waitFor({ timeout }),
  step: (name) => page.locator('nav.steps button.step', { hasText: name }).click(),
  shot: (name) => page.screenshot({ path: `scratch/shot-${tag}-${name}.png` }),
});

try {
  // ------------------------------------------------------------------ pass A
  let page = await newPage();
  let { click, text, step, shot } = helpers(page, 'a');
  log('engine ready (duckdb-wasm + spatial + rc_core)');

  await click('Load the Ebro example');
  await text('2. Rivers');
  await click('Read the rivers');
  await text('River layer read.');
  log('rivers read');

  // prune: runs by itself, then follows what is typed
  await step('Prune');
  await text('Reaches kept');
  const kept = async () => (await page.locator('.kv').first().innerText()).replace(/\s+/g, ' ');
  const first = await kept();
  log('prune (80): ' + first);
  await page.locator('input[type=number]').first().fill('400');
  await page.waitForFunction((was) => document.querySelector('.kv')?.innerText.replace(/\s+/g, ' ') !== was, first, { timeout: 15_000 });
  const second = await kept();
  log('prune (400, typed, no click): ' + second);
  if (second === first) throw new Error('prune did not update live');
  await page.locator('input[type=number]').first().fill('80');
  await page.waitForFunction((was) => document.querySelector('.kv')?.innerText.replace(/\s+/g, ' ') === was, first, { timeout: 15_000 });
  await page.locator('input[type=number]').nth(1).fill('3');
  await page.waitForFunction((was) => document.querySelector('.kv')?.innerText.replace(/\s+/g, ' ') !== was, first, { timeout: 15_000 });
  log('prune (order 3, typed): ' + (await kept()));
  await page.locator('input[type=number]').nth(1).fill('0');
  await page.waitForFunction((was) => document.querySelector('.kv')?.innerText.replace(/\s+/g, ' ') === was, first, { timeout: 15_000 });
  await shot('3-prune');

  await step('Merge');
  await click('Merge');
  await text('Merged.');

  await step('Barriers');
  const up = page.getByLabel('↑ Upstream').first();
  if ((await up.inputValue()) !== '0.1') throw new Error('example passability ↑ should start at 0.1');
  await click('Read and snap');
  await text('Barriers snapped.');
  log('barriers: ' + (await page.locator('.swatches').innerText()).replace(/\s+/g, ' '));
  await shot('5-barriers');

  await step('Split');
  await click('Split and build');
  await text('Network built.');
  log('network: ' + (await page.locator('.kv').last().innerText()).replace(/\s+/g, ' '));
  await shot('6-split');

  await step('Checks');
  await text('Checks');

  // indices: the default preset is computed on entry
  await step('Indices');
  await text('Debug: golden case dci_sym');
  let line = await page.getByText('Debug: golden case').first().innerText();
  log(line);
  if (!line.includes('OK')) throw new Error('DCI does not match golden');
  await shot('8-index');
  await click('PCI (distance decay)');
  await page.getByText('Debug: golden case pci_exp').first().waitFor({ timeout: 60_000 });
  line = await page.getByText('Debug: golden case').first().innerText();
  log(line);
  if (!line.includes('OK')) throw new Error('PCI does not match golden');
  await click('Threshold (IIC-like)');
  await page.getByText('Debug: golden case thr_full').first().waitFor({ timeout: 60_000 });
  line = await page.getByText('Debug: golden case').first().innerText();
  log(line);
  if (!line.includes('OK')) throw new Error('threshold index does not match golden');
  await click('DCI');
  await page.getByText('Debug: golden case dci_sym').first().waitFor({ timeout: 60_000 });
  await shot('8-index-dci');

  await step('Prioritisation');
  await click('Rank the dams');
  await text('Debug: golden case full_dci_sym', 180_000);
  line = await page.getByText('Debug: golden case').first().innerText();
  log(line);
  if (!line.includes('OK')) throw new Error('prioritisation does not match golden');
  await shot('9-priority');
  // heavy kernel: every scenario is a full search, split across the worker pool
  await page.locator('details.advanced > summary').click();
  await page.getByLabel('Dispersal kernel').selectOption({ label: 'Leptokurtic (two Gaussians)' });
  await click('Rank the dams');
  await page.getByText(/Computed in \d+ ms for 100 dams: full · symmetric barriers · leptokurtic/).first().waitFor({ timeout: 300_000 });
  log((await page.getByText(/Computed in \d+ ms/).first().innerText()).slice(0, 140));

  await step('Export');
  await text('Index results');
  await page.locator('.export-card', { hasText: 'Barriers' }).first().hover();
  await shot('10-export');

  // tooltips: hover cards one at a time, never more handlers than layers, no popup left behind
  const handlers = await page.evaluate(() => window.__rc.map.tooltipCount);
  if (handlers > 3) throw new Error(`tooltip handlers accumulate (${handlers})`);
  await step('Barriers');
  await step('Split');
  await step('Indices');
  await step('Export');
  const after = await page.evaluate(() => ({ handlers: window.__rc.map.tooltipCount, popups: document.querySelectorAll('.rc-tip').length }));
  if (after.handlers > 3 || after.popups !== 0) throw new Error(`tooltips leak across steps: ${JSON.stringify(after)}`);
  log(`tooltips ok (${after.handlers} layer handlers, ${after.popups} popups left)`);
  await page.close();

  // ------------------------------------------------------------------ pass B
  page = await newPage();
  ({ click, text, step, shot } = helpers(page, 'b'));
  const files = page.locator('input[type=file]');
  await files.nth(0).setInputFiles('test/fixtures/ebro_rivers.geojson');
  await text('Loaded ebro_rivers.geojson');
  await files.nth(1).setInputFiles('test/fixtures/ebro_dams.csv');
  await files.nth(2).setInputFiles('test/fixtures/ebro_falls.csv');
  await text('Loaded ebro_falls.csv');
  // the barrier layers are CSV tables: pick their id columns
  await page.getByLabel('Barrier id column').first().selectOption('dam_id');
  await page.getByLabel('Barrier id column').nth(1).selectOption('fall_id');
  await shot('1-data');
  await click('Use these files');
  await text('2. Rivers');
  await click('Read the rivers');
  await text('River layer read.');
  await step('Prune');
  await text('Reaches kept');
  await step('Merge');
  await click('Merge');
  await text('Merged.');
  await step('Barriers');
  // dams: 0.1 up / 0.8 down; waterfalls keep their defaults (0 up / 1 down)
  await page.getByLabel('↑ Upstream').first().fill('0.1');
  await page.getByLabel('↓ Downstream').first().fill('0.8');
  await click('Read and snap');
  await text('Barriers snapped.');
  const sw = (await page.locator('.swatches').innerText()).replace(/\s+/g, ' ');
  log('own data barriers: ' + sw);
  if (!sw.includes('natural barrier on the river')) throw new Error('waterfalls were not placed on the river');
  await shot('5-barriers');
  await step('Split');
  await click('Split and build');
  await text('Network built.');
  const kv = (await page.locator('.kv').last().innerText()).replace(/\s+/g, ' ');
  log('own data network: ' + kv);
  if (!kv.includes('Natural barrier links')) throw new Error('no natural links in the network');
  await shot('6-split');
  await step('Indices');
  await text('Show the numbers');
  await step('Prioritisation');
  await click('Rank the dams');
  await text('Top 10 dams');
  const top = await page.locator('.hbars').innerText();
  if (/nat_|\bf\d\b/.test(top)) throw new Error('a waterfall appeared in the ranking');
  await shot('9-priority');
  await step('Export');
  await text('Natural barriers');
  await shot('10-export');
  log('DONE');
} catch (e) {
  console.error('FAILED:', e.message);
  console.error(errors.join('\n'));
  await browser.close();
  process.exit(1);
}
if (errors.length) console.log('console errors:\n' + errors.join('\n'));
await browser.close();
