// Step 1: data (the bundled Ebro example, or the user's own files).
import { type LayerInfo, type Source, listLayers } from '../geo/pipeline';
import type { Ctx, DataCfg } from './ctx';
import { field, h, numberInput, select } from './dom';
import { type Step, note, runButton } from './step';

const MAIN_EXT = ['gpkg', 'geojson', 'json', 'shp', 'parquet', 'csv', 'tsv', 'txt'];

/** Groups picked files into a Source: the main file plus its sidecars (same basename). */
export async function sourceFromFiles(files: FileList | File[]): Promise<Source> {
  const list = [...files];
  const ext = (n: string) => n.toLowerCase().split('.').pop() ?? '';
  const base = (n: string) => n.replace(/\.[^.]+$/, '');
  const main = list.find((f) => MAIN_EXT.includes(ext(f.name)));
  if (!main) throw new Error(`Pick a GeoPackage, GeoJSON, shapefile (.shp with .dbf/.shx/.prj), GeoParquet or CSV file. Supported: ${MAIN_EXT.join(', ')}.`);
  const side = list.filter((f) => f === main || (ext(main.name) === 'shp' && base(f.name) === base(main.name)));
  const out: Source = { name: main.name, files: [] };
  for (const f of side) out.files.push({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  return out;
}

function pickLayer(layers: LayerInfo[], re: RegExp, geom?: RegExp): string | undefined {
  return (
    layers.find((l) => re.test(l.name))?.name ??
    layers.find((l) => (geom ? geom.test(l.geometry) : true))?.name ??
    layers[0]?.name
  );
}

/** One barrier layer (dams or natural barriers), seen through the flat fields of DataCfg. */
interface Slot {
  src: Source | undefined;
  layers: LayerInfo[];
  layer: string | undefined;
  id: string | undefined;
  crs: number | undefined;
  coordX: string | undefined;
  coordY: string | undefined;
}

function slot(d: DataCfg, kind: 'dam' | 'natural'): Slot {
  const dam = kind === 'dam';
  return {
    get src() { return dam ? d.barriers : d.naturals; },
    set src(v) { if (dam) d.barriers = v; else d.naturals = v; },
    get layers() { return dam ? d.barriersLayers : d.naturalsLayers; },
    set layers(v) { if (dam) d.barriersLayers = v; else d.naturalsLayers = v; },
    get layer() { return dam ? d.barriersLayer : d.naturalsLayer; },
    set layer(v) { if (dam) d.barriersLayer = v; else d.naturalsLayer = v; },
    get id() { return dam ? d.barrierId : d.naturalId; },
    set id(v) { if (dam) d.barrierId = v; else d.naturalId = v; },
    get crs() { return dam ? d.barriersCrs : d.naturalsCrs; },
    set crs(v) { if (dam) d.barriersCrs = v; else d.naturalsCrs = v; },
    get coordX() { return dam ? d.coordX : d.naturalCoordX; },
    set coordX(v) { if (dam) d.coordX = v; else d.naturalCoordX = v; },
    get coordY() { return dam ? d.coordY : d.naturalCoordY; },
    set coordY(v) { if (dam) d.coordY = v; else d.naturalCoordY = v; },
  };
}

export const dataStep: Step = {
  id: 'data',
  title: 'Data',
  blurb: 'Load a river layer and a barrier layer, or start from the bundled Ebro example.',
  needs: [],
  render(ctx, root) {
    const d = ctx.cfg.data;

    const example = h(
      'section',
      { class: 'card' },
      h('h3', {}, 'Ebro example'),
      h('p', { class: 'muted' }, '4 985 HydroRIVERS reaches of the Ebro basin and 224 dams, as in the original tutorial.'),
      h('p', { class: 'muted' }, 'River data: HydroRIVERS (Lehner & Grill 2013), part of HydroSHEDS, used under its licence terms.'),
      runButton('Load the Ebro example', () =>
        ctx.run('Loading the example', async () => {
          const res = await fetch(`${import.meta.env.BASE_URL}example/ebro.gpkg`);
          if (!res.ok) throw new Error(`Could not fetch the example (HTTP ${res.status}).`);
          const src: Source = { name: 'ebro.gpkg', files: [{ name: 'ebro.gpkg', data: new Uint8Array(await res.arrayBuffer()) }] };
          d.rivers = src;
          d.barriers = src;
          d.naturals = undefined;
          d.riversLayers = d.barriersLayers = await listLayers(ctx.db, src);
          d.riversLayer = 'rivers';
          d.barriersLayer = 'dams';
          d.adapter = 'hydrorivers_v1';
          d.barrierId = 'dam_id';
          d.isExample = true;
          ctx.cfg.pass.dam = { mode: 'value', up: 0.1, down: 0.8 };
          ctx.cfg.prune.minUpland = 80;
          ctx.completed(0);
          ctx.goto(1);
        }),
      ),
    );

    // ---- rivers ----
    const riversInput = h('input', { type: 'file', multiple: true, accept: '.gpkg,.geojson,.json,.shp,.dbf,.shx,.prj,.cpg,.parquet' });
    const riversPanel = h('div');
    const drawRivers = () => {
      riversPanel.replaceChildren();
      if (!d.rivers || d.isExample) return;
      const cols = d.riversLayers.find((l) => l.name === d.riversLayer)?.columns ?? [];
      const colSel = (key: keyof typeof d.mapping, optional = false) => {
        const s = select([...(optional ? [['', '(none)'] as [string, string]] : []), ...cols.map((c) => [c, c] as [string, string])], d.mapping[key]);
        s.addEventListener('change', () => (d.mapping[key] = s.value));
        return s;
      };
      riversPanel.append(
        note(`Loaded ${d.rivers.name}.`, 'ok'),
        field('Layer', select(d.riversLayers.map((l) => [l.name, `${l.name} (${l.geometry})`] as [string, string]), d.riversLayer, (v) => { d.riversLayer = v; drawRivers(); })),
        field(
          'Schema (adapter)',
          select([['hydrorivers_v1', 'HydroRIVERS v1 (HYRIV_ID, NEXT_DOWN, ...)'], ['hydrosheds_v2', 'HydroSHEDS v2 (STRM_ID, STRM_DN, ...)'], ['generic', 'Generic id / down_id table']], d.adapter, (v) => {
            d.adapter = v as typeof d.adapter;
            drawRivers();
          }),
        ),
      );
      if (d.adapter === 'generic') {
        riversPanel.append(
          field('Reach id', colSel('id')),
          field('Downstream id', colSel('down_id'), 'Empty or an unknown id for outlets.'),
          field('Length (km), optional', colSel('length_km', true)),
          field('Upstream area, optional', colSel('upland', true)),
          field('Strahler order, optional', colSel('order', true)),
        );
      }
      const crs = numberInput(d.riversCrs ?? NaN, { min: 1 });
      if (d.riversCrs === undefined) crs.value = '';
      crs.placeholder = 'auto';
      crs.addEventListener('change', () => (d.riversCrs = crs.value ? Number(crs.value) : undefined));
      riversPanel.append(field('EPSG code, if the file has none', crs, 'Leave empty to read it from the file (lon/lat is assumed otherwise).'));
    };
    riversInput.addEventListener('change', () =>
      ctx.run('Reading the river layer', async () => {
        if (!riversInput.files?.length) return;
        const src = await sourceFromFiles(riversInput.files);
        d.isExample = false;
        d.rivers = src;
        d.riversLayers = await listLayers(ctx.db, src);
        d.riversLayer = pickLayer(d.riversLayers, /river|stream|reach|line/i, /LINE/i);
        const cols = d.riversLayers.find((l) => l.name === d.riversLayer)?.columns ?? [];
        d.adapter = cols.includes('HYRIV_ID') ? 'hydrorivers_v1' : cols.includes('STRM_ID') ? 'hydrosheds_v2' : 'generic';
        if (d.adapter === 'generic') {
          d.mapping.id = cols.find((c) => /^id$/i.test(c)) ?? cols[0] ?? '';
          d.mapping.down_id = cols.find((c) => /down|next/i.test(c)) ?? cols[1] ?? '';
        }
        drawRivers();
      }),
    );

    // ---- barrier layers (dams, natural barriers) ----
    const barrierBlock = (kind: 'dam' | 'natural', title: string, blurb: string, nameRe: RegExp, optional: boolean) => {
      const sl = slot(d, kind);
      const input = h('input', { type: 'file', multiple: true, accept: '.gpkg,.geojson,.json,.shp,.dbf,.shx,.prj,.cpg,.parquet,.csv,.tsv,.txt' });
      const panel = h('div');
      const draw = () => {
        panel.replaceChildren();
        if (!sl.src || (d.isExample && kind === 'dam')) return;
        const lay = sl.layers.find((l) => l.name === sl.layer);
        const cols = lay?.columns ?? [];
        const isTable = /coords/.test(lay?.geometry ?? '');
        panel.append(
          note(`Loaded ${sl.src.name}.`, 'ok'),
          field('Layer', select(sl.layers.map((l) => [l.name, `${l.name} (${l.geometry})`] as [string, string]), sl.layer, (v) => { sl.layer = v; draw(); })),
          field('Barrier id column', select([['', '(row number)'], ...cols.map((c) => [c, c] as [string, string])], sl.id ?? '', (v) => (sl.id = v || undefined))),
        );
        if (isTable) {
          const xs = select(cols, sl.coordX ?? cols.find((c) => /^(lon|long|x)/i.test(c)) ?? cols[0], (v) => (sl.coordX = v));
          const ys = select(cols, sl.coordY ?? cols.find((c) => /^(lat|y)/i.test(c)) ?? cols[1], (v) => (sl.coordY = v));
          sl.coordX = xs.value;
          sl.coordY = ys.value;
          panel.append(field('Longitude column', xs), field('Latitude column', ys));
        }
        const crs = numberInput(sl.crs ?? NaN, { min: 1 });
        if (sl.crs === undefined) crs.value = '';
        crs.placeholder = 'auto';
        crs.addEventListener('change', () => (sl.crs = crs.value ? Number(crs.value) : undefined));
        panel.append(field('EPSG code, if the file has none', crs));
        if (optional) {
          panel.append(h('button', { type: 'button', onClick: () => { sl.src = undefined; sl.layers = []; input.value = ''; draw(); } }, 'Remove this layer'));
        }
        panel.append(h('p', { class: 'muted' }, 'Passabilities (upstream and downstream) are set in the Barriers step.'));
      };
      input.addEventListener('change', () =>
        ctx.run(`Reading the ${title.toLowerCase()}`, async () => {
          if (!input.files?.length) return;
          const src = await sourceFromFiles(input.files);
          d.isExample = false;
          sl.src = src;
          sl.layers = await listLayers(ctx.db, src);
          sl.layer = pickLayer(sl.layers, nameRe, /POINT/i);
          draw();
        }),
      );
      draw();
      return { el: h('div', {}, h('h4', {}, title), h('p', { class: 'muted' }, blurb), input, panel), draw };
    };
    const dams = barrierBlock('dam', 'Dams and other barriers', 'Points (or polygons, reduced to their centroid) such as dams and weirs. A CSV with longitude/latitude columns works too. These are the ones the prioritisation ranks.', /dam|barrier|weir|obstacle|reservoir/i, false);
    const naturals = barrierBlock('natural', 'Natural barriers (optional)', 'Waterfalls and similar: they reduce connectivity like dams, but they cannot be removed, so they stay out of the ranking.', /fall|cascade|natural|rapid/i, true);

    const own = h(
      'section',
      { class: 'card' },
      h('h3', {}, 'Your data'),
      h('h4', {}, 'River layer'),
      h('p', { class: 'muted' }, 'GeoPackage, GeoJSON, shapefile (select the .shp together with its .dbf, .shx and .prj) or GeoParquet. Reaches must carry the id of their downstream reach.'),
      riversInput,
      riversPanel,
      dams.el,
      naturals.el,
      runButton('Use these files', () => {
        if (!d.rivers) return ctx.run('Checking', async () => { throw new Error('Pick a river layer first.'); });
        if (!d.barriers) return ctx.run('Checking', async () => { throw new Error('Pick a barrier layer first.'); });
        ctx.completed(0);
        ctx.goto(1);
      }),
    );
    drawRivers();

    root.append(
      h('p', { class: 'muted' }, 'Everything runs in this browser tab: your files are not uploaded anywhere.'),
      example,
      own,
    );
    if (ctx.done[0] && d.isExample) root.prepend(note('The Ebro example is loaded. Continue with the next step.', 'ok'));
  },
};

export type { Ctx };
