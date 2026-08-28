import { randomUUID } from "node:crypto";
import type {
  AdmissionDecision,
  AdmissionReason,
  Agent,
  AgentBudgetPolicy,
  AgentBudgetStatus,
  AgentRun,
  AppliedResourceLimits,
  Database,
  ResourceObservedUsage,
} from "./types.js";

// This is the Resource Governance admission component. The filename remains
// stable to avoid a needless public-module rename from the original budget MVP.
export const unlimitedBudgetPolicy = (): AgentBudgetPolicy => ({
  maxRuns: null,
  maxTotalTokens: null,
});

export function totalTokens(run: AgentRun): number {
  return (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
}

function countsTowardRuns(run: AgentRun): boolean {
  return run.budgetReserved || run.runtimeInvoked || run.startedAt !== null;
}

export function resourceLimits(agent: Agent): AppliedResourceLimits {
  const policy = agent.budgetPolicy ?? unlimitedBudgetPolicy();
  return {
    maxRuns: policy.maxRuns,
    maxTotalTokens: policy.maxTotalTokens,
    maxInputCharacters: agent.maxPromptChars,
  };
}

export function observedUsage(
  database: Database,
  agent: Agent,
  inputCharacters = 0,
): ResourceObservedUsage {
  const runs = database.runs.filter((run) => run.agentId === agent.id);
  return {
    runsUsed: runs.filter(countsTowardRuns).length,
    tokensUsed: runs.reduce((total, run) => total + totalTokens(run), 0),
    inputCharacters,
  };
}

export function budgetStatus(database: Database, agent: Agent): AgentBudgetStatus {
  const policy = agent.budgetPolicy ?? unlimitedBudgetPolicy();
  const usage = observedUsage(database, agent);
  return {
    policy,
    runsUsed: usage.runsUsed,
    tokensUsed: usage.tokensUsed,
    runsRemaining: policy.maxRuns === null ? null : Math.max(0, policy.maxRuns - usage.runsUsed),
    tokensRemaining:
      policy.maxTotalTokens === null ? null : Math.max(0, policy.maxTotalTokens - usage.tokensUsed),
  };
}

export function utilizationState(
  used: number,
  limit: number | null,
): "unlimited" | "healthy" | "warning" | "exhausted" {
  if (limit === null) return "unlimited";
  if (used >= limit) return "exhausted";
  return used / limit >= 0.8 ? "warning" : "healthy";
}

export function evaluateAdmission(
  database: Database,
  agent: Agent,
  inputCharacters: number,
): AdmissionDecision {
  const appliedLimits = resourceLimits(agent);
  const currentUsage = observedUsage(database, agent, inputCharacters);
  const reason: AdmissionReason =
    appliedLimits.maxInputCharacters !== null && inputCharacters > appliedLimits.maxInputCharacters
      ? "input_too_large"
      : appliedLimits.maxRuns !== null && currentUsage.runsUsed >= appliedLimits.maxRuns
        ? "run_limit_exhausted"
        : appliedLimits.maxTotalTokens !== null &&
            currentUsage.tokensUsed >= appliedLimits.maxTotalTokens
          ? "token_budget_exhausted"
          : "within_limits";
  return {
    decision: reason === "within_limits" ? "admit" : "deny",
    reason,
    runtimeInvoked: false,
    observedUsage: currentUsage,
    appliedLimits,
  };
}

export function admitRun(
  database: Database,
  agent: Agent,
  run: AgentRun,
  inputCharacters: number,
  timestamp: string,
): AdmissionDecision {
  const decision = evaluateAdmission(database, agent, inputCharacters);
  database.governanceEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: run.id,
    event: "resource_governance.admission",
    decision: decision.decision,
    reason: decision.reason,
    observedUsage: decision.observedUsage,
    appliedLimits: decision.appliedLimits,
    runtimeInvoked: false,
    actualTokensConsumed: null,
    createdAt: timestamp,
  });
  if (decision.decision === "admit") run.budgetReserved = true;
  return decision;
}

export function recordPolicyUpdate(
  database: Database,
  agent: Agent,
  previousLimits: AppliedResourceLimits,
  timestamp: string,
): void {
  database.governanceEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: null,
    event: "resource_governance.policy_updated",
    decision: null,
    reason: "policy_updated",
    observedUsage: observedUsage(database, agent),
    appliedLimits: resourceLimits(agent),
    previousLimits,
    runtimeInvoked: false,
    actualTokensConsumed: null,
    actor: "local_operator",
    createdAt: timestamp,
  });
}

export function recordUsageReconciliation(
  database: Database,
  agent: Agent,
  run: AgentRun,
  timestamp: string,
): void {
  database.governanceEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: run.id,
    event: "resource_governance.usage_reconciled",
    decision: null,
    reason: "usage_reconciled",
    observedUsage: observedUsage(database, agent, Array.from(run.prompt).length),
    appliedLimits: resourceLimits(agent),
    runtimeInvoked: true,
    actualTokensConsumed: totalTokens(run),
    createdAt: timestamp,
  });
}

export function admissionDenialMessage(decision: AdmissionDecision): string {
  if (decision.reason === "input_too_large") {
    return "Prompt exceeds this Agent's " + decision.appliedLimits.maxInputCharacters + "-character limit";
  }
  if (decision.reason === "run_limit_exhausted") {
    return "Budget exhausted: " + decision.observedUsage.runsUsed + " of " + decision.appliedLimits.maxRuns + " Runs used. Codex Runtime was not invoked.";
  }
  return "Budget exhausted: " + decision.observedUsage.tokensUsed + " of " + decision.appliedLimits.maxTotalTokens + " tokens used. Codex Runtime was not invoked.";
}
