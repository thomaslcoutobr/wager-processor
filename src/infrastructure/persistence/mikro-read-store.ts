import type { MikroORM } from "@mikro-orm/postgresql";
import type { ReadStore } from "../../application/ports";
import type { WalletLedgerEntry } from "../../domain/ledger-entry";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/wager-transaction";
import type { Wallet } from "../../domain/wallet";
import { translateDbError } from "./db-errors";
import { type LedgerRow, ledgerMapper, type TransactionRow, transactionMapper, type WalletRow, walletMapper } from "./mappers";
import { LedgerEntryRecord, WagerTransactionRecord, WalletRecord } from "./schemas";

/** Plain reads, each on a fresh fork (no identity map carried between requests). */
export class MikroReadStore implements ReadStore {
  constructor(private readonly orm: MikroORM) {}

  private async read<T>(fn: (em: ReturnType<MikroORM["em"]["fork"]>) => Promise<T>): Promise<T> {
    try {
      return await fn(this.orm.em.fork());
    } catch (err) {
      throw translateDbError(err);
    }
  }

  findWallet(walletId: string): Promise<Wallet | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WalletRecord, { id: walletId });
      return r ? walletMapper.toDomain(r as unknown as WalletRow) : undefined;
    });
  }

  findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WagerTransactionRecord, { id });
      return r ? transactionMapper.toDomain(r as unknown as TransactionRow) : undefined;
    });
  }

  findTransactionByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WagerTransactionRecord, { providerId, externalTransactionId: externalId });
      return r ? transactionMapper.toDomain(r as unknown as TransactionRow) : undefined;
    });
  }

  findTransactionByKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    return this.read(async (em) => {
      const r = await em.findOne(WagerTransactionRecord, { providerId, idempotencyKey });
      return r ? transactionMapper.toDomain(r as unknown as TransactionRow) : undefined;
    });
  }

  findDuePending(now: Date, limit: number): Promise<Array<{ id: string; walletId: string }>> {
    return this.read(async (em) => {
      const rows = await em.find(
        WagerTransactionRecord,
        { status: WagerTransactionStatus.PendingReference, nextAttemptAt: { $lte: now } },
        { fields: ["id", "walletId"], orderBy: { nextAttemptAt: "asc" }, limit },
      );
      return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
    });
  }

  listLedger(walletId: string, beforeVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    return this.read(async (em) => {
      const where = beforeVersion === undefined ? { walletId } : { walletId, walletVersion: { $lt: beforeVersion } };
      const rows = await em.find(LedgerEntryRecord, where, { orderBy: { walletVersion: "desc" }, limit });
      return rows.map((r) => ledgerMapper.toDomain(r as unknown as LedgerRow));
    });
  }
}
