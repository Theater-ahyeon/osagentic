import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import type { Persistence } from '../src/ports.js';
import type { Report } from '../src/domain.js';

function progress(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0, ...overrides };
}

function harnessWith(config: BudgetQoSConfig, now = 0) {
  return createHarness({ now, scheduler: (d) => new BudgetQoSScheduler(d, config) });
}

// 模拟重启：新 harness 的调度器从旧 harness 的持久化存储加载账本
function restartWith(persistence: Persistence, config: BudgetQoSConfig, now = 0) {
  return createHarness({ now, scheduler: (d) => new BudgetQoSScheduler({ ...d, persistence }, config) });
}

// 暴露调度器实例以便在边界测试中施加策略变更
function harnessWithPolicy(config: BudgetQoSConfig, now = 0) {
  let scheduler!: BudgetQoSScheduler;
  const h = createHarness({ now, scheduler: (d) => (scheduler = new BudgetQoSScheduler(d, config)) });
  return { h, scheduler };
}

describe('BudgetQoSScheduler 注意力预算（Source/Channel 边界）', () => {
  it('超出每窗口次数预算的下半部中断被节流，窗口滚动后补发', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 2, maxCost: 100 });
    h.report(progress('t1'));
    h.report(progress('t2'));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['t1', 't2']);

    h.report(progress('t3'));
    expect(h.channel.sent()).toHaveLength(2);

    h.advance(999);
    expect(h.channel.sent()).toHaveLength(2);

    h.advance(1);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['t1', 't2', 't3']);
  });

  it('多个待决下半部中断按 priority 降序、deadline 升序、value/cost 降序送达', () => {
    const h = harnessWith({ windowMs: 10000, maxInterrupts: 10, maxCost: 100 });
    h.pauseNow();
    h.report(progress('low', { priority: 1 }));
    h.report(progress('mid-late', { priority: 5, deadline: 800, value: 2, cost: 1 }));
    h.report(progress('high', { priority: 9 }));
    h.report(progress('mid-early-lowratio', { priority: 5, deadline: 300, value: 2, cost: 1 }));
    h.report(progress('mid-nodeadline', { priority: 5 }));
    h.report(progress('mid-early-highratio', { priority: 5, deadline: 300, value: 9, cost: 1 }));
    expect(h.channel.sent()).toHaveLength(0);

    h.resumeNow();
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual([
      'high',
      'mid-early-highratio',
      'mid-early-lowratio',
      'mid-late',
      'mid-nodeadline',
      'low',
    ]);
  });

  it('预算耗尽时上半部紧急中断仍立即送达，下半部继续被节流', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('t1'));
    expect(h.channel.sent()).toHaveLength(1);

    h.report({
      ticketId: 'urgent',
      kind: 'blocked',
      recipient: 'alice',
      channel: 'chat-1',
      at: 0,
      question: 'Which design should we use?',
    });
    const sent = h.channel.sent();
    expect(sent.map((m) => m.ticketId)).toEqual(['t1', 'urgent']);
    expect(sent[1]!.purpose).toBe('attention');

    h.report(progress('t2'));
    expect(h.channel.sent()).toHaveLength(2);
  });

  it('无 question 的 blocked/failed 恒为上半部：预算耗尽也立即送达，不被节流', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('t1'));
    h.report({ ticketId: 'b', kind: 'blocked', recipient: 'alice', channel: 'chat-1', at: 0 });
    h.report({ ticketId: 'f', kind: 'failed', recipient: 'alice', channel: 'chat-1', at: 0 });
    const sent = h.channel.sent();
    expect(sent.map((m) => m.ticketId)).toEqual(['t1', 'b', 'f']);
    expect(sent.slice(1).map((m) => m.purpose)).toEqual(['attention', 'attention']);

    h.report(progress('t2'));
    expect(h.channel.sent()).toHaveLength(3);
  });

  it('多接收人各自独立计费，一人耗尽不影响另一人', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('a1'));
    h.report(progress('a2'));
    h.report(progress('b1', { recipient: 'bob' }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'b1']);
  });

  it('可为特定接收人配置独立配额', () => {
    const h = harnessWith({
      windowMs: 1000,
      maxInterrupts: 1,
      maxCost: 100,
      recipients: { bob: { windowMs: 1000, maxInterrupts: 2, maxCost: 100 } },
    });
    h.report(progress('b1', { recipient: 'bob' }));
    h.report(progress('b2', { recipient: 'bob' }));
    h.report(progress('b3', { recipient: 'bob' }));
    h.report(progress('a1'));
    h.report(progress('a2'));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['b1', 'b2', 'a1']);
  });

  it('预算账本持久化，重启后计费精确：已用配额保留、不重复计费', () => {
    const config: BudgetQoSConfig = { windowMs: 1000, maxInterrupts: 2, maxCost: 100 };
    const h1 = harnessWith(config);
    h1.report(progress('a1'));
    h1.report(progress('a2'));
    expect(h1.channel.sent()).toHaveLength(2);

    // 重启：新调度器从同一份持久化存储加载账本
    const h2 = restartWith(h1.persistence, config);
    h2.report(progress('a3'));
    expect(h2.channel.sent()).toHaveLength(0);

    h2.report({ ticketId: 'urgent', kind: 'blocked', recipient: 'alice', channel: 'chat-1', at: 0, question: 'pick one' });
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['urgent']);

    h2.advance(1000);
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['urgent', 'a3']);
    h2.report(progress('a4'));
    h2.report(progress('a5'));
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['urgent', 'a3', 'a4']);
  });

  it('重启保留计费时间戳，滑动窗口按原时间精确滚动', () => {
    const config: BudgetQoSConfig = { windowMs: 1000, maxInterrupts: 2, maxCost: 100 };
    const h1 = harnessWith(config);
    h1.report(progress('a1'));
    h1.advance(600);
    h1.report(progress('a2'));
    expect(h1.channel.sent()).toHaveLength(2);

    const h2 = restartWith(h1.persistence, config, 600);
    h2.report(progress('a3'));
    expect(h2.channel.sent()).toHaveLength(0);

    // t=1000 时仅 t=0 的计费滚出窗口，t=600 的计费仍在窗口内
    h2.advance(400);
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['a3']);
  });

  it('截止时间到期的下半部中断不再被节流，立即补发', () => {
    const h = harnessWith({ windowMs: 10000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('a1'));
    h.report(progress('a2', { deadline: 500 }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1']);

    h.advance(400);
    expect(h.channel.sent()).toHaveLength(1);

    h.advance(200);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'a2']);
  });

  it('暂停期间截止时间按暂停时长顺延，恢复后不误判超时', () => {
    const h = harnessWith({ windowMs: 100000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('a1'));
    h.report(progress('a2', { deadline: 500 }));
    h.advance(100);
    expect(h.channel.sent()).toHaveLength(1);

    // t=100 暂停 400ms：a2 的截止时间从 500 顺延到 900
    h.pauseNow();
    h.advance(400);
    h.resumeNow();
    expect(h.channel.sent()).toHaveLength(1);

    h.advance(300);
    expect(h.channel.sent()).toHaveLength(1);

    h.advance(200);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'a2']);
  });

  it('超出每窗口成本预算的下半部中断被节流，窗口滚动后补发', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 10, maxCost: 5 });
    h.report(progress('c1', { cost: 3 }));
    h.report(progress('c2', { cost: 3 }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['c1']);

    h.advance(1000);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['c1', 'c2']);
  });

  it('成本闸门逐个判定：放不下的被节流，后面放得下的仍送达', () => {
    const h = harnessWith({ windowMs: 1000, maxInterrupts: 10, maxCost: 5 });
    h.pauseNow();
    h.report(progress('x', { value: 4, cost: 4 }));
    h.report(progress('y', { value: 3, cost: 3 }));
    h.report(progress('z', { value: 1, cost: 1 }));
    h.resumeNow();
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['x', 'z']);
  });

  it('团队预算耗尽时节流下半部，即使个人预算仍有余量', () => {
    const h = harnessWith({
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 1, maxCost: 100, members: ['alice', 'bob'] } },
    });
    h.report(progress('a1'));
    h.report(progress('b1', { recipient: 'bob' }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1']);

    h.advance(1000);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'b1']);
  });

  it('团队成本预算独立闸门：个人次数未超但团队成本耗尽仍节流', () => {
    const h = harnessWith({
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 10, maxCost: 5, members: ['alice', 'bob'] } },
    });
    h.report(progress('a1', { cost: 3 }));
    h.report(progress('b1', { recipient: 'bob', cost: 3 }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1']);

    h.advance(1000);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'b1']);
  });

  it('团队预算耗尽时上半部紧急中断仍立即送达', () => {
    const h = harnessWith({
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 1, maxCost: 100, members: ['alice', 'bob'] } },
    });
    h.report(progress('a1'));
    h.report({ ticketId: 'urgent', kind: 'blocked', recipient: 'bob', channel: 'chat-1', at: 0 });
    const sent = h.channel.sent();
    expect(sent.map((m) => m.ticketId)).toEqual(['a1', 'urgent']);
    expect(sent[1]!.purpose).toBe('attention');
  });

  it('团队账本持久化，重启后团队聚合配额保留', () => {
    const config: BudgetQoSConfig = {
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 1, maxCost: 100, members: ['alice', 'bob'] } },
    };
    const h1 = harnessWith(config);
    h1.report(progress('a1'));
    h1.report(progress('b1', { recipient: 'bob' }));
    expect(h1.channel.sent()).toHaveLength(1);

    const h2 = restartWith(h1.persistence, config);
    h2.report(progress('b2', { recipient: 'bob' }));
    expect(h2.channel.sent()).toHaveLength(0);

    // 团队配额已被 a1 消耗：b2 仍被节流；重启恢复的 b1 在窗口滚动后先补发
    h2.advance(1000);
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['b1']);
    h2.advance(1000);
    expect(h2.channel.sent().map((m) => m.ticketId)).toEqual(['b1', 'b2']);
  });

  it('未加入团队的接收人不受团队配额影响', () => {
    const h = harnessWith({
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 1, maxCost: 100, members: ['alice'] } },
    });
    h.report(progress('a1'));
    h.report(progress('a2'));
    h.report(progress('c1', { recipient: 'carol' }));
    h.report(progress('c2', { recipient: 'carol' }));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'c1', 'c2']);
  });

  it('策略版本变更提高配额后，待决中断按新策略重新评估并立即补发', () => {
    const { h, scheduler } = harnessWithPolicy({ version: 1, windowMs: 1000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('a1'));
    h.report(progress('a2'));
    expect(h.channel.sent()).toHaveLength(1);

    scheduler.applyPolicy({ version: 2, windowMs: 1000, maxInterrupts: 5, maxCost: 100 });
    expect(scheduler.policyVersion()).toBe(2);
    h.advance(0);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'a2']);
  });

  it('策略版本变更收紧配额后，新提交的下半部中断按新策略节流', () => {
    const { h, scheduler } = harnessWithPolicy({ version: 1, windowMs: 1000, maxInterrupts: 5, maxCost: 100 });
    h.report(progress('a1'));
    scheduler.applyPolicy({ version: 2, windowMs: 1000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('a2'));
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1']);

    h.advance(1000);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'a2']);
  });

  it('策略版本变更新增团队配额后，待决中断重新验证团队授权', () => {
    const { h, scheduler } = harnessWithPolicy({ version: 1, windowMs: 1000, maxInterrupts: 10, maxCost: 100 });
    h.pauseNow();
    h.report(progress('a1'));
    h.report(progress('b1', { recipient: 'bob' }));

    scheduler.applyPolicy({
      version: 2,
      windowMs: 1000,
      maxInterrupts: 10,
      maxCost: 100,
      teams: { core: { windowMs: 1000, maxInterrupts: 1, maxCost: 100, members: ['alice', 'bob'] } },
    });
    h.resumeNow();
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1']);

    h.advance(1000);
    expect(h.channel.sent().map((m) => m.ticketId)).toEqual(['a1', 'b1']);
  });
});
