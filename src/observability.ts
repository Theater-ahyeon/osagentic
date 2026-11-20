import type { Persistence, Scheduler } from './ports.js';
import type { Irq, Message } from './domain.js';

export const OBS_QUEUE_DEPTH_KEY = 'attention-obs:queue-depth';
export const OBS_COALESCED_KEY = 'attention-obs:coalesced';
export const OBS_THROTTLED_KEY = 'attention-obs:throttled';

// 可观测性调度器：包裹内层调度器，持久化队列深度、合并计数与节流计数。
// queueDepth 为当前待决中断数（活量）；coalesced 为已送达摘要消息数（irqIds>1）；
// throttled 为经历过节流（延迟送达）的不同下半部中断数。不改内层调度器源码。
export class ObservabilityScheduler implements Scheduler {
  private readonly pending = new Map<string, Irq>();
  private readonly throttledIrqs: Set<string>;
  private coalesced: number;

  constructor(
    private readonly deps: { persistence: Persistence },
    private readonly inner: Scheduler,
  ) {
    this.coalesced = deps.persistence.load<number>(OBS_COALESCED_KEY) ?? 0;
    this.throttledIrqs = new Set(deps.persistence.load<string[]>(OBS_THROTTLED_KEY) ?? []);
  }

  submit(irq: Irq): void {
    this.pending.set(irq.id, irq);
    this.inner.submit(irq);
  }

  due(now: number): Message[] {
    const messages = this.inner.due(now);
    for (const message of messages) {
      for (const id of message.irqIds) this.pending.delete(id);
      if (message.irqIds.length > 1) {
        this.coalesced += 1;
        this.deps.persistence.append({
          type: 'delivery.coalesced',
          at: now,
          payload: { messageId: message.id, irqIds: message.irqIds },
        });
      }
    }
    // 合并缓冲中的中断属于聚合延迟，不计入预算节流统计
    const buffered = new Set(this.inner.bufferedIrqIds?.() ?? []);
    for (const irq of this.pending.values()) {
      if (irq.half === 'bottom' && !buffered.has(irq.id)) this.throttledIrqs.add(irq.id);
    }
    this.deps.persistence.save(OBS_COALESCED_KEY, this.coalesced);
    this.deps.persistence.save(OBS_THROTTLED_KEY, [...this.throttledIrqs]);
    this.deps.persistence.save(OBS_QUEUE_DEPTH_KEY, this.pending.size);
    return messages;
  }
}
