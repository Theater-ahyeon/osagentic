import { randomUUID } from 'node:crypto';

export type ReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
export type Recipient = string;
export type TicketId = string;
export type ChannelAddress = string;
export type IrqHalf = 'top' | 'bottom';
export type DeliveryPurpose = 'acknowledgement' | 'answer' | 'result' | 'attention' | 'notice';

export interface Report {
  ticketId: TicketId;
  kind: ReportKind;
  recipient: Recipient;
  channel: ChannelAddress;
  at: number;
  question?: string;
  topic?: string;
  value?: number;
  cost?: number;
  priority?: number;
  deadline?: number;
}

export interface Irq {
  id: string;
  ticketId: TicketId;
  half: IrqHalf;
  kind: ReportKind;
  recipient: Recipient;
  channel: ChannelAddress;
  topic: string;
  value: number;
  cost: number;
  priority: number;
  createdAt: number;
  links: string[];
  question?: string;
  deadline?: number;
}

export interface Message {
  id: string;
  ticketId: TicketId;
  recipient: Recipient;
  channel: ChannelAddress;
  purpose: DeliveryPurpose;
  text: string;
  irqIds: string[];
  links: string[];
  createdAt: number;
}

export interface DeliveryRecord {
  message: Message;
  status: 'sent' | 'waiting' | 'gone';
  attempts: number;
  sentAt?: number;
}

// 单次送达的注意力度量：成本与价值来自 irq.created 事件，at 为打断时机
export interface DeliveryMetric {
  messageId: string;
  recipient: Recipient;
  at: number;
  cost: number;
  value: number;
  irqIds: string[];
}

// 合并摘要送达事件载荷
export interface CoalescedDelivery {
  messageId: string;
  irqIds: string[];
}

// 领域事件判别联合：消费端按 type 收窄载荷，无需 cast
export type DomainEvent =
  | { type: 'irq.created'; at: number; payload: Irq }
  | { type: 'delivery.enqueued'; at: number; payload: DeliveryRecord }
  | { type: 'delivery.sent'; at: number; payload: DeliveryRecord }
  | { type: 'irq.delivered'; at: number; payload: DeliveryMetric }
  | { type: 'delivery.coalesced'; at: number; payload: CoalescedDelivery };

// blocked/failed 等待人工输入，恒为上半部：立即送达，不可节流、不可合并
export function classify(report: Report): IrqHalf {
  if (report.kind === 'blocked' || report.kind === 'failed') return 'top';
  return 'bottom';
}

export function isInterruption(kind: ReportKind): boolean {
  return kind === 'progress' || kind === 'ready' || kind === 'blocked' || kind === 'failed';
}

// 随机 UUID 保证跨进程重启唯一：持久送达的幂等检查不会把新消息误判为已送达
export function nextId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function toIrq(report: Report, now: number): Irq | undefined {
  if (!isInterruption(report.kind)) return undefined;
  const half = classify(report);
  const irq: Irq = {
    id: nextId('irq'),
    ticketId: report.ticketId,
    half,
    kind: report.kind,
    recipient: report.recipient,
    channel: report.channel,
    topic: report.topic ?? report.ticketId,
    value: report.value ?? 1,
    cost: report.cost ?? 1,
    priority: report.priority ?? (half === 'top' ? 100 : 1),
    createdAt: now,
    links: [`${report.channel}#${report.ticketId}`],
  };
  if (report.question !== undefined) irq.question = report.question;
  if (report.deadline !== undefined) irq.deadline = report.deadline;
  return irq;
}

export function purposeOf(irq: Irq): DeliveryPurpose {
  if (irq.half === 'top') return 'attention';
  if (irq.kind === 'ready') return 'result';
  return 'notice';
}

export function messageOf(irq: Irq, now: number): Message {
  return {
    id: nextId('msg'),
    ticketId: irq.ticketId,
    recipient: irq.recipient,
    channel: irq.channel,
    purpose: purposeOf(irq),
    text: irq.question ?? `${irq.kind} on ${irq.ticketId}`,
    irqIds: [irq.id],
    links: [...irq.links],
    createdAt: now,
  };
}
