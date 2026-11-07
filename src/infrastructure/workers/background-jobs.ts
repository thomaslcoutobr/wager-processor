import type { BeforeApplicationShutdown, OnApplicationBootstrap } from "@nestjs/common";
import type { HealthChecks } from "../../interfaces/http/health.controller";

export interface BackgroundJob {
  name: string;
  start(): void;
  /** Must wait for the work in flight (drain) before resolving. */
  stop(): Promise<void>;
}

/**
 * Starts the enabled background roles after boot and drains them on shutdown. Draining happens in
 * beforeApplicationShutdown on purpose: by onApplicationShutdown MikroORM may already have closed
 * the pool, and in-flight work would hit a closed pool (reproduced in the research).
 */
export class BackgroundJobs implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(
    private readonly jobs: BackgroundJob[],
    private readonly health: HealthChecks,
  ) {}

  onApplicationBootstrap(): void {
    for (const job of this.jobs) job.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.health.startDraining(); // readiness goes 503 first, so no new work is routed here
    await Promise.all(this.jobs.map((j) => j.stop()));
  }
}
