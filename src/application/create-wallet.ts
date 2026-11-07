import type { Money } from "../domain/money";
import { WagerTransaction } from "../domain/wager-transaction";
import { Wallet } from "../domain/wallet";
import { UniqueViolationError } from "./errors";
import { outboxFor } from "./event-factory";
import type { Clock, IdGenerator, Metrics, RequestContext, UnitOfWork } from "./ports";

export type CreateWalletResult = { type: "created"; wallet: Wallet } | { type: "exists"; walletId: string };

/**
 * Opens a wallet. A positive initial balance becomes an internal OPENING transaction plus its CREDIT
 * entry and events, all in the same SQL transaction (the deferred trigger checks the pairing).
 */
export class CreateWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  async execute(input: { playerId: string; initialBalance: Money }, ctx: RequestContext): Promise<CreateWalletResult> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.uow.run(async (store) => {
          const existing = await store.findWalletByPlayer(input.playerId, input.initialBalance.currency);
          if (existing) return { type: "exists", walletId: existing.id } as const;

          const now = this.clock.now();
          const walletId = this.ids.next();
          const openingId = this.ids.next();
          const { wallet, openingEntry } = Wallet.open({
            id: walletId,
            playerId: input.playerId,
            initialBalance: input.initialBalance,
            at: now,
            openingTransactionId: openingId,
            openingEntryId: this.ids.next(),
          });
          await store.insertWallet(wallet);
          if (openingEntry) {
            const opening = WagerTransaction.opening({ id: openingId, walletId, playerId: input.playerId, money: input.initialBalance, at: now });
            opening.markProcessed({ resultBalance: wallet.balance, at: now });
            await store.insertTransaction(opening);
            await store.insertLedgerEntry(openingEntry);
            await store.insertOutbox(outboxFor({ transaction: opening, wallet, entry: openingEntry, ctx, now }, this.ids));
            this.metrics.transactionDecided(opening.status, opening.kind, "internal");
          }
          return { type: "created", wallet } as const;
        });
      } catch (err) {
        // two creations raced on (player_id, currency): the second re-reads and reports the winner
        if (err instanceof UniqueViolationError && attempt === 0) continue;
        throw err;
      }
    }
  }
}
