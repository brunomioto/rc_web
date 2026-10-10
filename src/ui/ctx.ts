// Shared state of the wizard.
import type { Barriers } from '../engine/dindex';
import type { IndexOptions } from '../engine/index';
import type { RcNetwork, Table } from '../engine/types';
import type { Db } from '../geo/db';
import type { AdapterMapping, GeoPipeline, LayerInfo, SnapRow, Source } from '../geo/pipeline';
import type { Engine } from '../worker/client';
import type { MapView } from './map';

export interface DataCfg {
  rivers?: Source;
  riversLayers: LayerInfo[];
  riversLayer?: string;
  adapter: 'hydrorivers_v1' | 'hydrosheds_v2' | 'generic';
  mapping: { id: string; down_id: string; length_km: string; upland: string; order: string };
  riversCrs?: number;
  barriers?: Source;
  barriersLayers: LayerInfo[];
  barriersLayer?: string;
  barrierId?: string;
  barriersCrs?: number;
  /** Optional layer of natural barriers (waterfalls). */
  naturals?: Source;
  naturalsLayers: LayerInfo[];
  naturalsLayer?: string;
  naturalId?: string;
  naturalsCrs?: number;
  naturalCoordX?: string;
  naturalCoordY?: string;
  coordX?: string;
  coordY?: string;
  isExample: boolean;
}

/** Passabilities of one kind of barrier: constants, or columns of the barrier layer. */
export interface PassCfg {
  mode: 'value' | 'column';
  /** Upstream passability (fish moving upstream across the barrier). */
  up: number;
  /** Downstream passability. */
  down: number;
  upCol?: string;
  downCol?: string;
}

export interface IndexCfg {
  weight: string[];
  type: 'full' | 'reach' | 'sum';
  mode: 'to' | 'from';
  useBarriers: boolean;
  direction: 'symmetric' | 'asymmetric';
  passConfluence: number;
  kernel: 'none' | 'exponential' | 'threshold' | 'leptokurtic';
  kernelDirection: 'symmetric' | 'asymmetric';
  param: number;
  paramU: number;
  paramD: number;
  sigmaStat: number;
  sigmaMob: number;
  p: number;
  distance: 'upstream' | 'midpoint';
  field: string;
}

export interface Cfg {
  data: DataCfg;
  pass: { dam: PassCfg; natural: PassCfg };
  prune: { minUpland: number; minOrder: number };
  merge: boolean;
  snap: { maxDist: number; endpointTol: number; atConfluence: 'links' | 'drop' };
  build: { lengthUnit: 'km' | 'm' | '10km' };
  derived: string;
  /** Index step: preset id ('dci', 'dci-asym', 'pci', 'iic' or 'custom'). */
  indexPreset: string;
  index: IndexCfg;
  priority: { index: IndexCfg; passU: number; passD: number };
}

export interface Results {
  index?: {
    opts: IndexOptions;
    /** Whole-network result (type full) or the CAFI-like sum. */
    table: Table;
    /** Per-reach result of the same specification (map, histogram, export). */
    reach?: Table;
    /** Index of the same specification without barriers, per network and weight (null: not applicable). */
    baseline?: Table | null;
    ms: number;
  };
  dindex?: { opts: IndexOptions; barriers: Barriers; table: Table; ms: number };
  snap?: SnapRow[];
  /** Node geometries (lon/lat) of the built network, by node id. */
  nodesGeo?: GeoJSON.FeatureCollection;
}

export interface Ctx {
  db: Db;
  geo: GeoPipeline;
  engine: Engine;
  map: MapView;
  cfg: Cfg;
  net?: RcNetwork;
  results: Results;
  done: boolean[];
  /** Go to a step (0-based). */
  goto(i: number): void;
  /** Mark step `i` done and invalidate everything after it. */
  completed(i: number): void;
  /** Runs `fn` with a busy indicator; shows errors in the step banner. */
  run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined>;
  setStatus(msg: string): void;
  debug: boolean;
}

export const defaultIndexCfg = (): IndexCfg => ({
  weight: ['length'],
  type: 'full',
  mode: 'from',
  useBarriers: true,
  direction: 'symmetric',
  passConfluence: 1,
  kernel: 'none',
  kernelDirection: 'symmetric',
  param: 0.95,
  paramU: 0.9,
  paramD: 0.97,
  sigmaStat: 5,
  sigmaMob: 40,
  p: 0.6,
  distance: 'upstream',
  field: 'length',
});

export function defaultCfg(): Cfg {
  const mapping: AdapterMapping & { length_km: string; upland: string; order: string } = {
    id: 'id',
    down_id: 'down_id',
    length_km: '',
    upland: '',
    order: '',
  };
  return {
    data: {
      riversLayers: [],
      barriersLayers: [],
      adapter: 'hydrorivers_v1',
      mapping,
      naturalsLayers: [],
      isExample: false,
    },
    pass: { dam: { mode: 'value', up: 0, down: 0 }, natural: { mode: 'value', up: 0, down: 1 } },
    prune: { minUpland: 0, minOrder: 0 },
    merge: true,
    snap: { maxDist: 1000, endpointTol: 1, atConfluence: 'links' },
    build: { lengthUnit: 'km' },
    derived: '',
    indexPreset: 'dci',
    index: defaultIndexCfg(),
    priority: { index: { ...defaultIndexCfg(), type: 'full' }, passU: 1, passD: 1 },
  };
}
