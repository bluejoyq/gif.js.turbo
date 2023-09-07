import { Condition } from './condition';
export class Throttler {
  private maxPending: number;
  private pendingCount: number;
  private full: Condition;
  constructor(maxPending) {
    this.maxPending = maxPending;
    this.pendingCount = 0;
    this.full = new Condition();
  }

  async wait() {
    while (this.pendingCount >= this.maxPending) {
      await this.full.wait();
    }
    this.pendingCount++;
  }

  async ensureEmpty() {
    while (this.pendingCount != 0) {
      await this.full.wait();
    }
  }

  notify() {
    this.pendingCount--;
    this.full.notifyOne();
  }
}
