import type { Persistence } from './ports.js';
import type { Recipient } from './domain.js';
import type { BudgetQoSConfig } from './scheduler.js';
import {
  METRICS_DELIVERIES_KEY,
  METRICS_RECIPIENTS_KEY,
  type DeliveryMetric,
  type RecipientMetrics,
} from './metrics.js';
import { OBS_QUEUE_DEPTH_KEY, OBS_COALESCED_KEY, OBS_THROTTLED_KEY } from './observability.js';

// 成本/价值汇总
export interface MetricsTotals {
  count: number;
  cost: number;
  value: number;
}

// 与 budget.ts 的账本存储键保持一致（T2 模块未导出该键）
const BUDGET_LEDGER_KEY = 'attention-budget:ledger';

// 账本计费记录，形状与 budget.ts 的 ChargeEntry 一致
interface ChargeEntry {
  at: number;
  cost: number;
}

// 单个接收人的剩余注意力预算
export interface BudgetView {
  recipient: Recipient;
  windowMs: number;
  maxInterrupts: number;
  maxCost: number;
  usedInterrupts: number;
  usedCost: number;
  remainingInterrupts: number;
  remainingCost: number;
}

// 面板读视图：只读查询 Persistence 中的度量状态
export interface AttentionPanel {
  deliveries: DeliveryMetric[];
  budgets: BudgetView[];
  recipients: Record<Recipient, RecipientMetrics>;
  totals: MetricsTotals;
  valueExceedsCost: boolean;
  queueDepth: number;
  coalesced: number;
  throttled: number;
}

export class AttentionViews {
  constructor(
    private readonly persistence: Persistence,
    private readonly config: BudgetQoSConfig,
  ) {}

  panel(now: number): AttentionPanel {
    const deliveries = this.persistence.load<DeliveryMetric[]>(METRICS_DELIVERIES_KEY) ?? [];
    const recipients = this.persistence.load<Record<Recipient, RecipientMetrics>>(METRICS_RECIPIENTS_KEY) ?? {};
    const totals: MetricsTotals = { count: 0, cost: 0, value: 0 };
    for (const metrics of Object.values(recipients)) {
      totals.count += metrics.count;
      totals.cost += metrics.cost;
      totals.value += metrics.value;
    }
    const budgets = this.budgetViews(now);
    return {
      deliveries,
      budgets,
      recipients,
      totals,
      valueExceedsCost: totals.value > totals.cost,
      queueDepth: this.persistence.load<number>(OBS_QUEUE_DEPTH_KEY) ?? 0,
      coalesced: this.persistence.load<number>(OBS_COALESCED_KEY) ?? 0,
      throttled: (this.persistence.load<string[]>(OBS_THROTTLED_KEY) ?? []).length,
    };
  }

  // 从 T2 账本 + 配额配置计算每人剩余预算；窗口语义与 AttentionBudget.active 一致
  private budgetViews(now: number): BudgetView[] {
    const ledger = this.persistence.load<Record<Recipient, ChargeEntry[]>>(BUDGET_LEDGER_KEY) ?? {};
    const names = new Set([...Object.keys(ledger), ...Object.keys(this.config.recipients ?? {})]);
    const views: BudgetView[] = [];
    for (const recipient of [...names].sort()) {
      const limits = this.config.recipients?.[recipient] ?? this.config;
      const entries = (ledger[recipient] ?? []).filter((e) => e.at > now - limits.windowMs);
      const usedCost = entries.reduce((sum, e) => sum + e.cost, 0);
      views.push({
        recipient,
        windowMs: limits.windowMs,
        maxInterrupts: limits.maxInterrupts,
        maxCost: limits.maxCost,
        usedInterrupts: entries.length,
        usedCost,
        remainingInterrupts: Math.max(0, limits.maxInterrupts - entries.length),
        remainingCost: Math.max(0, limits.maxCost - usedCost),
      });
    }
    return views;
  }
}
