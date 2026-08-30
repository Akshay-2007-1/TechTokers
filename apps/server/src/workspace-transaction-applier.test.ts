import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { detectWorkspaceChanges } from "./transactional-workspace.js";
import { WorkspaceTransactionApplier } from "./workspace-transaction-applier.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-tx-")); roots.push(root);
  const persistent = path.join(root, "persistent"); const staging = path.join(root, "staging");
  await mkdir(persistent); await mkdir(staging);
  await writeFile(path.join(persistent, "keep.txt"), "before"); await writeFile(path.join(persistent, "delete.txt"), "remove");
  await writeFile(path.join(staging, "keep.txt"), "after"); await writeFile(path.join(staging, "new.txt"), "new");
  return { root, persistent, staging };
}

describe("WorkspaceTransactionApplier", () => {
  it("applies a verified create, modify and delete transaction", async () => {
    const { root, persistent, staging } = await fixture(); const changes = await detectWorkspaceChanges(persistent, staging);
    await new WorkspaceTransactionApplier(path.join(root, "transactions")).apply(persistent, staging, changes);
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("after");
    await expect(readFile(path.join(persistent, "new.txt"), "utf8")).resolves.toBe("new");
    await expect(readFile(path.join(persistent, "delete.txt"), "utf8")).rejects.toThrow();
  });
  it("rolls back after a write already succeeded", async () => {
    const { root, persistent, staging } = await fixture(); const changes = await detectWorkspaceChanges(persistent, staging);
    await expect(new WorkspaceTransactionApplier(path.join(root, "transactions"), 1).apply(persistent, staging, changes)).rejects.toThrow("Injected");
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(path.join(persistent, "new.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(path.join(persistent, "delete.txt"), "utf8")).resolves.toBe("remove");
  });
  it("rejects a base conflict before mutation", async () => {
    const { root, persistent, staging } = await fixture(); const changes = await detectWorkspaceChanges(persistent, staging);
    await writeFile(path.join(persistent, "keep.txt"), "concurrent");
    await expect(new WorkspaceTransactionApplier(path.join(root, "transactions")).apply(persistent, staging, changes)).rejects.toThrow("conflict");
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("concurrent");
  });
  it("rejects staging tampering before mutation", async () => {
    const { root, persistent, staging } = await fixture(); const changes = await detectWorkspaceChanges(persistent, staging);
    await writeFile(path.join(staging, "keep.txt"), "tampered");
    await expect(new WorkspaceTransactionApplier(path.join(root, "transactions")).apply(persistent, staging, changes)).rejects.toThrow("Staging");
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("before");
  });
  it("rolls back a failure during deferred deletion", async () => {
    const { root, persistent, staging } = await fixture(); const changes = await detectWorkspaceChanges(persistent, staging);
    await expect(new WorkspaceTransactionApplier(path.join(root, "transactions"), 3).apply(persistent, staging, changes)).rejects.toThrow("Injected");
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("before");
    await expect(readFile(path.join(persistent, "delete.txt"), "utf8")).resolves.toBe("remove");
  });
  it("recovers an interrupted apply before another transaction can begin", async () => {
    const { root, persistent, staging } = await fixture();
    const transactions = path.join(root, "transactions"); const transaction = path.join(transactions, "interrupted");
    await mkdir(path.join(transaction, "backup"), { recursive: true });
    await writeFile(path.join(transaction, "backup", "keep.txt"), "before");
    await writeFile(path.join(persistent, "keep.txt"), "partially-applied");
    const baseHash = createHash("sha256").update("before").digest("hex");
    await writeFile(path.join(transaction, "journal.json"), JSON.stringify({
      id: "interrupted", state: "applying", persistent,
      changes: [{ kind: "modified", path: "keep.txt", baseHash, stagedHash: "unused" }],
      originals: [{ path: "keep.txt", existed: true, hash: baseHash }], completedPaths: ["keep.txt"], createdAt: new Date().toISOString(),
    }));
    await new WorkspaceTransactionApplier(transactions).recover();
    await expect(readFile(path.join(persistent, "keep.txt"), "utf8")).resolves.toBe("before");
    const journal = JSON.parse(await readFile(path.join(transaction, "journal.json"), "utf8"));
    expect(journal.state).toBe("rolled_back");
    await expect(readFile(path.join(staging, "keep.txt"), "utf8")).resolves.toBe("after");
  });
});
