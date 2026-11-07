import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { PromMetrics } from "../../infrastructure/observability/metrics";
import type { HttpReply } from "./problem";
import { TOKENS } from "./tokens";

@Controller("metrics")
export class MetricsController {
  constructor(@Inject(TOKENS.metrics) private readonly metrics: PromMetrics) {}

  @Get()
  async scrape(@Res() res: HttpReply) {
    res.setHeader("Content-Type", this.metrics.registry.contentType);
    res.status(200).send(await this.metrics.registry.metrics());
  }
}
