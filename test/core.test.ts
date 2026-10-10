import { beforeAll, describe, expect, it } from 'vitest';
import { type RcCore, getCore } from '../src/engine/core';

let c: RcCore;
beforeAll(async () => {
  c = await getCore();
});

describe('rc_core.wasm', () => {
  it('smoke: S_to of a 3-reach chain', () => {
    // reach 2 -> 1 -> 0 (0 is the outlet); fu = fd = (1, .5, .5); unit weights
    expect(c.smoke()).toBeCloseTo(1 + 0.5 + 0.25, 15);
  });

  it('topology, chains and Strahler order of a small forest', () => {
    //        0            5
    //       / \           |
    //      1   2          6
    //     / \
    //    3   4
    const parent = Int32Array.from([-1, 0, 0, 1, 1, -1, 5]);
    const t = c.topology(parent);
    expect(t.nReached).toBe(7);
    expect(Array.from(t.rootOf)).toEqual([0, 0, 0, 0, 0, 5, 5]);
    expect(Array.from(t.depth)).toEqual([0, 1, 1, 2, 2, 0, 1]);
    // children come after their parent in `order`
    const pos = new Map(Array.from(t.order).map((v, i) => [v, i]));
    for (let v = 0; v < 7; v++) if (parent[v] >= 0) expect(pos.get(v)!).toBeGreaterThan(pos.get(parent[v])!);
    expect(Array.from(c.strahler(t))).toEqual([2, 2, 1, 1, 1, 1, 1]);
    const { chain, pos: cp } = c.chains(t);
    // 6 is the only child of 5: same chain; 1 and 2 are children of the confluence 0
    expect(Array.from(chain)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    expect(Array.from(cp)).toEqual([0, 0, 0, 0, 0, 0, 1]);
  });

  it('rejects invalid parents and reports cycles', () => {
    expect(() => c.topology(Int32Array.from([-1, 5]))).toThrow(/invalid parent index at node 2/);
    expect(() => c.topology(Int32Array.from([0]))).toThrow(/own parent/);
    expect(c.topology(Int32Array.from([1, 0, -1])).nReached).toBe(1);
  });
});
