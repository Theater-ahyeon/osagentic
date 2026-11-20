import { ManualClock } from '../src/clock.js';
import { InMemoryPersistence } from '../src/persistence.js';
import { createRuntime } from '../src/runtime.js';
import type { RuntimeDeps } from '../src/runtime.js';
import type { Channel, SendResult } from '../src/ports.js';
import type { Message, Report } from '../src/domain.js';

export class RecordingChannel implements Channel {
  private readonly messages: Message[] = [];

  send(message: Message): SendResult {
    this.messages.push(message);
    return 'sent';
  }

  sent(): Message[] {
    return [...this.messages];
  }
}

export interface HarnessOptions {
  now?: number;
  scheduler?: RuntimeDeps['scheduler'];
  outbox?: RuntimeDeps['outbox'];
  metrics?: RuntimeDeps['metrics'];
}

export function createHarness(opts: HarnessOptions = {}) {
  const clock = new ManualClock(opts.now ?? 0);
  const channel = new RecordingChannel();
  const persistence = new InMemoryPersistence();
  const runtime = createRuntime({
    clock,
    channel,
    persistence,
    scheduler: opts.scheduler,
    outbox: opts.outbox,
    metrics: opts.metrics,
  });
  return {
    clock,
    channel,
    persistence,
    runtime,
    report(r: Report): void {
      runtime.ingest(r);
    },
    advance(ms: number): void {
      clock.advance(ms);
      runtime.flush();
    },
  };
}
