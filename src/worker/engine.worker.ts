// Engine worker: rc_core.wasm + the index / prioritisation code, off the UI
// thread. The page sends the network once (setNetwork) and then asks for
// indices and prioritisations; progress comes back through a callback.
import * as Comlink from 'comlink';
import { type RcCore, getCore } from '../engine/core';
import { rcDindex, type Barriers, type DindexOptions } from '../engine/dindex';
import { rcIndex, type IndexOptions } from '../engine/index';
import type { RcNetwork, Table } from '../engine/types';

let core: RcCore | null = null;
let net: RcNetwork | null = null;

const api = {
  async init(): Promise<number> {
    core = await getCore();
    return core.smoke();
  },
  setNetwork(n: RcNetwork): void {
    net = n;
  },
  index(o: IndexOptions): Table {
    if (!core || !net) throw new Error('Engine not ready: build the network first.');
    return rcIndex(core, net, o);
  },
  dindex(barriers: Barriers, o: Omit<DindexOptions, 'onProgress'>, onProgress?: (done: number, total: number) => void): Table {
    if (!core || !net) throw new Error('Engine not ready: build the network first.');
    return rcDindex(core, net, barriers, { ...o, onProgress });
  },
};

export type EngineApi = typeof api;
Comlink.expose(api);
