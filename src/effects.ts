import type { Persistence } from './ports.js';

// 副作用执行结果：done 表示完成，later 表示 EAGAIN，需要退避重试
export type EffectOutcome = 'done' | 'later';

export interface EffectTask<T> {
  id: string;
  key: string;
  payload: T;
}

interface EffectEntry<T> extends EffectTask<T> {
  attempts: number;
  nextAttemptAt: number;
}

export interface EffectsDeps {
  persistence: Persistence;
}

export interface EffectsOptions {
  storageKey?: string;
  baseDelayMs?: number;
  backoffFactor?: number;
}

// 持久副作用队列：按 key 分组保持 FIFO 有序，失败指数退避，状态随 Persistence 持久化
export class EffectsQueue<T> {
  private readonly persistence: Persistence;
  private readonly storageKey: string;
  private readonly baseDelayMs: number;
  private readonly backoffFactor: number;
  private entries: EffectEntry<T>[];

  constructor(deps: EffectsDeps, options: EffectsOptions = {}) {
    this.persistence = deps.persistence;
    this.storageKey = options.storageKey ?? 'effects:queue';
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.entries = this.persistence.load<EffectEntry<T>[]>(this.storageKey) ?? [];
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id);
  }

  ids(): string[] {
    return this.entries.map((entry) => entry.id);
  }

  enqueue(task: EffectTask<T>, now: number): void {
    if (this.has(task.id)) return;
    this.entries.push({ ...task, attempts: 0, nextAttemptAt: now });
    this.persist();
  }

  discard(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id);
    this.persist();
  }

  // 恢复后截止时间顺延；豁免集合内的条目保持原截止时间
  deferAll(deltaMs: number, exemptIds: ReadonlySet<string>): void {
    for (const entry of this.entries) {
      if (!exemptIds.has(entry.id)) entry.nextAttemptAt += deltaMs;
    }
    this.persist();
  }

  drain(now: number, execute: (payload: T) => EffectOutcome): void {
    const blockedKeys = new Set<string>();
    let index = 0;
    while (index < this.entries.length) {
      const entry = this.entries[index]!;
      if (blockedKeys.has(entry.key) || now < entry.nextAttemptAt) {
        blockedKeys.add(entry.key);
        index += 1;
        continue;
      }
      let outcome: EffectOutcome;
      try {
        outcome = execute(entry.payload);
      } catch {
        outcome = 'later';
      }
      if (outcome === 'done') {
        this.entries.splice(index, 1);
        this.persist();
        continue;
      }
      entry.attempts += 1;
      entry.nextAttemptAt = now + this.baseDelayMs * this.backoffFactor ** (entry.attempts - 1);
      this.persist();
      blockedKeys.add(entry.key);
      index += 1;
    }
  }

  private persist(): void {
    this.persistence.save(this.storageKey, this.entries);
  }
}