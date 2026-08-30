import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexArgs, CodexRunner, parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import { RuntimeLimitError } from "./errors.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

async function runnerWithFakeCodex(script: string): Promise<CodexRunner> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-runner-test-"));
  temporaryDirectories.push(root);
  const binary = path.join(root, "fake-codex");
  await writeFile(binary, "#!/usr/bin/env node\n" + script, "utf8");
  await chmod(binary, 0o755);
  const config = loadConfig({
    NODE_ENV: "test",
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    CODEX_HOME: path.join(root, "codex-home"),
    CODEX_BIN: binary,
  });
  return new CodexRunner(config);
}

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });
});

describe("Codex runner per-Run resource limits", () => {
  it("terminates a Run that exceeds its duration limit", async () => {
    const runner = await runnerWithFakeCodex("setInterval(() => {}, 1000);\n");
    const error = await runner
      .run({
        agentId: "agent-duration",
        workspacePath: tmpdir(),
        prompt: "loop forever",
        threadId: null,
        limits: { durationMs: 250, outputBytes: 1_000_000 },
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeLimitError);
    expect((error as RuntimeLimitError).reason).toBe("duration_exceeded");
    expect((error as RuntimeLimitError).limit).toBe(250);
  });

  it("terminates a Run that floods more output than allowed", async () => {
    const runner = await runnerWithFakeCodex(
      'process.stdout.write("x".repeat(200000));\nsetInterval(() => {}, 1000);\n',
    );
    const error = await runner
      .run({
        agentId: "agent-output",
        workspacePath: tmpdir(),
        prompt: "flood stdout",
        threadId: null,
        limits: { durationMs: 10_000, outputBytes: 4_096 },
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RuntimeLimitError);
    expect((error as RuntimeLimitError).reason).toBe("output_exceeded");
    expect((error as RuntimeLimitError).limit).toBe(4_096);
  });
});
