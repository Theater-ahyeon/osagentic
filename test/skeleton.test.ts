import { describe, it, expect } from 'vitest';
import { createHarness } from './harness.js';
import type { Report } from '../src/domain.js';

function report(overrides: Partial<Report> = {}): Report {
  return {
    ticketId: 't1',
    kind: 'blocked',
    recipient: 'alice',
    channel: 'chat-1',
    question: 'Which design should we use?',
    at: 0,
    ...overrides,
  };
}

describe('attention IRQ boundary (walking skeleton)', () => {
  it('delivers a blocked report question immediately to the channel', () => {
    const h = createHarness();
    h.report(report());
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.purpose).toBe('attention');
    expect(sent[0]!.recipient).toBe('alice');
    expect(sent[0]!.channel).toBe('chat-1');
    expect(sent[0]!.text).toContain('Which design should we use?');
  });

  it('delivers a failed report awaiting answer as an attention interruption', () => {
    const h = createHarness();
    h.report(report({ kind: 'failed' }));
    const sent = h.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.purpose).toBe('attention');
  });

  it('delivers progress as notice and ready as result (bottom-half)', () => {
    const h = createHarness();
    h.report(report({ ticketId: 'c', kind: 'progress', question: undefined }));
    h.report(report({ ticketId: 'd', kind: 'ready', question: undefined }));
    const byTicket = new Map(h.channel.sent().map((m) => [m.ticketId, m]));
    expect(byTicket.get('c')!.purpose).toBe('notice');
    expect(byTicket.get('d')!.purpose).toBe('result');
  });

  it('produces no interruption for waiting or dropped reports', () => {
    const h = createHarness();
    h.report(report({ kind: 'waiting', question: undefined }));
    h.report(report({ kind: 'dropped', question: undefined }));
    expect(h.channel.sent()).toHaveLength(0);
  });
});
