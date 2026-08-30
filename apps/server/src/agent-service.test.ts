import { lstat, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { RunCancelledError } from "./errors.js";
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

  it("runs against staging and leaves the persistent workspace unchanged pending approval", async () => {
    class StagingRunner extends FakeRunner {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "proposal.txt"), "staged", "utf8");
        await expect(readFile(path.join(request.workspacePath, ".env"), "utf8")).rejects.toThrow();
        return super.run(request);
      }
    }
    const runner = new StagingRunner();
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Staged" });
    await writeFile(path.join(agent.workspacePath, ".env"), "protected", "utf8");
    const { run } = await service.sendMessage(agent.id, "propose a file");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    expect(runner.requests[0]?.workspacePath).not.toBe(agent.workspacePath);
    await expect(readFile(path.join(agent.workspacePath, "proposal.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(agent.workspacePath, ".env"), "utf8")).resolves.toBe("protected");
  });

  it("auto-applies ordinary source edits in auto mode", async () => {
    class SourceRunner extends FakeRunner {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "hello.ts"), "export const hello = 'world';\n", "utf8");
        return super.run(request);
      }
    }
    const service = await makeService(new SourceRunner());
    const agent = await service.createAgent({ name: "Auto", workspaceApprovalMode: "auto" });
    const { run } = await service.sendMessage(agent.id, "write source");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    await expect(readFile(path.join(agent.workspacePath, "hello.ts"), "utf8")).resolves.toContain("world");
  });

  it("applies a pending staging change exactly once after approval", async () => {
    class StagingRunner extends FakeRunner {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "approved.txt"), "approved", "utf8");
        return super.run(request);
      }
    }
    const runner = new StagingRunner(); const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Approve" });
    const { run } = await service.sendMessage(agent.id, "propose");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    const staged = service.getWorkspaceChangeSet(agent.id, run.id).stagingPath;
    await service.decideWorkspaceChangeSet(agent.id, run.id, true);
    await expect(readFile(path.join(agent.workspacePath, "approved.txt"), "utf8")).resolves.toBe("approved");
    await expect(lstat(staged)).rejects.toThrow();
    await expect(service.decideWorkspaceChangeSet(agent.id, run.id, true)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("denies a pending change without touching the persistent workspace", async () => {
    class StagingRunner extends FakeRunner {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "denied.txt"), "denied", "utf8");
        return super.run(request);
      }
    }
    const runner = new StagingRunner(); const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Deny" });
    const { run } = await service.sendMessage(agent.id, "propose");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    await service.decideWorkspaceChangeSet(agent.id, run.id, false);
    await expect(readFile(path.join(agent.workspacePath, "denied.txt"), "utf8")).rejects.toThrow();
    const next = await service.sendMessage(agent.id, "try again");
    await expect.poll(() => service.getRun(next.run.id).status).toBe("awaiting_approval");
    expect(runner.requests.at(-1)?.prompt).toContain("previous proposed workspace changes were denied");
  });

  it("requires a pending workspace proposal to be decided before the next Run", async () => {
    class StagingRunner extends FakeRunner {
      async run(request: RunnerRequest): Promise<RunnerResult> {
        await writeFile(path.join(request.workspacePath, "pending.ts"), "export {};\n", "utf8");
        return super.run(request);
      }
    }
    const service = await makeService(new StagingRunner());
    const agent = await service.createAgent({ name: "Pending" });
    const { run } = await service.sendMessage(agent.id, "propose");
    await expect.poll(() => service.getRun(run.id).status).toBe("awaiting_approval");
    await expect(service.sendMessage(agent.id, "continue")).rejects.toMatchObject({ statusCode: 409 });
    await service.decideWorkspaceChangeSet(agent.id, run.id, false);
    await expect(service.sendMessage(agent.id, "continue")).resolves.toBeDefined();
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
});
