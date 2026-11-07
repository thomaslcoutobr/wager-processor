import { TransientError } from "../application/errors";
import type { FailpointPort } from "../application/ports";

export type FailpointAction = "crash" | "throw" | "transient";

const ACTIONS: ReadonlySet<string> = new Set(["crash", "throw", "transient"]);

export class FailpointError extends Error {
  constructor(name: string) {
    super(`failpoint ${name} triggered`);
    this.name = "FailpointError";
  }
}

/**
 * Crash and fault injection at named points, for the recovery tests (ARCHITECTURE §16).
 * Spec: `FAILPOINTS=consumer.after_commit_before_ack=crash,usecase.before_commit=transient`.
 *  - crash     → SIGKILL on the own process (exit 137), exactly at that line
 *  - throw     → a non-transient error (bug path)
 *  - transient → a TransientError (retry path)
 * The app refuses to start with FAILPOINTS set in production.
 */
export class Failpoints implements FailpointPort {
  private readonly points = new Map<string, FailpointAction>();

  constructor(spec: string, opts: { allowInProduction: boolean; nodeEnv?: string }) {
    if (spec.trim() && opts.nodeEnv === "production" && !opts.allowInProduction) {
      throw new Error("FAILPOINTS must not be set in production");
    }
    for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [name, action] = part.split("=");
      if (!name || !action || !ACTIONS.has(action)) throw new Error(`invalid failpoint "${part}"`);
      this.points.set(name, action as FailpointAction);
    }
  }

  set(name: string, action: FailpointAction): void {
    this.points.set(name, action);
  }

  clear(): void {
    this.points.clear();
  }

  isActive(): boolean {
    return this.points.size > 0;
  }

  async hit(name: string): Promise<void> {
    const action = this.points.get(name);
    if (!action) return;
    if (action === "crash") {
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {}); // never continue past a crash point
    }
    if (action === "transient") throw new TransientError("SERVICE_UNAVAILABLE", `failpoint ${name} (transient)`);
    throw new FailpointError(name);
  }
}
