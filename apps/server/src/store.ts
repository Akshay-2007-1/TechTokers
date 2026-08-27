import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 1,
  agents: [],
  messages: [],
  runs: [],
  budgetEvents: [],
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
        })),
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
        runs: parsedRuns.map((run) => ({
          ...run,
          budgetReserved: run.budgetReserved ?? Boolean(run.startedAt),
          runtimeInvoked: run.runtimeInvoked ?? Boolean(run.startedAt),
        })),
        budgetEvents: Array.isArray(parsed.budgetEvents) ? parsed.budgetEvents : [],
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
