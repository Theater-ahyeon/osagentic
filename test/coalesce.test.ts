import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import { CoalescingScheduler, type CoalesceConfig } from '../src/coalesce.js';
import type { Message, Report } from '../src/domain.js';

const ampleBudget: BudgetQoSConfig = { windowMs: 10000, maxInterrupts: 100, maxCost: 1000 };

function progress(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0, ...overrides };
}

function harnessWith(coalesce: CoalesceConfig, budget: BudgetQoSConfig = ampleBudget, now = 0) {
  return createHarness({
    now,
    scheduler: (d) => new CoalescingScheduler(new BudgetQoSScheduler(d, budget), coalesce, d.persistence),
  });
}

describe('CoalescingScheduler 中断合并（Source/Channel 边界）', () => {
  it('时间窗内同一接收人同主题的多个下半部中断聚合为一条摘要送达', () => {
    const h = harnessWith({ windowMs: 1000, growthMs: 0 });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' }));
    h.report(progress('t3', { topic: 'build' }));
    expect(h.channel.sent()).toHaveLength(0);

    h.advance(999);
    expect(h.channel.sent()).toHaveLength(0);

    h.advance(1);
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    const summary = sent[0]!;
    expect(summary.purpose).toBe('notice');
    expect(summary.recipient).toBe('alice');
    expect(summary.channel).toBe('chat-1');
    expect(summary.irqIds).toHaveLength(3);
    expect(new Set(summary.irqIds).size).toBe(3);
    expect(summary.text).toContain('progress on t1');
    expect(summary.text).toContain('progress on t2');
    expect(summary.text).toContain('progress on t3');
    expect(summary.createdAt).toBe(1000);
  });

  it('摘要保留每个原始事项的可追溯链接（links 并集，重复链接去重）', () => {
    const h = harnessWith({ windowMs: 500, growthMs: 0 });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' }));
    h.report(progress('t1', { topic: 'build' }));
    h.advance(500);
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.links).toEqual(['chat-1#t1', 'chat-1#t2']);
    expect(sent[0]!.irqIds).toHaveLength(3);
  });

  it('负载升高时合并窗口增大，且不超过窗口上限', () => {
    const config: CoalesceConfig = { windowMs: 1000, growthMs: 250, maxWindowMs: 4000 };

    const low = harnessWith(config);
    low.report(progress('t1', { topic: 'build' }));
    low.advance(1000);
    expect(low.channel.sent()).toHaveLength(1); // 负载 1 → 窗口 1000

    const high = harnessWith(config);
    for (let i = 1; i <= 5; i += 1) high.report(progress(`t${i}`, { topic: 'build' }));
    high.advance(1000);
    expect(high.channel.sent()).toHaveLength(0); // 负载 5 → 窗口 2000
    high.advance(999);
    expect(high.channel.sent()).toHaveLength(0);
    high.advance(1);
    expect(high.channel.sent()).toHaveLength(1);
    expect(high.channel.sent()[0]!.irqIds).toHaveLength(5);

    const saturated = harnessWith(config);
    for (let i = 1; i <= 20; i += 1) saturated.report(progress(`t${i}`, { topic: 'build' }));
    saturated.advance(3999);
    expect(saturated.channel.sent()).toHaveLength(0); // 窗口封顶 4000
    saturated.advance(1);
    expect(saturated.channel.sent()).toHaveLength(1);
    expect(saturated.channel.sent()[0]!.irqIds).toHaveLength(20);
  });

  it('合并后送达的相对顺序与未合并时一致（per-ticket 有序）', () => {
    const events: Report[] = [
      progress('t1', { topic: 'alpha' }),
      { ticketId: 't1', kind: 'ready', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'alpha' },
      progress('t2', { topic: 'beta' }),
      { ticketId: 't2', kind: 'ready', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'beta' },
    ];
    const sequence = (messages: Message[]) => messages.map((m) => `${m.ticketId}:${m.purpose}`);

    const baseline = createHarness({ scheduler: (d) => new BudgetQoSScheduler(d, ampleBudget) });
    const coalesced = harnessWith({ windowMs: 1000, growthMs: 0 });
    for (const event of events) {
      baseline.report(event);
      coalesced.report(event);
      baseline.advance(2000);
      coalesced.advance(2000);
    }
    expect(sequence(coalesced.channel.sent())).toEqual(sequence(baseline.channel.sent()));
    expect(sequence(coalesced.channel.sent())).toEqual(['t1:notice', 't1:result', 't2:notice', 't2:result']);
  });

  it('同一窗口内同一 Ticket 的事项保持提交顺序，多个摘要按时间先后送达', () => {
    const h = harnessWith({ windowMs: 1000, growthMs: 0 });
    h.report(progress('t1', { topic: 'build' }));
    h.report({ ticketId: 't1', kind: 'ready', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'build' });
    h.advance(1000);
    h.report(progress('t1', { topic: 'build' }));
    h.advance(1000);

    const sent = h.channel.sent();
    expect(sent.map((m) => m.createdAt)).toEqual([1000, 2000]);
    const first = sent[0]!;
    expect(first.purpose).toBe('result'); // 窗口内含 ready 结果
    expect(first.irqIds).toHaveLength(2);
    expect(first.text.indexOf('progress on t1')).toBeLessThan(first.text.indexOf('ready on t1'));
    expect(sent[1]!.irqIds).toHaveLength(1);
  });

  it('上半部紧急中断不参与合并，立即送达且先于窗口到期的摘要', () => {
    const h = harnessWith({ windowMs: 1000, growthMs: 0 });
    h.report(progress('t1', { topic: 'build' }));
    h.report({ ticketId: 't2', kind: 'blocked', question: '需要决策', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'build' });
    h.report({ ticketId: 't3', kind: 'failed', question: '如何修复', recipient: 'alice', channel: 'chat-1', at: 0, topic: 'build' });

    const immediate = h.channel.sent();
    expect(immediate.map((m) => m.purpose)).toEqual(['attention', 'attention']);
    expect(immediate.map((m) => m.ticketId)).toEqual(['t2', 't3']);
    expect(immediate.every((m) => m.irqIds.length === 1)).toBe(true);
    expect(immediate[0]!.text).toBe('需要决策');

    h.advance(1000);
    const sent = h.channel.sent();
    expect(sent).toHaveLength(3);
    expect(sent[2]!.purpose).toBe('notice');
    expect(sent[2]!.irqIds).toHaveLength(1);
  });

  it('不同主题或不同接收人的下半部中断各自独立合并', () => {
    const h = harnessWith({ windowMs: 1000, growthMs: 0 });
    h.report(progress('t1', { topic: 'alpha' }));
    h.report(progress('t2', { topic: 'beta' }));
    h.report(progress('t3', { topic: 'alpha', recipient: 'bob' }));
    expect(h.channel.sent()).toHaveLength(0);
    h.advance(1000);
    const sent = h.channel.sent();
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.irqIds.length === 1)).toBe(true);
    expect(sent.map((m) => m.recipient).sort()).toEqual(['alice', 'alice', 'bob']);
  });

  it('预算节流仍由内层负责：耗尽时不送达，预算恢复后聚合送达', () => {
    const h = harnessWith({ windowMs: 500, growthMs: 0 }, { windowMs: 2000, maxInterrupts: 1, maxCost: 100 });
    h.report(progress('t1', { topic: 'build' }));
    h.report(progress('t2', { topic: 'build' })); // 内层预算耗尽，t2 被节流
    expect(h.channel.sent()).toHaveLength(0);

    h.advance(500);
    expect(h.channel.sent()).toHaveLength(1);
    expect(h.channel.sent()[0]!.irqIds).toHaveLength(1);
    expect(h.channel.sent()[0]!.links).toEqual(['chat-1#t1']);

    h.advance(1500); // 预算窗口滚动，内层补发 t2，进入新的合并窗口
    expect(h.channel.sent()).toHaveLength(1);
    h.advance(500);
    expect(h.channel.sent()).toHaveLength(2);
    expect(h.channel.sent()[1]!.links).toEqual(['chat-1#t2']);
  });
});
