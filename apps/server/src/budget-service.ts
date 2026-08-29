import { randomUUID } from "node:crypto";
import type {
  AdmissionDecision,
  AdmissionReason,
  Agent,
  AgentBudgetPolicy,
  AgentBudgetStatus,
  AgentRuntimeLimits,
  AgentRun,
  AppliedResourceLimits,
  Database,
  ResourceObservedUsage,
  RuntimeTerminationDetail,
} from "./types.js";

// This is the Resource Governance admission component. The filename remains
// stable to avoid a needless public-module rename from the original budget MVP.
export const unlimitedBudgetPolicy = (): AgentBudgetPolicy => ({
  maxRuns: null,
  maxTotalTokens: null,
});

export const unlimitedRuntimeLimits = (): AgentRuntimeLimits => ({
  maxRunDurationMs: null,
  maxRunOutputBytes: null,
  maxRunCpus: null,
  maxRunMemoryMb: null,
  maxRunProcesses: null,
});

export function totalTokens(run: AgentRun): number {
  return (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0);
}

function countsTowardRuns(run: AgentRun): boolean {
  return run.budgetReserved || run.runtimeInvoked || run.startedAt !== null;
}

export function resourceLimits(agent: Agent): AppliedResourceLimits {
  const policy = agent.budgetPolicy ?? unlimitedBudgetPolicy();
  const runtime = agent.runtimeLimits ?? unlimitedRuntimeLimits();
  return {
    maxRuns: policy.maxRuns,
    maxTotalTokens: policy.maxTotalTokens,
    maxInputCharacters: agent.maxPromptChars,
    maxRunDurationMs: runtime.maxRunDurationMs,
    maxRunOutputBytes: runtime.maxRunOutputBytes,
    maxRunCpus: runtime.maxRunCpus ?? null,
    maxRunMemoryMb: runtime.maxRunMemoryMb ?? null,
    maxRunProcesses: runtime.maxRunProcesses ?? null,
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

export function recordRuntimeTermination(
  database: Database,
  agent: Agent,
  run: AgentRun | null,
  termination: RuntimeTerminationDetail,
  timestamp: string,
): void {
  database.governanceEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: run?.id ?? null,
    event: "resource_governance.run_terminated",
    decision: null,
    reason: "run_terminated",
    observedUsage: observedUsage(database, agent, run ? Array.from(run.prompt).length : 0),
    appliedLimits: resourceLimits(agent),
    runtimeInvoked: run !== null,
    actualTokensConsumed: run?.usage ? totalTokens(run) : null,
    runtimeTermination: termination,
    actor: termination.reason === "operator_kill" ? "local_operator" : undefined,
    createdAt: timestamp,
  });
}

/**
 * Escalating containment: if an Agent has produced `threshold` runtime
 * terminations within `windowMs`, stop it and record the quarantine so an
 * operator has to re-enable it. Operator kills are excluded — those are
 * already a deliberate stop. Returns true when the Agent was quarantined.
 */
export function maybeQuarantine(
  database: Database,
  agent: Agent,
  policy: { threshold: number; windowMs: number },
  timestamp: string,
): boolean {
  if (agent.status === "stopped") return false;
  const windowStart = Date.parse(timestamp) - policy.windowMs;
  const recent = database.governanceEvents.filter(
    (event) =>
      event.agentId === agent.id &&
      event.event === "resource_governance.run_terminated" &&
      (event.runtimeTermination?.reason === "duration_exceeded" ||
        event.runtimeTermination?.reason === "output_exceeded") &&
      Date.parse(event.createdAt) >= windowStart,
  ).length;
  if (recent < policy.threshold) return false;
  agent.status = "stopped";
  agent.lastError =
    "Auto-quarantined after " +
    recent +
    " runtime terminations within " +
    Math.round(policy.windowMs / 60_000) +
    " min. Start the Agent to clear it.";
  database.governanceEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: null,
    event: "resource_governance.agent_quarantined",
    decision: null,
    reason: "agent_quarantined",
    observedUsage: observedUsage(database, agent),
    appliedLimits: resourceLimits(agent),
    runtimeInvoked: false,
    actualTokensConsumed: null,
    actor: "local_operator",
    createdAt: timestamp,
  });
  return true;
}

export function runtimeTerminationMessage(termination: RuntimeTerminationDetail): string {
  if (termination.reason === "operator_kill") {
    return "Run terminated by the operator kill switch. The Agent has been stopped.";
  }
  if (termination.reason === "duration_exceeded") {
    return (
      "Run terminated by the runtime guard: exceeded the " +
      termination.limit +
      " ms per-Run time limit (ran " +
      termination.observed +
      " ms)."
    );
  }
  return (
    "Run terminated by the runtime guard: exceeded the " +
    termination.limit +
    " byte per-Run output limit (produced " +
    termination.observed +
    " bytes)."
  );
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
