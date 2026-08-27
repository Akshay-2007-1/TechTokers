import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  calls = 0;

  async run(request: RunnerRequest): Promise<RunnerResult> {
    this.calls += 1;
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
      rm(directory, { recursive: true, force: true }),
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
      event: "budget.run_denied",
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
});
