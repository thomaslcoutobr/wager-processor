import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from "@nestjs/common";
import { RetryableConflictError, TransientError } from "../../application/errors";
import type { FieldError } from "../../application/wager-command";
import { DomainValidationError } from "../../domain/errors";

/** What the provider should do next; with the HTTP code this is enough to decide without reading prose. */
export type RetryHint = "NEVER" | "AFTER_FIX" | "SAME_REQUEST" | "POLL";

export interface HttpReply {
  status(code: number): HttpReply;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/** RFC 9457 problem with the `code` and `retry` extensions. */
export class ProblemException extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly retry: RetryHint,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
    this.name = "ProblemException";
  }

  static validation(code: string, errors: FieldError[]): ProblemException {
    return new ProblemException(400, code, "the request is invalid", "AFTER_FIX", { errors });
  }

  static notFound(code: string, detail: string): ProblemException {
    return new ProblemException(404, code, detail, "AFTER_FIX");
  }

  static conflict(code: string, detail: string, extra: Record<string, unknown> = {}): ProblemException {
    return new ProblemException(409, code, detail, "NEVER", extra);
  }
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

export function toProblem(exception: unknown): ProblemException {
  if (exception instanceof ProblemException) return exception;
  if (exception instanceof DomainValidationError) {
    return ProblemException.validation(exception.code, [
      { field: exception.field ?? "body", code: exception.code, message: exception.message },
    ]);
  }
  if (exception instanceof TransientError) {
    return new ProblemException(503, exception.code, exception.message, "SAME_REQUEST", {}, { "Retry-After": "1" });
  }
  if (exception instanceof RetryableConflictError) {
    return new ProblemException(503, "CONCURRENCY_RETRY_EXHAUSTED", exception.message, "SAME_REQUEST", {}, { "Retry-After": "1" });
  }
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status === 404) return new ProblemException(404, "NOT_FOUND", "no such route", "NEVER");
    if (status < 500) return new ProblemException(status, "VALIDATION_ERROR", exception.message, "AFTER_FIX");
  }
  // anything else, including DatabaseInvariantError (the schema refused something validation and the
  // domain should have stopped): a bug, the transaction rolled back, nothing was written
  return new ProblemException(500, "INTERNAL_ERROR", "unexpected processing error", "SAME_REQUEST");
}

export function sendProblem(res: HttpReply, p: ProblemException, instance?: string): void {
  for (const [k, v] of Object.entries(p.headers)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/problem+json");
  res.status(p.status).send(
    JSON.stringify({
      type: `urn:wager-processor:problem:${p.code}`,
      title: TITLES[p.status] ?? "Error",
      status: p.status,
      detail: p.detail,
      instance,
      code: p.code,
      retry: p.retry,
      ...p.extra,
    }),
  );
}

export type ErrorReporter = (error: unknown, problem: ProblemException) => void;

@Catch()
export class ProblemFilter implements ExceptionFilter {
  constructor(private readonly report: ErrorReporter = () => {}) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<HttpReply>();
    const req = http.getRequest<{ url?: string }>();
    const problem = toProblem(exception);
    if (problem.status >= 500) this.report(exception, problem);
    sendProblem(res, problem, req.url);
  }
}
