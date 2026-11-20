import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { AttentionMetrics } from '../src/metrics.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import { CoalescingScheduler } from '../src/coalesce.js';
import { ObservabilityScheduler } from '../src/observability.js';
import { deliveryStreamOf, snapshotsOf, TraceRecorder, replayTrace } from '../src/replay.js';
import type { Report } from '../src/domain.js';
import { generateWorkload, compareAB, type EvalConfig, type RunFactory } from '../src/eval.js';
import type { TraceStep } from '../src/replay.js';

const budget: BudgetQoSConfig = { windowMs: 10_000, maxInterrupts: 10, maxCost: 100 };

function fullStackHarness() {
  return createHarness({
    scheduler: (d) =>
      new ObservabilityScheduler(
        d,
        new CoalescingScheduler(new BudgetQoSScheduler(d, budget), { windowMs: 2000, growthMs: 0 }, d.persistence),
      ),
    metrics: (d) => new AttentionMetrics(d),
  });
}

function report(ticketId: string, overrides: Partial<Report> = {}): Report {
  return {
    ticketId,
    kind: 'progress',
    recipient: 'alice',
    channel: 'chat-alice',
    topic: 'proj',
    at: 0,
    value: 4,
    cost: 2,
    ...overrides,
  };
}

describe('从持久事件重建送达流（Source/Channel 边界）', () => {
  it('replay 持久事件得到的送达流与实际送达一致', () => {
    const h = fullStackHarness();
    h.report(report('t1'));
    h.report(report('t2'));
    h.report(report('t3', { kind: 'blocked', question: '需要人工决策' }));
    h.advance(2000);
    h.report(report('t4', { kind: 'ready', at: 2000, value: 6 }));
    h.advance(2000);

    const sent = h.channel.sent();
    expect(sent).toHaveLength(3);
    const stream = deliveryStreamOf(h.persistence);
    // 外部行为：上半部立即送达，两条 progress 合并为一条摘要，ready 随后送达
    expect(stream.map((d) => d.purpose)).toEqual(['attention', 'notice', 'result']);
    expect(stream.map((d) => d.at)).toEqual([0, 2000, 4000]);
    expect(stream[1]!.interrupts).toHaveLength(2);
    expect(stream.every((d) => d.recipient === 'alice')).toBe(true);
    // 重建流与边界观察到的送达逐条一致
    expect(stream).toEqual(snapshotsOf(sent, h.persistence));
  });
});

describe('输入轨迹 replay 重现送达流（Source/Channel 边界）', () => {
  it('记录 Report 序列与时钟推进/暂停，经新 runtime 重现与原送达流一致', () => {
    const original = fullStackHarness();
    const recorder = new TraceRecorder(original);
    recorder.report(report('t1'));
    recorder.report(report('t2'));
    recorder.report(report('t3', { kind: 'blocked', question: '需要人工决策' }));
    recorder.advance(1000);
    recorder.pauseNow();
    recorder.advance(5000);
    // 暂停期间只有上半部已送达，下半部摘要被挂起
    expect(original.channel.sent()).toHaveLength(1);
    recorder.resumeNow();
    recorder.advance(1000);
    recorder.report(report('t4', { kind: 'ready', at: 7000, value: 6 }));
    recorder.advance(2000);

    const replayed = fullStackHarness();
    replayTrace(recorder.trace(), replayed);

    expect(original.channel.sent()).toHaveLength(3);
    expect(snapshotsOf(replayed.channel.sent(), replayed.persistence)).toEqual(
      deliveryStreamOf(original.persistence),
    );
    expect(snapshotsOf(replayed.channel.sent(), replayed.persistence)).toEqual(
      snapshotsOf(original.channel.sent(), original.persistence),
    );
  });
});

describe('多 Executor 并发负载（Source/Channel 边界）', () => {
  it('构造多 ticket/多 recipient 的带时间戳负载，全部任务经边界送达', () => {
    const trace = generateWorkload({
      executors: [
        { ticketId: 'task-a', recipient: 'alice', channel: 'chat-alice', value: 8, cost: 2 },
        { ticketId: 'task-b', recipient: 'alice', channel: 'chat-alice', value: 5, cost: 1 },
        { ticketId: 'task-c', recipient: 'bob', channel: 'chat-bob', value: 6, cost: 2 },
      ],
      reportsPerExecutor: 8,
      horizonMs: 20_000,
      seed: 42,
    });
    const reports = trace.filter((s): s is Extract<TraceStep, { kind: 'report' }> => s.kind === 'report');
    expect(reports).toHaveLength(24);
    const ats = reports.map((s) => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(new Set(reports.map((s) => s.report.ticketId))).toEqual(new Set(['task-a', 'task-b', 'task-c']));
    expect(new Set(reports.map((s) => s.report.recipient))).toEqual(new Set(['alice', 'bob']));
    expect(new Set(reports.map((s) => s.report.kind))).toEqual(
      new Set(['progress', 'ready', 'blocked', 'failed']),
    );
    expect(reports.some((s) => s.report.question !== undefined)).toBe(true);

    const h = fullStackHarness();
    replayTrace(trace, h);
    // 合并摘要保留每个原始事项的可追溯链接，全部 ticket 必须可见
    const deliveredTickets = new Set(
      h.channel.sent().flatMap((m) => m.links.map((link) => link.split('#')[1])),
    );
    expect(deliveredTickets).toEqual(new Set(['task-a', 'task-b', 'task-c']));
  });
});

describe('A/B 启发式 vs 调度器（Source/Channel 边界）', () => {
  const abConfig: EvalConfig = {
    budget: { windowMs: 10_000, maxInterrupts: 4, maxCost: 40 },
    coalesce: { windowMs: 2000 },
  };
  const workload = () =>
    generateWorkload({
      executors: [
        { ticketId: 'task-a', recipient: 'alice', channel: 'chat-alice', value: 8, cost: 2 },
        { ticketId: 'task-b', recipient: 'alice', channel: 'chat-alice', value: 5, cost: 1 },
        { ticketId: 'task-c', recipient: 'bob', channel: 'chat-bob', value: 6, cost: 2 },
        { ticketId: 'task-d', recipient: 'bob', channel: 'chat-bob', value: 9, cost: 1 },
      ],
      reportsPerExecutor: 10,
      horizonMs: 20_000,
      seed: 7,
      drainMs: 50_000,
      drainStepMs: 1000,
    });
  const runFactory: RunFactory = (opts) =>
    createHarness({
      scheduler: opts.scheduler ? (d) => opts.scheduler!(d) : undefined,
      metrics: opts.metrics ? (d) => opts.metrics!(d) : undefined,
    });

  it('调度器降低注意力成本（中断次数），产出价值不损失', () => {
    const ab = compareAB(workload(), abConfig, runFactory);
    // 启发式全部立即：40 个中断各送达一次；价值/成本为负载的已知总量
    expect(ab.heuristic.metrics.interruptCount).toBe(40);
    expect(ab.heuristic.metrics.deliveredValue).toBe(88);
    expect(ab.heuristic.metrics.deliveredCost).toBe(60);
    expect(ab.heuristic.metrics.interruptsPerRecipient).toBe(20);
    // 调度器合并+节流减少打断，全部价值最终送达
    expect(ab.scheduler.metrics.interruptCount).toBeLessThan(40);
    expect(ab.scheduler.metrics.deliveredValue).toBe(88);
    expect(ab.scheduler.metrics.deliveredCost).toBe(60);
    expect(ab.scheduler.metrics.interruptsPerRecipient).toBeLessThan(20);
    expect(ab.scheduler.metrics.meanInterInterruptMs).toBeGreaterThan(
      ab.heuristic.metrics.meanInterInterruptMs,
    );
    expect(ab.scheduler.metrics.coalescedRatio).toBeGreaterThan(0);
    expect(ab.heuristic.metrics.coalescedRatio).toBe(0);
    expect(ab.scheduler.metrics.throttledRatio).toBeGreaterThan(0);
    expect(ab.heuristic.metrics.throttledRatio).toBe(0);
    expect(ab.scheduler.panel.totals.count).toBe(ab.scheduler.metrics.interruptCount);
  });

  it('上半部紧急中断误抑制率为零且决策等待为零，下半部等待可度量', () => {
    const ab = compareAB(workload(), abConfig, runFactory);
    // 负载含 20 个上半部紧急中断（每个 Executor 2 个携带 question 的 blocked 与 3 个 failed）
    expect(ab.heuristic.metrics.topInterrupts).toBe(20);
    expect(ab.scheduler.metrics.topInterrupts).toBe(20);
    expect(ab.heuristic.metrics.falseSuppressionRate).toBe(0);
    expect(ab.scheduler.metrics.falseSuppressionRate).toBe(0);
    expect(ab.heuristic.metrics.topDecisionWaitMs).toBe(0);
    expect(ab.scheduler.metrics.topDecisionWaitMs).toBe(0);
    expect(ab.heuristic.metrics.bottomDecisionWaitMs).toBe(0);
    expect(ab.scheduler.metrics.bottomDecisionWaitMs).toBeGreaterThan(0);
    expect(ab.heuristic.metrics.undeliveredBottom).toBe(0);
    expect(ab.scheduler.metrics.undeliveredBottom).toBe(0);
  });
});
