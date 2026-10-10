// Port of rc2/R/checks.R network_checks(): checks shown in their own wizard step.
import type { Check } from '../geo/pipeline';
import { numCol, strCol, type RcNetwork } from './types';

function row(
  stage: string,
  check: string,
  ids: string[],
  message: string,
  hint: string | null,
  fail: Check['severity'] = 'warning',
): Check {
  const failed = ids.length > 0;
  return {
    stage,
    check,
    severity: failed ? fail : 'ok',
    n: ids.length,
    ids,
    message: failed ? message : 'passed',
    hint: failed ? hint : null,
  };
}

export function networkChecks(net: RcNetwork): Check[] {
  const nNet = net.netNames.length;
  const type = strCol(net.edges, 'type');
  const pu = numCol(net.edges, 'pass_u');
  const pd = numCol(net.edges, 'pass_d');
  const bar = strCol(net.edges, 'id_barrier');
  const passBad: string[] = [];
  type.forEach((t, e) => {
    if ((t === 'dam' || t === 'natural') && (Number.isNaN(pu[e]) || Number.isNaN(pd[e]))) passBad.push(String(bar[e]));
  });
  const nChild = new Int32Array(net.ids.length);
  for (const p of net.parent) nChild[p]++;
  const multi = net.ids.filter((_, v) => nChild[v] > 2);
  return [
    row(
      'topology',
      'single_network',
      nNet > 1 ? net.netNames : [],
      `${nNet} separate networks (outlets); indices are computed per network.`,
      'Restrict the input to one basin if a single index is expected.',
      'info',
    ),
    row(
      'topology',
      'multiple_confluences',
      multi,
      `${multi.length} reaches receive more than two tributaries.`,
      'Usually harmless; check digitisation errors at these confluences.',
      'info',
    ),
    row(
      'barriers',
      'passability_defined',
      passBad,
      `${passBad.length} barrier edges without pass_u/pass_d; treated as passable.`,
      'Set passabilities in the barrier table.',
    ),
  ];
}
