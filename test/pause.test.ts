import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import type { Report } from '../src/domain.js';

function progress(ticketId: string): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0 };
}

describe('pause infrastructure', () => {
  it('suppresses delivery while paused and delivers on resume', () => {
    const h = createHarness();
    h.pauseNow();
    h.report(progress('t1'));
    expect(h.channel.sent()).toHaveLength(0);
    h.resumeNow();
    expect(h.channel.sent()).toHaveLength(1);
  });

  it('accumulates paused duration for deadline shifting', () => {
    const h = createHarness();
    h.pauseNow();
    h.advance(5000);
    h.resumeNow();
    expect(h.pause.pausedMs()).toBe(5000);
    expect(h.runtime.isPaused()).toBe(false);
  });
});
