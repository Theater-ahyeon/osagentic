import type { Persistence } from './ports.js';
import type { DeliveryPurpose, Irq, Message, Report } from './domain.js';
import type { ManualClock } from './clock.js';
import type { Runtime } from './runtime.js';
import { irqIndexOf, irqOf } from './metrics.js';

// 送达流快照：去掉过程生成的 id，保留接收人外部可见的内容、时机与成员中断身份。
// interrupts 用 irq.created 事件中的稳定身份（ticket/kind/创建时刻），跨运行可比较。
export interface DeliverySnapshot {
  recipient: string;
  channel: string;
  purpose: DeliveryPurpose;
  text: string;
  links: string[];
  at: number;
  interrupts: string[];
}

function irqIdentity(irq: Irq): string {
  return `${irq.ticketId}/${irq.kind}@${irq.createdAt}`;
}

function snapshotOf(message: Message, at: number, index: Map<string, Irq>): DeliverySnapshot {
  return {
    recipient: message.recipient,
    channel: message.channel,
    purpose: message.purpose,
    text: message.text,
    links: [...message.links],
    at,
    interrupts: message.irqIds.map((id) => irqIdentity(irqOf(index, id))),
  };
}

// 从持久事件（irq.created / delivery.sent）重建历史送达流，顺序即送达顺序
export function deliveryStreamOf(persistence: Persistence): DeliverySnapshot[] {
  const index = irqIndexOf(persistence);
  const stream: DeliverySnapshot[] = [];
  for (const event of persistence.log()) {
    if (event.type !== 'delivery.sent') continue;
    const record = event.payload;
    if (record.status !== 'sent') continue;
    stream.push(snapshotOf(record.message, record.sentAt ?? record.message.createdAt, index));
  }
  return stream;
}

// 把边界观察到的已送达消息规范化为同一快照形状，便于与重建流逐条比较
export function snapshotsOf(messages: Message[], persistence: Persistence): DeliverySnapshot[] {
  const index = irqIndexOf(persistence);
  return messages.map((message) => snapshotOf(message, message.createdAt, index));
}

// 输入轨迹：驱动一段历史的 Report 注入与时钟推进/暂停操作
export type TraceStep =
  | { kind: 'report'; at: number; report: Report }
  | { kind: 'advance'; ms: number }
  | { kind: 'pause' }
  | { kind: 'resume' };

export interface RecordTarget {
  clock: { now(): number };
  report(r: Report): void;
  advance(ms: number): void;
  pauseNow(): void;
  resumeNow(): void;
}

// 记录器：转发操作到目标的同时记录输入轨迹
export class TraceRecorder {
  private readonly steps: TraceStep[] = [];

  constructor(private readonly target: RecordTarget) {}

  report(r: Report): void {
    this.steps.push({ kind: 'report', at: this.target.clock.now(), report: r });
    this.target.report(r);
  }

  advance(ms: number): void {
    this.steps.push({ kind: 'advance', ms });
    this.target.advance(ms);
  }

  pauseNow(): void {
    this.steps.push({ kind: 'pause' });
    this.target.pauseNow();
  }

  resumeNow(): void {
    this.steps.push({ kind: 'resume' });
    this.target.resumeNow();
  }

  trace(): TraceStep[] {
    return [...this.steps];
  }
}

export interface ReplayTarget {
  clock: ManualClock;
  runtime: Runtime;
}

// 经新 runtime 重放输入轨迹：时钟对齐到记录时刻，逐步重现调度决策与送达
export function replayTrace(trace: TraceStep[], target: ReplayTarget): void {
  for (const step of trace) {
    switch (step.kind) {
      case 'report':
        target.clock.set(step.at);
        target.runtime.ingest(step.report);
        break;
      case 'advance':
        target.clock.advance(step.ms);
        target.runtime.flush();
        break;
      case 'pause':
        target.runtime.pause();
        break;
      case 'resume':
        target.runtime.resume();
        break;
    }
  }
}
