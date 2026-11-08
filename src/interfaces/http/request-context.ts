import { currentLogContext, type LogFn, withLogContext } from "../../application/log-context";
import type { IdGenerator } from "../../application/ports";

interface Req {
  method?: string;
  url?: string;
  path?: string;
  route?: { path?: string };
  headers: Record<string, string | string[] | undefined>;
}
interface Res {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: "finish", cb: () => void): unknown;
}

const CORRELATION = /^[A-Za-z0-9._:-]{1,128}$/;
const QUIET = new Set(["/health/live", "/health/ready", "/metrics"]);

/**
 * Opens the log context of a request: X-Correlation-Id (accepted when well-formed, else generated,
 * always echoed back) and a request id. Logs one line per request: method, route, status, duration.
 */
export function requestContext(ids: IdGenerator, log: LogFn) {
  return (req: Req, res: Res, next: () => void): void => {
    const header = req.headers["x-correlation-id"];
    const correlationId = typeof header === "string" && CORRELATION.test(header) ? header : ids.next();
    res.setHeader("X-Correlation-Id", correlationId);
    const started = performance.now();
    withLogContext({ correlationId, requestId: ids.next() }, () => {
      const store = currentLogContext()!;
      res.on("finish", () => {
        const path = (req.url ?? "").split("?")[0] ?? "";
        const fields = {
          method: req.method,
          route: req.route?.path ?? path,
          status: res.statusCode,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        };
        withLogContext(store, () => log(QUIET.has(path) ? "debug" : "info", "request", fields));
      });
      next();
    });
  };
}
