import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { RunCancelledError, RuntimeLimitError } from "./errors.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  calls = 0;
  readonly requests: RunnerRequest[] = [];

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
    this.requests.push(request);
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 5 },
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      // A completed Run can still be flushing its final JsonStore write when the
      // test returns; retry so that late write does not fail the parent rmdir
      // with ENOTEMPTY.
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({ output: "done", threadId: "thread", usage: null });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("keeps Agents without a budget policy unlimited", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Unlimited" });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const second = await service.sendMessage(agent.id, "second");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
    expect(runner.calls).toBe(2);
    expect(service.getBudget(agent.id)).toMatchObject({
      runsUsed: 2,
      tokensUsed: 34,
      policy: { maxRuns: null, maxTotalTokens: null },
    });
    expect(service.getBudgetEvents(agent.id)).toContainEqual(
      expect.objectContaining({
        event: "resource_governance.usage_reconciled",
        actualTokensConsumed: 17,
        runtimeInvoked: true,
      }),
    );
  });

  it("denies a Run before Runtime invocation when maxRuns is exhausted", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Run limited",
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const denied = await service.sendMessage(agent.id, "second");
    expect(denied.run).toMatchObject({
      status: "denied",
      runtimeInvoked: false,
      budgetReserved: false,
    });
    expect(denied.run.error).toContain("1 of 1 Runs used");
    expect(runner.calls).toBe(1);
    expect(service.getBudget(agent.id)).toMatchObject({ runsUsed: 1, tokensUsed: 17 });
    const events = service.getBudgetEvents(agent.id);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      runId: denied.run.id,
      event: "resource_governance.admission",
      decision: "deny",
      reason: "run_limit_exhausted",
      runtimeInvoked: false,
    });
    expect(JSON.stringify(events)).not.toContain("second");
  });

  it("uses persisted input plus output tokens for future admission", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Token limited",
      budgetPolicy: { maxRuns: null, maxTotalTokens: 17 },
    });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const denied = await service.sendMessage(agent.id, "second");
    expect(denied.run.error).toContain("17 of 17 tokens used");
    expect(runner.calls).toBe(1);
    expect(service.getBudget(agent.id).tokensUsed).toBe(17);
  });

  it("counts a Runtime-invoking failure against maxRuns", async () => {
    const runner: AgentRunner = {
      run: async () => {
        throw new Error("Runtime failed after invocation");
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Failure limited",
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("failed");
    const denied = await service.sendMessage(agent.id, "second");
    expect(denied.run.status).toBe("denied");
    expect(service.getBudget(agent.id).runsUsed).toBe(1);
  });

  it("atomically reserves the final Run slot under concurrent requests", async () => {
    let finish!: (value: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: async () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Concurrent budget",
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(service.getBudget(agent.id).runsUsed).toBe(1);
    finish({ output: "done", threadId: "thread", usage: { outputTokens: 1 } });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("isolates usage by Agent and applies edited budgets to later Runs", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const first = await service.createAgent({
      name: "First",
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    const second = await service.createAgent({ name: "Second" });
    const firstRun = await service.sendMessage(first.id, "first");
    await expect.poll(() => service.getRun(firstRun.run.id).status).toBe("completed");
    const secondRun = await service.sendMessage(second.id, "second");
    await expect.poll(() => service.getRun(secondRun.run.id).status).toBe("completed");
    expect((await service.sendMessage(first.id, "blocked")).run.status).toBe("denied");
    await service.updateAgent(second.id, {
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    expect((await service.sendMessage(second.id, "blocked after edit")).run.status).toBe("denied");
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({ output: "done", threadId: "thread", usage: null });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("allows a prompt at an Agent's exact limit", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Prompt limited",
      maxPromptChars: 5,
    });

    const { run } = await service.sendMessage(agent.id, "12345");

    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.requests).toHaveLength(1);
  });

  it("rejects an over-limit prompt before invoking Codex", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Prompt limited",
      maxPromptChars: 5,
    });

    await expect(service.sendMessage(agent.id, "123456")).rejects.toMatchObject({
      statusCode: 422,
    });

    expect(runner.requests).toHaveLength(0);
    expect(service.getRuns(agent.id)).toHaveLength(0);
    expect(service.getMessages(agent.id)).toHaveLength(0);
    const events = service.getBudgetEvents(agent.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: agent.id,
      decision: "deny",
      reason: "input_too_large",
      runtimeInvoked: false,
      observedUsage: { inputCharacters: 6 },
      appliedLimits: { maxInputCharacters: 5 },
    });
    expect(JSON.stringify(events)).not.toContain("123456");
  });

  it("uses the unified contract for every admission reason", async () => {
    const service = await makeService();
    const unlimited = await service.createAgent({ name: "Unlimited" });
    const inputLimited = await service.createAgent({ name: "Input", maxPromptChars: 1 });
    const runLimited = await service.createAgent({
      name: "Runs",
      budgetPolicy: { maxRuns: 0, maxTotalTokens: null },
    });
    const tokenLimited = await service.createAgent({
      name: "Tokens",
      budgetPolicy: { maxRuns: null, maxTotalTokens: 0 },
    });

    const admitted = await service.sendMessage(unlimited.id, "ok");
    await expect.poll(() => service.getRun(admitted.run.id).status).toBe("completed");
    await expect(service.sendMessage(inputLimited.id, "too large")).rejects.toMatchObject({
      statusCode: 422,
    });
    await service.sendMessage(runLimited.id, "blocked");
    await service.sendMessage(tokenLimited.id, "blocked");

    expect(service.getBudgetEvents(unlimited.id).some((event) => event.reason === "within_limits")).toBe(true);
    expect(service.getBudgetEvents(inputLimited.id).some((event) => event.reason === "input_too_large")).toBe(true);
    expect(service.getBudgetEvents(runLimited.id).some((event) => event.reason === "run_limit_exhausted")).toBe(true);
    expect(service.getBudgetEvents(tokenLimited.id).some((event) => event.reason === "token_budget_exhausted")).toBe(true);
  });

  it("records a policy update without prompts or credentials", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Evidence" });
    await service.updateAgent(agent.id, {
      maxPromptChars: 25,
      budgetPolicy: { maxRuns: 2, maxTotalTokens: 50 },
    });
    const event = service.getBudgetEvents(agent.id)[0];
    expect(event).toMatchObject({
      event: "resource_governance.policy_updated",
      reason: "policy_updated",
      actor: "local_operator",
      previousLimits: { maxRuns: null, maxTotalTokens: null, maxInputCharacters: null },
      appliedLimits: { maxRuns: 2, maxTotalTokens: 50, maxInputCharacters: 25 },
    });
    expect(JSON.stringify(event)).not.toContain("test-key");
  });

  it("counts a cancelled admitted Run against the Run limit", async () => {
    let rejectRun!: (reason: Error) => void;
    const runner: AgentRunner = {
      run: () => new Promise<RunnerResult>((_resolve, reject) => { rejectRun = reject; }),
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Cancelled",
      budgetPolicy: { maxRuns: 1, maxTotalTokens: null },
    });
    const first = await service.sendMessage(agent.id, "first");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("running");
    await service.stopAgent(agent.id);
    expect(service.getRun(first.run.id).status).toBe("cancelled");
    await service.startAgent(agent.id);
    expect((await service.sendMessage(agent.id, "second")).run.status).toBe("denied");
  });

  it("passes the Agent's runtime limits to the Runner", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Bounded runtime",
      runtimeLimits: { maxRunDurationMs: 15_000, maxRunOutputBytes: 65_536 },
    });
    const { run } = await service.sendMessage(agent.id, "do work");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.requests.at(-1)?.limits).toMatchObject({
      durationMs: 15_000,
      outputBytes: 65_536,
    });
  });

  it("passes per-Agent container resource caps to the Runner", async () => {
    const runner = new FakeRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Capped compute",
      runtimeLimits: {
        maxRunDurationMs: null,
        maxRunOutputBytes: null,
        maxRunCpus: 0.5,
        maxRunMemoryMb: 512,
        maxRunProcesses: 64,
      },
    });
    const { run } = await service.sendMessage(agent.id, "do work");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(runner.requests.at(-1)?.limits).toMatchObject({
      cpus: 0.5,
      memoryMb: 512,
      processes: 64,
    });
  });

  it("force-terminates the active Run and stops the Agent on operator kill", async () => {
    let rejectRun!: (reason: Error) => void;
    const runner: AgentRunner = {
      run: () => new Promise<RunnerResult>((_resolve, reject) => { rejectRun = reject; }),
      cancel: async () => {
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Rogue" });
    const { run } = await service.sendMessage(agent.id, "go rogue");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    const killed = await service.killAgent(agent.id);
    expect(killed.status).toBe("stopped");
    expect(service.getRun(run.id).status).toBe("terminated");
    expect(service.getRun(run.id).terminationReason).toBe("operator_kill");
    const events = service.getBudgetEvents(agent.id);
    expect(events.some((event) => event.event === "resource_governance.run_terminated")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("go rogue");
  });

  it("records a control-plane operator_kill event when no Run is in progress", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Idle" });
    const killed = await service.killAgent(agent.id);
    expect(killed.status).toBe("stopped");
    const events = service.getBudgetEvents(agent.id);
    expect(events[0]).toMatchObject({
      event: "resource_governance.operator_kill",
      reason: "operator_kill",
      runId: null,
      runtimeInvoked: false,
      actor: "local_operator",
    });
    // Not a runtime termination: no Run linkage, no runtimeTermination detail.
    expect(events[0]?.runtimeTermination).toBeUndefined();
    expect(events.some((event) => event.event === "resource_governance.run_terminated")).toBe(false);
  });

  it("auto-quarantines an Agent after repeated runtime terminations", async () => {
    const runner: AgentRunner = {
      run: async () => {
        throw new RuntimeLimitError("duration_exceeded", 1_000, 1_100);
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Runaway",
      runtimeLimits: {
        maxRunDurationMs: 1_000,
        maxRunOutputBytes: null,
        maxRunCpus: null,
        maxRunMemoryMb: null,
        maxRunProcesses: null,
      },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { run } = await service.sendMessage(agent.id, "loop " + attempt);
      await expect.poll(() => service.getRun(run.id).status).toBe("terminated");
      if (service.getAgent(agent.id).status === "stopped") break;
      await service.startAgent(agent.id);
    }

    expect(service.getAgent(agent.id).status).toBe("stopped");
    expect(service.getAgent(agent.id).lastError).toContain("Auto-quarantined");
    const events = service.getBudgetEvents(agent.id);
    const quarantineEvent = events.find(
      (event) => event.event === "resource_governance.agent_quarantined",
    );
    expect(quarantineEvent).toBeDefined();
    // Automatic action: the actor is the system, not an operator.
    expect(quarantineEvent?.actor).toBe("system");

    // An operator can clear the quarantine by starting the Agent again.
    const restarted = await service.startAgent(agent.id);
    expect(restarted.status).toBe("ready");
    expect(restarted.lastError).toBeNull();
  });

  it("marks a runtime-terminated Run and lets a later Run proceed", async () => {
    let killRun = true;
    const runner: AgentRunner = {
      run: async () => {
        if (killRun) {
          killRun = false;
          throw new RuntimeLimitError("duration_exceeded", 10_000, 10_050);
        }
        return { output: "recovered", threadId: "thread", usage: { outputTokens: 3 } };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({
      name: "Runaway",
      runtimeLimits: { maxRunDurationMs: 10_000, maxRunOutputBytes: null },
    });

    const first = await service.sendMessage(agent.id, "loop forever");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("terminated");
    const terminated = service.getRun(first.run.id);
    expect(terminated.terminationReason).toBe("duration_exceeded");
    expect(terminated.error).toContain("10000 ms");
    // Containment, not an Agent fault: the Agent is usable again immediately.
    expect(service.getAgent(agent.id).status).toBe("ready");
    expect(service.getAgent(agent.id).lastError).toBeNull();

    const events = service.getBudgetEvents(agent.id);
    const terminationEvent = events.find(
      (event) => event.event === "resource_governance.run_terminated",
    );
    expect(terminationEvent).toMatchObject({
      reason: "run_terminated",
      runtimeInvoked: true,
      runtimeTermination: { reason: "duration_exceeded", limit: 10_000, observed: 10_050 },
    });
    expect(JSON.stringify(events)).not.toContain("loop forever");

    const second = await service.sendMessage(agent.id, "small safe task");
    await expect.poll(() => service.getRun(second.run.id).status).toBe("completed");
  });
});
