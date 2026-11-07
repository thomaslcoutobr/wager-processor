import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { HttpReply } from "./problem";
import { TOKENS } from "./tokens";

export interface HealthCheck {
  name: string;
  check(): Promise<void>;
}

/** Readiness state: checks plus a "draining" flag flipped on SIGTERM. */
export class HealthChecks {
  private draining = false;

  constructor(
    private readonly checks: HealthCheck[],
    private readonly timeoutMs = 1_000,
  ) {}

  startDraining(): void {
    this.draining = true;
  }

  async ready(): Promise<{ ok: boolean; checks: Record<string, string> }> {
    const checks: Record<string, string> = {};
    if (this.draining) return { ok: false, checks: { shutdown: "draining" } };
    let ok = true;
    await Promise.all(
      this.checks.map(async (c) => {
        try {
          await Promise.race([
            c.check(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), this.timeoutMs)),
          ]);
          checks[c.name] = "ok";
        } catch (e) {
          ok = false;
          checks[c.name] = `fail: ${(e as Error).message}`.slice(0, 120);
        }
      }),
    );
    return { ok, checks };
  }
}

/** Open endpoints (no auth): liveness says the process runs; readiness says it can do work. */
@Controller("health")
export class HealthController {
  constructor(@Inject(TOKENS.health) private readonly health: HealthChecks) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) res: HttpReply) {
    const r = await this.health.ready();
    res.status(r.ok ? 200 : 503);
    return { status: r.ok ? "ok" : "unavailable", checks: r.checks };
  }
}
