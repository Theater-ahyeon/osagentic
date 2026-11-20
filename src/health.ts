// 健康条目：组件名、健康判定、待决数量与说明
export interface HealthEntry {
  component: string;
  healthy: boolean;
  pending: number;
  detail: string;
}

export type HealthProbe = (now: number) => HealthEntry;

// 最小健康注册表：调度器与送达队列认领条目，运维经 entries 读取故障状态
export class HealthBoard {
  private readonly probes = new Map<string, HealthProbe>();

  claim(component: string, probe: HealthProbe): void {
    this.probes.set(component, probe);
  }

  entries(now: number): HealthEntry[] {
    return Array.from(this.probes.values(), (probe) => probe(now));
  }
}
