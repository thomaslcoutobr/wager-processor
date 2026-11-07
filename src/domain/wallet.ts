import { CurrencyMismatchError, DomainValidationError, InvariantViolationError } from "./errors";
import { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import { Money } from "./money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Id of the internal OPENING transaction that backs the initial credit. */
  openingTransactionId: string;
  openingEntryId: string;
}

export interface MovementProps {
  money: Money;
  transactionId: string;
  entryId: string;
  at: Date;
}

/** Insufficient funds is a normal protocol outcome, so it is a result value, not an exception. */
export type BalanceChange = { ok: true; entry: WalletLedgerEntry } | { ok: false; reason: "INSUFFICIENT_FUNDS" };

const PLAYER_ID_MAX = 64;

/**
 * Aggregate root. Every balance change bumps `version` by exactly one and yields exactly one
 * ledger entry; without a balance change nothing happens. Persisting the new state (and the entry,
 * in the same SQL transaction) is the caller's job; the database re-checks the pairing.
 */
export class Wallet {
  private constructor(
    readonly id: string,
    readonly playerId: string,
    readonly currency: string,
    private _balance: Money,
    private _version: number,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry?: WalletLedgerEntry } {
    if (typeof props.playerId !== "string" || props.playerId.length < 1 || props.playerId.length > PLAYER_ID_MAX) {
      throw new DomainValidationError("VALIDATION_ERROR", `playerId must have 1 to ${PLAYER_ID_MAX} characters`, "playerId");
    }
    if (props.initialBalance.isNegative()) {
      throw new DomainValidationError("INVALID_AMOUNT", "initial balance cannot be negative", "initialBalance.amount");
    }
    const currency = props.initialBalance.currency;
    const wallet = new Wallet(props.id, props.playerId, currency, props.initialBalance, 1, props.at, props.at);
    if (props.initialBalance.isZero()) return { wallet };
    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state. Does not re-run any rule. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(m: MovementProps): BalanceChange {
    this.assertMovement(m.money);
    if (this._balance.isLessThan(m.money)) return { ok: false, reason: "INSUFFICIENT_FUNDS" };
    return { ok: true, entry: this.move(LedgerDirection.Debit, m) };
  }

  credit(m: MovementProps): BalanceChange {
    this.assertMovement(m.money);
    return { ok: true, entry: this.move(LedgerDirection.Credit, m) };
  }

  apply(direction: LedgerDirection, m: MovementProps): BalanceChange {
    return direction === LedgerDirection.Debit ? this.debit(m) : this.credit(m);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance,
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  private move(direction: LedgerDirection, m: MovementProps): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(m.money) : before.add(m.money);
    const entry = WalletLedgerEntry.create({
      id: m.entryId,
      walletId: this.id,
      transactionId: m.transactionId,
      direction,
      money: m.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: this._version + 1,
      createdAt: m.at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = m.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvariantViolationError("wallet movements must be positive; zero-amount operations do not touch the balance");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new CurrencyMismatchError(this.currency, money.currency);
  }
}
