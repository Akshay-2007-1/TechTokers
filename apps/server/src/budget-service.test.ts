import { describe, expect, it } from "vitest";
import { utilizationState } from "./budget-service.js";

describe("Resource Governance utilization", () => {
  it.each([
    [79, 100, "healthy"],
    [80, 100, "warning"],
    [99, 100, "warning"],
    [100, 100, "exhausted"],
    [0, null, "unlimited"],
  ] as const)("classifies %s of %s as %s", (used, limit, expected) => {
    expect(utilizationState(used, limit)).toBe(expected);
  });
});
