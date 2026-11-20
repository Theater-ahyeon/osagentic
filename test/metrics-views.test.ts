import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { AttentionMetrics } from '../src/metrics.js';
import { AttentionViews } from '../src/views.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import type { Report } from '../src/domain.js';
import { CoalescingScheduler } from '../src/coalesce.js';
import { ObservabilityScheduler } from '../src/observability.js';

const generous: BudgetQoSConfig = { windowMs: 60_000, maxInterrupts: 100, maxCost: 1000 };

function progress(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0, ...overrides };
}

function harnessWith(config: BudgetQoSConfig = generous) {
  return createHarness({
    scheduler: (d) => new BudgetQoSScheduler(d, config),
    metrics: (d) => new AttentionMetrics(d),
  });
}

describe('AttentionMetrics 与面板读视图（Source/Channel 边界）', () => {
  it('每次送达记录成本与价值，按接收人累计次数/成本/价值与打断时机', () => {
    const h = harnessWith();
    h.report(progress('t1', { value: 5, cost: 2 }));
    h.report(progress('t2', { kind: 'ready', value: 3, cost: 1 }));
    h.advance(1000);
    h.report(progress('t3', { recipient: 'bob', channel: 'chat-2', value: 4, cost: 2 }));
    expect(h.channel.sent()).toHaveLength(3);

    const panel = new AttentionViews(h.persistence, generous).panel(h.clock.now());
    expect(panel.recipients['alice']).toEqual({ count: 2, cost: 3, value: 8, lastAt: 0 });
    expect(panel.recipients['bob']).toEqual({ count: 1, cost: 2, value: 4, lastAt: 1000 });
    expect(panel.totals).toEqual({ count: 3, cost: 5, value: 12 });
    expect(panel.valueExceedsCost).toBe(true);
    expect(panel.deliveries).toHaveLength(3);
    expect(panel.deliveries[0]).toMatchObject({ recipient: 'alice', at: 0, cost: 2, value: 5 });
    expect(panel.deliveries[2]).toMatchObject({ recipient: 'bob', at: 1000, cost: 2, value: 4 });
  });

  it('成本/价值汇总可验证价值 > 成本：价值不足时判定为 false', () => {
    const h = harnessWith();
    h.report(progress('t1', { value: 1, cost: 5 }));
    expect(h.channel.sent()).toHaveLength(1);

    const panel = new AttentionViews(h.persistence, generous).panel(h.clock.now());
    expect(panel.totals).toEqual({ count: 1, cost: 5, value: 1 });
    expect(panel.valueExceedsCost).toBe(false);
  });

  it('读视图返回每人剩余注意力预算，窗口滚动后恢复', () => {
    const config: BudgetQoSConfig = {
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      recipients: {
        alice: { windowMs: 1000, maxInterrupts: 2, maxCost: 5 },
        carol: { windowMs: 2000, maxInterrupts: 3, maxCost: 9 },
      },
    };
    const h = harnessWith(config);
    h.report(progress('t1', { value: 3, cost: 2 }));
    h.report(progress('t2', { value: 3, cost: 2 }));
    h.report(progress('t3', { recipient: 'bob', channel: 'chat-2', value: 1, cost: 1 }));
    expect(h.channel.sent()).toHaveLength(3);

    const views = new AttentionViews(h.persistence, config);
    expect(views.panel(h.clock.now()).budgets).toEqual([
      { recipient: 'alice', windowMs: 1000, maxInterrupts: 2, maxCost: 5, usedInterrupts: 2, usedCost: 4, remainingInterrupts: 0, remainingCost: 1 },
      { recipient: 'bob', windowMs: 1000, maxInterrupts: 10, maxCost: 100, usedInterrupts: 1, usedCost: 1, remainingInterrupts: 9, remainingCost: 99 },
      { recipient: 'carol', windowMs: 2000, maxInterrupts: 3, maxCost: 9, usedInterrupts: 0, usedCost: 0, remainingInterrupts: 3, remainingCost: 9 },
    ]);

    h.advance(1000);
    expect(views.panel(h.clock.now()).budgets).toEqual([
      { recipient: 'alice', windowMs: 1000, maxInterrupts: 2, maxCost: 5, usedInterrupts: 0, usedCost: 0, remainingInterrupts: 2, remainingCost: 5 },
      { recipient: 'bob', windowMs: 1000, maxInterrupts: 10, maxCost: 100, usedInterrupts: 0, usedCost: 0, remainingInterrupts: 10, remainingCost: 100 },
      { recipient: 'carol', windowMs: 2000, maxInterrupts: 3, maxCost: 9, usedInterrupts: 0, usedCost: 0, remainingInterrupts: 3, remainingCost: 9 },
    ]);
  });
});

describe('队列深度与合并/节流计数（Source/Channel 边界）', () => {
  it('预算节流时读视图返回队列深度与节流计数', () => {
    const config: BudgetQoSConfig = { windowMs: 1000, maxInterrupts: 1, maxCost: 100 };
    const h = createHarness({
      scheduler: (d) => new ObservabilityScheduler(d, new BudgetQoSScheduler(d, config)),
      metrics: (d) => new AttentionMetrics(d),
    });
    h.report(progress('t1', { value: 3, cost: 1 }));
    h.report(progress('t2', { value: 3, cost: 1 }));
    h.report(progress('t3', { value: 3, cost: 1 }));
    expect(h.channel.sent()).toHaveLength(1);
    const views = new AttentionViews(h.persistence, config);
    let panel = views.panel(h.clock.now());
    expect(panel.queueDepth).toBe(2);
    expect(panel.throttled).toBe(2);
    expect(panel.coalesced).toBe(0);

    h.advance(1000);
    expect(h.channel.sent()).toHaveLength(2);
    panel = views.panel(h.clock.now());
    expect(panel.queueDepth).toBe(1);
    expect(panel.throttled).toBe(2);

    h.advance(1000);
    expect(h.channel.sent()).toHaveLength(3);
    panel = views.panel(h.clock.now());
    expect(panel.queueDepth).toBe(0);
  });

  it('合并送达时读视图返回合并计数', () => {
    const config: BudgetQoSConfig = { windowMs: 60_000, maxInterrupts: 100, maxCost: 1000 };
    const h = createHarness({
      scheduler: (d) =>
        new ObservabilityScheduler(d, new CoalescingScheduler(new BudgetQoSScheduler(d, config), { windowMs: 1000, growthMs: 0 }, d.persistence)),
      metrics: (d) => new AttentionMetrics(d),
    });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' }));
    h.report(progress('t3', { topic: 'build' }));
    expect(h.channel.sent()).toHaveLength(0);
    let panel = new AttentionViews(h.persistence, config).panel(h.clock.now());
    expect(panel.queueDepth).toBe(3);

    h.advance(1000);
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.irqIds).toHaveLength(3);
    panel = new AttentionViews(h.persistence, config).panel(h.clock.now());
    expect(panel.coalesced).toBe(1);
    expect(panel.queueDepth).toBe(0);
  });

  it('合并缓冲中的中断不计入节流统计', () => {
    const config: BudgetQoSConfig = { windowMs: 60_000, maxInterrupts: 100, maxCost: 1000 };
    const h = createHarness({
      scheduler: (d) =>
        new ObservabilityScheduler(d, new CoalescingScheduler(new BudgetQoSScheduler(d, config), { windowMs: 1000, growthMs: 0 }, d.persistence)),
      metrics: (d) => new AttentionMetrics(d),
    });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' }));
    h.report(progress('t3', { topic: 'build' }));
    const views = new AttentionViews(h.persistence, config);
    let panel = views.panel(h.clock.now());
    expect(panel.queueDepth).toBe(3);
    expect(panel.throttled).toBe(0);
    expect(panel.coalesced).toBe(0);

    h.advance(1000);
    panel = views.panel(h.clock.now());
    expect(panel.coalesced).toBe(1);
    expect(panel.throttled).toBe(0);
    expect(panel.queueDepth).toBe(0);
  });

  it('预算节流与合并缓冲同时存在时只统计预算节流', () => {
    const config: BudgetQoSConfig = { windowMs: 1000, maxInterrupts: 1, maxCost: 100 };
    const h = createHarness({
      scheduler: (d) =>
        new ObservabilityScheduler(d, new CoalescingScheduler(new BudgetQoSScheduler(d, config), { windowMs: 500, growthMs: 0 }, d.persistence)),
      metrics: (d) => new AttentionMetrics(d),
    });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' }));
    const views = new AttentionViews(h.persistence, config);
    let panel = views.panel(h.clock.now());
    expect(panel.queueDepth).toBe(2);
    expect(panel.throttled).toBe(1);

    // t1 进入合并缓冲，t2 被预算节流：只有 t2 计入节流
    h.advance(500);
    panel = views.panel(h.clock.now());
    expect(h.channel.sent()).toHaveLength(1);
    expect(panel.throttled).toBe(1);
    expect(panel.queueDepth).toBe(1);

    // t=1000 预算窗口滚动，t2 补发进入新的合并缓冲；t=1500 窗口到期送达
    h.advance(500);
    expect(h.channel.sent()).toHaveLength(1);
    h.advance(500);
    panel = views.panel(h.clock.now());
    expect(h.channel.sent()).toHaveLength(2);
    expect(panel.throttled).toBe(1);
    expect(panel.queueDepth).toBe(0);
  });
});

describe('度量持久化重启可读', () => {
  it('重启后新实例从持久化加载度量', () => {
    const h = harnessWith();
    h.report(progress('t1', { value: 5, cost: 2 }));
    h.report(progress('t2', { kind: 'ready', value: 3, cost: 1 }));
    h.advance(1000);
    const before = new AttentionViews(h.persistence, generous).panel(h.clock.now());
    const restarted = new AttentionMetrics({ persistence: h.persistence });
    expect(restarted).toBeDefined();
    const after = new AttentionViews(h.persistence, generous).panel(h.clock.now());
    expect(after.recipients).toEqual(before.recipients);
    expect(after.totals).toEqual(before.totals);
    expect(after.deliveries).toEqual(before.deliveries);
  });
});
