import path from "node:path";

export const pipelineEventNames = [
  "playground.request.received",
  "run.created",
  "runtime.selected",
  "workspace.resolved",
  "container.launch.started",
  "container.launch.completed",
  "codex.process.started",
  "codex.event.received",
  "model.output.received",
  "tool.call.proposed",
  "tool.call.rejected",
  "tool.execution.started",
  "tool.execution.completed",
  "run.completed",
  "run.failed",
] as const;

export type PipelineEventName = (typeof pipelineEventNames)[number];

export interface PipelineLogger {
  info(object: Record<string, unknown>, message?: string): void;
}

export interface PipelineContext {
  agentId?: string | undefined;
  runId?: string | undefined;
  sessionId?: string | null | undefined;
  runtimeType?: "container" | "local-process" | undefined;
  workspacePath?: string | undefined;
  containerId?: string | undefined;
  processId?: number | undefined;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Redacts values before they reach any diagnostic logger. */
export function redactDiagnosticText(value: string): string {
  return value
    .slice(0, 500)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "<redacted:api-key>")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted:authorization>")
    .replace(
      /\b(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,;"']+/gi,
      "$1=<redacted:credential>",
    )
    .replace(
      /\b([A-Za-z_][A-Za-z0-9_]{1,})=([^\s,;"']+)/g,
      "$1=<redacted:env-value>",
    );
}

export function normalizeWorkspacePath(workspacePath: string): string {
  return "workspace/" + path.basename(workspacePath);
}

function pathPlaceholder(value: string): string {
  if (value.startsWith("/")) return "<path:absolute>";
  if (value.includes("/") || value.startsWith(".")) return "<path:relative>";
  return "<argument>";
}

export function summarizeCommand(command: string): Record<string, unknown> {
  const tokens = command.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const executable = tokens[0]?.replace(/^(?:"|')|(?:"|')$/g, "") || "<unknown>";
  const args = tokens.slice(1).map((token, index) => {
    const normalized = token.replace(/^(?:"|')|(?:"|')$/g, "");
    if (normalized === "-c" || normalized === "--command") return normalized;
    if (tokens[index] === "-c" || tokens[index] === "--command") {
      return "<redacted-shell-script>";
    }
    if (normalized.startsWith("-")) return normalized;
    return pathPlaceholder(normalized);
  });
  return {
    executable,
    arguments: args,
    commandForm: args.includes("<redacted-shell-script>") ? "shell-wrapper" : "direct",
  };
}

function commandFromItem(item: UnknownRecord): string | null {
  for (const key of ["command", "cmd", "input"]) {
    const value = stringValue(item[key]);
    if (value) return value;
  }
  return null;
}

function outputByteCount(item: UnknownRecord): number | null {
  for (const key of ["aggregated_output", "output", "stdout", "stderr"]) {
    const value = stringValue(item[key]);
    if (value !== null) return Buffer.byteLength(value, "utf8");
  }
  return null;
}

function errorText(event: UnknownRecord, item: UnknownRecord | null): string {
  return [event.message, event.error, item?.message, item?.error, item?.aggregated_output]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function classifyDiagnosticError(value: string): string | null {
  if (!value) return null;
  if (/rejected\(|blocked by policy/i.test(value)) return "policy_rejection";
  if (/sandbox|landlock/i.test(value)) return "sandbox";
  if (/timed?\s*out/i.test(value)) return "timeout";
  return "runtime_error";
}

export class PipelineDiagnostics {
  private logger: PipelineLogger | null = null;

  constructor(private readonly enabled: boolean) {}

  setLogger(logger: PipelineLogger): void {
    this.logger = logger;
  }

  emit(
    event: PipelineEventName,
    context: PipelineContext,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.enabled || !this.logger) return;
    this.logger.info(
      {
        timestamp: new Date().toISOString(),
        event,
        ...context,
        ...(context.workspacePath
          ? { workspacePath: normalizeWorkspacePath(context.workspacePath) }
          : {}),
        ...details,
      },
      "Agent pipeline diagnostic",
    );
  }

  observeCodexEvent(context: PipelineContext, rawEvent: unknown): void {
    if (!this.enabled) return;
    const event = asRecord(rawEvent);
    if (!event) return;
    const item = asRecord(event.item);
    const eventType = stringValue(event.type) ?? "unknown";
    const itemType = stringValue(item?.type) ?? null;
    const command = item ? commandFromItem(item) : null;
    const error = errorText(event, item);
    const category = classifyDiagnosticError(error);
    const exitCode = item ? numberValue(item.exit_code) : null;
    const outputBytes = item ? outputByteCount(item) : null;

    this.emit("codex.event.received", context, {
      codexEventType: eventType,
      ...(itemType ? { itemType } : {}),
      ...(command ? { command: summarizeCommand(command) } : {}),
      ...(outputBytes !== null ? { outputBytes } : {}),
      ...(category ? { errorCategory: category } : {}),
    });

    if (itemType === "agent_message") {
      const text = stringValue(item?.text) ?? "";
      this.emit("model.output.received", context, {
        outputBytes: Buffer.byteLength(text, "utf8"),
        sensitiveFieldRedacted: /\b[A-Za-z_][A-Za-z0-9_]{1,}=/.test(text),
      });
    }

    const isToolEvent = Boolean(command) || /(?:command|shell|tool)/i.test(itemType ?? "");
    if (!isToolEvent) return;
    const commandDetails = command
      ? { toolName: itemType ?? "command", command: summarizeCommand(command) }
      : { toolName: itemType ?? "unknown" };
    this.emit("tool.call.proposed", context, commandDetails);
    if (category === "policy_rejection") {
      this.emit("tool.call.rejected", context, {
        ...commandDetails,
        policyOutcome: "rejected",
        errorCategory: category,
        errorSummary: redactDiagnosticText(error),
      });
      return;
    }
    if (eventType.includes("started") || item?.status === "in_progress") {
      this.emit("tool.execution.started", context, commandDetails);
    }
    if (eventType.includes("completed") || item?.status === "completed" || exitCode !== null) {
      this.emit("tool.execution.completed", context, {
        ...commandDetails,
        executionStatus: exitCode === 0 || exitCode === null ? "completed" : "failed",
        ...(exitCode !== null ? { exitCode } : {}),
        ...(outputBytes !== null ? { outputBytes } : {}),
        ...(category ? { errorCategory: category } : {}),
      });
    }
  }
}
