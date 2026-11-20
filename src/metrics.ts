import type { AttentionFeedback, Metrics, Persistence, RecipientFeedback } from './ports.js';
import type { Irq, Message, Recipient } from './domain.js';

// 单次送达的注意力度量：成本与价值来自 irq.created 事件，at 为打断时机
export interface DeliveryMetric {
  messageId: string;
  recipient: Recipient;
  at: number;
  cost: number;
  value: number;
  irqIds: string[];
}

// 接收人累计度量
export interface RecipientMetrics {
  count: number;
  cost: number;
  value: number;
  lastAt: number;
}

export const METRICS_DELIVERIES_KEY = 'attention-metrics:deliveries';
export const METRICS_RECIPIENTS_KEY = 'attention-metrics:recipients';

// 注意力度量：每次送达按 message.irqIds 汇总成本与价值，按接收人累计，经 Persistence 持久化
export class AttentionMetrics implements Metrics, AttentionFeedback {
  private readonly persistence: Persistence;
  private readonly deliveries: DeliveryMetric[];
  private readonly recipients: Map<Recipient, RecipientMetrics>;
  private readonly recorded = new Set<string>();
  private readonly irqIndex = new Map<string, Irq>();
  private scanned = 0;

  constructor(deps: { persistence: Persistence }) {
    this.persistence = deps.persistence;
    // 重启恢复：构造时加载已持久化的度量
    this.deliveries = deps.persistence.load<DeliveryMetric[]>(METRICS_DELIVERIES_KEY) ?? [];
    const saved = deps.persistence.load<Record<Recipient, RecipientMetrics>>(METRICS_RECIPIENTS_KEY) ?? {};
    this.recipients = new Map(Object.entries(saved));
    for (const delivery of this.deliveries) this.recorded.add(delivery.messageId);
  }

  recordDelivery(message: Message, now: number): void {
    // 幂等：同一消息重复送达不重复计费
    if (this.recorded.has(message.id)) return;
    this.indexNewIrqs();
    let cost = 0;
    let value = 0;
    for (const id of message.irqIds) {
      const irq = this.irqIndex.get(id);
      if (!irq) throw new Error(`missing irq.created event for ${id}`);
      cost += irq.cost;
      value += irq.value;
    }
    const metric: DeliveryMetric = {
      messageId: message.id,
      recipient: message.recipient,
      at: now,
      cost,
      value,
      irqIds: [...message.irqIds],
    };
    this.deliveries.push(metric);
    this.recorded.add(message.id);
    const total = this.recipients.get(message.recipient) ?? { count: 0, cost: 0, value: 0, lastAt: now };
    total.count += 1;
    total.cost += cost;
    total.value += value;
    total.lastAt = now;
    this.recipients.set(message.recipient, total);
    this.persistence.save(METRICS_DELIVERIES_KEY, this.deliveries);
    this.persistence.save(METRICS_RECIPIENTS_KEY, Object.fromEntries(this.recipients));
    this.persistence.append({ type: 'irq.delivered', at: now, payload: metric });
  }

  // 增量扫描事件日志，建立 irq id → 成本/价值索引
  private indexNewIrqs(): void {
    const events = this.persistence.log();
    for (let i = this.scanned; i < events.length; i++) {
      const event = events[i]!;
      if (event.type === 'irq.created') {
        const irq = event.payload as Irq;
        this.irqIndex.set(irq.id, irq);
      }
    }
    this.scanned = events.length;
  }

  // 接收人历史反馈：平均响应延迟取各次送达（送达时刻 - 成员中断最早创建时刻）的均值
  feedbackFor(recipient: Recipient): RecipientFeedback | undefined {
    this.indexNewIrqs();
    const mine = this.deliveries.filter((delivery) => delivery.recipient === recipient);
    if (mine.length === 0) return undefined;
    let totalLatency = 0;
    for (const delivery of mine) {
      let earliest = delivery.at;
      for (const id of delivery.irqIds) {
        const irq = this.irqIndex.get(id);
        if (irq && irq.createdAt < earliest) earliest = irq.createdAt;
      }
      totalLatency += delivery.at - earliest;
    }
    return {
      meanResponseMs: totalLatency / mine.length,
      value: this.recipients.get(recipient)?.value ?? 0,
    };
  }
}
