import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  governanceEvents: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Database;
      if (parsed.version !== 1 || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      const parsedRuns = Array.isArray(parsed.runs) ? parsed.runs : [];
      this.data = {
        ...emptyDatabase(),
        ...parsed,
        agents: parsed.agents.map((agent) => ({
          ...agent,
          budgetPolicy: agent.budgetPolicy ?? { maxRuns: null, maxTotalTokens: null },
          maxPromptChars: agent.maxPromptChars ?? null,
        })),
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        runs: parsedRuns.map((run) => ({
          ...run,
          budgetReserved: run.budgetReserved ?? Boolean(run.startedAt),
          runtimeInvoked: run.runtimeInvoked ?? Boolean(run.startedAt),
        })),
        governanceEvents: Array.isArray(parsed.governanceEvents)
          ? parsed.governanceEvents
          : legacyGovernanceEvents(parsed),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function legacyGovernanceEvents(parsed: unknown): Database["governanceEvents"] {
  const legacyRecord = parsed as Record<string, unknown>;
  const legacy = Array.isArray(legacyRecord.budgetEvents) ? legacyRecord.budgetEvents : [];
  return legacy.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const event = item as Record<string, unknown>;
    const agentId = typeof event.agentId === "string" ? event.agentId : null;
    const runId = typeof event.runId === "string" ? event.runId : null;
    const createdAt = typeof event.createdAt === "string" ? event.createdAt : null;
    if (!agentId || !createdAt) return [];
    const denied = event.event === "budget.run_denied";
    const oldReason = event.reason;
    return [{
      id: typeof event.id === "string" ? event.id : randomUUID(),
      agentId,
      runId,
      event: "resource_governance.admission" as const,
      decision: denied ? "deny" as const : "admit" as const,
      reason: oldReason === "token_limit_exhausted" ? "token_budget_exhausted" as const : denied ? "run_limit_exhausted" as const : "within_limits" as const,
      observedUsage: {
        runsUsed: typeof event.runsUsed === "number" ? event.runsUsed : 0,
        tokensUsed: typeof event.tokensUsed === "number" ? event.tokensUsed : 0,
        inputCharacters: 0,
      },
      appliedLimits: {
        maxRuns: typeof event.maxRuns === "number" ? event.maxRuns : null,
        maxTotalTokens: typeof event.maxTotalTokens === "number" ? event.maxTotalTokens : null,
        maxInputCharacters: null,
      },
      runtimeInvoked: false,
      actualTokensConsumed: null,
      createdAt,
    }];
  });
}
