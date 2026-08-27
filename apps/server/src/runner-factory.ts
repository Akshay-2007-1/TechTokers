import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import type { PipelineDiagnostics } from "./pipeline-debug.js";
import type { AgentRunner } from "./types.js";

export function createRunner(
  config: AppConfig,
  diagnostics?: PipelineDiagnostics,
): AgentRunner {
  return config.runtimeProvider === "container"
    ? new ContainerCodexRunner(config, diagnostics)
    : new CodexRunner(config, diagnostics);
}
