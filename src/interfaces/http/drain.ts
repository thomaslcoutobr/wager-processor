import { ProblemException, sendProblem, type HttpReply } from "./problem";

interface Req {
  url?: string;
}
interface Res extends HttpReply {
  on(event: "finish" | "close", cb: () => void): unknown;
}

const OPEN_PATHS = new Set(["/health/live", "/health/ready", "/metrics"]);

/**
 * HTTP side of a graceful shutdown. Once draining:
 *  - new business requests get 503 SERVICE_UNAVAILABLE + Retry-After (the provider re-sends the same
 *    request elsewhere; the load balancer already stopped routing here because readiness is 503);
 *  - every response carries `Connection: close`, so keep-alive clients let go of this instance;
 *  - requests already in flight finish normally; `waitIdle` resolves when the last one ends.
 * Without this, a client that keeps reusing keep-alive connections holds server.close() open.
 */
export class HttpDrain {
  private inFlight = 0;
  private draining = false;
  private waiters: Array<() => void> = [];

  middleware() {
    return (req: Req, res: Res, next: () => void): void => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (this.draining) {
        res.setHeader("Connection", "close");
        if (!OPEN_PATHS.has(path)) {
          sendProblem(
            res,
            new ProblemException(503, "SERVICE_UNAVAILABLE", "instance is shutting down", "SAME_REQUEST", {}, { "Retry-After": "1" }),
            req.url,
          );
          return;
        }
      }
      this.inFlight++;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        this.inFlight--;
        if (this.inFlight === 0) for (const w of this.waiters.splice(0)) w();
      };
      res.on("finish", end);
      res.on("close", end);
      next();
    };
  }

  start(): void {
    this.draining = true;
  }

  /** true when every in-flight request finished, false if the timeout came first. */
  waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
