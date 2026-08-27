import { describe, expect, it } from "vitest";
import { parseCodexEventLine } from "./codex-runner.js";
import { loadConfig } from "./config.js";
import {
  PipelineDiagnostics,
  redactDiagnosticText,
  summarizeCommand,
} from "./pipeline-debug.js";

function capturedDiagnostics(enabled: boolean) {
  const entries: Record<string, unknown>[] = [];
  const diagnostics = new PipelineDiagnostics(enabled);
  diagnostics.setLogger({
    info: (entry) => entries.push(entry),
  });
  return { diagnostics, entries };
}

describe("Agent pipeline diagnostics", () => {
  it("is disabled by default and does not emit events", () => {
    expect(loadConfig({ NODE_ENV: "test" }).debugAgentPipeline).toBe(false);
    const { diagnostics, entries } = capturedDiagnostics(false);
    diagnostics.emit("run.created", { agentId: "agent", runId: "run" });
    expect(entries).toEqual([]);
  });

  it("includes Agent and Run correlation identifiers", () => {
    const { diagnostics, entries } = capturedDiagnostics(true);
    diagnostics.emit("run.created", {
      agentId: "agent-123",
      runId: "run-456",
      sessionId: "thread-789",
      runtimeType: "container",
      workspacePath: "/private/path/workspaces/agent-123",
    });
    expect(entries[0]).toMatchObject({
      event: "run.created",
      agentId: "agent-123",
      runId: "run-456",
      sessionId: "thread-789",
      workspacePath: "workspace/agent-123",
    });
  });

  it("redacts credentials and environment-style values", () => {
    const source = "Authorization: Bearer top-secret API_KEY=sk-proj-secret DEMO_SECRET=value";
    const redacted = redactDiagnosticText(source);
    expect(redacted).not.toContain("top-secret");
    expect(redacted).not.toContain("sk-proj-secret");
    expect(redacted).not.toContain("DEMO_SECRET=value");
    expect(redacted).toContain("DEMO_SECRET=<redacted:env-value>");
  });

  it("keeps policy rejection observable while redacting its details", () => {
    const { diagnostics, entries } = capturedDiagnostics(true);
    diagnostics.observeCodexEvent(
      { agentId: "agent", runId: "run", workspacePath: "/tmp/workspaces/agent" },
      {
        type: "item.completed",
        item: {
          type: "command_execution",
          command: "/bin/bash -c 'rm -f .env.permission-test'",
          aggregated_output:
            "Rejected(Authorization: Bearer top-secret DEMO_SECRET=THIS_IS_NOT_A_REAL_SECRET blocked by policy)",
        },
      },
    );
    const rejection = entries.find((entry) => entry.event === "tool.call.rejected");
    expect(rejection).toMatchObject({
      policyOutcome: "rejected",
      errorCategory: "policy_rejection",
    });
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("THIS_IS_NOT_A_REAL_SECRET");
  });

  it("summarizes shell-wrapper commands without logging their script", () => {
    expect(summarizeCommand("/bin/bash -c 'rm -f deletion-test.txt'")).toEqual({
      executable: "/bin/bash",
      arguments: ["-c", "<redacted-shell-script>"],
      commandForm: "shell-wrapper",
    });
    expect(summarizeCommand("rm deletion-test.txt")).toEqual({
      executable: "rm",
      arguments: ["<argument>"],
      commandForm: "direct",
    });
  });

  it("observes events without changing the Codex parser result", () => {
    const parsed = { messages: [], threadId: null, usage: null, errors: [] };
    const events: Record<string, unknown>[] = [];
    parseCodexEventLine(
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
      parsed,
      (event) => events.push(event),
    );
    expect(parsed.messages).toEqual(["Done"]);
    expect(events).toHaveLength(1);
  });
});
