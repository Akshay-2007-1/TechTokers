export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "denied";
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

export interface AgentBudgetPolicy {
  maxRuns: number | null;
  maxTotalTokens: number | null;
}

export type BudgetEventName = "budget.run_admitted" | "budget.run_denied";
export type BudgetDenialReason = "run_limit_exhausted" | "token_limit_exhausted";

export interface BudgetEvent {
  id: string;
  agentId: string;
  runId: string;
  event: BudgetEventName;
  reason: BudgetDenialReason | null;
  runsUsed: number;
  maxRuns: number | null;
  tokensUsed: number;
  maxTotalTokens: number | null;
  runtimeInvoked: false;
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
  budgetEvents: BudgetEvent[];
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
