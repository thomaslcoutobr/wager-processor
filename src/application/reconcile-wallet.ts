import { Money, type MoneyProps } from "../domain/money";
import type { LogFn } from "./log-context";
import type { Metrics, ReadStore } from "./ports";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
  chainBreaks: number;
}

/** Money from a signed decimal string produced by SQL (the contract's Money.from refuses the sign). */
function signed(amount: string, currency: string): Money {
  return amount.startsWith("-") ? Money.from({ amount: amount.slice(1), currency }).negate() : Money.from({ amount, currency });
}

/**
 * Rebuilds the balance from the ledger (ARCHITECTURE §15). A divergence is NEVER corrected here:
 * it is logged (ids and values, no payload), counted and returned with consistent = false.
 */
export class ReconcileWallet {
  constructor(
    private readonly read: ReadStore,
    private readonly metrics: Metrics,
    private readonly log: LogFn,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult | undefined> {
    const r = await this.read.reconcile(walletId);
    if (!r) return undefined;
    const stored = signed(r.stored, r.currency);
    const calculated = signed(r.calculated, r.currency);
    const difference = stored.subtract(calculated);
    const consistent = difference.isZero() && r.chainBreaks === 0;
    if (!consistent) {
      this.metrics.reconciliationDivergence();
      this.log("error", "reconciliation divergence", {
        walletId,
        stored: stored.amount,
        calculated: calculated.amount,
        difference: difference.amount,
        chainBreaks: r.chainBreaks,
      });
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: r.checkedEntries,
      chainBreaks: r.chainBreaks,
    };
  }
}
