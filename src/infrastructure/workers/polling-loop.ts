import { jitter } from "../../domain/pending-reference-policy";

/**
 * Runs `tick` forever with a jittered pause between runs (never overlapping itself).
 * `stop()` waits for the tick in flight, so shutdown never cuts a transaction in half. A tick that
 * does several units of work checks `stopping()` between them, so the drain waits for one unit
 * and not for the whole backlog.
 */
export class PollingLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly tick: (stopping: () => boolean) => Promise<void>,
    private readonly onError: (err: unknown) => void,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(Math.round(this.intervalMs * this.random()));
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick(() => !this.running)
        .catch(this.onError)
        .finally(() => {
          this.inFlight = undefined;
          this.schedule(Math.round(this.intervalMs * jitter(this.random)));
        });
    }, delayMs);
  }
}
