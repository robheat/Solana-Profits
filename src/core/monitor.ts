// Read-only health checks. Needs only the wallet's PUBLIC address, so it can run
// unattended (e.g. on a GitHub Actions schedule) without any key material.

import { formatSol } from '../util/amount.ts';
import type { ChainContext } from './chain.ts';
import type { Policy } from './policy.ts';
import type { Issue, PoolEvaluation, ProgramStatus } from './pools.ts';
import { rankPools } from './pools.ts';
import type { Portfolio } from './portfolio.ts';

export interface Alert {
  level: 'critical' | 'warning' | 'info';
  code: string;
  message: string;
}

export interface MonitorReport {
  alerts: Alert[];
  recommendations: string[];
  /** 0 = healthy, 1 = warnings, 2 = critical. */
  exitCode: 0 | 1 | 2;
}

const toAlert = (scope: string, i: Issue): Alert => ({ level: i.level, code: i.code, message: `${scope}: ${i.message}` });

export function runMonitor(params: {
  chain: ChainContext;
  policy: Policy;
  evaluations: PoolEvaluation[];
  programs: ProgramStatus[];
  portfolio: Portfolio;
}): MonitorReport {
  const { chain, policy, evaluations, programs, portfolio } = params;
  const alerts: Alert[] = [];
  const recommendations: string[] = [];

  if (!chain.clusterVerified) {
    alerts.push({ level: 'critical', code: 'wrong-cluster', message: `RPC genesis hash ${chain.genesisHash} is not ${policy.cluster}` });
  }
  for (const p of programs) for (const i of p.issues) alerts.push(toAlert(`program ${p.program}`, i));
  for (const i of portfolio.issues) alerts.push(toAlert('wallet', i));

  const held = portfolio.positions.filter((p) => p.tokens > 0n);
  const heldSymbols = new Set(held.map((p) => p.evaluation.config.symbol));
  for (const e of evaluations) {
    // Pool problems matter most for pools we are actually exposed to.
    const exposed = heldSymbols.has(e.config.symbol);
    for (const i of e.issues) {
      if (exposed) alerts.push(toAlert(e.config.symbol, i));
      else if (i.level === 'critical') alerts.push({ ...toAlert(e.config.symbol, i), level: 'info' });
    }
  }
  for (const pos of portfolio.positions) for (const i of pos.issues) alerts.push(toAlert(`${pos.evaluation.config.symbol} position`, i));

  // Exit readiness: can we actually leave each position right now?
  for (const pos of held) {
    const v = pos.evaluation.verified;
    if (!v) continue;
    if (pos.valueLamports > v.reserveAvailableLamports) {
      alerts.push({
        level: 'warning',
        code: 'exit-liquidity',
        message: `${pos.evaluation.config.symbol}: pool reserve (${formatSol(v.reserveAvailableLamports)} SOL) cannot cover an instant exit of this position (${formatSol(pos.valueLamports)} SOL) right now`,
      });
    }
  }
  const feeFloor = 5_000n + policy.maxPriorityFeeLamports;
  if (held.length && portfolio.solLamports < feeFloor * 3n) {
    alerts.push({
      level: 'warning',
      code: 'low-fee-reserve',
      message: `wallet has ${formatSol(portfolio.solLamports)} SOL liquid; keep at least ${formatSol(policy.reserveLamports)} SOL so an exit can be paid for`,
    });
  }
  if (policy.monitorMinTotalLamports !== null && portfolio.totalValueLamports < policy.monitorMinTotalLamports) {
    alerts.push({
      level: 'critical',
      code: 'value-floor',
      message: `total value ${formatSol(portfolio.totalValueLamports)} SOL is below the alert floor ${formatSol(policy.monitorMinTotalLamports)} SOL — check recent transactions for unauthorized activity`,
    });
  }

  // Advice (never automatic): idle SOL and better pools.
  const idle = portfolio.solLamports - policy.reserveLamports;
  if (idle >= policy.minDepositLamports) {
    recommendations.push(`${formatSol(idle)} SOL is idle above the fee reserve; "plan" shows what a deposit would do`);
  }
  const best = rankPools(evaluations).find((e) => e.depositable);
  for (const pos of held) {
    const cur = pos.evaluation.metrics?.score;
    const top = best?.metrics?.score;
    if (best && best !== pos.evaluation && cur !== undefined && cur !== null && top !== undefined && top !== null) {
      const gain = (top - cur) * 100;
      if (gain >= policy.switchMinAprGainPct) {
        recommendations.push(
          `${best.config.symbol} scores ${gain.toFixed(2)} pp/yr better than ${pos.evaluation.config.symbol} on the latest epoch; confirm over several epochs before switching (withdraw, then deposit)`,
        );
      }
    }
  }

  const exitCode = alerts.some((a) => a.level === 'critical') ? 2 : alerts.some((a) => a.level === 'warning') ? 1 : 0;
  return { alerts, recommendations, exitCode };
}
