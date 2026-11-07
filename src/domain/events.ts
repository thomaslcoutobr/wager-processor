import type { FailureCode } from "./failure-code";
import type { LedgerDirection, WalletLedgerEntry } from "./ledger-entry";
import type { MoneyProps } from "./money";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";
import type { Wallet } from "./wallet";

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Everything an event needs besides its own data. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Envelope base class; each concrete event fixes `eventType` and `version` in its type. */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = deepFreeze(props.data);
  }

  /** Serialized envelope stored in the outbox payload. Plain JSON only (MoneyProps, ISO strings). */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
    if (this.causationId !== undefined) envelope.causationId = this.causationId;
    return envelope;
  }
}

// ---- transaction events ------------------------------------------------------------------------

export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Wallet balance observed when the outcome was decided. */
  balance?: MoneyProps;
  pendingDeadlineAt?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  const data: WagerTransactionEventData = {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
  };
  // optional fields are omitted, never null, so the JSON stays minimal and stable
  if (tx.roundId !== undefined) data.roundId = tx.roundId;
  if (tx.gameId !== undefined) data.gameId = tx.gameId;
  if (tx.referenceExternalTransactionId !== undefined) data.referenceExternalTransactionId = tx.referenceExternalTransactionId;
  if (tx.referenceTransactionId !== undefined) data.referenceTransactionId = tx.referenceTransactionId;
  if (tx.failureCode !== undefined) data.failureCode = tx.failureCode;
  if (tx.resultBalance !== undefined) data.balance = tx.resultBalance.toJSON();
  if (tx.pendingDeadlineAt !== undefined) data.pendingDeadlineAt = tx.pendingDeadlineAt.toISOString();
  return data;
}

/** Any applied transaction, including LOSS and OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionProcessed" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }
}

/** Business rejection, including an expired PENDING_REFERENCE. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionRejected" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }
}

/** Emitted once, when the transaction starts waiting for its reference. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionPendingReference" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }
}

/** Permanent processing failure recorded for audit (FAILED). */
export class WagerTransactionFailed extends IntegrationEvent<WagerTransactionEventData> {
  readonly eventType = "WagerTransactionFailed" as const;
  readonly version = 1 as const;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionFailed {
    return new WagerTransactionFailed({ ...ctx, aggregateId: tx.id, data: transactionData(tx) });
  }
}

// ---- wallet events ------------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  /** Consumers order by this, because publishers do not guarantee order across batches. */
  walletVersion: number;
}

/** Only when the balance actually changes. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged" as const;
  readonly version = 1 as const;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      },
    });
  }
}
