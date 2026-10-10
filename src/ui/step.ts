// Step plumbing: every step renders its controls into a panel and, once run,
// keeps a summary and a map redraw function so that going back to the step
// shows the result again.
import type { Ctx } from './ctx';
import { h } from './dom';

export interface StepResult {
  summary: HTMLElement;
  /** Redraws the map layers of the step. */
  redraw: () => Promise<void>;
}

export interface Step {
  id: string;
  title: string;
  blurb: string;
  /** Steps that must be done before this one can run. */
  needs: number[];
  render(ctx: Ctx, root: HTMLElement, index: number): void | Promise<void>;
}

export const stepResults = new Map<number, StepResult>();

/** Appends the stored summary of step `i` (if it is done) and redraws its map layers. */
export async function showStored(ctx: Ctx, root: HTMLElement, i: number): Promise<void> {
  const r = stepResults.get(i);
  if (!r || !ctx.done[i]) return;
  root.append(r.summary);
  await r.redraw();
}

export function runButton(label: string, onClick: () => void): HTMLButtonElement {
  return h('button', { class: 'primary', type: 'button', onClick }, label);
}

export function kv(rows: [string, string | number][]): HTMLElement {
  return h(
    'dl',
    { class: 'kv' },
    rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]),
  );
}

export function note(text: string, kind: 'info' | 'warn' | 'ok' = 'info'): HTMLElement {
  return h('p', { class: `note ${kind}` }, text);
}
