import { describe, it, expect, vi } from 'vitest';
import type { Report } from '../src/domain.js';

function progress(ticketId: string): Report {
  return { ticketId, kind: 'progress', recipient: 'alice', channel: 'chat-1', at: 0 };
}

// 模拟进程重启：重置模块注册表后重新导入，模块级状态（如 ID 计数器）回到初始值，
// 持久化存储跨重启共享，送达幂等检查必须仍然正确。
// 静态导入无法重置模块级状态，此处必须用动态导入行使模块加载边界
describe('重启恢复（Source/Channel 边界）', () => {
  it('重启后新消息 ID 不与旧送达冲突，新中断不被幂等检查丢弃', async () => {
    vi.resetModules();
    const first = await import('./harness.js');
    const { DurableOutbox } = await import('../src/outbox.js');
    const h1 = first.createHarness({ outbox: (d) => new DurableOutbox(d) });
    h1.report(progress('t1'));
    expect(h1.channel.sent()).toHaveLength(1);
    const oldIds = h1.channel.sent().map((m) => m.id);

    vi.resetModules();
    const second = await import('./harness.js');
    const { DurableOutbox: RestartedOutbox } = await import('../src/outbox.js');
    const h2 = second.createHarness({
      persistence: h1.persistence,
      outbox: (d) => new RestartedOutbox(d),
    });
    h2.report(progress('t2'));
    const sent = h2.channel.sent();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe('progress on t2');
    expect(oldIds).not.toContain(sent[0]!.id);
  });
});
