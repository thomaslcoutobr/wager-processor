import { InvariantViolationError } from "./errors";

export interface PendingReferencePolicyProps {
  /** Time a transaction may wait for its reference, counted from acceptance (default 10 min). */
  ttlMs: number;
  /** First retry delay; doubles each attempt. */
  baseDelayMs: number;
  /** Cap for a single retry delay. */
  maxDelayMs: number;
}

/** Jitter factor in [0.5, 1]: spreads retries of many pending transactions without ever waiting longer than the cap. */
export function jitter(random: () => number): number {
  return 0.5 + 0.5 * Math.min(1, Math.max(0, random()));
}

/**
 * Retry schedule for PENDING_REFERENCE (ARCHITECTURE §14): exponential backoff with jitter,
 * bounded by a TTL rather than by an attempt count.
 */
export class PendingReferencePolicy {
  private constructor(
    readonly ttlMs: number,
    readonly baseDelayMs: number,
    readonly maxDelayMs: number,
  ) {
    Object.freeze(this);
  }

  static create(p: PendingReferencePolicyProps): PendingReferencePolicy {
    const positive = (n: number) => Number.isFinite(n) && n > 0;
    if (!positive(p.ttlMs) || !positive(p.baseDelayMs) || !positive(p.maxDelayMs) || p.baseDelayMs > p.maxDelayMs) {
      throw new InvariantViolationError("pending reference policy needs positive ttl/base/max with base <= max");
    }
    return new PendingReferencePolicy(p.ttlMs, p.baseDelayMs, p.maxDelayMs);
  }

  deadlineFrom(acceptedAt: Date): Date {
    return new Date(acceptedAt.getTime() + this.ttlMs);
  }

  /** `attempts` is the attempt count after the increment (0 when first entering PENDING_REFERENCE). */
  nextAttemptAt(now: Date, attempts: number, random: () => number = Math.random): Date {
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempts) * jitter(random);
    return new Date(now.getTime() + Math.round(delay));
  }

  isExpired(deadlineAt: Date, now: Date): boolean {
    return now.getTime() >= deadlineAt.getTime();
  }
}
