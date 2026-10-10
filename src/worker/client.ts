// Pool of engine workers. Each worker holds its own rc_core.wasm instance and a
// copy of the network. A prioritisation is split by barrier across the workers
// (barrier b goes to worker b mod N) and the partial tables are merged back.
// No SharedArrayBuffer is involved, so no COOP/COEP headers are needed.
import * as Comlink from 'comlink';
import type { Barriers, DindexOptions } from '../engine/dindex';
import type { IndexOptions } from '../engine/index';
import { mergeDindex } from '../engine/merge';
import type { RcNetwork, Table } from '../engine/types';
import type { EngineApi } from './engine.worker';

type Remote = Comlink.Remote<EngineApi>;

export class EnginePool {
  private constructor(private workers: Remote[]) {}

  static async start(size?: number): Promise<EnginePool> {
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
    const n = Math.max(1, Math.min(size ?? cores - 1, 8));
    const workers = Array.from({ length: n }, () =>
      Comlink.wrap<EngineApi>(new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })),
    );
    await Promise.all(workers.map((w) => w.init()));
    return new EnginePool(workers);
  }

  get size(): number {
    return this.workers.length;
  }

  /** Sends the network to every worker. */
  async setNetwork(net: RcNetwork): Promise<void> {
    await Promise.all(this.workers.map((w) => w.setNetwork(net)));
  }

  index(o: IndexOptions): Promise<Table> {
    return this.workers[0].index(o);
  }

  async dindex(
    barriers: Barriers,
    o: Omit<DindexOptions, 'onProgress'>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Table> {
    const B = barriers.id.length;
    const n = Math.min(this.workers.length, B);
    const subset = (w: number): Barriers => {
      const idx = Array.from({ length: B }, (_, b) => b).filter((b) => b % n === w);
      return { id: idx.map((b) => barriers.id[b]), passU: Float64Array.from(idx, (b) => barriers.passU[b]), passD: Float64Array.from(idx, (b) => barriers.passD[b]) };
    };
    const done = new Array<number>(n).fill(0);
    const parts = await Promise.all(
      Array.from({ length: n }, (_, w) =>
        this.workers[w].dindex(
          subset(w),
          o,
          Comlink.proxy((d: number) => {
            done[w] = d;
            onProgress?.(done.reduce((a, x) => a + x, 0), B);
          }),
        ),
      ),
    );
    onProgress?.(B, B);
    if (parts.length === 1) return parts[0];
    return mergeDindex(parts, barriers.id, o.weight ?? ['length'], o.type ?? 'full');
  }
}

export type Engine = EnginePool;

export const startEngine = (size?: number): Promise<Engine> => EnginePool.start(size);
