import { describe, it, expect } from 'vitest';
import { ManualClock } from '../src/clock.js';
import { InMemoryPersistence } from '../src/persistence.js';
import { PauseState } from '../src/pause.js';
import { DurableOutbox } from '../src/outbox.js';
import { nextId } from '../src/domain.js';
import type { DeliveryRecord, DomainEvent, Message } from '../src/domain.js';
import type { SendResult } from '../src/ports.js';
import { RecordingChannel, createHarness } from './harness.js';
import type { Report } from '../src/domain.js';
import { AttentionMetrics } from '../src/metrics.js';
import { AttentionViews } from '../src/views.js';
import type { BudgetQoSConfig } from '../src/scheduler.js';

type Fault = 'waiting' | 'gone' | 'throw';

// 可配置故障的 Channel：按调用次序消费故障序列，其余调用正常送达
class ControllableChannel extends RecordingChannel {
  private readonly faults: Fault[] = [];
  private calls = 0;
  onAttempt?: (message: Message) => void;

  failNext(...faults: Fault[]): void {
    this.faults.push(...faults);
  }

  attempts(): number {
    return this.calls;
  }

  override send(message: Message): SendResult {
    this.calls += 1;
    this.onAttempt?.(message);
    const fault = this.faults.shift();
    if (fault === 'throw') throw new Error('channel send failed');
    if (fault !== undefined) return fault;
    return super.send(message);
  }
}

// 故障注入：receipt 事件写入后的第一次 save 抛错，模拟进程在队列更新前崩溃
class CrashAfterReceiptPersistence extends InMemoryPersistence {
  private crashPending = false;

  override append(event: DomainEvent): void {
    super.append(event);
    if (event.type === 'delivery.sent') this.crashPending = true;
  }

  override save<T>(key: string, value: T): void {
    if (this.crashPending) {
      this.crashPending = false;
      throw new Error('crash before queue update');
    }
    // 快照模拟真实持久化：崩溃后存储保留最后一次成功 save 的状态
    super.save(key, structuredClone(value));
  }
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: nextId('msg'),
    ticketId: 't1',
    recipient: 'alice',
    channel: 'chat-1',
    purpose: 'notice',
    text: 'progress on t1',
    irqIds: [nextId('irq')],
    links: ['chat-1#t1'],
    createdAt: 0,
    ...overrides,
  };
}

function setup(now = 0) {
  const clock = new ManualClock(now);
  const channel = new ControllableChannel();
  const persistence = new InMemoryPersistence();
  const pause = new PauseState();
  const outbox = new DurableOutbox({ clock, channel, persistence, pause });
  return { clock, channel, persistence, pause, outbox };
}

function receipt(persistence: InMemoryPersistence, id: string): DeliveryRecord | undefined {
  return persistence.load<DeliveryRecord>(`delivery:${id}`);
}

describe('DurableOutbox boundary', () => {
  it('persists before sending and records a receipt on success', () => {
    const s = setup();
    const m = message();
    const statusAtSend: Array<string | undefined> = [];
    s.channel.onAttempt = () => {
      statusAtSend.push(receipt(s.persistence, m.id)?.status);
    };
    s.outbox.enqueue(m);
    expect(statusAtSend).toEqual(['waiting']);
    expect(s.channel.sent()).toEqual([m]);
    const record = receipt(s.persistence, m.id);
    expect(record?.status).toBe('sent');
    expect(record?.sentAt).toBe(0);
    expect(record?.attempts).toBe(1);
  });

  it('retries failed delivery with exponential backoff and records the receipt on success', () => {
    const s = setup();
    const m = message();
    s.channel.failNext('waiting', 'waiting');
    s.outbox.enqueue(m);
    expect(s.channel.sent()).toHaveLength(0);
    expect(receipt(s.persistence, m.id)?.status).toBe('waiting');
    expect(receipt(s.persistence, m.id)?.attempts).toBe(1);
    s.outbox.drain(999);
    expect(s.channel.attempts()).toBe(1);
    s.outbox.drain(1000);
    expect(s.channel.attempts()).toBe(2);
    expect(s.channel.sent()).toHaveLength(0);
    s.outbox.drain(2999);
    expect(s.channel.attempts()).toBe(2);
    s.outbox.drain(3000);
    expect(s.channel.sent()).toEqual([m]);
    const record = receipt(s.persistence, m.id);
    expect(record?.status).toBe('sent');
    expect(record?.sentAt).toBe(3000);
    expect(record?.attempts).toBe(3);
  });

  it('treats a throwing channel as a retryable failure', () => {
    const s = setup();
    const m = message();
    s.channel.failNext('throw');
    s.outbox.enqueue(m);
    expect(s.channel.sent()).toHaveLength(0);
    s.outbox.drain(999);
    expect(s.channel.attempts()).toBe(1);
    s.outbox.drain(1000);
    expect(s.channel.sent()).toEqual([m]);
    expect(receipt(s.persistence, m.id)?.attempts).toBe(2);
  });

  it('keeps acknowledgement ahead of answer and result in the same conversation', () => {
    const s = setup();
    const ack = message({ purpose: 'acknowledgement', text: 'received' });
    const answer = message({ purpose: 'answer', text: 'use design A' });
    const result = message({ purpose: 'result', text: 'done' });
    s.channel.failNext('waiting', 'waiting');
    s.outbox.enqueue(ack);
    s.outbox.enqueue(answer);
    s.outbox.enqueue(result);
    // acknowledgement 未送达，后序消息不得越过
    expect(s.channel.attempts()).toBe(1);
    expect(s.channel.sent()).toHaveLength(0);
    s.outbox.drain(1000);
    expect(s.channel.attempts()).toBe(2);
    expect(s.channel.sent()).toHaveLength(0);
    s.outbox.drain(3000);
    expect(s.channel.sent()).toEqual([ack, answer, result]);
  });

  it('does not block other tickets or conversations behind a failed delivery', () => {
    const s = setup();
    const blocked = message({ ticketId: 't1' });
    const otherTicket = message({ ticketId: 't2' });
    const otherChannel = message({ ticketId: 't1', channel: 'chat-2' });
    s.channel.failNext('waiting');
    s.outbox.enqueue(blocked);
    s.outbox.enqueue(otherTicket);
    s.outbox.enqueue(otherChannel);
    expect(s.channel.sent()).toEqual([otherTicket, otherChannel]);
    s.outbox.drain(1000);
    expect(s.channel.sent()).toEqual([otherTicket, otherChannel, blocked]);
  });

  it('waits instead of dropping when the source is gone and delivers after recovery', () => {
    const s = setup();
    const m = message();
    s.channel.failNext('gone', 'gone');
    s.outbox.enqueue(m);
    expect(s.channel.sent()).toHaveLength(0);
    expect(receipt(s.persistence, m.id)?.status).toBe('gone');
    s.outbox.drain(1000);
    expect(s.channel.sent()).toHaveLength(0);
    expect(receipt(s.persistence, m.id)?.status).toBe('gone');
    s.outbox.drain(3000);
    expect(s.channel.sent()).toEqual([m]);
    expect(receipt(s.persistence, m.id)?.status).toBe('sent');
  });

  it('suppresses delivery while paused and delivers on resume', () => {
    const s = setup();
    s.pause.pause(0);
    const m = message();
    s.outbox.enqueue(m);
    expect(s.channel.attempts()).toBe(0);
    expect(s.channel.sent()).toHaveLength(0);
    s.clock.set(2000);
    s.pause.resume(2000);
    s.outbox.drain(2000);
    expect(s.channel.sent()).toEqual([m]);
  });

  it('shifts retry deadlines by the paused duration after resume', () => {
    const s = setup();
    const m = message();
    s.channel.failNext('waiting');
    s.outbox.enqueue(m);
    s.pause.pause(500);
    s.clock.set(3500);
    s.pause.resume(3500);
    s.outbox.drain(3500);
    // 重试截止时间从 1000 顺延暂停时长 3000 到 4000
    expect(s.channel.attempts()).toBe(1);
    expect(s.channel.sent()).toHaveLength(0);
    s.outbox.drain(4000);
    expect(s.channel.sent()).toEqual([m]);
  });

  it('delivers messages enqueued during pause immediately on resume', () => {
    const s = setup();
    s.pause.pause(0);
    s.clock.set(1000);
    const m = message({ createdAt: 1000 });
    s.outbox.enqueue(m);
    s.clock.set(5000);
    s.pause.resume(5000);
    s.outbox.drain(5000);
    expect(s.channel.sent()).toEqual([m]);
  });

  it('restores pending deliveries after restart and never resends delivered messages', () => {
    const s = setup();
    const delivered = message({ text: 'already sent' });
    const pendingAck = message({ purpose: 'acknowledgement' });
    const pendingAnswer = message({ purpose: 'answer' });
    s.outbox.enqueue(delivered);
    s.channel.failNext('gone');
    s.outbox.enqueue(pendingAck);
    s.outbox.enqueue(pendingAnswer);
    expect(s.channel.sent()).toEqual([delivered]);

    // 重启：新进程共享 Persistence，Channel 重新记录送达
    const channel2 = new ControllableChannel();
    const restarted = new DurableOutbox({
      clock: s.clock,
      channel: channel2,
      persistence: s.persistence,
      pause: s.pause,
    });
    restarted.drain(0);
    expect(channel2.sent()).toHaveLength(0);
    restarted.drain(1000);
    expect(channel2.sent()).toEqual([pendingAck, pendingAnswer]);

    // 再次重启：待决队列已清空，幂等无重复送达
    const channel3 = new ControllableChannel();
    const restartedAgain = new DurableOutbox({
      clock: s.clock,
      channel: channel3,
      persistence: s.persistence,
      pause: s.pause,
    });
    restartedAgain.drain(5000);
    expect(channel3.sent()).toHaveLength(0);
  });

  it('ignores re-enqueue of an already delivered message after restart', () => {
    const s = setup();
    const m = message();
    s.outbox.enqueue(m);
    const channel2 = new ControllableChannel();
    const restarted = new DurableOutbox({
      clock: s.clock,
      channel: channel2,
      persistence: s.persistence,
      pause: s.pause,
    });
    restarted.enqueue(m);
    restarted.drain(1000);
    expect(channel2.sent()).toHaveLength(0);
    expect(s.channel.attempts()).toBe(1);
  });

  it('does not resend when a crash lands between the receipt and the queue update', () => {
    const clock = new ManualClock(0);
    const channel = new ControllableChannel();
    const persistence = new CrashAfterReceiptPersistence();
    const pause = new PauseState();
    const outbox = new DurableOutbox({ clock, channel, persistence, pause });
    const m = message();
    // receipt 持久化之后、队列更新之前进程崩溃
    expect(() => outbox.enqueue(m)).toThrow('crash before queue update');
    expect(channel.sent()).toEqual([m]);

    const channel2 = new ControllableChannel();
    const restarted = new DurableOutbox({ clock, channel: channel2, persistence, pause });
    restarted.drain(5000);
    expect(channel2.sent()).toHaveLength(0);
  });
});

describe('DurableOutbox via runtime harness', () => {
  function harness() {
    return createHarness({ outbox: (d) => new DurableOutbox(d) });
  }

  function report(overrides: Partial<Report> = {}): Report {
    return {
      ticketId: 't1',
      kind: 'progress',
      recipient: 'alice',
      channel: 'chat-1',
      at: 0,
      ...overrides,
    };
  }

  it('delivers a blocked question immediately through the runtime', () => {
    const h = harness();
    h.report(report({ kind: 'blocked', question: 'Which design should we use?' }));
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.purpose).toBe('attention');
    expect(sent[0]!.text).toContain('Which design should we use?');
  });

  it('keeps notice ahead of result for the same ticket and conversation', () => {
    const h = harness();
    h.report(report({ kind: 'progress' }));
    h.report(report({ kind: 'ready' }));
    expect(h.channel.sent().map((m) => m.purpose)).toEqual(['notice', 'result']);
  });

  it('suppresses delivery while paused and delivers on resume', () => {
    const h = harness();
    h.pauseNow();
    h.report(report());
    expect(h.channel.sent()).toHaveLength(0);
    h.advance(5000);
    expect(h.channel.sent()).toHaveLength(0);
    h.resumeNow();
    expect(h.channel.sent()).toHaveLength(1);
    expect(h.pause.pausedMs()).toBe(5000);
  });

  it('does not duplicate deliveries when a restarted outbox drains again', () => {
    const h = harness();
    h.report(report());
    expect(h.channel.sent()).toHaveLength(1);
    const restarted = new DurableOutbox({
      clock: h.clock,
      channel: h.channel,
      persistence: h.persistence,
      pause: h.pause,
    });
    restarted.drain(h.clock.now());
    expect(h.channel.sent()).toHaveLength(1);
  });

  const ample: BudgetQoSConfig = { windowMs: 60_000, maxInterrupts: 100, maxCost: 1000 };

  it('DurableOutbox 与 AttentionMetrics 组合：退避重试成功后仍记录度量', () => {
    const channel = new ControllableChannel();
    const h = createHarness({
      channel,
      outbox: (d) => new DurableOutbox({ ...d, metrics: new AttentionMetrics(d) }),
    });
    channel.failNext('waiting', 'waiting');
    h.report(report({ value: 5, cost: 2 }));
    expect(channel.sent()).toHaveLength(0);
    expect(new AttentionViews(h.persistence, ample).panel(0).totals).toEqual({ count: 0, cost: 0, value: 0 });

    h.advance(1000);
    expect(channel.sent()).toHaveLength(0);
    h.advance(2000);
    expect(channel.sent()).toHaveLength(1);
    const panel = new AttentionViews(h.persistence, ample).panel(h.clock.now());
    expect(panel.totals).toEqual({ count: 1, cost: 2, value: 5 });
    expect(panel.deliveries[0]!.at).toBe(3000);
  });

  it('默认即时 Outbox 送达失败（waiting）时不计入注意力度量', () => {
    const channel = new ControllableChannel();
    const h = createHarness({ channel, metrics: (d) => new AttentionMetrics(d) });
    channel.failNext('waiting');
    h.report(report({ value: 5, cost: 2 }));
    expect(channel.attempts()).toBe(1);
    const panel = new AttentionViews(h.persistence, ample).panel(0);
    expect(panel.totals).toEqual({ count: 0, cost: 0, value: 0 });
  });
});