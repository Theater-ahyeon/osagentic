import type { DomainEvent, Irq, Message, Recipient } from './domain.js';

export interface Clock {
  now(): number;
}

export type SendResult = 'sent' | 'gone' | 'waiting';

export interface Channel {
  send(message: Message): SendResult;
}

export interface Persistence {
  load<T>(key: string): T | undefined;
  save<T>(key: string, value: T): void;
  append(event: DomainEvent): void;
  log(): DomainEvent[];
}

export interface Scheduler {
  submit(irq: Irq): void;
  due(now: number): Message[];
  // 缓冲中（尚未聚合送达）的成员中断身份；供可观测性区分合并缓冲与预算节流
  bufferedIrqIds?(): string[];
}

export interface Outbox {
  enqueue(message: Message): void;
  drain(now: number): void;
}

export interface Metrics {
  recordDelivery(message: Message, now: number): void;
}

// 接收人历史反馈：平均响应延迟（创建到送达）与累计产出价值
export interface RecipientFeedback {
  meanResponseMs: number;
  value: number;
}

// 自适应调度的反馈来源：按接收人查询历史度量
export interface AttentionFeedback {
  feedbackFor(recipient: Recipient): RecipientFeedback | undefined;
}
