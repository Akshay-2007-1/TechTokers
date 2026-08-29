export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "denied"
  | "terminated";
export type MessageRole = "user" | "assistant";
export type RuntimeTerminationReason = "duration_exceeded" | "output_exceeded";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  budgetPolicy: AgentBudgetPolicy;
  maxPromptChars: number | null;
  runtimeLimits: AgentRuntimeLimits;
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
  terminationReason: RuntimeTerminationReason | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AgentBudgetPolicy {
  maxRuns: number | null;
  maxTotalTokens: number | null;
}

/**
 * Runtime-side controls that terminate a single Run in progress, in contrast to
 * AgentBudgetPolicy which denies a Run before the Runtime is invoked. `null`
 * means fall back to the server-wide CODEX_TIMEOUT_MS / CODEX_MAX_OUTPUT_BYTES.
 */
export interface AgentRuntimeLimits {
  maxRunDurationMs: number | null;
  maxRunOutputBytes: number | null;
}

export interface RuntimeTerminationDetail {
  reason: RuntimeTerminationReason;
  limit: number;
  observed: number;
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
  maxRunDurationMs: number | null;
  maxRunOutputBytes: number | null;
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
  | "resource_governance.usage_reconciled"
  | "resource_governance.run_terminated";

export interface GovernanceEvent {
  id: string;
  agentId: string;
  runId: string | null;
  event: GovernanceEventName;
  decision: AdmissionOutcome | null;
  reason: AdmissionReason | "policy_updated" | "usage_reconciled" | "run_terminated";
  observedUsage: ResourceObservedUsage;
  appliedLimits: AppliedResourceLimits;
  runtimeInvoked: boolean;
  actualTokensConsumed: number | null;
  previousLimits?: AppliedResourceLimits | undefined;
  actor?: "local_operator" | undefined;
  runtimeTermination?: RuntimeTerminationDetail | undefined;
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
}

export interface CreateAgentInput {
  name: string;
  description?: string | undefined;
  instructions?: string | undefined;
  budgetPolicy?: AgentBudgetPolicy | undefined;
  maxPromptChars?: number | null | undefined;
  runtimeLimits?: AgentRuntimeLimits | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
  budgetPolicy?: AgentBudgetPolicy | undefined;
  maxPromptChars?: number | null | undefined;
  runtimeLimits?: AgentRuntimeLimits | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
}

export interface RunResourceLimits {
  durationMs: number;
  outputBytes: number;
}

export interface RunnerRequest {
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  limits?: RunResourceLimits | undefined;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(agentId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}
