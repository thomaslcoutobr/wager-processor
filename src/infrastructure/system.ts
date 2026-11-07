import type { Clock, IdGenerator } from "../application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUIDv7: unique across instances and ordered in time (good for outbox ordering and B-tree locality). */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
