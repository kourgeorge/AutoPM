import { sweepProposals } from './proposalExecutor';
import { sweepStops } from './stopOrders';
import { executionHealthy, renewLease, runtimeFailed } from '../core/runtime';
import { logger } from '../core/logger';
import { refreshJournalProtection } from '../journal/protection';

/** Account execution is independent of research, charting and market-data collection. */
export class ExecutionLoop {
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  start(): void { this.running = true; this.next(); }
  private next(): void {
    if (!this.running) return;
    this.active = (async () => {
      try {
        renewLease();
        await sweepProposals();
        await sweepStops();
        await refreshJournalProtection();
        executionHealthy();
      } catch (err: any) {
        runtimeFailed(err.message);
        logger.error('[Execution] ' + err.message);
      }
    })().finally(() => { if (this.running) this.timer = setTimeout(() => this.next(), 2_000); });
  }
  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.timer);
    await this.active;
  }
}
