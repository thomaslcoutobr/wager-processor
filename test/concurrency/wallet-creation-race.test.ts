import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { call, gate, type RunningApp, startApp } from "../helpers/app";
import { createTestDb, expectWalletConsistent, type TestDb } from "../helpers/test-db";

let db: TestDb;
let running: RunningApp;
let base: string;

beforeAll(async () => {
  db = await createTestDb("walletrace");
  running = await startApp(db);
  base = running.baseUrl;
});
afterAll(async () => {
  await running?.close();
  await db?.drop();
});

const ROUNDS = 10;
const PARALLEL = 10;

describe("POST /wallets racing for the same player and currency (section 6.2)", () => {
  it(`${PARALLEL} simultaneous creations: one 201, the others 409 with the winner's id, one wallet (${ROUNDS} rounds)`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const playerId = crypto.randomUUID();
      const g = gate();
      const all = Array.from({ length: PARALLEL }, async () => {
        await g.wait;
        return call(base, "POST", "/wallets", { playerId, initialBalance: { amount: "10.00", currency: "BRL" } });
      });
      g.open();
      const results = await Promise.all(all);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, ...Array(PARALLEL - 1).fill(409)]);
      const winner = results.find((r) => r.status === 201)!.body.id as string;
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body).toMatchObject({ code: "WALLET_ALREADY_EXISTS", walletId: winner });
      }
      const [n] = await db.app`select count(*)::int as n from wallets where player_id = ${playerId}`;
      expect(n.n).toBe(1);
      const [opening] = await db.app`select count(*)::int as n from wager_transactions where wallet_id = ${winner}`;
      expect(opening.n).toBe(1);
      await expectWalletConsistent(db.app, winner);
    }
  });
});
