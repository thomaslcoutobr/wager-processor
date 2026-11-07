import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, gate, postWager, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("reversals");
  running = await startApp(db);
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function setup(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(base, amount, playerId);
  return { walletId, playerId };
}
const balanceOf = async (walletId: string) => (await call(base, "GET", `/wallets/${walletId}`)).body.balance.amount as string;
const ext = (p: string) => `${p}-${crypto.randomUUID()}`;

describe("REFUND", () => {
  it("credits back a processed BET once and links the reference", async () => {
    const w = await setup();
    const betId = ext("bet");
    const bet = await postWager(base, { ...w, externalTransactionId: betId, amount: "25.00" });
    const refund = await postWager(base, { ...w, kind: "REFUND", amount: "25.00", referenceExternalTransactionId: betId });
    expect(refund.status).toBe(200);
    expect(refund.body.balance.amount).toBe("100.00");
    const view = (await call(base, "GET", `/wagering/transactions/${refund.body.transactionId}`)).body;
    expect(view.referenceTransactionId).toBe(bet.body.transactionId);
    expect(view.referenceExternalTransactionId).toBe(betId);
    await expectWalletConsistent(db.app, w.walletId);
  });

  it("of a WIN is 422 REFERENCE_KIND_NOT_ALLOWED", async () => {
    const w = await setup();
    const winId = ext("win");
    await postWager(base, { ...w, kind: "WIN", externalTransactionId: winId, amount: "5.00" });
    const r = await postWager(base, { ...w, kind: "REFUND", amount: "5.00", referenceExternalTransactionId: winId });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("REFERENCE_KIND_NOT_ALLOWED");
  });

  it("with another amount is 422 AMOUNT_MISMATCH (no partial reversal)", async () => {
    const w = await setup();
    const betId = ext("bet");
    await postWager(base, { ...w, externalTransactionId: betId, amount: "25.00" });
    const r = await postWager(base, { ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("AMOUNT_MISMATCH");
    expect(await balanceOf(w.walletId)).toBe("75.00");
  });

  it("of a REJECTED bet is 422 REFERENCE_NOT_PROCESSED", async () => {
    const w = await setup("1.00");
    const betId = ext("bet");
    const bet = await postWager(base, { ...w, externalTransactionId: betId, amount: "5.00" });
    expect(bet.status).toBe(422);
    const r = await postWager(base, { ...w, kind: "REFUND", amount: "5.00", referenceExternalTransactionId: betId });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("REFERENCE_NOT_PROCESSED");
    expect(await balanceOf(w.walletId)).toBe("1.00");
  });

  it("referencing another wallet or another round is 422 REFERENCE_MISMATCH", async () => {
    const a = await setup();
    const b = await setup();
    const betId = ext("bet");
    await postWager(base, { ...a, externalTransactionId: betId, amount: "5.00" });
    const otherWallet = await postWager(base, { ...b, kind: "REFUND", amount: "5.00", referenceExternalTransactionId: betId });
    expect(otherWallet.status).toBe(422);
    expect(otherWallet.body.failureCode).toBe("REFERENCE_MISMATCH");
    const otherRound = await postWager(base, {
      ...a,
      kind: "REFUND",
      amount: "5.00",
      roundId: "round-2",
      referenceExternalTransactionId: betId,
    });
    expect(otherRound.status).toBe(422);
    expect(otherRound.body.failureCode).toBe("REFERENCE_MISMATCH");
    expect(await balanceOf(a.walletId)).toBe("95.00");
    expect(await balanceOf(b.walletId)).toBe("100.00");
  });
});

describe("ROLLBACK", () => {
  it("of a BET credits, of a WIN debits, of a REFUND debits", async () => {
    const w = await setup();
    const betId = ext("bet");
    const winId = ext("win");
    await postWager(base, { ...w, externalTransactionId: betId, amount: "10.00" }); // 90
    await postWager(base, { ...w, kind: "WIN", externalTransactionId: winId, amount: "30.00" }); // 120
    const rbBet = await postWager(base, { ...w, kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: betId });
    expect(rbBet.body.balance.amount).toBe("130.00");
    const rbWin = await postWager(base, { ...w, kind: "ROLLBACK", amount: "30.00", referenceExternalTransactionId: winId });
    expect(rbWin.body.balance.amount).toBe("100.00");

    const bet2 = ext("bet");
    const refund2 = ext("refund");
    await postWager(base, { ...w, externalTransactionId: bet2, amount: "20.00" }); // 80
    await postWager(base, { ...w, kind: "REFUND", externalTransactionId: refund2, amount: "20.00", referenceExternalTransactionId: bet2 }); // 100
    const rbRefund = await postWager(base, { ...w, kind: "ROLLBACK", amount: "20.00", referenceExternalTransactionId: refund2 });
    expect(rbRefund.status).toBe(200);
    expect(rbRefund.body.balance.amount).toBe("80.00");
    await expectWalletConsistent(db.app, w.walletId);
  });

  it("that would make the balance negative is 422 REVERSAL_INSUFFICIENT_FUNDS and stays auditable", async () => {
    const w = await setup("0.00");
    const winId = ext("win");
    await postWager(base, { ...w, kind: "WIN", externalTransactionId: winId, amount: "50.00" });
    await postWager(base, { ...w, amount: "45.00" }); // 5.00 left
    const r = await postWager(base, { ...w, kind: "ROLLBACK", amount: "50.00", referenceExternalTransactionId: winId });
    expect(r.status).toBe(422);
    expect(r.body.failureCode).toBe("REVERSAL_INSUFFICIENT_FUNDS");
    const view = (await call(base, "GET", `/wagering/transactions/${r.body.transactionId}`)).body;
    expect(view.status).toBe("REJECTED");
    expect(await balanceOf(w.walletId)).toBe("5.00");
  });
});

describe("a transaction is reversed at most once", () => {
  it("a second reversal of any kind is 422 ALREADY_REVERSED", async () => {
    const w = await setup();
    const betId = ext("bet");
    await postWager(base, { ...w, externalTransactionId: betId, amount: "10.00" });
    expect((await postWager(base, { ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId })).status).toBe(200);
    const again = await postWager(base, { ...w, kind: "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("ALREADY_REVERSED");
    const rb = await postWager(base, { ...w, kind: "ROLLBACK", amount: "10.00", referenceExternalTransactionId: betId });
    expect(rb.status).toBe(422);
    expect(rb.body.failureCode).toBe("ALREADY_REVERSED");
    expect(await balanceOf(w.walletId)).toBe("100.00");
  });

  it("10 different reversals of the same BET racing: exactly one credit (5 rounds)", async () => {
    for (let round = 0; round < 5; round++) {
      const w = await setup();
      const betId = ext("bet");
      await postWager(base, { ...w, externalTransactionId: betId, amount: "10.00" });
      const g = gate();
      const all = Array.from({ length: 10 }, async (_, i) => {
        await g.wait;
        return postWager(base, { ...w, kind: i % 2 ? "ROLLBACK" : "REFUND", amount: "10.00", referenceExternalTransactionId: betId });
      });
      g.open();
      const res = await Promise.all(all);
      expect(res.filter((r) => r.status === 200).length).toBe(1);
      expect(res.filter((r) => r.status === 422 && r.body.failureCode === "ALREADY_REVERSED").length).toBe(9);
      expect(await balanceOf(w.walletId)).toBe("100.00");
      const [credits] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${w.walletId} and direction = 'CREDIT'`;
      expect(credits.n).toBe(2); // opening + one reversal
      await expectWalletConsistent(db.app, w.walletId);
    }
  });
});
