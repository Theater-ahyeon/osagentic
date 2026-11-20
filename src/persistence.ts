import type { Persistence } from './ports.js';
import type { DomainEvent } from './domain.js';

export class InMemoryPersistence implements Persistence {
  private readonly kv = new Map<string, unknown>();
  private readonly events: DomainEvent[] = [];

  load<T>(key: string): T | undefined {
    return this.kv.get(key) as T | undefined;
  }

  save<T>(key: string, value: T): void {
    this.kv.set(key, value);
  }

  append(event: DomainEvent): void {
    this.events.push(event);
  }

  log(): DomainEvent[] {
    return [...this.events];
  }
}
