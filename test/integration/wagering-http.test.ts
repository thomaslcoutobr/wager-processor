import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, createWallet, postWager, type RunningApp, startApp, wagerBody } from "../helpers/app";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("http");
  running = await startApp(db);
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

async function walletOf(id: string) {
  return (await call(base, "GET", `/wallets/${id}`)).body;
}

async function newWallet(amount = "100.00") {
  const playerId = crypto.randomUUID();
  const walletId = await createWallet(base, amount, playerId);
  return { walletId, playerId };
}

async function outboxTypes(aggregateIds: string[]): Promise<string[]> {
  const rows = await db.app`select event_type from outbox_messages where aggregate_id in ${db.app(aggregateIds)} order by event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

/** Event types in the outbox that talk about this transaction (WalletBalanceChanged is keyed by wallet). */
async function eventsOfTransaction(transactionId: string): Promise<string[]> {
  const rows = await db.app`select event_type from outbox_messages
                             where payload->'data'->>'transactionId' = ${transactionId} order by event_type`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

describe("POST /wallets", () => {
  it("creates a wallet with the OPENING credit in the same transaction", async () => {
    const playerId = crypto.randomUUID();
    const r = await call(base, "POST", "/wallets", { playerId, initialBalance: { amount: "1000.00", currency: "BRL" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ playerId, balance: { amount: "1000.00", currency: "BRL" }, version: 1 });
    const id = r.body.id as string;
    const entries = await db.app`select direction, amount::text as amount, wallet_version from wallet_ledger_entries where wallet_id = ${id}`;
    expect(entries).toEqual([{ direction: "CREDIT", amount: "1000.00", wallet_version: 1 }]);
    const [opening] = await db.app`select kind, status, provider_id from wager_transactions where wallet_id = ${id}`;
    expect(opening).toEqual({ kind: "OPENING", status: "PROCESSED", provider_id: "__internal__" });
    expect(await outboxTypes([id, ...(await db.app`select id from wager_transactions where wallet_id = ${id}`).map((x: { id: string }) => x.id)])).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    await expectWalletConsistent(db.app, id);
  });

  it("zero initial balance creates no ledger entry", async () => {
    const { walletId } = await newWallet("0.00");
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId}`;
    expect(n.n).toBe(0);
    expect((await walletOf(walletId)).version).toBe(1);
  });

  it("a second wallet for the same player and currency is a 409 with the existing id", async () => {
    const { walletId, playerId } = await newWallet("1.00");
    const r = await call(base, "POST", "/wallets", { playerId, initialBalance: { amount: "5.00", currency: "BRL" } });
    expect(r.status).toBe(409);
    expect(r.headers.get("content-type")).toContain("application/problem+json");
    expect(r.body).toMatchObject({ code: "WALLET_ALREADY_EXISTS", walletId, retry: "NEVER" });
  });

  it("invalid input is a 400 problem+json", async () => {
    const r = await call(base, "POST", "/wallets", { playerId: "p", initialBalance: { amount: "10", currency: "BRL" } });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ code: "INVALID_AMOUNT", retry: "AFTER_FIX", status: 400 });
    const nul = await call(base, "POST", "/wallets", { playerId: "p\u0000", initialBalance: { amount: "10.00", currency: "BRL" } });
    expect(nul.status).toBe(400);
    expect(nul.body.errors[0].field).toBe("playerId");
  });
});

describe("GET /wallets/:id", () => {
  it("200 for an existing wallet, 404 for an unknown one, 400 for a malformed id", async () => {
    const { walletId } = await newWallet("3.00");
    expect((await call(base, "GET", `/wallets/${walletId}`)).status).toBe(200);
    const missing = await call(base, "GET", `/wallets/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("WALLET_NOT_FOUND");
    expect((await call(base, "GET", "/wallets/not-a-uuid")).status).toBe(400);
  });
});

describe("POST /wagering/transactions", () => {
  it("BET is applied: 200 with the new balance", async () => {
    const { walletId, playerId } = await newWallet("1000.00");
    const r = await postWager(base, { walletId, playerId, amount: "25.00" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "PROCESSED", balance: { amount: "975.00", currency: "BRL" }, idempotentReplay: false });
    expect(r.body.transactionId).toBeString();
    expect(await eventsOfTransaction(r.body.transactionId)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
    await expectWalletConsistent(db.app, walletId);
  });

  it("an identical request is a replay with the ORIGINAL result and balance", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const req = wagerBody({ walletId, playerId, amount: "10.00" });
    const first = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    await postWager(base, { walletId, playerId, amount: "5.00" }); // the balance moves on
    const again = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect(again.body.balance.amount).toBe("90.00");
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where wallet_id = ${walletId} and direction = 'DEBIT'`;
    expect(n.n).toBe(2);
  });

  it("same key with a different payload is a 409 conflict, never a replay", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const req = wagerBody({ walletId, playerId, amount: "10.00" });
    await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    const r = await call(
      base,
      "POST",
      "/wagering/transactions",
      { ...req.body, money: { amount: "11.00", currency: "BRL" } },
      { "Idempotency-Key": req.key },
    );
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH", retry: "NEVER" });
    expect((await walletOf(walletId)).balance.amount).toBe("90.00");
  });

  it("same externalTransactionId under another key is a 409 even with the same payload (the key is the source of truth)", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const req = wagerBody({ walletId, playerId, amount: "10.00" });
    const first = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    const same = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": "another-key" });
    expect(same.status).toBe(409);
    expect(same.body).toMatchObject({ code: "EXTERNAL_TRANSACTION_ID_CONFLICT", retry: "NEVER", transactionId: first.body.transactionId });
    const diff = await call(
      base,
      "POST",
      "/wagering/transactions",
      { ...req.body, money: { amount: "12.00", currency: "BRL" } },
      { "Idempotency-Key": "yet-another-key" },
    );
    expect(diff.status).toBe(409);
    expect(diff.body.code).toBe("EXTERNAL_TRANSACTION_ID_CONFLICT");
    expect((await walletOf(walletId)).balance.amount).toBe("90.00");
  });

  it("a key that only ever got a 409 is not bound to anything: reused for a new operation it processes once", async () => {
    // La-02: before, the second key got a replay of E1 without being recorded, so it could later
    // answer a different payload as a brand-new operation. Now it never answered a result.
    const { walletId, playerId } = await newWallet("100.00");
    const e1 = wagerBody({ walletId, playerId, amount: "10.00" });
    await call(base, "POST", "/wagering/transactions", e1.body, { "Idempotency-Key": e1.key });
    const k2 = `k2-${crypto.randomUUID()}`;
    expect((await call(base, "POST", "/wagering/transactions", e1.body, { "Idempotency-Key": k2 })).status).toBe(409);
    const e2 = wagerBody({ walletId, playerId, amount: "10.00" });
    const fresh = await call(base, "POST", "/wagering/transactions", e2.body, { "Idempotency-Key": k2 });
    expect(fresh.status).toBe(200);
    expect(fresh.body.idempotentReplay).toBe(false);
    const again = await call(base, "POST", "/wagering/transactions", e2.body, { "Idempotency-Key": k2 });
    expect(again.body).toMatchObject({ transactionId: fresh.body.transactionId, idempotentReplay: true });
    expect((await walletOf(walletId)).balance.amount).toBe("80.00");
  });

  it("a CURRENCY_MISMATCH rejection replays the wallet balance in the wallet currency (POST, replay and GET agree)", async () => {
    // La-01: result_balance was stored without its currency and rehydrated with the transaction's.
    const { walletId, playerId } = await newWallet("50.00");
    const req = wagerBody({ walletId, playerId, currency: "USD" });
    const r1 = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(r1.status).toBe(422);
    expect(r1.body.balance).toEqual({ amount: "50.00", currency: "BRL" });
    const r2 = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(r2.status).toBe(422);
    expect(r2.body.idempotentReplay).toBe(true);
    expect(r2.body.balance).toEqual(r1.body.balance);
    const g = await call(base, "GET", `/wagering/transactions/${r1.body.transactionId}`);
    expect(g.body.money).toEqual({ amount: "10.00", currency: "USD" });
    expect(g.body.balance).toEqual({ amount: "50.00", currency: "BRL" });
  });

  it("a credit that would pass the largest representable balance is a 422 BALANCE_LIMIT_EXCEEDED, not a 500", async () => {
    // H3: numeric(20,2) holds up to 999999999999999999.99; the sum used to reach Postgres as 22003.
    const { walletId, playerId } = await newWallet("999999999999999999.00");
    const win = await postWager(base, { walletId, playerId, kind: "WIN", amount: "1.00" });
    expect(win.status).toBe(422);
    expect(win.body).toMatchObject({ status: "REJECTED", failureCode: "BALANCE_LIMIT_EXCEEDED", retry: "NEVER" });
    expect(win.body.balance).toEqual({ amount: "999999999999999999.00", currency: "BRL" });
    const fits = await postWager(base, { walletId, playerId, kind: "WIN", amount: "0.99" });
    expect(fits.status).toBe(200);
    expect(fits.body.balance.amount).toBe("999999999999999999.99");
    await expectWalletConsistent(db.app, walletId);
  });

  it("insufficient funds is a 422 REJECTED, recorded, with no ledger entry; the replay is 422 too", async () => {
    const { walletId, playerId } = await newWallet("10.00");
    const req = wagerBody({ walletId, playerId, amount: "10.01" });
    const r = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      retry: "NEVER",
      balance: { amount: "10.00", currency: "BRL" },
      idempotentReplay: false,
    });
    const again = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(again.status).toBe(422);
    expect(again.body.idempotentReplay).toBe(true);
    const [n] = await db.app`select count(*)::int as n from wallet_ledger_entries where transaction_id = ${r.body.transactionId}`;
    expect(n.n).toBe(0);
    expect(await outboxTypes([r.body.transactionId])).toEqual(["WagerTransactionRejected"]);
  });

  it("LOSS is 200 without moving the balance; WIN credits", async () => {
    const { walletId, playerId } = await newWallet("50.00");
    const loss = await postWager(base, { walletId, playerId, kind: "LOSS", amount: "20.00" });
    expect(loss.status).toBe(200);
    expect(loss.body.balance.amount).toBe("50.00");
    expect((await walletOf(walletId)).version).toBe(1);
    expect(await outboxTypes([loss.body.transactionId])).toEqual(["WagerTransactionProcessed"]);
    const win = await postWager(base, { walletId, playerId, kind: "WIN", amount: "70.00" });
    expect(win.status).toBe(200);
    expect(win.body.balance.amount).toBe("120.00");
    expect((await walletOf(walletId)).version).toBe(2);
    await expectWalletConsistent(db.app, walletId);
  });

  it("currency and player conflicts are business rejections (422)", async () => {
    const { walletId, playerId } = await newWallet("50.00");
    const cur = await postWager(base, { walletId, playerId, currency: "USD" });
    expect(cur.status).toBe(422);
    expect(cur.body.failureCode).toBe("CURRENCY_MISMATCH");
    const player = await postWager(base, { walletId, playerId: "someone-else" });
    expect(player.status).toBe(422);
    expect(player.body.failureCode).toBe("PLAYER_WALLET_MISMATCH");
  });

  it("Lc-03: a control character in the GET-by-external-id path is a 400, never a 503 'retry the same'", async () => {
    const bad = await call(base, "GET", "/providers/provider-a/wagering/transactions/tx%00x");
    expect(bad.status).toBe(400);
    expect(bad.body.retry).toBe("AFTER_FIX");
    const badProvider = await call(base, "GET", "/providers/bad%00provider/wagering/transactions/tx-1");
    expect(badProvider.status).toBe(400);
    const tooLong = await call(base, "GET", `/providers/provider-a/wagering/transactions/${"x".repeat(129)}`);
    expect(tooLong.status).toBe(400);
    const unknown = await call(base, "GET", "/providers/provider-a/wagering/transactions/never-sent");
    expect(unknown.status).toBe(404);
  });

  it("unknown wallet is a 404 and nothing is recorded", async () => {
    const walletId = crypto.randomUUID();
    const req = wagerBody({ walletId, playerId: "p" });
    const r = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("WALLET_NOT_FOUND");
    const [n] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${req.key}`;
    expect(n.n).toBe(0);
  });

  it("validation errors are 400 with field errors, and nothing is recorded", async () => {
    const { walletId, playerId } = await newWallet("50.00");
    const req = wagerBody({ walletId, playerId });
    const noKey = await call(base, "POST", "/wagering/transactions", req.body);
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe("MISSING_IDEMPOTENCY_KEY");
    const opening = await call(base, "POST", "/wagering/transactions", { ...req.body, kind: "OPENING" }, { "Idempotency-Key": req.key });
    expect(opening.status).toBe(400);
    expect(opening.body.code).toBe("FORBIDDEN_KIND");
    const malformed = await call(base, "POST", "/wagering/transactions", "{not json", { "Idempotency-Key": req.key });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("VALIDATION_ERROR");
    const amount = await call(base, "POST", "/wagering/transactions", { ...req.body, money: { amount: "1e3", currency: "BRL" } }, { "Idempotency-Key": req.key });
    expect(amount.status).toBe(400);
    expect(amount.body).toMatchObject({ code: "INVALID_AMOUNT", retry: "AFTER_FIX" });
    expect(amount.body.errors[0].field).toBe("money.amount");
    // a NUL byte would be refused by Postgres (22021): a 400 at the edge, never a 503 "retry"
    const nul = await call(base, "POST", "/wagering/transactions", { ...req.body, roundId: "round\u0000x" }, { "Idempotency-Key": req.key });
    expect(nul.status).toBe(400);
    expect(nul.body).toMatchObject({ code: "VALIDATION_ERROR", retry: "AFTER_FIX" });
    expect(nul.body.errors[0].field).toBe("roundId");
    // the same key is still free: the corrected request goes through
    const ok = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(ok.status).toBe(200);
  });
});

describe("queries", () => {
  it("GET a transaction by id and by provider + external id, in any status", async () => {
    const { walletId, playerId } = await newWallet("5.00");
    const rejected = await postWager(base, { walletId, playerId, amount: "6.00", externalTransactionId: "ext-q-1" });
    const byId = await call(base, "GET", `/wagering/transactions/${rejected.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({
      transactionId: rejected.body.transactionId,
      providerId: "provider-a",
      externalTransactionId: "ext-q-1",
      walletId,
      kind: "BET",
      status: "REJECTED",
      failureCode: "INSUFFICIENT_FUNDS",
      money: { amount: "6.00", currency: "BRL" },
    });
    const byExt = await call(base, "GET", "/providers/provider-a/wagering/transactions/ext-q-1");
    expect(byExt.status).toBe(200);
    expect(byExt.body.transactionId).toBe(rejected.body.transactionId);
    expect((await call(base, "GET", `/wagering/transactions/${crypto.randomUUID()}`)).status).toBe(404);
    expect((await call(base, "GET", "/providers/provider-a/wagering/transactions/nope")).status).toBe(404);
  });

  it("ledger pages with a stable opaque cursor, newest first", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    for (let i = 0; i < 5; i++) await postWager(base, { walletId, playerId, amount: "1.00" });
    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q: string = cursor ? `?limit=2&cursor=${encodeURIComponent(cursor)}` : "?limit=2";
      const page = await call(base, "GET", `/wallets/${walletId}/ledger${q}`);
      expect(page.status).toBe(200);
      versions.push(...page.body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = page.body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(versions).toEqual([6, 5, 4, 3, 2, 1]);
    expect(pages).toBe(3);
    expect((await call(base, "GET", `/wallets/${walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await call(base, "GET", `/wallets/${walletId}/ledger?limit=500`)).status).toBe(400);
    // a version past the integer column is a bad cursor (400), never a database error (Ld-03)
    const cursorOf = (v: number) => Buffer.from(JSON.stringify({ v })).toString("base64url");
    expect((await call(base, "GET", `/wallets/${walletId}/ledger?cursor=${cursorOf(2147483647)}`)).status).toBe(200);
    for (const v of [2147483648, Number.MAX_SAFE_INTEGER]) {
      expect((await call(base, "GET", `/wallets/${walletId}/ledger?cursor=${cursorOf(v)}`)).status).toBe(400);
    }
  });
});

describe("atomicity and transient failures", () => {
  it("a failure injected right before COMMIT leaves nothing behind; the retry applies once", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const req = wagerBody({ walletId, playerId, amount: "30.00" });
    running.failpoints.set("usecase.before_commit", "throw");
    try {
      const r = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
      expect(r.status).toBe(500);
      expect(r.body.retry).toBe("SAME_REQUEST");
    } finally {
      running.failpoints.clear();
    }
    const [tx] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${req.key}`;
    const [out] = await db.app`select count(*)::int as n from outbox_messages where payload->'data'->>'walletId' = ${walletId}`;
    expect(tx.n).toBe(0);
    expect(out.n).toBe(2); // only the wallet opening events
    expect((await walletOf(walletId)).balance.amount).toBe("100.00");
    const retry = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
    expect(retry.status).toBe(200);
    expect(retry.body.idempotentReplay).toBe(false);
    expect((await walletOf(walletId)).balance.amount).toBe("70.00");
    await expectWalletConsistent(db.app, walletId);
  });

  it("a transient failure is a 503 with Retry-After and nothing recorded", async () => {
    const { walletId, playerId } = await newWallet("100.00");
    const req = wagerBody({ walletId, playerId });
    running.failpoints.set("usecase.before_commit", "transient");
    try {
      const r = await call(base, "POST", "/wagering/transactions", req.body, { "Idempotency-Key": req.key });
      expect(r.status).toBe(503);
      expect(r.headers.get("retry-after")).toBeTruthy();
      expect(r.body.retry).toBe("SAME_REQUEST");
    } finally {
      running.failpoints.clear();
    }
    const [tx] = await db.app`select count(*)::int as n from wager_transactions where idempotency_key = ${req.key}`;
    expect(tx.n).toBe(0);
  });
});
