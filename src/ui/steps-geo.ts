// Steps 2-7: the geoprocessing pipeline, one step per stage, each with its map.
import { networkChecks } from '../engine/checks';
import { setWeights } from '../engine/network';
import type { Col, Table } from '../engine/types';
import type { Check, LayerInfo } from '../geo/pipeline';
import type { Ctx, PassCfg } from './ctx';
import { field, fmt, h, numberInput, select, tableEl } from './dom';
import { type Step, type StepResult, kv, note, runButton, showStored, stepResults } from './step';

const store = (i: number, r: StepResult) => stepResults.set(i, r);

async function drawReaches(ctx: Ctx, table = 'rc_reaches', extra: string[] = []): Promise<GeoJSON.FeatureCollection> {
  const n = await ctx.geo.count(table);
  if (n > 150_000) throw new Error(`${n} features is too many to draw; the numbers are still computed.`);
  return ctx.geo.geojson(table, ['rc_id', 'rc_upland', ...extra]);
}

// ---- 2. rivers --------------------------------------------------------------

export const riversStep: Step = {
  id: 'rivers',
  title: 'Rivers',
  blurb: 'Read the river layer: topology comes from the downstream id of each reach.',
  needs: [0],
  async render(ctx, root, i) {
    const d = ctx.cfg.data;
    const out = h('div');
    const run = () =>
      ctx.run('Reading the rivers', async () => {
        await ctx.geo.rivers(d.rivers!, {
          layer: d.riversLayer,
          adapter: d.adapter,
          crs: d.riversCrs,
          mapping: d.adapter === 'generic' ? {
            id: d.mapping.id, down_id: d.mapping.down_id,
            length_km: d.mapping.length_km || undefined, upland: d.mapping.upland || undefined, order: d.mapping.order || undefined,
          } : undefined,
        });
        const s = (await ctx.db.query(
          'SELECT count(*) AS n, count(*) FILTER (WHERE rc_down IS NULL) AS outlets, sum(rc_length_km) AS km, max(rc_upland) AS up, max(rc_order) AS ord FROM rc_reaches',
        ))[0];
        ctx.completed(i);
        const data = await drawReaches(ctx);
        const draw = async () => {
          await ctx.map.clear();
          ctx.map.setLegend(null);
          await ctx.map.setData('reaches', 'line', data, { color: '#2a788e', width: 1 }, (p) => ({ title: `Reach ${p.rc_id}`, rows: [['Upstream area', fmt(p.rc_upland)]] }));
          await ctx.map.fitTo(data);
        };
        const summary = h('div', {}, note('River layer read.', 'ok'), kv([
          ['Reaches', s.n], ['Outlets (networks)', s.outlets], ['Total length (km, attribute)', fmt(s.km, 8)],
          ['Metric CRS', `EPSG:${ctx.geo.crsM} (UTM)`],
        ]), checksOf(ctx.geo.checks, 'input', 'topology'));
        store(i, { summary, redraw: draw });
        out.replaceChildren(summary);
        await draw();
      });
    root.append(
      kv([['File', d.rivers?.name ?? ''], ['Layer', d.riversLayer ?? ''], ['Schema', d.adapter]]),
      runButton('Read the rivers', run),
      out,
    );
    await showStored(ctx, out, i);
  },
};

export function checksOf(all: Check[], ...stages: string[]): HTMLElement {
  const rows = all.filter((c) => stages.includes(c.stage) && c.severity !== 'ok');
  if (!rows.length) return h('span');
  return h('div', {}, rows.map((c) => note(`${c.check}: ${c.message}${c.hint ? ' ' + c.hint : ''}`, c.severity === 'info' ? 'info' : 'warn')));
}

// ---- 3. prune ---------------------------------------------------------------

export const pruneStep: Step = {
  id: 'prune',
  title: 'Prune',
  blurb: 'Drop small streams. Reaches stay only if their upstream area and Strahler order are large enough. The map updates as you type.',
  needs: [1],
  async render(ctx, root, i) {
    const p = ctx.cfg.prune;
    const source = ctx.geo.has('rc_reaches_pre_prune') ? 'rc_reaches_pre_prune' : 'rc_reaches';
    const stats = (await ctx.db.query(`SELECT max(rc_upland) AS up, max(rc_order) AS ord, count(rc_order) AS has_order FROM ${source}`))[0];
    const upMax = Number(stats.up ?? 0);
    const ordMax = Math.max(1, Number(stats.ord ?? 12));
    // the slider is logarithmic: useful thresholds are tiny next to the largest basin
    const STEPS = 1000;
    const toPos = (v: number) => (v <= 1 || upMax <= 1 ? 0 : Math.round((Math.log10(v) / Math.log10(upMax)) * STEPS));
    const toVal = (pos: number) => (pos <= 0 || upMax <= 1 ? 0 : Math.round(Math.pow(10, (pos / STEPS) * Math.log10(upMax))));
    const upSlider = h('input', { type: 'range', min: 0, max: STEPS, step: 1, value: String(toPos(p.minUpland)), disabled: !upMax, 'aria-label': 'Minimum upstream area' });
    const up = numberInput(p.minUpland, { min: 0 });
    const ord = numberInput(p.minOrder, { min: 0, max: ordMax, step: 1 });
    const out = h('div');
    const state = h('span', { class: 'live-state' });

    let fitted = false;
    const apply = async () => {
      const total = ctx.geo.has('rc_reaches_pre_prune') ? await ctx.geo.count('rc_reaches_pre_prune') : await ctx.geo.count('rc_reaches');
      if (p.minUpland > 0 || p.minOrder > 0) {
        await ctx.geo.prune({ minUpland: p.minUpland > 0 ? p.minUpland : undefined, minOrder: p.minOrder > 0 ? p.minOrder : undefined });
      } else if (ctx.geo.has('rc_reaches_pre_prune')) {
        await ctx.db.exec('CREATE OR REPLACE TABLE rc_reaches AS SELECT * FROM rc_reaches_pre_prune');
      }
      ctx.completed(i);
      const kept = await ctx.geo.count('rc_reaches');
      const keptData = await drawReaches(ctx);
      const removed = ctx.geo.has('rc_reaches_pre_prune')
        ? await ctx.geo.geojson('rc_reaches_pre_prune', ['rc_id'], 'WHERE rc_id NOT IN (SELECT rc_id FROM rc_reaches)')
        : { type: 'FeatureCollection' as const, features: [] };
      const draw = async (fit: boolean) => {
        await ctx.map.clear();
        ctx.map.setLegend(null);
        await ctx.map.setData('removed', 'line', removed, { color: '#c9d1d6', width: 0.8 });
        await ctx.map.setData('reaches', 'line', keptData, { color: '#2a788e', width: 1.3 }, (f) => ({ title: `Reach ${f.rc_id}`, rows: [['Upstream area', fmt(f.rc_upland)]] }));
        if (fit) await ctx.map.fitTo(keptData);
      };
      const summary = h('div', {}, kv([['Reaches kept', `${kept} of ${total}`], ['Removed', total - kept]]), checksOf(ctx.geo.checks, 'topology'));
      store(i, { summary, redraw: () => draw(true) });
      out.replaceChildren(summary);
      await draw(!fitted); // do not move the map while the user is dragging a threshold
      fitted = true;
    };

    // live updates: debounced, one run at a time, the last value always wins
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pending = false;
    const live = async () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      state.textContent = 'updating…';
      try {
        do {
          pending = false;
          await apply();
        } while (pending);
      } catch (e) {
        out.replaceChildren(note((e as Error).message, 'warn'));
      } finally {
        running = false;
        state.textContent = '';
      }
    };
    const schedule = () => {
      clearTimeout(timer);
      state.textContent = 'updating…';
      timer = setTimeout(() => void live(), 350);
    };
    const num = (el: HTMLInputElement) => (Number.isFinite(el.valueAsNumber) ? Math.max(0, el.valueAsNumber) : 0);

    upSlider.addEventListener('input', () => {
      p.minUpland = toVal(Number(upSlider.value));
      up.value = String(p.minUpland);
      schedule();
    });
    up.addEventListener('input', () => {
      p.minUpland = num(up);
      upSlider.value = String(toPos(p.minUpland));
      schedule();
    });
    ord.addEventListener('input', () => {
      p.minOrder = Math.round(num(ord));
      schedule();
    });
    root.append(
      field('Minimum upstream area (keep reaches with more than)', h('div', { class: 'row' }, upSlider, up), upMax ? `Largest value in the data: ${fmt(upMax)}. Units follow the data (km² for HydroRIVERS). The slider is logarithmic.` : 'This layer has no upstream area column.'),
      field('Minimum Strahler order', ord, Number(stats.has_order) ? '0 keeps every order. Use the arrows to step through the orders.' : 'No order column: it is computed from the topology.'),
      h('div', { class: 'row' }, h('button', { type: 'button', onClick: () => void live() }, 'Update now'), state),
      out,
    );
    if (ctx.done[i] && stepResults.has(i)) await showStored(ctx, out, i);
    else void live(); // show the first result right away
  },
};

// ---- 4. merge chains --------------------------------------------------------

export const mergeStep: Step = {
  id: 'merge',
  title: 'Merge',
  blurb: 'Merge unbranched sequences of reaches between confluences into single reaches.',
  needs: [2],
  async render(ctx, root, i) {
    const cb = h('input', { type: 'checkbox', checked: ctx.cfg.merge });
    cb.addEventListener('change', () => (ctx.cfg.merge = cb.checked));
    const out = h('div');
    const run = () =>
      ctx.run('Merging reaches', async () => {
        const before = await ctx.geo.count('rc_reaches');
        await ctx.geo.mergeChains({ merge: ctx.cfg.merge });
        ctx.completed(i);
        const after = await ctx.geo.count('rc_chains');
        const data = await ctx.geo.geojson('rc_chains', ['chain_id', 'n_reaches']);
        const maxN = Math.max(1, ...data.features.map((f) => Number(f.properties?.n_reaches ?? 1)));
        const draw = async () => {
          await ctx.map.clear();
          await ctx.map.setData('chains', 'line', data, { colorBy: { prop: 'n_reaches', min: 1, max: Math.max(maxN, 2), label: 'Reaches merged' }, width: 1.4 }, (p) => ({ title: `Reach ${p.chain_id}`, rows: [['Reaches merged', String(p.n_reaches)]] }));
          ctx.map.setLegend({ prop: 'n_reaches', min: 1, max: Math.max(maxN, 2), label: 'Reaches merged' });
          await ctx.map.fitTo(data);
        };
        const summary = h('div', {}, note('Merged.', 'ok'), kv([['Reaches', before], ['Merged reaches', after]]), checksOf(ctx.geo.checks, 'topology'));
        store(i, { summary, redraw: draw });
        out.replaceChildren(summary);
        await draw();
      });
    root.append(
      field('Merge unbranched chains', h('label', { class: 'check' }, cb, ' Merge (recommended: fewer, longer reaches)')),
      runButton('Merge', run),
      out,
    );
    await showStored(ctx, out, i);
  },
};

// ---- 5. barriers + snap -----------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  ok: '#1b9e77',
  natural: '#1f78b4',
  duplicate: '#d95f02',
  headwater: '#7570b3',
  outlet: '#7570b3',
  confluence: '#e7298a',
  unsnapped: '#e31a1c',
};
const STATUS_LABELS: Record<string, string> = {
  ok: 'dam on the river',
  natural: 'natural barrier on the river',
  duplicate: 'duplicate (dropped)',
  headwater: 'headwater (dropped)',
  outlet: 'at the outlet (dropped)',
  confluence: 'on a confluence (dropped)',
  unsnapped: 'too far from any reach',
};

/** Editor of the passabilities of one kind of barrier: constants, or columns of the layer. */
function passEditor(title: string, hint: string, pc: PassCfg, cols: string[], onChange: () => void): HTMLElement {
  const body = h('div');
  const num = (key: 'up' | 'down', label: string) => {
    const el = numberInput(pc[key], { min: 0, max: 1, step: 0.05 });
    el.addEventListener('input', () => {
      pc[key] = Number.isFinite(el.valueAsNumber) ? el.valueAsNumber : 0;
      onChange();
    });
    return field(label, el);
  };
  const colSel = (key: 'upCol' | 'downCol', label: string) =>
    field(
      label,
      select(cols, pc[key] ?? cols[0], (v) => {
        pc[key] = v;
        onChange();
      }),
    );
  const draw = () => {
    if (pc.mode === 'column' && cols.length) {
      pc.upCol ??= cols[0];
      pc.downCol ??= cols[0];
      body.replaceChildren(h('div', { class: 'two' }, colSel('upCol', '↑ Upstream column'), colSel('downCol', '↓ Downstream column')));
    } else {
      body.replaceChildren(h('div', { class: 'two' }, num('up', '↑ Upstream'), num('down', '↓ Downstream')));
    }
  };
  draw();
  const mode = select(
    [['value', 'Same value for every barrier'], ...(cols.length ? [['column', 'Read from a column of the layer'] as [string, string]] : [])],
    pc.mode,
    (v) => {
      pc.mode = v as PassCfg['mode'];
      draw();
      onChange();
    },
  );
  return h('section', { class: 'card' }, h('h4', {}, title), h('p', { class: 'muted' }, hint), mode, body);
}

export const barriersStep: Step = {
  id: 'barriers',
  title: 'Barriers',
  blurb: 'Set how passable the barriers are, then snap each one onto the nearest reach.',
  needs: [3],
  async render(ctx, root, i) {
    const s = ctx.cfg.snap;
    const d = ctx.cfg.data;
    const md = numberInput(s.maxDist, { min: 0 });
    const tol = numberInput(s.endpointTol, { min: 0 });
    md.addEventListener('input', () => ((s.maxDist = Number(md.value)), stale()));
    tol.addEventListener('input', () => ((s.endpointTol = Number(tol.value)), stale()));
    const out = h('div');
    // a changed setting makes this step and the later ones out of date
    const stale = () => {
      ctx.completed(i - 1);
      stepResults.delete(i);
      out.replaceChildren(note('Settings changed: press "Read and snap" to apply them.', 'info'));
    };

    const colsOf = (layers: LayerInfo[], layer?: string) =>
      (layers.find((l) => l.name === layer)?.columns ?? []).filter((c) => !/^(geom|geometry)$/i.test(c));
    const isTable = (layers: LayerInfo[], layer?: string) => /coords/.test(layers.find((l) => l.name === layer)?.geometry ?? '');
    const pass = (pc: PassCfg, which: 'up' | 'down') => (pc.mode === 'column' ? (which === 'up' ? pc.upCol : pc.downCol) : pc[which]);

    const run = () =>
      ctx.run('Reading and snapping the barriers', async () => {
        const dam = ctx.cfg.pass.dam;
        const tbl = isTable(d.barriersLayers, d.barriersLayer);
        await ctx.geo.barriers(d.barriers!, {
          layer: tbl ? undefined : d.barriersLayer,
          crs: d.barriersCrs,
          id: d.barrierId,
          passU: pass(dam, 'up'),
          passD: pass(dam, 'down'),
          coords: tbl && d.coordX && d.coordY ? [d.coordX, d.coordY] : undefined,
          kind: 'dam',
        });
        if (d.naturals) {
          const nat = ctx.cfg.pass.natural;
          const ntbl = isTable(d.naturalsLayers, d.naturalsLayer);
          await ctx.geo.barriers(d.naturals, {
            layer: ntbl ? undefined : d.naturalsLayer,
            crs: d.naturalsCrs,
            id: d.naturalId,
            passU: pass(nat, 'up'),
            passD: pass(nat, 'down'),
            coords: ntbl && d.naturalCoordX && d.naturalCoordY ? [d.naturalCoordX, d.naturalCoordY] : undefined,
            kind: 'natural',
            append: true,
          });
        }
        const snap = await ctx.geo.snap({ maxDist: s.maxDist, endpointTol: s.endpointTol, atConfluence: s.atConfluence });
        ctx.results.snap = snap;
        ctx.completed(i);
        const pts = await ctx.geo.featureCollection(
          `SELECT b.bar_id, b.rc_kind AS kind, COALESCE(s.status, 'unsnapped') AS status,
                  CASE WHEN COALESCE(s.status, 'unsnapped') = 'ok' AND b.rc_kind = 'natural' THEN 'natural'
                       ELSE COALESCE(s.status, 'unsnapped') END AS cat,
                  b.pass_u, b.pass_d, round(s.dist_m, 1) AS dist_m, b.geom
           FROM rc_barriers b LEFT JOIN rc_snap s USING (bar_id)`,
          ['bar_id', 'kind', 'status', 'cat', 'pass_u', 'pass_d', 'dist_m'],
        );
        const counts = new Map<string, number>();
        let nDams = 0;
        let nNat = 0;
        for (const f of pts.features) {
          const c = String(f.properties!.cat);
          counts.set(c, (counts.get(c) ?? 0) + 1);
          if (f.properties!.kind === 'natural') nNat++;
          else nDams++;
        }
        const chains = await ctx.geo.geojson('rc_chains', ['chain_id']);
        const draw = async () => {
          await ctx.map.clear();
          ctx.map.setLegend(null);
          await ctx.map.setData('chains', 'line', chains, { color: '#9fb3bf', width: 1 });
          await ctx.map.setData('barriers', 'point', pts, { categories: { prop: 'cat', colors: STATUS_COLORS }, radius: 4.5 }, (p) => ({
            title: `${p.kind === 'natural' ? 'Natural barrier' : 'Dam'} ${String(p.bar_id).replace(/^nat_/, '')}`,
            rows: [
              ['Status', STATUS_LABELS[p.cat] ?? p.cat],
              ['Passability ↑ / ↓', `${fmt(p.pass_u, 3)} / ${fmt(p.pass_d, 3)}`],
              ...(p.dist_m != null ? ([['Distance to river', `${p.dist_m} m`]] as [string, string][]) : []),
            ],
          }));
          await ctx.map.fitTo(chains);
        };
        const legend = h('div', { class: 'swatches' }, [...counts.entries()].filter(([, n]) => n > 0).map(([k, n]) => h('span', { class: 'swatch' }, h('i', { style: { background: STATUS_COLORS[k] ?? '#888' } }), `${STATUS_LABELS[k] ?? k}: ${n}`)));
        const summary = h('div', {}, note('Barriers snapped.', 'ok'), legend,
          kv([['Dams read', nDams], ...(d.naturals ? ([['Natural barriers read', nNat]] as [string, number][]) : []), ['Placed on the river', (counts.get('ok') ?? 0) + (counts.get('natural') ?? 0)]]),
          checksOf(ctx.geo.checks, 'barriers'));
        store(i, { summary, redraw: draw });
        out.replaceChildren(summary);
        await draw();
      });

    root.append(
      kv([['Dams', `${d.barriers?.name ?? ''}${d.barriersLayer ? ` / ${d.barriersLayer}` : ''}`], ...(d.naturals ? ([['Natural barriers', `${d.naturals.name}${d.naturalsLayer ? ` / ${d.naturalsLayer}` : ''}`]] as [string, string][]) : [])]),
      passEditor('Dams: passability', '1 lets every fish through, 0 blocks them completely. Fish swimming up and down often face different odds (a fish ladder helps ↑ only).', ctx.cfg.pass.dam, colsOf(d.barriersLayers, d.barriersLayer), stale),
      d.naturals
        ? passEditor('Natural barriers: passability', 'Waterfalls usually stop fish going up (↑ close to 0) but let them go down (↓ close to 1).', ctx.cfg.pass.natural, colsOf(d.naturalsLayers, d.naturalsLayer), stale)
        : h('p', { class: 'muted' }, 'No natural barriers (waterfalls) loaded: add a layer in the Data step if you have one.'),
      field('Maximum snapping distance (m)', md, 'Barriers farther than this from every reach are left out.'),
      field('End-of-reach tolerance (m)', tol, 'Barriers this close to the end of a reach are placed on the confluence; duplicates closer than this are dropped.'),
      field('Barriers on a confluence', select([['links', 'Place them on the links entering the confluence'], ['drop', 'Drop them (reproduces the original tutorial code)']], s.atConfluence, (v) => ((s.atConfluence = v as typeof s.atConfluence), stale()))),
      runButton('Read and snap', run),
      out,
    );
    await showStored(ctx, out, i);
  },
};

// ---- 6. split + build -------------------------------------------------------

export const splitStep: Step = {
  id: 'split',
  title: 'Split',
  blurb: 'Cut reaches exactly at the barriers and build the network.',
  needs: [4],
  async render(ctx, root, i) {
    const b = ctx.cfg.build;
    const derived = h('textarea', { rows: 5, spellcheck: false, placeholder: 'wul = Math.exp(-rc_upland / 50000) * length' }, ctx.cfg.derived);
    derived.addEventListener('input', () => (ctx.cfg.derived = derived.value));
    const out = h('div');

    const sendNet = async () => {
      const n = ctx.net!;
      await ctx.engine.setNetwork({ ...n, geometry: undefined, barrierGeometry: undefined });
    };

    const run = () =>
      ctx.run('Splitting reaches and building the network', async () => {
        await ctx.geo.split();
        ctx.net = await ctx.geo.build({ lengthUnit: b.lengthUnit });
        if (ctx.cfg.derived.trim()) ctx.net = applyDerived(ctx.net, ctx.cfg.derived);
        await sendNet();
        ctx.results.index = undefined;
        ctx.results.dindex = undefined;
        ctx.completed(i);
        const net = ctx.net;
        const nodes = await ctx.geo.featureCollection('SELECT node_id, round(length_m / 1000, 3) AS length_km, geom FROM rc_nodes', ['node_id', 'length_km']);
        ctx.results.nodesGeo = nodes;
        const nDams = (net.edges.type as string[]).filter((t) => t === 'dam').length;
        const nNat = (net.edges.type as string[]).filter((t) => t === 'natural').length;
        const total = (net.nodes.length as Float64Array).reduce((a, x) => a + x, 0);
        const passOf = new Map<string, [number, number]>();
        (net.edges.id_barrier as (string | null)[]).forEach((b, e) => {
          if (b !== null) passOf.set(b, [(net.edges.pass_u as Float64Array)[e], (net.edges.pass_d as Float64Array)[e]]);
        });
        const barrierPts = (type: string): GeoJSON.FeatureCollection => ({
          type: 'FeatureCollection',
          features: (net.barrierGeometry ?? [])
            .filter((bg) => bg.type === type)
            .map((bg) => ({ type: 'Feature', properties: { id_barrier: bg.id_barrier, pu: passOf.get(bg.id_barrier)?.[0], pd: passOf.get(bg.id_barrier)?.[1] }, geometry: parseWktPoint(bg.wkt) })),
        });
        const tip = (label: string) => (p: Record<string, any>) => ({
          title: `${label} ${String(p.id_barrier).replace(/^nat_/, '')}`,
          rows: [['Passability ↑ / ↓', `${fmt(p.pu, 3)} / ${fmt(p.pd, 3)}`]] as [string, string][],
        });
        const draw = async () => {
          await ctx.map.clear();
          ctx.map.setLegend(null);
          await ctx.map.setData('nodes', 'line', nodes, { color: '#2a788e', width: 1.5 }, (p) => ({ title: `Reach ${p.node_id}`, rows: [['Length', `${fmt(p.length_km, 4)} km`]] }));
          await ctx.map.setData('dams', 'point', barrierPts('dam'), { color: '#c0392b', radius: 4 }, tip('Dam'));
          await ctx.map.setData('naturals', 'point', barrierPts('natural'), { color: '#1f78b4', radius: 4 }, tip('Natural barrier'));
          await ctx.map.fitTo(nodes);
        };
        const summary = h('div', {}, note('Network built.', 'ok'), kv([
          ['Reaches (nodes)', net.ids.length], ['Links', net.edges.from.length], ['Dam links', nDams],
          ...(nNat ? ([['Natural barrier links', nNat]] as [string, number][]) : []),
          ['Networks (outlets)', net.netNames.length], [`Total length (${b.lengthUnit})`, fmt(total, 8)],
        ]), checksOf(ctx.geo.checks, 'barriers'));
        store(i, { summary, redraw: draw });
        out.replaceChildren(summary);
        await draw();
      });

    const apply = () =>
      ctx.run('Computing weights', async () => {
        if (!ctx.net) throw new Error('Build the network first.');
        ctx.net = applyDerived(ctx.net, ctx.cfg.derived);
        await sendNet();
        ctx.results.index = undefined;
        ctx.results.dindex = undefined;
        out.append(note(`Weight columns now available: ${Object.keys(ctx.net.nodes).filter((k) => ctx.net!.nodes[k] instanceof Float64Array).join(', ')}.`, 'ok'));
      });

    root.append(
      field('Length unit of the network', select([['km', 'kilometres'], ['m', 'metres'], ['10km', '10 km (tutorial convention)']], b.lengthUnit, (v) => (b.lengthUnit = v as typeof b.lengthUnit)), 'Lengths are geodesic, on the WGS84 ellipsoid. Distance-decay parameters use this unit.'),
      runButton('Split and build', run),
      out,
      h('details', {},
        h('summary', {}, 'Derived weights (optional)'),
        h('p', { class: 'muted' }, 'One column per line: name = expression. Reach columns are variables, Math functions are available. Example: hsi = Math.exp(-rc_upland / 50000), then wul = hsi * length.'),
        derived,
        h('button', { type: 'button', onClick: apply }, 'Apply to the network'),
      ),
    );
    await showStored(ctx, out, i);
  },
};

export function parseWktPoint(wkt: string): GeoJSON.Point {
  const m = /POINT\s*\(\s*([-\d.eE+]+)\s+([-\d.eE+]+)\s*\)/.exec(wkt);
  if (!m) throw new Error(`Cannot parse ${wkt}`);
  return { type: 'Point', coordinates: [Number(m[1]), Number(m[2])] };
}

/** Evaluates "name = expression" lines per reach (the web version of rc_set_weights). */
export function applyDerived(net: NonNullable<Ctx['net']>, code: string): NonNullable<Ctx['net']> {
  const lines = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('#'));
  if (!lines.length) return net;
  return setWeights(net, (nodes) => {
    const n = net.ids.length;
    const scope: Record<string, Col> = { ...nodes };
    const added: Record<string, Col> = {};
    for (const line of lines) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (!m) throw new Error(`Cannot read "${line}": use name = expression.`);
      const [, name, expr] = m;
      if (name === net.id) throw new Error('The reach identifier column cannot be changed.');
      const names = Object.keys(scope).filter((k) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && scope[k] instanceof Float64Array);
      let fn: (...a: number[]) => number;
      try {
        fn = new Function(...names, `return (${expr});`) as (...a: number[]) => number;
      } catch (e) {
        throw new Error(`Cannot read the expression of ${name}: ${(e as Error).message}`);
      }
      const out = new Float64Array(n);
      const cols = names.map((k) => scope[k] as Float64Array);
      for (let v = 0; v < n; v++) {
        const r = fn(...cols.map((c) => c[v]));
        out[v] = typeof r === 'number' ? r : Number(r);
      }
      scope[name] = out;
      added[name] = out;
    }
    return added;
  });
}

// ---- 7. checks --------------------------------------------------------------

export const checksStep: Step = {
  id: 'checks',
  title: 'Checks',
  blurb: 'What the pipeline checked along the way. Errors stop the build; warnings deserve a look.',
  needs: [5],
  async render(ctx, root, i) {
    const all: Check[] = [...ctx.geo.checks, ...(ctx.net ? networkChecks(ctx.net) : [])];
    const t: Table = {
      severity: all.map((c) => c.severity),
      stage: all.map((c) => c.stage),
      check: all.map((c) => c.check),
      n: Float64Array.from(all.map((c) => c.n)),
      message: all.map((c) => c.message),
      hint: all.map((c) => c.hint ?? ''),
    };
    const bad = all.filter((c) => c.severity === 'warning' || c.severity === 'error').length;
    ctx.completed(i);
    root.append(
      bad ? note(`${bad} check(s) need attention.`, 'warn') : note('All checks passed.', 'ok'),
      tableEl(t, ['severity', 'stage', 'check', 'n', 'message', 'hint'], { cellClass: (c, v) => (c === 'severity' ? `sev-${v}` : undefined), limit: 100 }),
      ...all.filter((c) => c.ids.length && c.severity !== 'ok').map((c) => h('details', {}, h('summary', {}, `${c.stage}/${c.check}: ${c.n} ids`), h('p', { class: 'ids' }, c.ids.slice(0, 200).join(', ') + (c.ids.length > 200 ? ' …' : '')))),
    );
    await ctx.map.whenReady();
  },
};

export { field };
