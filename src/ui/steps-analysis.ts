// Steps 8-10: indices, barrier prioritisation and export.
import type { Barriers } from '../engine/dindex';
import type { IndexOptions } from '../engine/index';
import { strCol, type Table } from '../engine/types';
import { hbars, histogram, percentileOf, summarize } from './charts';
import type { Ctx, IndexCfg } from './ctx';
import { download, field, fmt, h, numberInput, select, tableEl, toCsv } from './dom';
import { checkGolden } from './golden';
import { describeOptions, indexForm, toOptions } from './indexForm';
import { type Step, kv, note, runButton, stepResults } from './step';
import { parseWktPoint } from './steps-geo';

const ms = (t0: number) => Math.round(performance.now() - t0);
const pct = (x: number, digits = 3) => fmt(x * 100, digits);

function colRange(a: ArrayLike<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of Array.from(a)) {
    if (Number.isFinite(x)) {
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

/** Names of the columns defined in the derived-weights box. */
function derivedNames(ctx: Ctx): string[] {
  return ctx.cfg.derived.split('\n').flatMap((l) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l);
    return m ? [m[1]] : [];
  });
}

/** Plain network on the map, so the map is never blank while a result is a table. */
async function drawNetwork(ctx: Ctx, color = '#2a788e'): Promise<void> {
  const fc = ctx.results.nodesGeo;
  if (!fc) return;
  await ctx.map.clear();
  ctx.map.setLegend(null);
  await ctx.map.setData('nodes', 'line', fc, { color, width: 1.5 });
  await ctx.map.fitTo(fc);
}

function needNet(ctx: Ctx): NonNullable<Ctx['net']> {
  if (!ctx.net) throw new Error('Build the network first (step 6).');
  return ctx.net;
}

// ---- 8. indices -------------------------------------------------------------

interface Preset {
  id: string;
  label: string;
  blurb: string;
  apply(c: IndexCfg): void;
}

const PRESETS: Preset[] = [
  {
    id: 'dci',
    label: 'DCI',
    blurb: 'Dendritic Connectivity Index: only barriers matter, distance does not. The classic score for river fragmentation.',
    apply: (c) => Object.assign(c, { type: 'full', useBarriers: true, direction: 'symmetric', kernel: 'none' }),
  },
  {
    id: 'dci-asym',
    label: 'DCI, direction-aware',
    blurb: 'Same as the DCI, but a barrier counts with its upstream passability when fish swim up and with its downstream passability when they swim down.',
    apply: (c) => Object.assign(c, { type: 'full', useBarriers: true, direction: 'asymmetric', kernel: 'none' }),
  },
  {
    id: 'pci',
    label: 'PCI (distance decay)',
    blurb: 'Probability of Connectivity: barriers and distance both reduce the chance that two places are connected.',
    apply: (c) => Object.assign(c, { type: 'full', useBarriers: true, direction: 'symmetric', kernel: 'exponential', kernelDirection: 'symmetric', param: 0.95 }),
  },
  {
    id: 'iic',
    label: 'Threshold (IIC-like)',
    blurb: 'Two places count as connected only if they are closer than a threshold distance and no barrier blocks the way.',
    apply: (c) => Object.assign(c, { type: 'full', useBarriers: true, direction: 'symmetric', kernel: 'threshold', kernelDirection: 'symmetric', param: 25 }),
  },
];

/** What the chosen specification means, in plain words. */
function explain(c: IndexCfg): { name: string; what: string; barriers: string } {
  const w = c.weight.length === 1 && c.weight[0] === 'length' ? 'river length' : `the weight${c.weight.length > 1 ? 's' : ''} ${c.weight.join(', ')}`;
  const barriers = !c.useBarriers && c.type !== 'sum'
    ? 'Barriers are ignored: only distance matters.'
    : c.direction === 'symmetric'
      ? 'A barrier counts with ↑ × ↓ (its upstream times its downstream passability) whichever way fish cross it.'
      : 'Fish swimming up cross a barrier with its upstream passability ↑, fish swimming down with its downstream passability ↓.';
  if (c.type === 'sum') {
    return {
      name: 'Fragmentation sum (CAFI-like)',
      what: `For every dam: the share of the habitat upstream of it (measured in ${w}) that the dam cuts off, (1 − passability) × upstream weight ÷ largest weight. The sum over all dams: higher means a more fragmented network. Natural barriers are not counted.`,
      barriers,
    };
  }
  const base = `Take two random points of the river (chosen in proportion to ${w}): `;
  if (c.kernel === 'exponential') {
    return { name: 'PCI', what: `${base}the index is how likely it is that one can reach the other. Barriers on the way reduce that chance, and every unit of length multiplies it by ${fmt(c.kernelDirection === 'symmetric' ? c.param : c.paramU)}.`, barriers };
  }
  if (c.kernel === 'threshold') {
    return { name: 'Threshold index', what: `${base}they count as connected only if they are closer than ${fmt(c.kernelDirection === 'symmetric' ? c.param : c.paramD)} length units and no barrier blocks the way.`, barriers };
  }
  if (c.kernel === 'leptokurtic') {
    return { name: 'Leptokurtic dispersal index', what: `${base}the chance to reach each other follows two Gaussians: stationary fish (scale ${fmt(c.sigmaStat)}, ${pct(c.p, 2)} %) and mobile fish (scale ${fmt(c.sigmaMob)}).`, barriers };
  }
  return { name: 'DCI', what: `${base}the index is how likely it is that a fish can swim from one to the other crossing every barrier in between. 100 % means no barrier is in the way.`, barriers };
}

export const indexStep: Step = {
  id: 'index',
  title: 'Indices',
  blurb: 'How well connected is the river? Pick an index; the answer, the map and the distribution update at once.',
  needs: [5],
  async render(ctx, root, i) {
    const cfg = ctx.cfg.index;
    cfg.type = cfg.type === 'sum' ? 'sum' : 'full'; // per-reach values are always computed, for the map
    const presetRow = h('div', { class: 'presets', role: 'group', 'aria-label': 'Index presets' });
    const desc = h('p', { class: 'preset-desc' });
    const out = h('div', { class: 'results' });
    const adv = h('div');

    const drawPresets = () => {
      presetRow.replaceChildren(
        ...PRESETS.map((p) =>
          h('button', { type: 'button', class: `chip-btn${ctx.cfg.indexPreset === p.id ? ' on' : ''}`, 'aria-pressed': ctx.cfg.indexPreset === p.id, onClick: () => choose(p) }, p.label),
        ),
        h('button', { type: 'button', class: `chip-btn${ctx.cfg.indexPreset === 'custom' ? ' on' : ''}`, 'aria-pressed': ctx.cfg.indexPreset === 'custom', onClick: () => openAdvanced() }, 'Custom…'),
      );
      const p = PRESETS.find((x) => x.id === ctx.cfg.indexPreset);
      desc.textContent = p ? p.blurb : 'Custom settings: open "Advanced settings" below, change what you need and press "Update the results".';
    };
    const advDetails = h('details', { class: 'advanced' }, h('summary', {}, 'Advanced settings'), adv);
    const drawAdvanced = () =>
      adv.replaceChildren(
        indexForm(cfg, ctx.net, () => {
          ctx.cfg.indexPreset = 'custom';
          drawPresets();
        }, { types: ['full', 'sum'], featured: derivedNames(ctx), showMode: true }),
        h('button', { type: 'button', class: 'primary', onClick: () => void compute() }, 'Update the results'),
      );
    const openAdvanced = () => {
      ctx.cfg.indexPreset = 'custom';
      drawPresets();
      advDetails.open = true;
    };
    const choose = (p: Preset) => {
      p.apply(cfg);
      ctx.cfg.indexPreset = p.id;
      drawPresets();
      drawAdvanced();
      void compute();
    };

    const compute = async () => {
      out.replaceChildren(h('p', { class: 'muted' }, 'Computing…'));
      try {
        needNet(ctx);
        const opts = toOptions(cfg);
        const sum = cfg.type === 'sum';
        const main: IndexOptions = { ...opts, type: sum ? 'sum' : 'full' };
        const t0 = performance.now();
        const [table, reach, baseline] = await Promise.all([
          ctx.engine.index(main),
          sum ? undefined : ctx.engine.index({ ...opts, type: 'reach', mode: cfg.mode }),
          // with no dispersal the barrier-free index is exactly 1; otherwise recompute it without barriers
          !sum && opts.connectivity && opts.dispersal ? ctx.engine.index({ ...opts, type: 'full', connectivity: null }) : Promise.resolve(null),
        ]);
        ctx.results.index = { opts: main, table, reach, baseline, ms: ms(t0) };
        ctx.completed(i);
        await show();
      } catch (e) {
        out.replaceChildren(note((e as Error).message, 'warn'));
      }
    };

    const show = async () => {
      const r = ctx.results.index;
      if (!r) return;
      const net = needNet(ctx);
      const sum = r.opts.type === 'sum';
      const ex = explain(cfg);
      const nets = r.table.network as string[];
      const wcol = r.table.weight as string[];
      const idx = r.table.index as Float64Array;
      const weights = [...new Set(wcol)];
      const baseOf = new Map<string, number>();
      if (r.baseline) (r.baseline.network as string[]).forEach((n, k) => baseOf.set(`${n}|${(r.baseline!.weight as string[])[k]}`, (r.baseline!.index as Float64Array)[k]));

      const box = h('div', {});
      box.append(h('div', { class: 'explain' }, h('b', {}, ex.name), ': ', ex.what, h('br'), h('span', { class: 'muted' }, ex.barriers)));

      // answer cards: one per network and weight (the first few)
      const cards = h('div', { class: 'cards' });
      const shown = Math.min(idx.length, 4);
      for (let k = 0; k < shown; k++) {
        const v = idx[k];
        const base = r.baseline ? baseOf.get(`${nets[k]}|${wcol[k]}`) : sum ? undefined : 1;
        const head = h('div', { class: 'answer-head' }, h('span', { class: 'answer-name' }, ex.name), h('span', { class: 'chip' }, wcol[k]), net.netNames.length > 1 ? h('span', { class: 'muted' }, `network ${nets[k]}`) : null);
        if (sum) {
          cards.append(h('div', { class: 'answer' }, head, h('div', { class: 'answer-value' }, fmt(v, 4)), h('p', { class: 'answer-text' }, 'Sum over the dams of the habitat share each one cuts off. 0 would mean no dam blocks anything; the larger the value, the more fragmented the network.')));
          continue;
        }
        const loss = base && base > 0 ? 1 - v / base : NaN;
        cards.append(
          h(
            'div',
            { class: 'answer' },
            head,
            h('div', { class: 'answer-value' }, pct(v), h('small', {}, ' %')),
            h('div', { class: 'answer-bar', role: 'img', 'aria-label': `${pct(v)} percent${base !== undefined ? `, ${pct(base)} percent without barriers` : ''}` },
              h('span', { class: 'answer-fill', style: { width: `${Math.min(100, v * 100)}%` } }),
              base !== undefined ? h('span', { class: 'answer-mark', style: { left: `${Math.min(100, base * 100)}%` }, title: `Without barriers: ${pct(base)} %` }) : null),
            h('p', { class: 'answer-text' },
              base === undefined
                ? ''
                : base >= 0.99999
                  ? `The barriers cost this river ${pct(1 - v)} % of the connectivity it would have without them.`
                  : `Without barriers the same kernel gives ${pct(base)} %: the barriers remove ${Number.isFinite(loss) ? pct(loss) : '–'} % of it.`),
          ),
        );
      }
      box.append(cards);
      if (idx.length > shown) box.append(h('p', { class: 'muted' }, `${idx.length - shown} more network/weight rows are in the table below.`));

      // per-reach map and distribution
      if (r.reach) {
        const reach = r.reach;
        const wSel = select(weights, weights[0]);
        const mapNote = h('p', { class: 'muted' });
        const histBox = h('div');
        const paint = async () => {
          const w = wSel.value;
          const idc = strCol(reach, net.id) as string[];
          const rv = reach.index as Float64Array;
          const rw = reach.weight as string[];
          const by = new Map<string, number>();
          idc.forEach((id, k) => {
            if (rw[k] === w) by.set(id!, rv[k]);
          });
          const fc = ctx.results.nodesGeo;
          if (!fc) return;
          const vals = Float64Array.from(by.values());
          const sorted = Float64Array.from(vals).sort();
          const feats = fc.features.map((f) => {
            const v = by.get(String(f.properties?.node_id));
            return { ...f, properties: { ...f.properties, pct: v === undefined ? null : v * 100, pctile: v === undefined ? null : percentileOf(sorted, v) } };
          });
          const [lo, hi] = colRange(vals.map((x) => x * 100));
          await ctx.map.clear();
          await ctx.map.setData('nodes', 'line', { type: 'FeatureCollection', features: feats }, { colorBy: { prop: 'pct', min: lo, max: hi }, width: 2 }, (p) => ({
            title: `Reach ${p.node_id}`,
            rows: [
              ['Length', `${fmt(p.length_km, 4)} km`],
              ['Reach index', p.pct === null ? 'NA' : `${fmt(p.pct, 3)} %`],
              ['Rank', p.pctile === null ? 'NA' : `better connected than ${Math.round(p.pctile * 100)} % of reaches`],
            ],
          }));
          ctx.map.setLegend({ prop: 'pct', min: lo, max: hi, label: `Reach index (%), ${w}` });
          await ctx.map.fitTo(fc);
          const s = summarize(vals);
          histBox.replaceChildren(
            h('p', { class: 'muted' }, 'How the reaches are distributed (each bar counts reaches; colours match the map):'),
            histogram(vals, { scale: 100, unit: '%' }),
            h('p', { class: 'muted' }, `Least connected reach ${pct(s.min)} %, median ${pct(s.median)} %, best ${pct(s.max)} %.`),
          );
        };
        wSel.addEventListener('change', () => void paint());
        mapNote.textContent =
          cfg.mode === 'from'
            ? 'On the map each reach shows how reachable it is: the share of the whole network (weighted, after barriers and distance) that can get to it.'
            : 'On the map each reach shows how well it reaches the rest of the network (paths leaving it).';
        box.append(h('h4', {}, 'Reach by reach'), weights.length > 1 ? field('Weight shown', wSel) : h('span'), mapNote, histBox);
        await paint();
      } else {
        await drawNetwork(ctx);
      }

      const details = h('details', {}, h('summary', {}, 'Show the numbers'));
      details.append(
        tableEl(r.table, sum ? ['network', 'weight', 'index'] : ['network', 'weight', 'num', 'den', 'index'], { limit: 100 }),
        ...(r.reach ? [h('p', { class: 'muted' }, 'Per reach:'), tableEl(r.reach, [net.id, 'weight', 'index'], { limit: 200 })] : []),
        h('div', { class: 'buttons' },
          h('button', { type: 'button', onClick: () => download('index.csv', toCsv(r.table)) }, 'Download the network result (CSV)'),
          r.reach ? h('button', { type: 'button', onClick: () => download('index_by_reach.csv', toCsv(r.reach!)) }, 'Download the per-reach result (CSV)') : null,
        ),
      );
      box.append(details, h('p', { class: 'muted' }, `Computed in ${r.ms} ms: ${describeOptions(cfg)}.`));
      if (ctx.debug && ctx.cfg.data.isExample) {
        const verdict = await checkGolden('index', r.opts, r.table, net.id);
        if (verdict) box.append(h('p', { class: `note ${verdict.includes('OK') ? 'ok' : 'warn'}` }, `Debug: ${verdict}`));
      }
      box.append(h('p', { class: 'muted' }, 'Next: the Prioritisation step shows which dams matter most for this index.'));
      out.replaceChildren(box);
    };
    stepResults.set(i, { summary: out, redraw: show });

    drawPresets();
    drawAdvanced();
    root.append(
      h('p', { class: 'muted' }, 'An index condenses the whole river into a number. Choose one below; every choice has a one-line explanation.'),
      presetRow,
      desc,
      out,
      advDetails,
    );
    await drawNetwork(ctx);
    await compute();
  },
};

// ---- 9. prioritisation ------------------------------------------------------

export const priorityStep: Step = {
  id: 'priority',
  title: 'Prioritisation',
  blurb: 'Which dam matters most? Each dam alone is fixed (removed, or given a fish pass) and we measure how much the index improves.',
  needs: [5],
  async render(ctx, root, i) {
    const pc = ctx.cfg.priority;
    const cfg = pc.index;
    cfg.type = cfg.type === 'sum' ? 'sum' : 'full';
    const out = h('div');
    const form = indexForm(cfg, ctx.net, () => {}, { types: ['full', 'sum'], featured: derivedNames(ctx) });
    const pu = numberInput(pc.passU, { min: 0, max: 1, step: 0.05 });
    const pd = numberInput(pc.passD, { min: 0, max: 1, step: 0.05 });
    pu.addEventListener('input', () => (pc.passU = Number.isFinite(pu.valueAsNumber) ? pu.valueAsNumber : 0));
    pd.addEventListener('input', () => (pc.passD = Number.isFinite(pd.valueAsNumber) ? pd.valueAsNumber : 0));
    const progress = h('progress', { max: 1, value: 0, hidden: true });
    const progressText = h('span', { class: 'muted' });

    const draw = async () => {
      const r = ctx.results.dindex;
      if (!r) return;
      const net = needNet(ctx);
      const t = r.table;
      const ids = t.id_barrier as string[];
      const wc = t.weight as string[];
      const di = t.d_index as Float64Array;
      const weights = [...new Set(wc)];
      const n = ids.length;
      const order = [...Array(n).keys()].sort((a, b) => weights.indexOf(wc[a]) - weights.indexOf(wc[b]) || (di[b] - di[a] || 0));
      const rankOf = new Map<string, number>(); // `${weight}|${id}` -> rank
      const seen = new Map<string, number>();
      const ranked: Record<string, any[]> = { rank: [], id_barrier: [], weight: [], index_bl: [], index: [], d_index: [] };
      for (const k of order) {
        const rk = (seen.get(wc[k]) ?? 0) + 1;
        seen.set(wc[k], rk);
        rankOf.set(`${wc[k]}|${ids[k]}`, rk);
        ranked.rank.push(rk);
        ranked.id_barrier.push(ids[k]);
        ranked.weight.push(wc[k]);
        ranked.index_bl.push((t.index_bl as Float64Array)[k]);
        ranked.index.push((t.index as Float64Array)[k]);
        ranked.d_index.push(di[k]);
      }
      const rt: Table = { rank: Float64Array.from(ranked.rank), id_barrier: ranked.id_barrier, weight: ranked.weight, index_bl: Float64Array.from(ranked.index_bl), index: Float64Array.from(ranked.index), d_index: Float64Array.from(ranked.d_index) };
      const total = ids.length / weights.length;
      const summary = h('div', {}, note(`Computed in ${r.ms} ms for ${(r.barriers.id as string[]).length} dams: ${describeOptions(cfg)}.`, 'ok'));

      const wSel = select(weights, weights[0]);
      const bars = h('div');
      const paint = async () => {
        const w = wSel.value;
        const d = new Map<string, number>();
        ids.forEach((id, k) => {
          if (wc[k] === w) d.set(id, di[k]);
        });
        const passOf = new Map<string, [number, number]>();
        (net.edges.id_barrier as (string | null)[]).forEach((b, e) => {
          if (b !== null) passOf.set(b, [(net.edges.pass_u as Float64Array)[e], (net.edges.pass_d as Float64Array)[e]]);
        });
        const feats: GeoJSON.Feature[] = (net.barrierGeometry ?? [])
          .filter((b) => d.has(b.id_barrier))
          .map((b) => ({
            type: 'Feature',
            properties: { id_barrier: b.id_barrier, d_index: d.get(b.id_barrier)!, rank: rankOf.get(`${w}|${b.id_barrier}`), pu: passOf.get(b.id_barrier)?.[0], pd: passOf.get(b.id_barrier)?.[1] },
            geometry: parseWktPoint(b.wkt),
          }));
        const [lo, hi] = colRange(feats.map((f) => f.properties!.d_index as number));
        await ctx.map.clear();
        if (ctx.results.nodesGeo) await ctx.map.setData('nodes', 'line', ctx.results.nodesGeo, { color: '#b8c4cc', width: 1.2 });
        const naturals = (net.barrierGeometry ?? []).filter((b) => b.type === 'natural');
        if (naturals.length) {
          await ctx.map.setData('naturals', 'point', { type: 'FeatureCollection', features: naturals.map((b) => ({ type: 'Feature', properties: { id_barrier: b.id_barrier }, geometry: parseWktPoint(b.wkt) })) }, { color: '#1f78b4', radius: 3.5, opacity: 0.8 }, (p) => ({ title: `Natural barrier ${String(p.id_barrier).replace(/^nat_/, '')}`, rows: [['Not ranked', 'it cannot be removed']] }));
        }
        await ctx.map.setData(
          'dindex',
          'point',
          { type: 'FeatureCollection', features: feats.sort((a, b) => (a.properties!.d_index as number) - (b.properties!.d_index as number)) },
          { colorBy: { prop: 'd_index', min: Math.max(0, lo), max: hi }, radiusBy: ['d_index', Math.max(0, lo), hi, 3, 11] },
          (p) => ({
            title: `Dam ${p.id_barrier}`,
            rows: [
              ['Gain if fixed', `${fmt(p.d_index, 3)} %`],
              ['Rank', `#${p.rank} of ${total}`],
              ['Passability now ↑ / ↓', `${fmt(p.pu, 3)} / ${fmt(p.pd, 3)}`],
            ],
          }),
        );
        ctx.map.setLegend({ prop: 'd_index', min: Math.max(0, lo), max: hi, label: `Gain in the index if fixed (%), ${w}` });
        if (ctx.results.nodesGeo) await ctx.map.fitTo(ctx.results.nodesGeo);
        const top = [...d.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        bars.replaceChildren(
          h('h4', {}, 'Top 10 dams'),
          hbars(top.map(([id, v], k) => ({ label: `#${k + 1}  dam ${id}`, value: Math.max(0, v), text: `+${fmt(v, 3)} %`, title: `Fixing dam ${id} alone raises the index by ${fmt(v, 4)} %` }))),
          h('p', { class: 'muted' }, 'The bar is the relative gain of the index when only that dam is fixed. The same ranking is on the map: bigger, brighter dots matter more.'),
        );
      };
      wSel.addEventListener('change', () => void paint());
      summary.append(weights.length > 1 ? field('Weight shown', wSel) : h('span'), bars, h('details', {}, h('summary', {}, 'Show the full ranking'), tableEl(rt, ['rank', 'id_barrier', 'weight', 'index_bl', 'index', 'd_index'], { limit: 200 })));
      if (ctx.debug && ctx.cfg.data.isExample) {
        const verdict = await checkGolden('dindex', r.opts, t, net.id, { passU: pc.passU, passD: pc.passD });
        if (verdict) summary.append(h('p', { class: `note ${verdict.includes('OK') ? 'ok' : 'warn'}` }, `Debug: ${verdict}`));
      }
      summary.append(h('button', { type: 'button', onClick: () => download('prioritisation.csv', toCsv(rt)) }, 'Download the ranking (CSV)'));
      out.replaceChildren(summary);
      await paint();
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    stepResults.set(i, { summary: out, redraw: draw });

    const run = () =>
      ctx.run('Prioritising dams', async () => {
        const net = needNet(ctx);
        const type = net.edges.type as string[];
        const bar = strCol(net.edges, 'id_barrier') as (string | null)[];
        // only dams are candidates: a waterfall cannot be removed
        const ids = [...new Set(bar.filter((b, e): b is string => b !== null && type[e] === 'dam'))];
        if (!ids.length) throw new Error('The network has no dams to rank.');
        const barriers: Barriers = { id: ids, passU: new Float64Array(ids.length).fill(pc.passU), passD: new Float64Array(ids.length).fill(pc.passD) };
        const opts = toOptions(cfg);
        progress.hidden = false;
        progress.value = 0;
        const t0 = performance.now();
        const { weight, type: itype, mode, connectivity, dispersal } = opts;
        const table = await ctx.engine.dindex(barriers, { weight, type: itype, mode, connectivity, dispersal }, (done: number, tot: number) => {
          progress.value = done / tot;
          progressText.textContent = `${done} / ${tot} dams`;
        });
        progressText.textContent = '';
        ctx.results.dindex = { opts, barriers, table, ms: ms(t0) };
        ctx.completed(i);
        await draw();
      }).finally(() => {
        progress.hidden = true;
      });

    root.append(
      h('p', { class: 'muted' }, 'The result ranks the dams of your network; natural barriers (waterfalls) keep reducing connectivity but are not ranked.'),
      h('h4', {}, 'What happens to each dam'),
      h('p', { class: 'muted' }, 'Passabilities the dam gets when it is treated: 1 and 1 removes it completely; lower values model a fish pass.'),
      h('div', { class: 'two' }, field('↑ Upstream', pu), field('↓ Downstream', pd)),
      h('details', { class: 'advanced' }, h('summary', {}, 'Index to improve (advanced)'), form),
      runButton('Rank the dams', run),
      h('div', { class: 'row' }, progress, progressText),
      out,
    );
    if (ctx.done[i] && ctx.results.dindex) await draw();
    else await drawNetwork(ctx, '#b8c4cc');
  },
};

// ---- 10. export -------------------------------------------------------------

interface ExportCard {
  title: string;
  blurb: string;
  /** Map layers this card puts on disk (highlighted on hover). */
  layers: string[];
  table: Table | null;
  columns: string[];
  /** Columns shown in the preview (default: the first ones). */
  previewColumns?: string[];
  empty?: string;
  buttons: { label: string; run: () => void }[];
}

function previewTable(t: Table, columns: string[], rows = 3): HTMLElement {
  return tableEl(t, columns.slice(0, 5), { limit: rows, digits: 4, quiet: true });
}

export const exportStep: Step = {
  id: 'export',
  title: 'Export',
  blurb: 'What you can take with you. Hover a card to see on the map what it contains.',
  needs: [5],
  async render(ctx, root, i) {
    const net = needNet(ctx);
    ctx.completed(i);
    const nodeCols = Object.keys(net.nodes);
    const r = ctx.results;

    // ---- data behind the cards ----
    const passOf = new Map<string, [number, number]>();
    (net.edges.id_barrier as (string | null)[]).forEach((b, e) => {
      if (b !== null) passOf.set(b, [(net.edges.pass_u as Float64Array)[e], (net.edges.pass_d as Float64Array)[e]]);
    });
    const dIndexOf = new Map<string, Record<string, number>>();
    const dTable = r.dindex?.table;
    if (dTable) {
      (dTable.id_barrier as string[]).forEach((id, k) => {
        const rec = dIndexOf.get(id) ?? {};
        rec[`d_index_${(dTable.weight as string[])[k]}`] = (dTable.d_index as Float64Array)[k];
        dIndexOf.set(id, rec);
      });
    }
    const reachT = r.index?.reach;
    const reachExtra = new Map<string, Record<string, number>>();
    if (reachT) {
      (strCol(reachT, net.id) as string[]).forEach((id, k) => {
        const rec = reachExtra.get(id!) ?? {};
        rec[`index_${(reachT.weight as string[])[k]}`] = (reachT.index as Float64Array)[k];
        reachExtra.set(id!, rec);
      });
    }
    const dIndexCols = [...new Set([...dIndexOf.values()].flatMap((x) => Object.keys(x)))];
    const indexCols = [...new Set([...reachExtra.values()].flatMap((x) => Object.keys(x)))];

    const reachesTable = (): Table => {
      const t: Table = { ...net.nodes };
      for (const c of indexCols) t[c] = Float64Array.from(net.ids, (id) => reachExtra.get(id)?.[c] ?? NaN);
      return t;
    };
    const barrierRows = (net.barrierGeometry ?? []).map((b) => {
      const p = parseWktPoint(b.wkt).coordinates;
      return { b, lon: p[0], lat: p[1] };
    });
    const barriersTable = (): Table => {
      const t: Table = {
        id_barrier: barrierRows.map((x) => x.b.id_barrier),
        type: barrierRows.map((x) => x.b.type),
        lon: Float64Array.from(barrierRows, (x) => x.lon),
        lat: Float64Array.from(barrierRows, (x) => x.lat),
        pass_u: Float64Array.from(barrierRows, (x) => passOf.get(x.b.id_barrier)?.[0] ?? NaN),
        pass_d: Float64Array.from(barrierRows, (x) => passOf.get(x.b.id_barrier)?.[1] ?? NaN),
      };
      for (const c of dIndexCols) t[c] = Float64Array.from(barrierRows, (x) => dIndexOf.get(x.b.id_barrier)?.[c] ?? NaN);
      return t;
    };
    const reachesGeoJson = (): string => {
      const fc = ctx.results.nodesGeo!;
      const at = new Map(net.ids.map((id, v) => [id, v]));
      return JSON.stringify({
        type: 'FeatureCollection',
        features: fc.features.map((f) => {
          const id = String(f.properties?.node_id);
          const v = at.get(id)!;
          const props: Record<string, unknown> = { node_id: id };
          for (const c of nodeCols) {
            if (c === net.id) continue;
            const col = net.nodes[c];
            props[c] = col instanceof Float64Array ? (Number.isNaN(col[v]) ? null : col[v]) : col[v];
          }
          return { type: 'Feature', geometry: f.geometry, properties: { ...props, ...(reachExtra.get(id) ?? {}) } };
        }),
      });
    };
    const barriersGeoJson = (): string => {
      const t = barriersTable();
      return JSON.stringify({
        type: 'FeatureCollection',
        features: barrierRows.map((x, k) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [x.lon, x.lat] },
          properties: Object.fromEntries(['id_barrier', 'type', 'pass_u', 'pass_d', ...dIndexCols].map((c) => {
            const v = (t[c] as any)[k];
            return [c, typeof v === 'number' && Number.isNaN(v) ? null : v];
          })),
        })),
      });
    };

    const cards: ExportCard[] = [
      {
        title: 'Reaches',
        blurb: 'Every reach of the network with its attributes (length, weights, ...)' + (indexCols.length ? ' and the per-reach index.' : '. Compute an index to add the per-reach index.'),
        layers: ['reaches'],
        table: reachesTable(),
        columns: [...nodeCols, ...indexCols],
        previewColumns: [net.id, 'length', ...indexCols.slice(0, 1), ...(nodeCols.includes('rc_upland') ? ['rc_upland'] : [])],
        buttons: [
          { label: 'CSV', run: () => download('reaches.csv', toCsv(reachesTable())) },
          { label: 'GeoJSON', run: () => download('reaches.geojson', reachesGeoJson(), 'application/geo+json') },
        ],
      },
      {
        title: 'Links',
        blurb: 'How the reaches connect, and where the barriers sit.',
        layers: ['reaches', 'dams', 'naturals'],
        table: net.edges,
        columns: ['from', 'to', 'type', 'id_barrier', 'pass_u', 'pass_d'],
        buttons: [{ label: 'CSV', run: () => download('links.csv', toCsv(net.edges, ['from', 'to', 'type', 'id_barrier', 'pass_u', 'pass_d'])) }],
      },
      {
        title: 'Barriers',
        blurb: 'Dams and natural barriers with their passabilities' + (dIndexCols.length ? ' and the gain if each dam is fixed.' : '. Run the prioritisation to add the gain per dam.'),
        layers: ['dams', 'naturals'],
        table: barriersTable(),
        columns: ['id_barrier', 'type', 'lon', 'lat', 'pass_u', 'pass_d', ...dIndexCols],
        buttons: [
          { label: 'CSV', run: () => download('barriers.csv', toCsv(barriersTable())) },
          { label: 'GeoJSON', run: () => download('barriers.geojson', barriersGeoJson(), 'application/geo+json') },
        ],
      },
      {
        title: 'Index results',
        blurb: 'The network-level index and the one per reach, as computed in the Indices step.',
        layers: ['reaches'],
        table: r.index?.table ?? null,
        columns: r.index ? Object.keys(r.index.table) : [],
        empty: 'Not computed yet: open the Indices step.',
        buttons: r.index
          ? [
              { label: 'Network CSV', run: () => download('index.csv', toCsv(r.index!.table)) },
              ...(r.index.reach ? [{ label: 'Per-reach CSV', run: () => download('index_by_reach.csv', toCsv(r.index!.reach!)) }] : []),
            ]
          : [],
      },
      {
        title: 'Prioritisation',
        blurb: 'For every dam, the index after fixing it alone and the relative gain.',
        layers: ['dams'],
        table: r.dindex?.table ?? null,
        columns: r.dindex ? Object.keys(r.dindex.table) : [],
        empty: 'Not computed yet: open the Prioritisation step.',
        buttons: r.dindex ? [{ label: 'CSV', run: () => download('prioritisation.csv', toCsv(r.dindex!.table)) }] : [],
      },
    ];

    const grid = h('div', { class: 'export-grid' });
    for (const c of cards) {
      const ready = c.table !== null;
      const nRows = c.table && c.columns.length ? (c.table[c.columns[0]] as ArrayLike<unknown>).length : 0;
      const chips = h('div', { class: 'chips' }, c.columns.slice(0, 10).map((x) => h('span', { class: 'chip' }, x)), c.columns.length > 10 ? h('span', { class: 'muted' }, `+${c.columns.length - 10} more`) : null);
      const card = h(
        'section',
        { class: `card export-card${ready ? '' : ' empty'}`, tabindex: 0 },
        h('div', { class: 'export-head' }, h('h3', {}, c.title), h('span', { class: `badge ${ready ? 'ok' : ''}` }, ready ? `${nRows} rows` : 'not computed')),
        h('p', { class: 'muted' }, ready ? c.blurb : (c.empty ?? c.blurb)),
        ready ? chips : null,
        ready && c.columns.length ? previewTable(c.table!, c.previewColumns ?? c.columns) : null,
        h('div', { class: 'buttons' }, c.buttons.map((b) => h('button', { type: 'button', onClick: b.run }, b.label))),
      );
      const on = () => ctx.map.emphasize(c.layers);
      const off = () => ctx.map.emphasize(null);
      card.addEventListener('mouseenter', on);
      card.addEventListener('mouseleave', off);
      card.addEventListener('focusin', on);
      card.addEventListener('focusout', off);
      grid.append(card);
    }
    root.append(
      kv([['Reaches', net.ids.length], ['Dams', barrierRows.filter((x) => x.b.type === 'dam').length], ['Natural barriers', barrierRows.filter((x) => x.b.type === 'natural').length], ['Index', r.index ? describeOptions(ctx.cfg.index) : 'not computed yet']]),
      grid,
    );

    // map: everything that is exported
    await ctx.map.clear();
    ctx.map.setLegend(null);
    if (ctx.results.nodesGeo) {
      const fc = ctx.results.nodesGeo;
      const ws = r.index?.reach ? ((r.index.reach.weight as string[])[0] as string) : null;
      const col = ws ? `index_${ws}` : null;
      const feats = fc.features.map((f) => ({ ...f, properties: { ...f.properties, pct: col ? (reachExtra.get(String(f.properties?.node_id))?.[col] ?? NaN) * 100 : null } }));
      const [lo, hi] = col ? colRange(feats.map((f) => f.properties!.pct as number)) : [0, 1];
      await ctx.map.setData('reaches', 'line', { type: 'FeatureCollection', features: feats }, col ? { colorBy: { prop: 'pct', min: lo, max: hi }, width: 1.8 } : { color: '#2a788e', width: 1.5 }, (p) => ({ title: `Reach ${p.node_id}`, rows: [['Length', `${fmt(p.length_km, 4)} km`], ...(p.pct != null ? ([['Reach index', `${fmt(p.pct, 3)} %`]] as [string, string][]) : [])] }));
      if (col) ctx.map.setLegend({ prop: 'pct', min: lo, max: hi, label: `Reach index (%), ${ws}` });
      await ctx.map.fitTo(fc);
    }
    const dFor = dIndexCols[0];
    const damFeats = barrierRows.filter((x) => x.b.type === 'dam').map((x) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [x.lon, x.lat] }, properties: { id_barrier: x.b.id_barrier, d_index: dFor ? (dIndexOf.get(x.b.id_barrier)?.[dFor] ?? 0) : null } }));
    const [dlo, dhi] = dFor ? colRange(damFeats.map((f) => f.properties.d_index as number)) : [0, 1];
    await ctx.map.setData('dams', 'point', { type: 'FeatureCollection', features: damFeats }, dFor ? { colorBy: { prop: 'd_index', min: Math.max(0, dlo), max: dhi }, radiusBy: ['d_index', Math.max(0, dlo), dhi, 3, 9] } : { color: '#c0392b', radius: 4 }, (p) => ({ title: `Dam ${p.id_barrier}`, rows: p.d_index != null ? [['Gain if fixed', `${fmt(p.d_index, 3)} %`]] : [] }));
    const natFeats = barrierRows.filter((x) => x.b.type === 'natural').map((x) => ({ type: 'Feature' as const, geometry: { type: 'Point' as const, coordinates: [x.lon, x.lat] }, properties: { id_barrier: x.b.id_barrier } }));
    if (natFeats.length) await ctx.map.setData('naturals', 'point', { type: 'FeatureCollection', features: natFeats }, { color: '#1f78b4', radius: 4 }, (p) => ({ title: `Natural barrier ${String(p.id_barrier).replace(/^nat_/, '')}`, rows: [] }));
  },
};

export type { IndexCfg };
