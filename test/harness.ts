import { ManualClock } from '../src/clock.js';
import { InMemoryPersistence } from '../src/persistence.js';
import { PauseState } from '../src/pause.js';
import { createRuntime } from '../src/runtime.js';
import type { Scheduler, Outbox, Metrics, Channel, SendResult, Persistence } from '../src/ports.js';
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

export interface HarnessDeps {
  clock: ManualClock;
  channel: RecordingChannel;
  persistence: Persistence;
  pause: PauseState;
}

export interface HarnessOptions {
  now?: number;
  persistence?: Persistence;
  channel?: RecordingChannel;
  scheduler?: (deps: HarnessDeps) => Scheduler;
  outbox?: (deps: HarnessDeps) => Outbox;
  metrics?: (deps: HarnessDeps) => Metrics;
}

export function createHarness(opts: HarnessOptions = {}) {
  const clock = new ManualClock(opts.now ?? 0);
  const channel = opts.channel ?? new RecordingChannel();
  const persistence = opts.persistence ?? new InMemoryPersistence();
  const pause = new PauseState();
  const deps: HarnessDeps = { clock, channel, persistence, pause };
  const runtime = createRuntime({
    clock,
    channel,
    persistence,
    pause,
    scheduler: opts.scheduler?.(deps),
    outbox: opts.outbox?.(deps),
    metrics: opts.metrics?.(deps),
  });
  return {
    clock,
    channel,
    persistence,
    pause,
    runtime,
    report(r: Report): void {
      runtime.ingest(r);
    },
    advance(ms: number): void {
      clock.advance(ms);
      runtime.flush();
    },
    pauseNow(): void {
      runtime.pause();
    },
    resumeNow(): void {
      runtime.resume();
    },
  };
}
