import type { Report, ReportKind, Irq, Message } from './domain.js';
import type { Channel, Metrics, Persistence, Scheduler } from './ports.js';
import type { ManualClock } from './clock.js';
import type { PauseState } from './pause.js';
import type { Runtime } from './runtime.js';
import { AttentionMetrics, type DeliveryMetric } from './metrics.js';
import { AttentionViews, type AttentionPanel } from './views.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from './scheduler.js';
import { CoalescingScheduler, type CoalesceConfig } from './coalesce.js';
import { ObservabilityScheduler } from './observability.js';
import { replayTrace, type TraceStep } from './replay.js';

// 一个 Executor 对应一个 ticket，向固定接收人产出报告；value/cost 为该任务的产出价值与注意力成本估计
export interface ExecutorSpec {
  ticketId: string;
  recipient: string;
  channel: string;
  value: number;
  cost: number;
}

export interface WorkloadConfig {
  executors: ExecutorSpec[];
  reportsPerExecutor: number;
  horizonMs: number; // 负载时间跨度
  seed: number; // 确定性随机种子
  drainMs?: number; // 负载结束后的空闲时长，让预算恢复、合并窗口到期，节流的中断补发
  drainStepMs?: number;
}

// 确定性伪随机数（mulberry32），保证负载可复现
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOTTOM_KINDS: ReportKind[] = ['progress', 'ready', 'failed'];
const DEFAULT_DRAIN_MS = 30_000;
const DEFAULT_DRAIN_STEP_MS = 5_000;

// 构造多 Executor 并发负载：每个 Executor 在时间跨度内交错产出 progress/ready/blocked/failed，
// 每第 4 个报告为携带 question 的 blocked（上半部紧急中断）；同一接收人共享主题以便合并。
// 返回按时间排序的输入轨迹，末尾附空闲推进使下半部中断最终全部送达。
export function generateWorkload(config: WorkloadConfig): TraceStep[] {
  const rng = mulberry32(config.seed);
  const spacing = config.horizonMs / config.reportsPerExecutor;
  const timed: { at: number; order: number; report: Report }[] = [];
  config.executors.forEach((executor, executorIndex) => {
    for (let j = 0; j < config.reportsPerExecutor; j++) {
      const jitter = (rng() - 0.5) * spacing * 0.6;
      const at = Math.max(0, Math.floor((j + 0.5) * spacing + jitter));
      const urgent = j % 4 === 3;
      const kind: ReportKind = urgent ? 'blocked' : BOTTOM_KINDS[j % 3]!;
      const report: Report = {
        ticketId: executor.ticketId,
        kind,
        recipient: executor.recipient,
        channel: executor.channel,
        topic: `work-${executor.recipient}`,
        at,
        value: kind === 'ready' ? executor.value : 1,
        cost: executor.cost,
      };
      if (urgent) report.question = `decision-${executor.ticketId}-${j}`;
      timed.push({ at, order: executorIndex * config.reportsPerExecutor + j, report });
    }
  });
  timed.sort((a, b) => a.at - b.at || a.order - b.order);

  const steps: TraceStep[] = [];
  let cursor = 0;
  for (const { at, report } of timed) {
    if (at > cursor) steps.push({ kind: 'advance', ms: at - cursor });
    steps.push({ kind: 'report', at, report });
    cursor = at;
  }
  const drainMs = config.drainMs ?? DEFAULT_DRAIN_MS;
  const drainStepMs = config.drainStepMs ?? DEFAULT_DRAIN_STEP_MS;
  for (let remaining = drainMs; remaining > 0; remaining -= drainStepMs) {
    steps.push({ kind: 'advance', ms: Math.min(drainStepMs, remaining) });
  }
  return steps;
}

export interface EvalConfig {
  budget: BudgetQoSConfig;
  coalesce?: CoalesceConfig;
}

// 完整调度器：可观测性包裹合并，合并包裹预算 QoS；度量经 AttentionMetrics 持久化
export function attentionScheduler(
  deps: { persistence: Persistence; pause: PauseState },
  config: EvalConfig,
): Scheduler {
  return new ObservabilityScheduler(
    { persistence: deps.persistence },
    new CoalescingScheduler(new BudgetQoSScheduler(deps, config.budget), config.coalesce),
  );
}

// 评测运行的外部边界：注入 Report、观察送达、推进时钟（与 test/harness 形状一致）
export interface EvalDeps {
  clock: ManualClock;
  channel: Channel & { sent(): Message[] };
  persistence: Persistence;
  pause: PauseState;
}

export interface EvalRun {
  clock: ManualClock;
  runtime: Runtime;
  persistence: Persistence;
  channel: Channel & { sent(): Message[] };
}

export interface EvalRunOptions {
  scheduler?: (deps: EvalDeps) => Scheduler;
  metrics?: (deps: EvalDeps) => Metrics;
}

export type RunFactory = (opts: EvalRunOptions) => EvalRun;

export type EvalVariant = 'heuristic' | 'scheduler';

export interface EvalMetrics {
  interruptCount: number; // 送达消息数（注意力成本）
  interruptsPerRecipient: number; // 人均中断次数
  meanInterInterruptMs: number; // 同一接收人相邻打断的平均间隔
  deliveredValue: number; // 已送达中断的产出价值总量
  deliveredCost: number; // 已送达中断的注意力成本总量
  coalescedRatio: number; // 合并摘要占送达消息的比例
  throttledRatio: number; // 经历过节流的下半部中断比例
  topInterrupts: number; // 上半部紧急中断总数
  falseSuppressionRate: number; // 上半部被延迟/节流/未送达的比例，正确性约束要求为零
  topDecisionWaitMs: number; // 上半部从中断创建到送达的平均等待
  bottomDecisionWaitMs: number; // 下半部从中断创建到送达的平均等待
  undeliveredBottom: number; // 运行结束仍未送达的下半部中断数
}

export interface EvalOutcome {
  variant: EvalVariant;
  panel: AttentionPanel;
  metrics: EvalMetrics;
  deliveries: Message[];
}

// 同一接收人相邻送达的时间间隔均值
function meanInterInterruptMs(deliveries: DeliveryMetric[]): number {
  const byRecipient = new Map<string, number[]>();
  for (const delivery of deliveries) {
    const ats = byRecipient.get(delivery.recipient) ?? [];
    ats.push(delivery.at);
    byRecipient.set(delivery.recipient, ats);
  }
  const gaps: number[] = [];
  for (const ats of byRecipient.values()) {
    ats.sort((a, b) => a - b);
    for (let i = 1; i < ats.length; i++) gaps.push(ats[i]! - ats[i - 1]!);
  }
  return gaps.length ? gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length : 0;
}

// 从持久事件与 T5 读视图计算度量
function evaluate(persistence: Persistence, panel: AttentionPanel): EvalMetrics {
  const irqs: Irq[] = [];
  // 每个中断的首次送达时刻（合并摘要的成员共享同一送达时刻）
  const deliveredAt = new Map<string, number>();
  for (const event of persistence.log()) {
    if (event.type === 'irq.created') {
      irqs.push(event.payload as Irq);
    } else if (event.type === 'irq.delivered') {
      const metric = event.payload as DeliveryMetric;
      for (const id of metric.irqIds) {
        if (!deliveredAt.has(id)) deliveredAt.set(id, metric.at);
      }
    }
  }
  const top = irqs.filter((irq) => irq.half === 'top');
  const bottom = irqs.filter((irq) => irq.half === 'bottom');
  const waitsOf = (half: Irq[]): number[] =>
    half
      .map((irq) => {
        const at = deliveredAt.get(irq.id);
        return at === undefined ? undefined : at - irq.createdAt;
      })
      .filter((wait): wait is number => wait !== undefined);
  const topWaits = waitsOf(top);
  const bottomWaits = waitsOf(bottom);
  const mean = (values: number[]): number =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  // 误抑制：上半部未送达，或送达时刻晚于创建时刻（被延迟/节流）
  const falseSuppressed = top.filter((irq) => {
    const at = deliveredAt.get(irq.id);
    return at === undefined || at > irq.createdAt;
  }).length;
  const recipientCount = Object.keys(panel.recipients).length;
  return {
    interruptCount: panel.totals.count,
    interruptsPerRecipient: recipientCount ? panel.totals.count / recipientCount : 0,
    meanInterInterruptMs: meanInterInterruptMs(panel.deliveries),
    deliveredValue: panel.totals.value,
    deliveredCost: panel.totals.cost,
    coalescedRatio: panel.totals.count ? panel.coalesced / panel.totals.count : 0,
    throttledRatio: bottom.length ? panel.throttled / bottom.length : 0,
    topInterrupts: top.length,
    falseSuppressionRate: top.length ? falseSuppressed / top.length : 0,
    topDecisionWaitMs: mean(topWaits),
    bottomDecisionWaitMs: mean(bottomWaits),
    undeliveredBottom: bottom.length - bottomWaits.length,
  };
}

// 运行单个变体：启发式用 runtime 默认的立即调度器，调度器用完整调度器；两者均记录度量
export function runVariant(
  variant: EvalVariant,
  trace: TraceStep[],
  config: EvalConfig,
  createRun: RunFactory,
): EvalOutcome {
  const run = createRun({
    scheduler: variant === 'scheduler' ? (d) => attentionScheduler(d, config) : undefined,
    metrics: (d) => new AttentionMetrics(d),
  });
  replayTrace(trace, run);
  const panel = new AttentionViews(run.persistence, config.budget).panel(run.clock.now());
  return {
    variant,
    panel,
    metrics: evaluate(run.persistence, panel),
    deliveries: run.channel.sent(),
  };
}

// 同一负载分别经启发式基线与完整调度器运行，输出注意力成本与产出价值对比
export function compareAB(
  trace: TraceStep[],
  config: EvalConfig,
  createRun: RunFactory,
): { heuristic: EvalOutcome; scheduler: EvalOutcome } {
  return {
    heuristic: runVariant('heuristic', trace, config, createRun),
    scheduler: runVariant('scheduler', trace, config, createRun),
  };
}
