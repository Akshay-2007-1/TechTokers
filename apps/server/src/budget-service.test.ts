import { describe, expect, it } from "vitest";
import {
  recordRuntimeTermination,
  resourceLimits,
  runtimeTerminationMessage,
  utilizationState,
} from "./budget-service.js";
import type { Agent, AgentRun, Database } from "./types.js";

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

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    name: "A",
    description: "",
    instructions: "",
    budgetPolicy: { maxRuns: null, maxTotalTokens: null },
    maxPromptChars: null,
    runtimeLimits: { maxRunDurationMs: null, maxRunOutputBytes: null },
    status: "ready",
    workspacePath: "/tmp/a",
    codexThreadId: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Runtime governance", () => {
  it("surfaces the runtime limits in the applied-limits contract", () => {
    const agent = fakeAgent({ runtimeLimits: { maxRunDurationMs: 30_000, maxRunOutputBytes: 2048 } });
    expect(resourceLimits(agent)).toMatchObject({
      maxRunDurationMs: 30_000,
      maxRunOutputBytes: 2048,
    });
  });

  it("records a redacted termination event with the offending limit", () => {
    const agent = fakeAgent();
    const run: AgentRun = {
      id: "run-1",
      agentId: agent.id,
      status: "terminated",
      prompt: "a secret-looking prompt",
      output: null,
      error: null,
      usage: { inputTokens: 10, outputTokens: 2 },
      budgetReserved: true,
      runtimeInvoked: true,
      terminationReason: "output_exceeded",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:09.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const database: Database = {
      version: 1,
      agents: [agent],
      messages: [],
      runs: [run],
      governanceEvents: [],
    };

    recordRuntimeTermination(
      database,
      agent,
      run,
      { reason: "output_exceeded", limit: 4096, observed: 9000 },
      "2026-01-01T00:00:09.000Z",
    );

    const [event] = database.governanceEvents;
    expect(event).toMatchObject({
      agentId: agent.id,
      runId: run.id,
      event: "resource_governance.run_terminated",
      runtimeInvoked: true,
      actualTokensConsumed: 12,
      runtimeTermination: { reason: "output_exceeded", limit: 4096, observed: 9000 },
    });
    expect(JSON.stringify(event)).not.toContain("secret-looking");
  });

  it("phrases the two termination reasons for the operator", () => {
    expect(
      runtimeTerminationMessage({ reason: "duration_exceeded", limit: 10_000, observed: 10_400 }),
    ).toContain("10000 ms per-Run time limit");
    expect(
      runtimeTerminationMessage({ reason: "output_exceeded", limit: 4096, observed: 9000 }),
    ).toContain("4096 byte per-Run output limit");
  });
});
