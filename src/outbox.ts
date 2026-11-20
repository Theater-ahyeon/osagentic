import type { Channel, Clock, Metrics, Outbox, Persistence, SendResult } from './ports.js';
import type { DeliveryRecord, Message } from './domain.js';
import { PauseState } from './pause.js';
import { EffectsQueue } from './effects.js';
import type { EffectOutcome } from './effects.js';
import type { HealthBoard, HealthEntry } from './health.js';

export interface OutboxDeps {
  clock: Clock;
  channel: Channel;
  persistence: Persistence;
  pause?: PauseState;
  metrics?: Metrics;
  health?: HealthBoard;
}

export interface OutboxOptions {
  storageKey?: string;
  baseDelayMs?: number;
  backoffFactor?: number;
}

function deliveryKey(messageId: string): string {
  return `delivery:${messageId}`;
}

// 事务性持久送达：先持久化再 send，成功记录 receipt，失败指数退避，
// 同一 Ticket 同一会话保持有序，Source 关闭时等待而非丢弃
export class DurableOutbox implements Outbox {
  private readonly clock: Clock;
  private readonly channel: Channel;
  private readonly persistence: Persistence;
  private readonly pause: PauseState;
  private readonly metrics: Metrics | undefined;
  private readonly effects: EffectsQueue<Message>;
  private lastPausedMs: number;
  // 暂停期间或恢复后顺延生效前入队的消息立即送达，不参与截止时间顺延
  private readonly pauseShiftExempt = new Set<string>();

  constructor(deps: OutboxDeps, options: OutboxOptions = {}) {
    this.clock = deps.clock;
    this.channel = deps.channel;
    this.persistence = deps.persistence;
    this.metrics = deps.metrics;
    this.pause = deps.pause ?? new PauseState();
    this.effects = new EffectsQueue<Message>(
      { persistence: deps.persistence },
      {
        storageKey: options.storageKey ?? 'outbox:effects',
        baseDelayMs: options.baseDelayMs,
        backoffFactor: options.backoffFactor,
      },
    );
    // 恢复幂等：receipt 先于队列更新持久化，崩溃窗口内队列可能残留已送达条目
    for (const id of this.effects.ids()) {
      const record = this.persistence.load<DeliveryRecord>(deliveryKey(id));
      if (record?.status === 'sent') this.effects.discard(id);
    }
    this.lastPausedMs = this.pause.pausedMs();
    deps.health?.claim('attention-outbox', (now) => this.healthEntry(now));
  }

  // 健康条目：重试停滞（超过截止时间一个退避间隔仍未执行）表明送达泵停止运转；
  // 暂停属有意抑制，不报故障
  private healthEntry(now: number): HealthEntry {
    const pending = this.effects.ids().length;
    if (this.pause.isPaused()) {
      return { component: 'attention-outbox', healthy: true, pending, detail: 'paused' };
    }
    const stuck = this.effects.stuckCount(now);
    return {
      component: 'attention-outbox',
      healthy: stuck === 0,
      pending,
      detail: stuck > 0 ? 'stuck-retry' : 'ok',
    };
  }

  enqueue(message: Message): void {
    const existing = this.persistence.load<DeliveryRecord>(deliveryKey(message.id));
    if (existing?.status === 'sent' || this.effects.has(message.id)) return;
    const now = this.clock.now();
    if (!existing) {
      const record: DeliveryRecord = { message, status: 'waiting', attempts: 0 };
      this.persistence.save(deliveryKey(message.id), record);
      this.persistence.append({ type: 'delivery.enqueued', at: now, payload: record });
    }
    this.effects.enqueue(
      { id: message.id, key: `${message.ticketId}|${message.channel}`, payload: message },
      now,
    );
    if (this.pause.isPaused() || this.pause.pausedMs() > this.lastPausedMs) {
      this.pauseShiftExempt.add(message.id);
    }
    this.drain(now);
  }

  drain(now: number): void {
    const pausedMs = this.pause.pausedMs();
    const delta = pausedMs - this.lastPausedMs;
    this.lastPausedMs = pausedMs;
    if (this.pause.isPaused()) return;
    if (delta > 0) {
      // 恢复后截止时间按暂停时长顺延
      this.effects.deferAll(delta, this.pauseShiftExempt);
      this.pauseShiftExempt.clear();
    }
    this.effects.drain(now, (message) => this.attempt(message, now));
  }

  private attempt(message: Message, now: number): EffectOutcome {
    const key = deliveryKey(message.id);
    const record = this.persistence.load<DeliveryRecord>(key);
    if (!record) throw new Error(`missing delivery record for ${message.id}`);
    let result: SendResult;
    try {
      result = this.channel.send(message);
    } catch {
      // 发送抛错与 waiting 相同：退避重试
      result = 'waiting';
    }
    const updated: DeliveryRecord = { message, status: result, attempts: record.attempts + 1 };
    if (result === 'sent') {
      updated.sentAt = now;
      this.persistence.save(key, updated);
      this.persistence.append({ type: 'delivery.sent', at: now, payload: updated });
      this.metrics?.recordDelivery(message, now);
      return 'done';
    }
    this.persistence.save(key, updated);
    return 'later';
  }
}