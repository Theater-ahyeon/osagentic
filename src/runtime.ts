import type { Clock, Channel, Persistence, Scheduler, Outbox, Metrics } from './ports.js';
import type { DeliveryRecord, Irq, Message, Report } from './domain.js';
import { toIrq, messageOf } from './domain.js';
import { PauseState } from './pause.js';
import { deliveryKey } from './outbox.js';

export interface RuntimeDeps {
  clock: Clock;
  channel: Channel;
  persistence: Persistence;
  pause?: PauseState;
  scheduler?: Scheduler;
  outbox?: Outbox;
  metrics?: Metrics;
}

class ImmediateScheduler implements Scheduler {
  private pending: Irq[] = [];

  submit(irq: Irq): void {
    this.pending.push(irq);
  }

  due(now: number): Message[] {
    const messages = this.pending.map((irq) => messageOf(irq, now));
    this.pending = [];
    return messages;
  }
}

class NoopMetrics implements Metrics {
  recordDelivery(_message: Message, _now: number): void {}
}

class SimpleOutbox implements Outbox {
  constructor(
    private readonly channel: Channel,
    private readonly persistence: Persistence,
    private readonly metrics: Metrics,
    private readonly clock: Clock,
  ) {}

  enqueue(message: Message): void {
    const now = this.clock.now();
    const result = this.channel.send(message);
    const record: DeliveryRecord = { message, status: result, attempts: 1 };
    if (result === 'sent') record.sentAt = now;
    this.persistence.save(deliveryKey(message.id), record);
    this.persistence.append({ type: 'delivery.sent', at: now, payload: record });
    // 度量只记录成功送达；waiting/gone 尚未消耗接收人注意力
    if (result === 'sent') this.metrics.recordDelivery(message, now);
  }

  drain(_now: number): void {}
}

export class Runtime {
  private readonly clock: Clock;
  private readonly persistence: Persistence;
  private readonly pauseState: PauseState;
  private readonly scheduler: Scheduler;
  private readonly outbox: Outbox;

  constructor(deps: RuntimeDeps) {
    this.clock = deps.clock;
    this.persistence = deps.persistence;
    this.pauseState = deps.pause ?? new PauseState();
    const metrics = deps.metrics ?? new NoopMetrics();
    this.scheduler = deps.scheduler ?? new ImmediateScheduler();
    this.outbox = deps.outbox ?? new SimpleOutbox(deps.channel, deps.persistence, metrics, deps.clock);
  }

  ingest(report: Report): void {
    const now = this.clock.now();
    const irq = toIrq(report, now);
    if (!irq) return;
    this.persistence.append({ type: 'irq.created', at: now, payload: irq });
    this.scheduler.submit(irq);
    this.flush();
  }

  flush(): void {
    if (this.pauseState.isPaused()) return;
    const now = this.clock.now();
    for (const message of this.scheduler.due(now)) {
      this.outbox.enqueue(message);
    }
    this.outbox.drain(now);
  }

  pause(): void {
    this.pauseState.pause(this.clock.now());
  }

  resume(): void {
    this.pauseState.resume(this.clock.now());
    this.flush();
  }

  isPaused(): boolean {
    return this.pauseState.isPaused();
  }
}

export function createRuntime(deps: RuntimeDeps): Runtime {
  return new Runtime(deps);
}
