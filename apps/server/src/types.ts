export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "denied";
export type MessageRole = "user" | "assistant";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  budgetPolicy: AgentBudgetPolicy;
  maxPromptChars: number | null;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  budgetReserved: boolean;
  runtimeInvoked: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface WorkspaceChangeSet {
  id: string; agentId: string; runId: string; stagingPath: string;
  status: "pending" | "approved" | "denied" | "expired" | "conflicted" | "apply_failed";
  changes: import("./transactional-workspace.js").WorkspaceChange[];
  createdAt: string; decidedAt: string | null;
}

export interface AgentBudgetPolicy {
  maxRuns: number | null;
  maxTotalTokens: number | null;
}

export type AdmissionReason =
  | "within_limits"
  | "input_too_large"
  | "run_limit_exhausted"
  | "token_budget_exhausted";
export type AdmissionOutcome = "admit" | "deny";

export interface ResourceObservedUsage {
  runsUsed: number;
  tokensUsed: number;
  inputCharacters: number;
}

export interface AppliedResourceLimits {
  maxRuns: number | null;
  maxTotalTokens: number | null;
  maxInputCharacters: number | null;
}

export interface AdmissionDecision {
  decision: AdmissionOutcome;
  reason: AdmissionReason;
  runtimeInvoked: false;
  observedUsage: ResourceObservedUsage;
  appliedLimits: AppliedResourceLimits;
}

export type GovernanceEventName =
  | "resource_governance.admission"
  | "resource_governance.policy_updated"
  | "resource_governance.usage_reconciled";

export interface GovernanceEvent {
  id: string;
  agentId: string;
  runId: string | null;
  event: GovernanceEventName;
  decision: AdmissionOutcome | null;
  reason: AdmissionReason | "policy_updated" | "usage_reconciled";
  observedUsage: ResourceObservedUsage;
  appliedLimits: AppliedResourceLimits;
  runtimeInvoked: boolean;
  actualTokensConsumed: number | null;
  previousLimits?: AppliedResourceLimits | undefined;
  actor?: "local_operator" | undefined;
  createdAt: string;
}

export interface AgentBudgetStatus {
  policy: AgentBudgetPolicy;
  runsUsed: number;
  tokensUsed: number;
  runsRemaining: number | null;
  tokensRemaining: number | null;
}

export interface Database {
  version: 1;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  governanceEvents: GovernanceEvent[];
  workspaceChangeSets: WorkspaceChangeSet[];
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  budgetPolicy?: AgentBudgetPolicy | undefined;
  maxPromptChars?: number | null | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  budgetPolicy?: AgentBudgetPolicy | undefined;
  maxPromptChars?: number | null | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
