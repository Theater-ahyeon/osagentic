import { describe, it, expect, vi } from 'vitest';
import type { Report } from '../src/domain.js';
import { createHarness, type HarnessDeps } from './harness.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import { CoalescingScheduler } from '../src/coalesce.js';
import { DurableOutbox } from '../src/outbox.js';

function progress(ticketId: string): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0 };
}

function progressWith(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ...progress(ticketId), ...overrides };
}

// 模拟进程重启：重置模块注册表后重新导入，模块级状态（如 ID 计数器）回到初始值，
// 持久化存储跨重启共享，送达幂等检查必须仍然正确。
// 静态导入无法重置模块级状态，此处必须用动态导入行使模块加载边界
describe('重启恢复（Source/Channel 边界）', () => {
  it('重启后新消息 ID 不与旧送达冲突，新中断不被幂等检查丢弃', async () => {
    vi.resetModules();
    const first = await import('./harness.js');
    const { DurableOutbox } = await import('../src/outbox.js');
    const h1 = first.createHarness({ outbox: (d) => new DurableOutbox(d) });
    h1.report(progress('t1'));
    expect(h1.channel.sent()).toHaveLength(1);
    const oldIds = h1.channel.sent().map((m) => m.id);

    vi.resetModules();
    const second = await import('./harness.js');
    const { DurableOutbox: RestartedOutbox } = await import('../src/outbox.js');
    const h2 = second.createHarness({
      persistence: h1.persistence,
      outbox: (d) => new RestartedOutbox(d),
    });
    h2.report(progress('t2'));
    const sent = h2.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('progress on t2');
    expect(oldIds).not.toContain(sent[0]!.id);
  });
});

describe('调度器待决队列与合并组持久化恢复（Source/Channel 边界）', () => {
  const tight: BudgetQoSConfig = { windowMs: 1000, maxInterrupts: 1, maxCost: 100 };
  const ample: BudgetQoSConfig = { windowMs: 10_000, maxInterrupts: 100, maxCost: 1000 };

  it('重启恢复被节流的下半部中断，窗口滚动后补发且不重复', () => {
    const h1 = createHarness({ scheduler: (d) => new BudgetQoSScheduler(d, tight) });
    h1.report(progress('a1'));
    h1.report(progress('a2'));
    expect(h1.channel.sent()).toHaveLength(1);

    const h2 = createHarness({
      persistence: h1.persistence,
      scheduler: (d) => new BudgetQoSScheduler(d, tight),
    });
    h2.advance(1000);
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['a2']);

    const h3 = createHarness({
      persistence: h1.persistence,
      now: 1000,
      scheduler: (d) => new BudgetQoSScheduler(d, tight),
    });
    h3.advance(1000);
    expect(h3.channel.sent()).toHaveLength(0);
  });

  it('重启恢复暂停期间待决的上半部中断，恢复后立即送达且不重复', () => {
    const h1 = createHarness({ scheduler: (d) => new BudgetQoSScheduler(d, tight) });
    h1.pauseNow();
    h1.report(progressWith('urgent', { kind: 'blocked', question: '需要决策' }));
    expect(h1.channel.sent()).toHaveLength(0);

    const h2 = createHarness({
      persistence: h1.persistence,
      scheduler: (d) => new BudgetQoSScheduler(d, tight),
    });
    h2.advance(0);
    const sent = h2.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.purpose).toBe('attention');
    expect(sent[0]!.text).toBe('需要决策');

    const h3 = createHarness({
      persistence: h1.persistence,
      scheduler: (d) => new BudgetQoSScheduler(d, tight),
    });
    h3.advance(0);
    expect(h3.channel.sent()).toHaveLength(0);
  });

  it('重启恢复合并组：窗口中途重启不丢失成员，到期聚合送达一次', () => {
    const scheduler = (d: HarnessDeps) =>
      new CoalescingScheduler(new BudgetQoSScheduler(d, ample), { windowMs: 1000, growthMs: 0 }, d.persistence);
    const h1 = createHarness({ scheduler });
    h1.report(progressWith('t1', { topic: 'build' }));
    h1.report(progressWith('t2', { topic: 'build' }));
    h1.advance(500);
    expect(h1.channel.sent()).toHaveLength(0);

    const h2 = createHarness({ persistence: h1.persistence, now: 500, scheduler });
    h2.report(progressWith('t3', { topic: 'build' }));
    h2.advance(500);
    const sent = h2.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.irqIds).toHaveLength(3);
    expect(sent[0]!.text).toContain('progress on t1');
    expect(sent[0]!.text).toContain('progress on t2');
    expect(sent[0]!.text).toContain('progress on t3');

    const h3 = createHarness({ persistence: h1.persistence, now: 1000, scheduler });
    h3.advance(1000);
    expect(h3.channel.sent()).toHaveLength(0);
  });

  it('合并摘要经 DurableOutbox 送达后重启不重复送达', () => {
    const h1 = createHarness({
      scheduler: (d) =>
        new CoalescingScheduler(new BudgetQoSScheduler(d, ample), { windowMs: 1000, growthMs: 0 }, d.persistence),
      outbox: (d) => new DurableOutbox(d),
    });
    h1.report(progressWith('t1', { topic: 'build' }));
    h1.report(progressWith('t2', { topic: 'build' }));
    h1.advance(1000);
    expect(h1.channel.sent()).toHaveLength(1);

    const h2 = createHarness({
      persistence: h1.persistence,
      now: 1000,
      scheduler: (d) =>
        new CoalescingScheduler(new BudgetQoSScheduler(d, ample), { windowMs: 1000, growthMs: 0 }, d.persistence),
      outbox: (d) => new DurableOutbox(d),
    });
    h2.advance(1000);
    expect(h2.channel.sent()).toHaveLength(0);
  });
});
