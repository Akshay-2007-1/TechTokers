import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceChange } from "./transactional-workspace.js";
import { safeRelativePath } from "./transactional-workspace.js";

type JournalState = "prepared" | "applying" | "committed" | "rolling_back" | "rolled_back" | "failed";
type Original = { path: string; existed: boolean; hash: string | null };
type Journal = { id: string; state: JournalState; persistent: string; changes: WorkspaceChange[]; originals: Original[]; completedPaths: string[]; createdAt: string };
const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
const journalFile = (root: string) => path.join(root, "journal.json");
async function persist(root: string, journal: Journal): Promise<void> { const temporary = journalFile(root) + ".tmp"; await writeFile(temporary, JSON.stringify(journal, null, 2) + "\n", "utf8"); await rename(temporary, journalFile(root)); }

export class WorkspaceTransactionApplier {
  constructor(private readonly transactionRoot: string, private readonly failAfter?: number) {}

  async recover(): Promise<void> {
    try { for (const entry of await readdir(this.transactionRoot, { withFileTypes: true })) { if (!entry.isDirectory()) continue; const root = path.join(this.transactionRoot, entry.name); const journal = JSON.parse(await readFile(journalFile(root), "utf8")) as Journal; if (journal.state !== "committed" && journal.state !== "rolled_back") await this.rollback(root, journal); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  async apply(persistent: string, staging: string, changes: WorkspaceChange[]): Promise<void> {
    await this.recover();
    const id = randomUUID(); const root = path.join(this.transactionRoot, id); const backup = path.join(root, "backup");
    await mkdir(backup, { recursive: true });
    const existing = new Map<string, string | null>(); const originals: Original[] = []; const paths = new Set<string>();
    for (const change of changes) {
      if (change.kind !== "created" && change.kind !== "modified" && change.kind !== "deleted") throw new Error("Invalid transaction manifest");
      const relative = safeRelativePath(change.path); if (relative !== change.path || paths.has(relative)) throw new Error("Invalid transaction manifest"); paths.add(relative);
      const target = path.join(persistent, relative); const staged = path.join(staging, relative);
      try { const stat = await lstat(target); if (!stat.isFile()) throw new Error("Unsupported target type"); existing.set(relative, await hash(target)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") existing.set(relative, null); else throw error; }
      if (change.kind === "created" && existing.get(relative) !== null) throw new Error("Workspace conflict");
      if (change.kind !== "created" && existing.get(relative) !== change.baseHash) throw new Error("Workspace conflict");
      if (change.kind !== "deleted") { const stat = await lstat(staged); if (!stat.isFile() || await hash(staged) !== change.stagedHash) throw new Error("Staging manifest changed"); }
      originals.push({ path: relative, existed: existing.get(relative) !== null, hash: existing.get(relative) ?? null });
    }
    for (const original of originals) if (original.existed) { const target = path.join(persistent, original.path); const destination = path.join(backup, original.path); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(target, destination); if (await hash(destination) !== original.hash) throw new Error("Backup verification failed"); }
    const journal: Journal = { id, state: "prepared", persistent, changes: structuredClone(changes), originals, completedPaths: [], createdAt: new Date().toISOString() }; await persist(root, journal); journal.state = "applying"; await persist(root, journal); let applied = 0;
    try {
      for (const change of changes) {
        const target = path.join(persistent, change.path); const prior = existing.get(change.path);
        if (prior !== null) { await mkdir(path.dirname(path.join(backup, change.path)), { recursive: true }); await copyFile(target, path.join(backup, change.path)); }
      }
      for (const change of changes.filter((x) => x.kind !== "deleted")) {
        const target = path.join(persistent, change.path); await mkdir(path.dirname(target), { recursive: true });
        const temporary = target + ".launchpad-tx-" + id; await copyFile(path.join(staging, change.path), temporary); await rename(temporary, target);
        journal.completedPaths.push(change.path); await persist(root, journal); if (++applied === this.failAfter) throw new Error("Injected transaction failure");
      }
      for (const change of changes.filter((x) => x.kind === "deleted")) { await rm(path.join(persistent, change.path)); journal.completedPaths.push(change.path); await persist(root, journal); if (++applied === this.failAfter) throw new Error("Injected transaction failure"); }
      journal.state = "committed"; await persist(root, journal);
    } catch (error) {
      await this.rollback(root, journal); throw error;
    }
  }

  private async rollback(root: string, journal: Journal): Promise<void> { journal.state = "rolling_back"; await persist(root, journal); for (const original of journal.originals) { const target = path.join(journal.persistent, original.path); if (!original.existed) await rm(target, { force: true }); else { await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(root, "backup", original.path), target); if (await hash(target) !== original.hash) throw new Error("Rollback verification failed"); } } journal.state = "rolled_back"; await persist(root, journal); }
}
