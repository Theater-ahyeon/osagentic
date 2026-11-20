import type { Persistence } from './ports.js';
import type { Recipient } from './domain.js';

// 单个接收人在一个时间窗口内的注意力配额
export interface BudgetLimits {
  windowMs: number; // 窗口长度（毫秒）
  maxInterrupts: number; // 每窗口中断次数上限
  maxCost: number; // 每窗口注意力成本上限
}

interface ChargeEntry {
  at: number;
  cost: number;
}

const LEDGER_KEY = 'attention-budget:ledger';

// 注意力预算账本：按接收人独立计费，滑动窗口统计已送达中断的次数与成本
export class AttentionBudget {
  private readonly ledger = new Map<Recipient, ChargeEntry[]>();

  constructor(
    private readonly persistence: Persistence,
    private readonly limitsFor: (recipient: Recipient) => BudgetLimits,
  ) {
    // 重启恢复：构造时从持久化存储加载账本
    const saved = this.persistence.load<Record<Recipient, ChargeEntry[]>>(LEDGER_KEY);
    if (saved) {
      for (const [recipient, entries] of Object.entries(saved)) this.ledger.set(recipient, entries);
    }
  }

  private save(): void {
    this.persistence.save(LEDGER_KEY, Object.fromEntries(this.ledger));
  }

  // 窗口内的计费记录；顺带清理已滚出窗口的旧记录
  private active(recipient: Recipient, now: number): ChargeEntry[] {
    const limits = this.limitsFor(recipient);
    const previous = this.ledger.get(recipient) ?? [];
    const entries = previous.filter((e) => e.at > now - limits.windowMs);
    this.ledger.set(recipient, entries);
    if (entries.length !== previous.length) this.save();
    return entries;
  }

  // 预算是否还容得下一次成本为 cost 的送达
  allows(recipient: Recipient, cost: number, now: number): boolean {
    const limits = this.limitsFor(recipient);
    const entries = this.active(recipient, now);
    const usedCost = entries.reduce((sum, e) => sum + e.cost, 0);
    return entries.length + 1 <= limits.maxInterrupts && usedCost + cost <= limits.maxCost;
  }

  // 送达即计费（上半部与到期补发无条件计费，不受配额闸门限制）
  charge(recipient: Recipient, cost: number, now: number): void {
    const entries = this.active(recipient, now);
    entries.push({ at: now, cost });
    this.save();
  }
}
