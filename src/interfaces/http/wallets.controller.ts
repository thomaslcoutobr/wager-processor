import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CreateWallet } from "../../application/create-wallet";
import { currentLogContext } from "../../application/log-context";
import { ReconcileWallet } from "../../application/reconcile-wallet";
import type { IdGenerator, ReadStore } from "../../application/ports";
import { CONTROL_CHARS, UUID_PATTERN } from "../../application/wager-command";
import { DomainValidationError } from "../../domain/errors";
import { Money } from "../../domain/money";
import { ProviderAuthGuard } from "./auth";
import { ledgerEntryView, walletView } from "./presenters";
import { ProblemException } from "./problem";
import { TOKENS } from "./tokens";

const LEDGER_DEFAULT_LIMIT = 50;
const LEDGER_MAX_LIMIT = 200;

export function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw ProblemException.validation("VALIDATION_ERROR", [{ field, code: "VALIDATION_ERROR", message: `${field} must be a UUID` }]);
  }
  return value.toLowerCase();
}

const MAX_WALLET_VERSION = 2_147_483_647;

/** Opaque, stable keyset cursor: base64url({"v": <wallet_version>}). */
export function encodeCursor(version: number): string {
  return Buffer.from(JSON.stringify({ v: version })).toString("base64url");
}

export function decodeCursor(cursor: string): number {
  try {
    const v = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown }).v;
    // wallet_version is an integer column: a version past it was never issued by us (Ld-03)
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_WALLET_VERSION) return v;
  } catch {
    // fall through
  }
  throw ProblemException.validation("VALIDATION_ERROR", [{ field: "cursor", code: "VALIDATION_ERROR", message: "invalid cursor" }]);
}

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(TOKENS.createWallet) private readonly createWallet: CreateWallet,
    @Inject(TOKENS.readStore) private readonly read: ReadStore,
    @Inject(TOKENS.ids) private readonly ids: IdGenerator,
    @Inject(TOKENS.reconcile) private readonly reconciler: ReconcileWallet,
  ) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const correlationId = currentLogContext()?.correlationId;
    const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const errors = [];
    const playerId = b.playerId;
    if (typeof playerId !== "string" || playerId.length < 1 || playerId.length > 64 || CONTROL_CHARS.test(playerId)) {
      errors.push({ field: "playerId", code: "VALIDATION_ERROR" as const, message: "playerId must have 1 to 64 characters, no control characters" });
    }
    let initialBalance: Money | undefined;
    const ib = b.initialBalance as Record<string, unknown> | undefined;
    try {
      initialBalance = Money.from({ amount: ib?.amount as string, currency: ib?.currency as string });
    } catch (e) {
      if (!(e instanceof DomainValidationError)) throw e;
      errors.push({ field: `initialBalance.${e.field?.split(".")[1] ?? "amount"}`, code: e.code, message: e.message });
    }
    if (errors.length > 0) throw ProblemException.validation(errors.length === 1 ? errors[0]!.code : "VALIDATION_ERROR", errors);

    const result = await this.createWallet.execute(
      { playerId: playerId as string, initialBalance: initialBalance! },
      { source: "http", correlationId: correlationId ?? this.ids.next() },
    );
    if (result.type === "exists") {
      throw ProblemException.conflict("WALLET_ALREADY_EXISTS", "this player already has a wallet in this currency", {
        walletId: result.walletId,
      });
    }
    return walletView(result.wallet);
  }

  /** consistent: false is still 200: a divergence is a result, not a request error. */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconcile(@Param("walletId") walletId: string) {
    const result = await this.reconciler.execute(requireUuid(walletId, "walletId"));
    if (!result) throw ProblemException.notFound("WALLET_NOT_FOUND", "wallet not found");
    return result;
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    const wallet = await this.read.findWallet(requireUuid(walletId, "walletId"));
    if (!wallet) throw ProblemException.notFound("WALLET_NOT_FOUND", "wallet not found");
    return walletView(wallet);
  }

  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor?: string, @Query("limit") limitRaw?: string) {
    const id = requireUuid(walletId, "walletId");
    const limit = limitRaw === undefined ? LEDGER_DEFAULT_LIMIT : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > LEDGER_MAX_LIMIT) {
      throw ProblemException.validation("VALIDATION_ERROR", [
        { field: "limit", code: "VALIDATION_ERROR", message: `limit must be an integer from 1 to ${LEDGER_MAX_LIMIT}` },
      ]);
    }
    const before = cursor ? decodeCursor(cursor) : undefined;
    const wallet = await this.read.findWallet(id);
    if (!wallet) throw ProblemException.notFound("WALLET_NOT_FOUND", "wallet not found");
    const entries = await this.read.listLedger(id, before, limit + 1);
    const page = entries.slice(0, limit);
    const last = page[page.length - 1];
    return {
      walletId: id,
      items: page.map(ledgerEntryView),
      nextCursor: entries.length > limit && last ? encodeCursor(last.walletVersion) : null,
    };
  }
}
