import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "./job-state-machine.js";

describe("job state machine", () => {
  it("allows normal workflow transitions", () => {
    expect(canTransition("QUEUED", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "NEEDS_REVIEW")).toBe(true);
    expect(canTransition("FAILED", "QUEUED")).toBe(true);
  });

  it("does not restart a completed job", () => {
    expect(canTransition("COMPLETED", "RUNNING")).toBe(false);
    expect(() => assertTransition("COMPLETED", "RUNNING")).toThrow(/Invalid job status transition/);
  });
});
