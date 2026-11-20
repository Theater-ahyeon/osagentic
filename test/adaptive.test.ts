import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { AttentionMetrics } from '../src/metrics.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import { CoalescingScheduler } from '../src/coalesce.js';
import type { Report } from '../src/domain.js';

const ample: BudgetQoSConfig = { windowMs: 10_000, maxInterrupts: 100, maxCost: 1000 };

function progress(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'build', ...overrides };
}

describe('自适应权重：响应延迟与历史价值反馈（Source/Channel 边界）', () => {
  it('接收人历史响应延迟越大，合并窗口越宽', () => {
    // 构造历史：t2 被节流 1000ms 后补发，alice 的平均响应延迟为 500ms
    const h1 = createHarness({
      scheduler: (d) => new BudgetQoSScheduler(d, { windowMs: 1000, maxInterrupts: 1, maxCost: 100 }),
      metrics: (d) => new AttentionMetrics(d),
    });
    h1.report(progress('t1'));
    h1.report(progress('t2'));
    h1.advance(1000);
    expect(h1.channel.sent()).toHaveLength(2);

    const h2 = createHarness({
      persistence: h1.persistence,
      now: 1000,
      scheduler: (d) =>
        new CoalescingScheduler(
          new BudgetQoSScheduler(d, ample),
          { windowMs: 1000, growthMs: 0, latencyWeight: 1, valueWeight: 0 },
          d.persistence,
          new AttentionMetrics(d),
        ),
    });
    h2.report(progress('t3'));
    // 窗口 = 基础 1000 + 平均响应延迟 500 → 2500 时刻到期
    h2.advance(1499);
    expect(h2.channel.sent()).toHaveLength(0);
    h2.advance(1);
    expect(h2.channel.sent()).toHaveLength(1);
    expect(h2.channel.sent()[0]!.createdAt).toBe(2500);
  });

  it('接收人历史产出价值越高，合并窗口越窄', () => {
    const h1 = createHarness({ metrics: (d) => new AttentionMetrics(d) });
    h1.report(progress('t1', { value: 50, cost: 1 }));
    expect(h1.channel.sent()).toHaveLength(1);

    const h2 = createHarness({
      persistence: h1.persistence,
      scheduler: (d) =>
        new CoalescingScheduler(
          new BudgetQoSScheduler(d, ample),
          { windowMs: 1000, growthMs: 0, latencyWeight: 1, valueWeight: 10 },
          d.persistence,
          new AttentionMetrics(d),
        ),
    });
    h2.report(progress('t2'));
    // 窗口 = 基础 1000 - 价值 50 × 10 → 500 时刻到期
    h2.advance(499);
    expect(h2.channel.sent()).toHaveLength(0);
    h2.advance(1);
    expect(h2.channel.sent()).toHaveLength(1);
    expect(h2.channel.sent()[0]!.createdAt).toBe(500);
  });

  it('历史产出价值提高接收人的优先级权重，团队配额竞争时先送达', () => {
    const h1 = createHarness({ metrics: (d) => new AttentionMetrics(d) });
    h1.report(progress('seed', { value: 10, cost: 1 }));
    expect(h1.channel.sent()).toHaveLength(1);

    const config: BudgetQoSConfig = {
      windowMs: 10_000,
      maxInterrupts: 10,
      maxCost: 100,
      valuePriorityWeight: 1,
      teams: { core: { windowMs: 10_000, maxInterrupts: 1, maxCost: 100, members: ['alice', 'bob'] } },
    };
    const h2 = createHarness({
      persistence: h1.persistence,
      scheduler: (d) => new BudgetQoSScheduler(d, config, new AttentionMetrics(d)),
    });
    h2.pauseNow();
    h2.report(progress('bob-task', { recipient: 'bob', value: 1, cost: 1 }));
    h2.report(progress('alice-task', { value: 1, cost: 1 }));
    h2.resumeNow();
    // 同等 priority/deadline/value-cost 比下，alice 的历史价值权重更高，先送达
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['alice-task']);
  });
});
