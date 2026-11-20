import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import { HealthBoard } from '../src/health.js';
import { BudgetQoSScheduler, type BudgetQoSConfig } from '../src/scheduler.js';
import { DurableOutbox } from '../src/outbox.js';
import type { Channel, SendResult } from '../src/ports.js';
import type { Message, Report } from '../src/domain.js';

const ample: BudgetQoSConfig = { windowMs: 10_000, maxInterrupts: 100, maxCost: 1000 };
const tight: BudgetQoSConfig = { windowMs: 10_000, maxInterrupts: 1, maxCost: 100 };

function progress(ticketId: string, overrides: Partial<Report> = {}): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0, ...overrides };
}

// 持续不可达的 Channel：送达始终返回 gone，重试持续失败
class GoneChannel implements Channel {
  send(_message: Message): SendResult {
    return 'gone';
  }
}

function harnessWithBoard(board: HealthBoard, config: BudgetQoSConfig = ample, channel?: Channel) {
  return createHarness({
    scheduler: (d) => new BudgetQoSScheduler({ ...d, health: board }, config),
    outbox: (d) => new DurableOutbox({ ...d, channel: channel ?? d.channel, health: board }),
  });
}

describe('HealthBoard 健康上报（Source/Channel 边界）', () => {
  it('调度器与送达队列认领健康条目，正常送达时均健康', () => {
    const board = new HealthBoard();
    const h = harnessWithBoard(board);
    h.report(progress('t1'));
    expect(board.entries(h.clock.now())).toEqual([
      { component: 'attention-scheduler', healthy: true, pending: 0, detail: 'ok' },
      { component: 'attention-outbox', healthy: true, pending: 0, detail: 'ok' },
    ]);
  });

  it('被节流的待决中断计入调度器条目的待决数量', () => {
    const board = new HealthBoard();
    const h = harnessWithBoard(board, tight);
    h.report(progress('t1'));
    h.report(progress('t2'));
    const entries = board.entries(h.clock.now());
    expect(entries[0]).toEqual({ component: 'attention-scheduler', healthy: true, pending: 1, detail: 'ok' });
  });

  it('截止时间已过仍待决的中断使调度器条目不健康，补发后恢复', () => {
    const board = new HealthBoard();
    const h = harnessWithBoard(board, tight);
    h.report(progress('t1'));
    h.report(progress('t2', { deadline: 500 }));
    // 时钟推进但未驱动调度：截止时间已过的中断仍待决
    h.clock.advance(600);
    expect(board.entries(h.clock.now())[0]).toEqual({
      component: 'attention-scheduler',
      healthy: false,
      pending: 1,
      detail: 'deadline-miss',
    });

    h.advance(0);
    expect(h.channel.sent()).toHaveLength(2);
    expect(board.entries(h.clock.now())[0]).toEqual({
      component: 'attention-scheduler',
      healthy: true,
      pending: 0,
      detail: 'ok',
    });
  });

  it('送达重试停滞使队列条目不健康，恢复 drain 后回到健康', () => {
    const board = new HealthBoard();
    const h = harnessWithBoard(board, ample, new GoneChannel());
    h.report(progress('t1'));
    // 首次尝试失败，重试截止 1000；时钟推进到 5000 仍未 drain → 停滞
    h.clock.advance(5000);
    expect(board.entries(h.clock.now())[1]).toEqual({
      component: 'attention-outbox',
      healthy: false,
      pending: 1,
      detail: 'stuck-retry',
    });

    h.advance(0);
    expect(board.entries(h.clock.now())[1]).toEqual({
      component: 'attention-outbox',
      healthy: true,
      pending: 1,
      detail: 'ok',
    });
  });

  it('暂停期间健康条目不因时钟推进误报故障', () => {
    const board = new HealthBoard();
    const h = harnessWithBoard(board, tight);
    h.pauseNow();
    h.report(progress('t1', { deadline: 100 }));
    h.clock.advance(5000);
    expect(board.entries(h.clock.now())).toEqual([
      { component: 'attention-scheduler', healthy: true, pending: 1, detail: 'paused' },
      { component: 'attention-outbox', healthy: true, pending: 0, detail: 'paused' },
    ]);
  });
});
