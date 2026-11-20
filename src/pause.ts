export class PauseState {
  private pausedAt: number | undefined;
  private accumulated = 0;

  pause(now: number): void {
    if (this.pausedAt === undefined) this.pausedAt = now;
  }

  resume(now: number): void {
    if (this.pausedAt !== undefined) {
      this.accumulated += now - this.pausedAt;
      this.pausedAt = undefined;
    }
  }

  isPaused(): boolean {
    return this.pausedAt !== undefined;
  }

  pausedMs(): number {
    return this.accumulated;
  }
}
