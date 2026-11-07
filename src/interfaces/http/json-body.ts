import { ProblemException, sendProblem, type HttpReply } from "./problem";

interface IncomingLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "end" | "error", cb: (err?: Error) => void): unknown;
  body?: unknown;
  url?: string;
}

/**
 * Own JSON body parser so a malformed or oversized body becomes the same problem+json 400/413 as
 * any other invalid input (instead of the framework's default error shape).
 */
export function jsonBody(limitBytes: number) {
  return (req: IncomingLike, res: HttpReply, next: (err?: unknown) => void): void => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limitBytes) {
        aborted = true;
        sendProblem(res, new ProblemException(413, "VALIDATION_ERROR", `body larger than ${limitBytes} bytes`, "AFTER_FIX"), req.url);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        req.body = undefined;
        return next();
      }
      try {
        req.body = JSON.parse(text);
      } catch {
        sendProblem(
          res,
          ProblemException.validation("VALIDATION_ERROR", [{ field: "body", code: "VALIDATION_ERROR", message: "body is not valid JSON" }]),
          req.url,
        );
        return;
      }
      next();
    });
    req.on("error", (err) => next(err));
  };
}
