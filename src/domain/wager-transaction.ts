import { DomainValidationError, InvalidTransactionStateError, InvariantViolationError } from "./errors";
import {
  type BusinessRejectionCode,
  type FailureCode,
  isBusinessRejectionCode,
  isPermanentFailureCode,
  type PermanentFailureCode,
} from "./failure-code";
import { LedgerDirection } from "./ledger-entry";
import type { Money } from "./money";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: opening credit of a wallet
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // birth state; never persisted (ARCHITECTURE §4.3)
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

export const INTERNAL_PROVIDER_ID = "__internal__";

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** id at the provider, not our internal id */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId?: string;
  gameId?: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Wallet balance observed under the lock when the outcome was decided (rule 7). */
  resultBalance?: Money;
  attempts: number;
  nextAttemptAt?: Date;
  pendingDeadlineAt?: Date;
  processedAt?: Date;
}

/**
 * Transitions (anything else throws InvalidTransactionStateError):
 *
 *   PENDING ──markProcessed──► PROCESSED
 *   PENDING ──reject─────────► REJECTED
 *   PENDING ──fail───────────► FAILED
 *   PENDING ──markPendingReference──► PENDING_REFERENCE ──scheduleRetry──┐
 *                                      │      ▲──────────────────────────┘
 *                                      └──markProcessed | reject | fail──► terminal
 */
export class WagerTransaction {
  private constructor(
    readonly id: string,
    readonly providerId: string,
    readonly externalTransactionId: string,
    readonly idempotencyKey: string,
    readonly payloadHash: string,
    readonly walletId: string,
    readonly playerId: string,
    readonly roundId: string | undefined,
    readonly gameId: string | undefined,
    readonly kind: WagerTransactionKind,
    readonly money: Money,
    readonly referenceExternalTransactionId: string | undefined,
    readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _resultBalance: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _pendingDeadlineAt: Date | undefined,
    private _processedAt: Date | undefined,
  ) {}

  /** Born PENDING. Enforces the per-kind reference rules. OPENING is not reachable from here. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainValidationError("FORBIDDEN_KIND", "OPENING is internal and cannot be submitted", "kind");
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new DomainValidationError("VALIDATION_ERROR", "providerId is reserved", "providerId");
    }
    if (!props.roundId || !props.gameId) {
      throw new DomainValidationError("VALIDATION_ERROR", "roundId and gameId are required", "roundId");
    }
    const ref = props.referenceExternalTransactionId;
    if (ref === undefined && (props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback)) {
      throw new DomainValidationError(
        "MISSING_REFERENCE",
        `${props.kind} requires referenceExternalTransactionId`,
        "referenceExternalTransactionId",
      );
    }
    if (ref !== undefined && props.kind === WagerTransactionKind.Bet) {
      throw new DomainValidationError("VALIDATION_ERROR", "BET cannot reference another transaction", "referenceExternalTransactionId");
    }
    if (ref !== undefined && ref === props.externalTransactionId) {
      throw new DomainValidationError("VALIDATION_ERROR", "a transaction cannot reference itself", "referenceExternalTransactionId");
    }
    return WagerTransaction.newPending(props);
  }

  /** The internal OPENING credit created together with a wallet. */
  static opening(props: { id: string; walletId: string; playerId: string; money: Money; at: Date }): WagerTransaction {
    const externalId = `opening:${props.walletId}`;
    return WagerTransaction.newPending({
      id: props.id,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: externalId,
      idempotencyKey: externalId,
      payloadHash: "internal:opening",
      walletId: props.walletId,
      playerId: props.playerId,
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
  }

  /** Rebuilds persisted state; transition rules are NOT re-validated. */
  static rehydrate(s: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      s.id,
      s.providerId,
      s.externalTransactionId,
      s.idempotencyKey,
      s.payloadHash,
      s.walletId,
      s.playerId,
      s.roundId,
      s.gameId,
      s.kind,
      s.money,
      s.referenceExternalTransactionId,
      s.createdAt,
      s.status,
      s.referenceTransactionId,
      s.failureCode,
      s.resultBalance,
      s.attempts,
      s.nextAttemptAt,
      s.pendingDeadlineAt,
      s.processedAt,
    );
  }

  private static newPending(
    p: Omit<CreateWagerTransactionProps, "roundId" | "gameId"> & { roundId?: string; gameId?: string },
  ): WagerTransaction {
    return new WagerTransaction(
      p.id,
      p.providerId,
      p.externalTransactionId,
      p.idempotencyKey,
      p.payloadHash,
      p.walletId,
      p.playerId,
      p.roundId,
      p.gameId,
      p.kind,
      p.money,
      p.referenceExternalTransactionId,
      p.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }
  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get pendingDeadlineAt(): Date | undefined {
    return this._pendingDeadlineAt;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  // ---- transitions ----------------------------------------------------------------------------

  markProcessed(p: { referenceTransactionId?: string; resultBalance: Money; at: Date }): void {
    this.assertOpen("markProcessed");
    if (this.requiresReference() && !p.referenceTransactionId) {
      throw new InvariantViolationError(`a processed ${this.kind} must know the id of the transaction it reverses`);
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = p.referenceTransactionId;
    this.close(p.at, p.resultBalance);
  }

  markPendingReference(p: { resultBalance: Money; nextAttemptAt: Date; deadlineAt: Date }): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(`markPendingReference is only valid from PENDING (current: ${this._status})`);
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvariantViolationError("only a transaction with a reference can wait for it");
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = p.resultBalance;
    this._nextAttemptAt = p.nextAttemptAt;
    this._pendingDeadlineAt = p.deadlineAt;
  }

  /** Reference still missing: stay in PENDING_REFERENCE, one more attempt consumed. */
  scheduleRetry(p: { nextAttemptAt: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(`scheduleRetry is only valid from PENDING_REFERENCE (current: ${this._status})`);
    }
    this._attempts += 1;
    this._nextAttemptAt = p.nextAttemptAt;
  }

  reject(p: { code: BusinessRejectionCode | FailureCode; resultBalance: Money; at: Date; referenceTransactionId?: string }): void {
    this.assertOpen("reject");
    if (!isBusinessRejectionCode(p.code)) {
      throw new InvariantViolationError(`${p.code} is not a business rejection code`);
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = p.code;
    this._referenceTransactionId = p.referenceTransactionId;
    this.close(p.at, p.resultBalance);
  }

  fail(p: { code: PermanentFailureCode | FailureCode; at: Date }): void {
    this.assertOpen("fail");
    if (!isPermanentFailureCode(p.code)) {
      throw new InvariantViolationError(`${p.code} is not a permanent failure code`);
    }
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = p.code;
    this.close(p.at, this._resultBalance);
  }

  // ---- queries --------------------------------------------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** BET debits; WIN, REFUND and OPENING credit; LOSS moves nothing; ROLLBACK inverts its reference. */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        return undefined;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvariantViolationError("ROLLBACK direction depends on its reference");
        const reversed = reference.ledgerDirectionFor();
        if (reversed === undefined) throw new InvariantViolationError(`cannot roll back a ${reference.kind}`);
        return reversed === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money,
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      resultBalance: this._resultBalance,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      pendingDeadlineAt: this._pendingDeadlineAt,
      processedAt: this._processedAt,
    };
  }

  private assertOpen(op: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(`${op} on terminal transaction ${this.id} (${this._status})`);
    }
  }

  private close(at: Date, resultBalance: Money | undefined): void {
    this._resultBalance = resultBalance;
    this._processedAt = at;
    this._nextAttemptAt = undefined;
  }
}
