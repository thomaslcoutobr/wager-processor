import { describe, expect, it } from "bun:test";
import { retryDelayS } from "../../src/infrastructure/messaging/sqs-consumer";

describe("consumer retry delay (R1-04: equal jitter, whole seconds)", () => {
  it("never retries at once while the ceiling is above zero, even when the random part is 0", () => {
    for (let n = 1; n <= 5; n++) expect(retryDelayS(n, 1_000, 30_000, () => 0)).toBeGreaterThanOrEqual(1);
  });

  it("keeps half of the exponential ceiling fixed and stays under the ceiling", () => {
    expect(retryDelayS(3, 1_000, 30_000, () => 0)).toBe(2); // ceiling 4 s → between 2 and 4
    expect(retryDelayS(3, 1_000, 30_000, () => 0.999)).toBe(4);
    expect(retryDelayS(10, 1_000, 30_000, () => 0.999)).toBe(30); // capped by the maximum
  });

  it("is zero only when the base is zero (the test setting)", () => {
    expect(retryDelayS(1, 0, 30_000, () => 0.5)).toBe(0);
  });
});
