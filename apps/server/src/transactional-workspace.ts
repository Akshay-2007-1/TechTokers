import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type WorkspaceChange =
  | { kind: "created"; path: string; stagedHash: string }
  | { kind: "modified"; path: string; baseHash: string; stagedHash: string }
  | { kind: "deleted"; path: string; baseHash: string };

const protectedPath = (relativePath: string) =>
  relativePath === ".env" || relativePath.startsWith(".env.");

export function safeRelativePath(relativePath: string): string {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid workspace path");
  }
  const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Workspace path escapes its root");
  }
  if (protectedPath(normalized)) throw new Error("Protected workspace path");
  return normalized;
}

async function manifest(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (protectedPath(relative)) continue;
      const full = path.join(directory, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error("Unsupported workspace file type: " + relative);
      }
      if (stat.isDirectory()) await visit(full, relative);
      else files.set(relative, createHash("sha256").update(await readFile(full)).digest("hex"));
    }
  }
  await visit(root);
  return files;
}

export async function createStagingWorkspace(
  persistentWorkspace: string,
  stagingWorkspace: string,
): Promise<void> {
  await rm(stagingWorkspace, { recursive: true, force: true });
  await mkdir(stagingWorkspace, { recursive: true });
  await cp(persistentWorkspace, stagingWorkspace, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(persistentWorkspace, source).replaceAll("\\", "/");
      return !protectedPath(relative);
    },
  });
}

export async function detectWorkspaceChanges(
  persistentWorkspace: string,
  stagingWorkspace: string,
): Promise<WorkspaceChange[]> {
  const base = await manifest(persistentWorkspace);
  const staged = await manifest(stagingWorkspace);
  const paths = new Set([...base.keys(), ...staged.keys()]);
  const changes: WorkspaceChange[] = [];
  for (const relative of [...paths].sort()) {
    const before = base.get(relative);
    const after = staged.get(relative);
    if (before === undefined && after !== undefined) changes.push({ kind: "created", path: relative, stagedHash: after });
    else if (before !== undefined && after === undefined) changes.push({ kind: "deleted", path: relative, baseHash: before });
    else if (before !== after) changes.push({ kind: "modified", path: relative, baseHash: before!, stagedHash: after! });
  }
  return changes;
}

export async function discardStagingWorkspace(stagingWorkspace: string): Promise<void> {
  await rm(stagingWorkspace, { recursive: true, force: true });
}

export async function writeStagedFile(root: string, relativePath: string, content: string): Promise<void> {
  const safe = safeRelativePath(relativePath);
  const destination = path.join(root, safe);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
}
