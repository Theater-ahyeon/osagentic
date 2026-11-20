import type { AttentionFeedback, Persistence, Scheduler } from './ports.js';
import type { Irq, Message } from './domain.js';
import { nextId } from './domain.js';

export interface CoalesceConfig {
  windowMs?: number; // 基础合并窗口（毫秒）
  growthMs?: number; // 每多一个待决下半部中断，窗口增加的长度
  maxWindowMs?: number; // 窗口上限，保证高负载下送达延迟有界
  latencyWeight?: number; // 响应延迟放大窗口的系数：窗口增加 latencyWeight × 平均响应延迟
  valueWeight?: number; // 历史价值缩减窗口的系数：窗口减少 valueWeight × 累计产出价值
}

// 同一接收人、同一会话、同一主题的待决下半部消息组
interface Group {
  recipient: string;
  channel: string;
  firstAt: number;
  deadline: number;
  members: Message[];
}

const DEFAULT_WINDOW_MS = 1000;
const DEFAULT_MAX_WINDOW_MS = 8000;
const DEFAULT_GROWTH_MS = 250;
const COALESCE_GROUPS_KEY = 'attention-coalesce:groups';

// 合并组持久化形状：重启后恢复缓冲中的摘要组与 irq 主题映射
interface CoalesceState {
  groups: [string, Group][];
  irqTopics: [string, string][];
  pending: number;
}

// 合并调度器：包裹内层调度器，下半部消息按接收人+会话+主题在时间窗内聚合为一条摘要；
// 上半部 attention 立即透传；预算与 QoS 排序仍由内层调度器负责
export class CoalescingScheduler implements Scheduler {
  private readonly groups = new Map<string, Group>();
  // Message 不携带 topic，提交时记录 irq 到 topic 的映射
  private readonly irqTopics = new Map<string, string>();
  private readonly windowMs: number;
  private readonly maxWindowMs: number;
  private readonly growthMs: number;
  private readonly latencyWeight: number;
  private readonly valueWeight: number;
  // 待决下半部数量：已缓冲、尚未聚合送达的消息数
  private pending = 0;

  constructor(
    private readonly inner: Scheduler,
    config: CoalesceConfig = {},
    private readonly persistence?: Persistence,
    private readonly feedback?: AttentionFeedback,
  ) {
    this.windowMs = config.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxWindowMs = config.maxWindowMs ?? DEFAULT_MAX_WINDOW_MS;
    this.growthMs = config.growthMs ?? DEFAULT_GROWTH_MS;
    this.latencyWeight = config.latencyWeight ?? 1;
    this.valueWeight = config.valueWeight ?? 10;
    // 重启恢复：加载缓冲中的合并组，窗口中途重启不丢失成员
    const saved = this.persistence?.load<CoalesceState>(COALESCE_GROUPS_KEY);
    if (saved) {
      for (const [key, group] of saved.groups) this.groups.set(key, group);
      for (const [id, topic] of saved.irqTopics) this.irqTopics.set(id, topic);
      this.pending = saved.pending;
    }
  }

  private persistState(): void {
    this.persistence?.save(COALESCE_GROUPS_KEY, {
      groups: Array.from(this.groups.entries()),
      irqTopics: Array.from(this.irqTopics.entries()),
      pending: this.pending,
    });
  }

  submit(irq: Irq): void {
    this.irqTopics.set(irq.id, irq.topic);
    this.inner.submit(irq);
    this.persistState();
  }

  bufferedIrqIds(): string[] {
    return Array.from(this.groups.values()).flatMap((group) => group.members.flatMap((m) => m.irqIds));
  }

  due(now: number): Message[] {
    const immediate: Message[] = [];
    for (const message of this.inner.due(now)) {
      const irqId = message.irqIds[0]!;
      const topic = this.irqTopics.get(irqId)!;
      this.irqTopics.delete(irqId);
      if (message.purpose !== 'notice' && message.purpose !== 'result') {
        immediate.push(message); // 上半部不参与合并
        continue;
      }
      this.buffer(message, topic, now);
    }

    const expired: Group[] = [];
    for (const [key, group] of this.groups) {
      if (now >= group.deadline) {
        expired.push(group);
        this.groups.delete(key);
      }
    }
    expired.sort((a, b) => a.deadline - b.deadline || a.firstAt - b.firstAt);
    this.pending -= expired.reduce((count, group) => count + group.members.length, 0);
    const summaries = expired.map((group) => this.summarize(group, now));
    this.persistState();
    return [...immediate, ...summaries];
  }

  private buffer(message: Message, topic: string, now: number): void {
    const key = `${message.recipient}\u0000${message.channel}\u0000${topic}`;
    let group = this.groups.get(key);
    if (!group) {
      group = {
        recipient: message.recipient,
        channel: message.channel,
        firstAt: now,
        deadline: now,
        members: [],
      };
      this.groups.set(key, group);
    }
    group.members.push(message);
    this.pending += 1;
    // 负载越高窗口越大；窗口锚定首个成员时刻，上限封顶
    group.deadline = group.firstAt + this.windowFor(this.pending, message.recipient);
  }

  // 合并窗口随待决下半部负载线性增长，并按接收人反馈自适应：
  // 响应延迟越大窗口越宽（慢响应者更适合批量送达），历史价值越高窗口越窄（高价值产出尽早送达）
  private windowFor(load: number, recipient: string): number {
    const grown = this.windowMs + this.growthMs * Math.max(0, load - 1);
    const stats = this.feedback?.feedbackFor(recipient);
    const adjusted = stats
      ? grown + this.latencyWeight * stats.meanResponseMs - this.valueWeight * stats.value
      : grown;
    return Math.min(this.maxWindowMs, Math.max(0, adjusted));
  }

  private summarize(group: Group, now: number): Message {
    const first = group.members[0]!;
    return {
      id: nextId('msg'),
      ticketId: first.ticketId,
      recipient: group.recipient,
      channel: group.channel,
      purpose: group.members.some((m) => m.purpose === 'result') ? 'result' : 'notice',
      text: group.members.map((m) => m.text).join('\n'),
      irqIds: group.members.flatMap((m) => m.irqIds),
      links: unionLinks(group.members),
      createdAt: now,
    };
  }
}

// 成员 links 的并集，保留首次出现顺序
function unionLinks(members: Message[]): string[] {
  const links: string[] = [];
  for (const member of members) {
    for (const link of member.links) {
      if (!links.includes(link)) links.push(link);
    }
  }
  return links;
}
