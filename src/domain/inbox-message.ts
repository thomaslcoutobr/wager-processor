import { InvalidStateError } from "./errors";

export interface ReceiveInboxProps {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  at: Date;
}

export interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

/**
 * Persistent dedup record of a consumed message, keyed by (consumerName, messageId). It is written
 * in the same SQL transaction as the effect, so in practice it is stored already processed.
 */
export class InboxMessage {
  private constructor(
    readonly consumerName: string,
    readonly messageId: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(p: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(p.consumerName, p.messageId, p.payloadHash, p.at, undefined);
  }

  static rehydrate(s: InboxMessageState): InboxMessage {
    return new InboxMessage(s.consumerName, s.messageId, s.payloadHash, s.receivedAt, s.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new InvalidStateError(`inbox message ${this.messageId} already processed`);
    this._processedAt = at;
  }

  /** Same messageId with another payload is a producer bug, never a duplicate. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  toState(): InboxMessageState {
    return {
      consumerName: this.consumerName,
      messageId: this.messageId,
      payloadHash: this.payloadHash,
      receivedAt: this.receivedAt,
      processedAt: this._processedAt,
    };
  }
}
