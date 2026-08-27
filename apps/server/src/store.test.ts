import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

describe("JsonStore", () => {
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("backfills collections and budget fields from a pre-budget database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [{ id: "a1", name: "Legacy", status: "ready" }],
        runs: [
          { id: "r-started", agentId: "a1", status: "completed", startedAt: "2026-01-01T00:00:00.000Z" },
          { id: "r-queued", agentId: "a1", status: "queued", startedAt: null },
        ],
        // no `messages`, no `budgetEvents`
      }),
      "utf8",
    );

    const store = new JsonStore(filePath);
    await store.initialize();
    const data = store.snapshot();

    expect(data.messages).toEqual([]);
    expect(data.budgetEvents).toEqual([]);
    expect(data.agents[0]?.budgetPolicy).toEqual({ maxRuns: null, maxTotalTokens: null });
    expect(data.runs.find((run) => run.id === "r-started")).toMatchObject({
      budgetReserved: true,
      runtimeInvoked: true,
    });
    expect(data.runs.find((run) => run.id === "r-queued")).toMatchObject({
      budgetReserved: false,
      runtimeInvoked: false,
    });
  });

  it("loads a database file that omits the runs array without crashing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify({ version: 1, agents: [] }), "utf8");

    const store = new JsonStore(filePath);
    await expect(store.initialize()).resolves.toBeUndefined();
    expect(store.snapshot()).toEqual({
      version: 1,
      agents: [],
      messages: [],
      runs: [],
      budgetEvents: [],
    });
  });
});
