import type { Persistence } from './ports.js';
import type { Recipient } from './domain.js';

// 单个接收人在一个时间窗口内的注意力配额
export interface BudgetLimits {
  windowMs: number; // 窗口长度（毫秒）
  maxInterrupts: number; // 每窗口中断次数上限
  maxCost: number; // 每窗口注意力成本上限
}

// 团队配额：成员共享团队窗口内的聚合次数与成本上限
export interface TeamBudgetLimits extends BudgetLimits {
  members: Recipient[];
}

// 账本计费记录
export interface ChargeEntry {
  at: number;
  cost: number;
}

export const BUDGET_LEDGER_KEY = 'attention-budget:ledger';
export const BUDGET_TEAM_LEDGER_KEY = 'attention-budget:team-ledger';

// 窗口用量：汇总仍在窗口内的记录次数与成本（预算闸门与面板读视图共用）
export function windowUsage(
  entries: readonly ChargeEntry[],
  limits: BudgetLimits,
  now: number,
): { usedInterrupts: number; usedCost: number } {
  let usedInterrupts = 0;
  let usedCost = 0;
  for (const entry of entries) {
    if (entry.at > now - limits.windowMs) {
      usedInterrupts += 1;
      usedCost += entry.cost;
    }
  }
  return { usedInterrupts, usedCost };
}

// 注意力预算账本：按接收人独立计费，团队成员额外共享团队聚合配额；
// 滑动窗口统计已送达中断的次数与成本，状态经 Persistence 持久化
export class AttentionBudget {
  private readonly ledger = new Map<Recipient, ChargeEntry[]>();
  private readonly teamLedger = new Map<string, ChargeEntry[]>();

  constructor(
    private readonly persistence: Persistence,
    private readonly limitsFor: (recipient: Recipient) => BudgetLimits,
    private readonly teamsFor: () => Record<string, TeamBudgetLimits> = () => ({}),
  ) {
    // 重启恢复：构造时从持久化存储加载个人与团队账本
    const saved = this.persistence.load<Record<Recipient, ChargeEntry[]>>(BUDGET_LEDGER_KEY);
    if (saved) {
      for (const [recipient, entries] of Object.entries(saved)) this.ledger.set(recipient, entries);
    }
    const savedTeams = this.persistence.load<Record<string, ChargeEntry[]>>(BUDGET_TEAM_LEDGER_KEY);
    if (savedTeams) {
      for (const [team, entries] of Object.entries(savedTeams)) this.teamLedger.set(team, entries);
    }
  }

  private save(): void {
    this.persistence.save(BUDGET_LEDGER_KEY, Object.fromEntries(this.ledger));
    this.persistence.save(BUDGET_TEAM_LEDGER_KEY, Object.fromEntries(this.teamLedger));
  }

  // 窗口内的计费记录；顺带清理已滚出窗口的旧记录
  private active(
    ledger: Map<string, ChargeEntry[]>,
    key: string,
    windowMs: number,
    now: number,
  ): ChargeEntry[] {
    const previous = ledger.get(key) ?? [];
    const entries = previous.filter((e) => e.at > now - windowMs);
    ledger.set(key, entries);
    if (entries.length !== previous.length) this.save();
    return entries;
  }

  // 接收人所属团队及其配额；未加入任何团队时返回 undefined
  private teamOf(recipient: Recipient): { id: string; limits: TeamBudgetLimits } | undefined {
    for (const [id, limits] of Object.entries(this.teamsFor())) {
      if (limits.members.includes(recipient)) return { id, limits };
    }
    return undefined;
  }

  // 预算是否还容得下一次成本为 cost 的送达：个人与团队闸门均须通过
  allows(recipient: Recipient, cost: number, now: number): boolean {
    const limits = this.limitsFor(recipient);
    const personal = windowUsage(this.active(this.ledger, recipient, limits.windowMs, now), limits, now);
    if (personal.usedInterrupts + 1 > limits.maxInterrupts || personal.usedCost + cost > limits.maxCost) {
      return false;
    }
    const team = this.teamOf(recipient);
    if (!team) return true;
    const aggregate = windowUsage(
      this.active(this.teamLedger, team.id, team.limits.windowMs, now),
      team.limits,
      now,
    );
    return (
      aggregate.usedInterrupts + 1 <= team.limits.maxInterrupts &&
      aggregate.usedCost + cost <= team.limits.maxCost
    );
  }

  // 送达即计费（上半部与到期补发无条件计费，不受配额闸门限制）
  charge(recipient: Recipient, cost: number, now: number): void {
    this.active(this.ledger, recipient, this.limitsFor(recipient).windowMs, now).push({ at: now, cost });
    const team = this.teamOf(recipient);
    if (team) {
      this.active(this.teamLedger, team.id, team.limits.windowMs, now).push({ at: now, cost });
    }
    this.save();
  }
}
