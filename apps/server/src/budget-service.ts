import { randomUUID } from "node:crypto";
import type {
  Agent,
  AgentBudgetPolicy,
  AgentBudgetStatus,
  AgentRun,
  BudgetDenialReason,
  Database,
} from "./types.js";

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

export function budgetStatus(database: Database, agent: Agent): AgentBudgetStatus {
  const policy = agent.budgetPolicy ?? unlimitedBudgetPolicy();
  const runs = database.runs.filter((run) => run.agentId === agent.id);
  const runsUsed = runs.filter(countsTowardRuns).length;
  const tokensUsed = runs.reduce((total, run) => total + totalTokens(run), 0);
  return {
    policy,
    runsUsed,
    tokensUsed,
    runsRemaining: policy.maxRuns === null ? null : Math.max(0, policy.maxRuns - runsUsed),
    tokensRemaining:
      policy.maxTotalTokens === null ? null : Math.max(0, policy.maxTotalTokens - tokensUsed),
  };
}

export type BudgetAdmission =
  | { admitted: true; status: AgentBudgetStatus }
  | { admitted: false; status: AgentBudgetStatus; reason: BudgetDenialReason };

export function admitRun(
  database: Database,
  agent: Agent,
  run: AgentRun,
  timestamp: string,
): BudgetAdmission {
  const status = budgetStatus(database, agent);
  const reason =
    status.policy.maxRuns !== null && status.runsUsed >= status.policy.maxRuns
      ? "run_limit_exhausted"
      : status.policy.maxTotalTokens !== null && status.tokensUsed >= status.policy.maxTotalTokens
        ? "token_limit_exhausted"
        : null;
  database.budgetEvents.push({
    id: randomUUID(),
    agentId: agent.id,
    runId: run.id,
    event: reason ? "budget.run_denied" : "budget.run_admitted",
    reason,
    runsUsed: status.runsUsed,
    maxRuns: status.policy.maxRuns,
    tokensUsed: status.tokensUsed,
    maxTotalTokens: status.policy.maxTotalTokens,
    runtimeInvoked: false,
    createdAt: timestamp,
  });
  if (reason) return { admitted: false, status, reason };
  run.budgetReserved = true;
  return { admitted: true, status };
}

export function budgetDenialMessage(reason: BudgetDenialReason, status: AgentBudgetStatus): string {
  if (reason === "run_limit_exhausted") {
    return "Budget exhausted: " + status.runsUsed + " of " + status.policy.maxRuns + " Runs used. Codex Runtime was not invoked.";
  }
  return "Budget exhausted: " + status.tokensUsed + " of " + status.policy.maxTotalTokens + " tokens used. Codex Runtime was not invoked.";
}
