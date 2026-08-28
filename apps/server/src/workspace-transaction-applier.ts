import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceChange } from "./transactional-workspace.js";
import { safeRelativePath } from "./transactional-workspace.js";

type JournalState = "prepared" | "applying" | "committed" | "rolling_back" | "rolled_back" | "failed";
type Journal = { id: string; state: JournalState; changes: WorkspaceChange[]; createdAt: string };
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");

export class WorkspaceTransactionApplier {
  constructor(private readonly transactionRoot: string, private readonly failAfter?: number) {}

  async apply(persistent: string, staging: string, changes: WorkspaceChange[]): Promise<void> {
    const id = randomUUID(); const root = path.join(this.transactionRoot, id); const backup = path.join(root, "backup");
    await mkdir(backup, { recursive: true });
    const journal: Journal = { id, state: "prepared", changes, createdAt: new Date().toISOString() };
    const persist = async (state: JournalState) => { journal.state = state; await writeFile(path.join(root, "journal.json"), JSON.stringify(journal), "utf8"); };
    const existing = new Map<string, string | null>();
    for (const change of changes) {
      const relative = safeRelativePath(change.path); if (relative !== change.path) throw new Error("Ambiguous path");
      const target = path.join(persistent, relative); const staged = path.join(staging, relative);
      try { const stat = await lstat(target); if (!stat.isFile()) throw new Error("Unsupported target type"); existing.set(relative, await hash(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existing.set(relative, null); else throw error; }
      if (change.kind === "created" && existing.get(relative) !== null) throw new Error("Workspace conflict");
      if (change.kind !== "created" && existing.get(relative) !== change.baseHash) throw new Error("Workspace conflict");
      if (change.kind !== "deleted" && await hash(staged) !== change.stagedHash) throw new Error("Staging manifest changed");
    }
    await persist("applying"); let applied = 0;
    try {
      for (const change of changes) {
        const target = path.join(persistent, change.path); const prior = existing.get(change.path);
        if (prior !== null) { await mkdir(path.dirname(path.join(backup, change.path)), { recursive: true }); await copyFile(target, path.join(backup, change.path)); }
      }
      for (const change of changes.filter((x) => x.kind !== "deleted")) {
        const target = path.join(persistent, change.path); await mkdir(path.dirname(target), { recursive: true });
        const temporary = target + ".launchpad-tx-" + id; await copyFile(path.join(staging, change.path), temporary); await rename(temporary, target);
        if (++applied === this.failAfter) throw new Error("Injected transaction failure");
      }
      for (const change of changes.filter((x) => x.kind === "deleted")) { await rm(path.join(persistent, change.path)); if (++applied === this.failAfter) throw new Error("Injected transaction failure"); }
      await persist("committed"); await rm(root, { recursive: true, force: true });
    } catch (error) {
      await persist("rolling_back");
      for (const change of changes) {
        const target = path.join(persistent, change.path); const prior = existing.get(change.path);
        if (prior === null) await rm(target, { force: true });
        else { await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(backup, change.path), target); if (await hash(target) !== prior) throw new Error("Rollback verification failed"); }
      }
      await persist("rolled_back"); throw error;
    }
  }
}
