export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type WorkspaceApprovalMode = "auto" | "review";
export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "denied" | "terminated";
export type RuntimeTerminationReason = "duration_exceeded" | "output_exceeded" | "operator_kill";

export interface AgentBudgetPolicy {
  maxRuns: number | null;
  maxTotalTokens: number | null;
}

export interface AgentBudgetStatus {
  policy: AgentBudgetPolicy;
  runsUsed: number;
  tokensUsed: number;
  runsRemaining: number | null;
  tokensRemaining: number | null;
}

export interface GovernanceEvent {
  id: string;
  agentId: string;
  runId: string | null;
  event: string;
  decision: "admit" | "deny" | null;
  reason: string;
  runtimeInvoked: boolean;
  actualTokensConsumed: number | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  budgetPolicy: AgentBudgetPolicy;
  maxPromptChars: number | null;
  workspaceApprovalMode: WorkspaceApprovalMode;
  runtimeLimits: AgentRuntimeLimits;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRuntimeLimits {
  maxRunDurationMs: number | null;
  maxRunOutputBytes: number | null;
  maxRunCpus: number | null;
  maxRunMemoryMb: number | null;
  maxRunProcesses: number | null;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  terminationReason: RuntimeTerminationReason | null;
  createdAt: string;
}

export interface RuntimeDefaults {
  maxRunDurationMs: number;
  maxRunOutputBytes: number;
  maxRunCpus: number;
  maxRunMemoryMb: number;
  maxRunProcesses: number;
  quarantineThreshold: number;
  quarantineWindowMs: number;
}

export interface WorkspaceChangeSet {
  id: string; agentId: string; runId: string;
  status: "pending" | "applying" | "approved" | "denied" | "expired" | "conflicted" | "apply_failed";
  changes: Array<{ kind: "created" | "modified" | "deleted"; path: string }>;
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  runtimeDefaults?: RuntimeDefaults;
}
