// Wizard shell: step navigation, busy overlay, error banner, map.
import { getCore } from '../engine/core';
import { createBrowserDb } from '../geo/db-browser';
import { GeoPipeline } from '../geo/pipeline';
import { startEngine } from '../worker/client';
import { type Ctx, defaultCfg } from './ctx';
import { clear, h } from './dom';
import { MapView } from './map';
import { type Step, stepResults } from './step';
import { indexStep, priorityStep, exportStep } from './steps-analysis';
import { dataStep } from './steps-data';
import { barriersStep, checksStep, mergeStep, pruneStep, riversStep, splitStep } from './steps-geo';

const STEPS: Step[] = [dataStep, riversStep, pruneStep, mergeStep, barriersStep, splitStep, checksStep, indexStep, priorityStep, exportStep];

export async function startApp(root: HTMLElement): Promise<void> {
  const debug = new URLSearchParams(location.search).has('debug');
  const status = h('span', { class: 'status' }, 'Starting…');
  const nav = h('nav', { class: 'steps', 'aria-label': 'Steps' });
  const title = h('h2');
  const blurb = h('p', { class: 'blurb' });
  const msg = h('div', { class: 'msg', role: 'alert' });
  const body = h('div', { class: 'step-body' });
  const mapEl = h('div', { class: 'map' });
  const busy = h('div', { class: 'busy', hidden: true }, h('div', { class: 'spinner' }), h('span', { class: 'busy-text' }));
  root.append(
    h('header', {}, h('h1', {}, 'rc', h('span', {}, '-web')), h('span', { class: 'tag' }, 'river connectivity in your browser'), status),
    h('div', { class: 'layout' }, nav, h('section', { class: 'panel' }, title, blurb, msg, body), mapEl),
    busy,
  );

  const loader = (m: string) => (status.textContent = m);
  const map = new MapView(mapEl);
  const [db, core, engine] = await Promise.all([createBrowserDb(loader), getCore(), startEngine()]);
  const geo = GeoPipeline.create(db, core);

  let current = -1;
  const ctx: Ctx = {
    db,
    geo,
    engine,
    map,
    cfg: defaultCfg(),
    results: {},
    done: STEPS.map(() => false),
    debug,
    goto: (i) => void render(i),
    completed(i) {
      ctx.done[i] = true;
      for (let j = i + 1; j < STEPS.length; j++) {
        ctx.done[j] = false;
        stepResults.delete(j);
      }
      if (i < 5) {
        ctx.net = undefined;
        ctx.results = { snap: ctx.results.snap };
      }
      drawNav();
    },
    async run(label, fn) {
      msg.replaceChildren();
      (busy.querySelector('.busy-text') as HTMLElement).textContent = `${label}…`;
      busy.hidden = false;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        return await fn();
      } catch (e) {
        console.error(e);
        msg.replaceChildren(h('div', { class: 'note warn' }, h('b', {}, 'Something went wrong. '), (e as Error)?.message ?? String(e)));
        return undefined;
      } finally {
        busy.hidden = true;
      }
    },
    setStatus: loader,
  };

  const unlocked = (i: number) => STEPS[i].needs.every((n) => ctx.done[n]);
  function drawNav(): void {
    clear(nav);
    STEPS.forEach((s, i) => {
      const b = h(
        'button',
        {
          type: 'button',
          class: ['step', i === current ? 'current' : '', ctx.done[i] ? 'done' : '', unlocked(i) ? '' : 'locked'].join(' ').trim(),
          disabled: !unlocked(i),
          'aria-current': i === current ? 'step' : undefined,
          onClick: () => void render(i),
        },
        h('span', { class: 'n' }, ctx.done[i] ? '✓' : String(i + 1)),
        s.title,
      );
      nav.append(b);
    });
  }

  async function render(i: number): Promise<void> {
    if (!unlocked(i)) return;
    current = i;
    drawNav();
    title.textContent = `${i + 1}. ${STEPS[i].title}`;
    blurb.textContent = STEPS[i].blurb;
    msg.replaceChildren();
    clear(body);
    // a step's map layers belong to that step
    await map.clear();
    map.setLegend(null);
    try {
      await STEPS[i].render(ctx, body, i);
    } catch (e) {
      console.error(e);
      msg.replaceChildren(h('div', { class: 'note warn' }, (e as Error).message));
    }
    map.resize();
  }

  status.textContent = `DuckDB ${'1.4'} + rc_core ready`;
  if (debug) (window as any).__rc = ctx;
  drawNav();
  await render(0);
}
