import { Body, Controller, Get, Headers, Inject, Param, Post, Res, UseGuards } from "@nestjs/common";
import type { FailpointPort, IdGenerator, ReadStore } from "../../application/ports";
import { SubmitWagerTransaction } from "../../application/submit-wager-transaction";
import { parseWagerCommand } from "../../application/wager-command";
import { ProviderAuthGuard } from "./auth";
import { submitReply, transactionView } from "./presenters";
import { type HttpReply, ProblemException } from "./problem";
import { TOKENS } from "./tokens";
import { requireUuid } from "./wallets.controller";

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(TOKENS.submit) private readonly submit: SubmitWagerTransaction,
    @Inject(TOKENS.readStore) private readonly read: ReadStore,
    @Inject(TOKENS.ids) private readonly ids: IdGenerator,
    @Inject(TOKENS.failpoints) private readonly failpoints: FailpointPort,
  ) {}

  @Post("wagering/transactions")
  async post(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Res({ passthrough: true }) res: HttpReply,
  ) {
    const parsed = parseWagerCommand(body, idempotencyKey);
    if (!parsed.ok) throw ProblemException.validation(parsed.code, parsed.errors);

    const requestId = this.ids.next();
    const result = await this.submit.execute(parsed.command, {
      source: "http",
      correlationId: correlationId ?? requestId,
      causationId: requestId,
    });

    switch (result.type) {
      case "wallet_not_found":
        throw ProblemException.notFound("WALLET_NOT_FOUND", "wallet not found");
      case "conflict":
        throw ProblemException.conflict(
          result.code,
          result.code === "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH"
            ? "this Idempotency-Key was already used with a different payload"
            : "this externalTransactionId was already used with a different payload",
          { transactionId: result.transactionId },
        );
      case "decided": {
        if (!result.replay) await this.failpoints.hit("http.after_commit_before_response");
        const reply = submitReply(result.transaction, result.replay);
        res.status(reply.status);
        for (const [k, v] of Object.entries(reply.headers)) res.setHeader(k, v);
        return reply.body;
      }
      default:
        // inbox outcomes only exist on the queue path
        throw new Error(`unexpected result ${result.type} on HTTP`);
    }
  }

  @Get("wagering/transactions/:transactionId")
  async get(@Param("transactionId") transactionId: string) {
    const t = await this.read.findTransactionById(requireUuid(transactionId, "transactionId"));
    if (!t) throw ProblemException.notFound("TRANSACTION_NOT_FOUND", "transaction not found");
    return transactionView(t);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternalId(@Param("providerId") providerId: string, @Param("externalTransactionId") externalId: string) {
    const t = await this.read.findTransactionByExternalId(providerId, externalId);
    if (!t) throw ProblemException.notFound("TRANSACTION_NOT_FOUND", "transaction not found");
    return transactionView(t);
  }
}
