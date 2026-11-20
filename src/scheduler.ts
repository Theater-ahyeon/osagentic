import type { Persistence, Scheduler } from './ports.js';
import type { Irq, Message, Recipient } from './domain.js';
import { messageOf } from './domain.js';
import type { PauseState } from './pause.js';
import { AttentionBudget, type BudgetLimits, type TeamBudgetLimits } from './budget.js';

// 默认配额作用于每个接收人；recipients 可为特定接收人指定独立配额；
// teams 为团队聚合配额，成员共享团队窗口内的次数与成本上限；
// version 标识策略版本，版本变更经 applyPolicy 生效并触发待决中断重新评估
export interface BudgetQoSConfig extends BudgetLimits {
  version?: number;
  recipients?: Record<Recipient, BudgetLimits>;
  teams?: Record<string, TeamBudgetLimits>;
}

export interface SchedulerDeps {
  persistence: Persistence;
  pause: PauseState;
}

// QoS 排序：priority 降序 → 有效 deadline 升序（无 deadline 视为无穷远）→ value/cost 降序；
// 完全同序时保持提交顺序（稳定排序）
function qosOrder(a: Irq, b: Irq, deadlineOf: (irq: Irq) => number): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const deadlineA = deadlineOf(a);
  const deadlineB = deadlineOf(b);
  if (deadlineA !== deadlineB) return deadlineA - deadlineB;
  const ratioA = a.cost > 0 ? a.value / a.cost : Number.POSITIVE_INFINITY;
  const ratioB = b.cost > 0 ? b.value / b.cost : Number.POSITIVE_INFINITY;
  if (ratioA !== ratioB) return ratioB - ratioA;
  return 0;
}

// QoS 调度器：上半部立即送达且永不节流；下半部按预算闸门送达，耗尽时节流、窗口滚动后补发
export class BudgetQoSScheduler implements Scheduler {
  private readonly top: Irq[] = [];
  private readonly bottom: Irq[] = [];
  private readonly budget: AttentionBudget;
  // 提交时刻的累计暂停时长基线；此后新增的暂停时长顺延该中断的截止时间
  private readonly pauseBaselines = new Map<string, number>();

  constructor(
    private readonly deps: SchedulerDeps,
    private config: BudgetQoSConfig,
  ) {
    this.budget = new AttentionBudget(
      deps.persistence,
      (recipient) => this.config.recipients?.[recipient] ?? this.config,
      () => this.config.teams ?? {},
    );
  }

  // 策略版本化生效：替换配额与团队配置；待决中断在下一次调度按新策略
  // 重新验证预算与团队授权（闸门逐条重判，QoS 顺序随之重排）
  applyPolicy(config: BudgetQoSConfig): void {
    this.config = config;
  }

  policyVersion(): number | undefined {
    return this.config.version;
  }

  submit(irq: Irq): void {
    if (irq.half === 'top') {
      this.top.push(irq);
      return;
    }
    if (irq.deadline !== undefined) this.pauseBaselines.set(irq.id, this.deps.pause.pausedMs());
    this.bottom.push(irq);
  }

  // 有效截止时间 = 原始截止时间 + 提交之后经历的暂停时长
  private effectiveDeadline(irq: Irq): number | undefined {
    if (irq.deadline === undefined) return undefined;
    const baseline = this.pauseBaselines.get(irq.id) ?? 0;
    return irq.deadline + (this.deps.pause.pausedMs() - baseline);
  }

  due(now: number): Message[] {
    const messages: Message[] = [];

    // 上半部无条件立即送达，预算耗尽也不节流
    for (const irq of this.top.splice(0)) {
      this.budget.charge(irq.recipient, irq.cost, now);
      messages.push(messageOf(irq, now));
    }

    this.bottom.sort((a, b) => qosOrder(a, b, (irq) => this.effectiveDeadline(irq) ?? Number.POSITIVE_INFINITY));
    const throttled: Irq[] = [];
    for (const irq of this.bottom) {
      // 截止时间到期后不再节流，立即补发（仍计入预算消耗）
      const deadline = this.effectiveDeadline(irq);
      const expired = deadline !== undefined && now >= deadline;
      if (expired || this.budget.allows(irq.recipient, irq.cost, now)) {
        this.budget.charge(irq.recipient, irq.cost, now);
        this.pauseBaselines.delete(irq.id);
        messages.push(messageOf(irq, now));
      } else {
        throttled.push(irq);
      }
    }
    this.bottom.length = 0;
    this.bottom.push(...throttled);
    return messages;
  }
}
