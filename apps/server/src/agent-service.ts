import { randomUUID } from "node:crypto";
import {
  admitRun,
  budgetStatus,
  admissionDenialMessage,
  maybeQuarantine,
  recordPolicyUpdate,
  recordRuntimeTermination,
  recordUsageReconciliation,
  resourceLimits,
  runtimeTerminationMessage,
  unlimitedBudgetPolicy,
  unlimitedRuntimeLimits,
} from "./budget-service.js";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import { HttpError, RunCancelledError, RuntimeLimitError } from "./errors.js";
import { JsonStore } from "./store.js";
import type {
  Agent,
  AgentRun,
  AgentRunner,
  CreateAgentInput,
  Message,
  RuntimeTerminationDetail,
  UpdateAgentInput,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const now = () => new Date().toISOString();

export class AgentService {
  private readonly activeExecutions = new Map<string, Promise<void>>();
  private readonly cancellationRequests = new Set<string>();
  private readonly operatorKillRequests = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: JsonStore,
    private readonly workspaces: WorkspaceManager,
    private readonly runner: AgentRunner,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.workspaces.initialize();
    await this.store.mutate((database) => {
      for (const run of database.runs) {
        if (run.status === "queued" || run.status === "running") {
          run.status = "cancelled";
          run.error = "Server restarted while this run was active";
          run.completedAt = now();
        }
      }
      for (const agent of database.agents) {
        if (agent.status === "busy") {
          agent.status = "ready";
          agent.updatedAt = now();
        }
      }
    });
  }

  listAgents(): Agent[] {
    return this.store
      .snapshot()
      .agents.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  getAgent(id: string): Agent {
    const agent = this.store.snapshot().agents.find((item) => item.id === id);
    if (!agent) {
      throw new HttpError(404, "Agent not found");
    }
    return agent;
  }

  async createAgent(input: CreateAgentInput): Promise<Agent> {
    const timestamp = now();
    const id = randomUUID();
    const agent: Agent = {
      id,
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      instructions: input.instructions?.trim() ?? "",
      budgetPolicy: input.budgetPolicy ?? unlimitedBudgetPolicy(),
      maxPromptChars: input.maxPromptChars ?? null,
      runtimeLimits: input.runtimeLimits ?? unlimitedRuntimeLimits(),
      status: "ready",
      workspacePath: this.workspaces.workspacePath(id),
      codexThreadId: null,
      lastError: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.workspaces.create(agent);
    await this.store.mutate((database) => database.agents.push(agent));
    return agent;
  }

  async updateAgent(id: string, input: UpdateAgentInput): Promise<Agent> {
    const current = this.getAgent(id);
    if (current.status === "busy") {
      throw new HttpError(409, "Stop the active run before editing this Agent");
    }
    const updated = await this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before editing this Agent");
      }
      const previousLimits = resourceLimits(agent);
      const policyChanged =
        input.budgetPolicy !== undefined ||
        input.maxPromptChars !== undefined ||
        input.runtimeLimits !== undefined;
      if (input.name !== undefined) agent.name = input.name.trim();
      if (input.description !== undefined) agent.description = input.description.trim();
      if (input.instructions !== undefined) agent.instructions = input.instructions.trim();
      if (input.budgetPolicy !== undefined) agent.budgetPolicy = input.budgetPolicy;
      if (input.maxPromptChars !== undefined) agent.maxPromptChars = input.maxPromptChars;
      if (input.runtimeLimits !== undefined) agent.runtimeLimits = input.runtimeLimits;
      if (policyChanged) recordPolicyUpdate(database, agent, previousLimits, now());
      agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
    await this.workspaces.writeInstructions(updated);
    return updated;
  }

  async deleteAgent(id: string): Promise<{ archivedWorkspace: string }> {
    const agent = this.getAgent(id);
    await this.cancelExecution(id);
    const archivedWorkspace = await this.workspaces.archive(agent);
    await this.store.mutate((database) => {
      database.agents = database.agents.filter((item) => item.id !== id);
      database.messages = database.messages.filter((item) => item.agentId !== id);
      database.runs = database.runs.filter((item) => item.agentId !== id);
      database.governanceEvents = database.governanceEvents.filter((item) => item.agentId !== id);
    });
    return { archivedWorkspace };
  }

  async startAgent(id: string): Promise<Agent> {
    return this.setStatus(id, "ready");
  }

  async stopAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    await this.cancelExecution(id);
    return this.setStatus(id, "stopped");
  }

  /**
   * Operator kill switch: force-terminate any Run in progress and stop the
   * Agent. Unlike stopAgent, an in-flight Run is recorded as `terminated`
   * (reason `operator_kill`) with a governance event, and the Agent stays
   * stopped until an operator explicitly starts it again.
   */
  async killAgent(id: string): Promise<Agent> {
    this.getAgent(id);
    const hadActiveRun = this.activeExecutions.has(id);
    this.operatorKillRequests.add(id);
    try {
      await this.cancelExecution(id);
    } finally {
      this.operatorKillRequests.delete(id);
    }
    return this.store.mutate((database) => {
      const stored = database.agents.find((item) => item.id === id);
      if (!stored) {
        throw new HttpError(404, "Agent not found");
      }
      stored.status = "stopped";
      stored.lastError = null;
      stored.updatedAt = now();
      if (!hadActiveRun) {
        recordRuntimeTermination(
          database,
          stored,
          null,
          { reason: "operator_kill", limit: 0, observed: 0 },
          now(),
        );
      }
      return structuredClone(stored);
    });
  }

  getMessages(agentId: string): Message[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .messages.filter((message) => message.agentId === agentId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  getRun(runId: string): AgentRun {
    const run = this.store.snapshot().runs.find((item) => item.id === runId);
    if (!run) {
      throw new HttpError(404, "Run not found");
    }
    return run;
  }

  getRuns(agentId: string): AgentRun[] {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .runs.filter((run) => run.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getBudget(agentId: string) {
    const agent = this.getAgent(agentId);
    return budgetStatus(this.store.snapshot(), agent);
  }

  getBudgetEvents(agentId: string) {
    this.getAgent(agentId);
    return this.store
      .snapshot()
      .governanceEvents.filter((event) => event.agentId === agentId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async sendMessage(
    agentId: string,
    prompt: string,
  ): Promise<{ run: AgentRun; message: Message }> {
    if (!isArkConfigured(this.config)) {
      throw new HttpError(
        503,
        "Ark is not configured. Set ARK_API_KEY and ARK_MODEL, then restart.",
      );
    }
    const timestamp = now();
    const runId = randomUUID();
    const run: AgentRun = {
      id: runId,
      agentId,
      status: "queued",
      prompt,
      output: null,
      error: null,
      usage: null,
      budgetReserved: false,
      runtimeInvoked: false,
      terminationReason: null,
      startedAt: null,
      completedAt: null,
      createdAt: timestamp,
    };
    const message: Message = {
      id: randomUUID(),
      agentId,
      runId,
      role: "user",
      content: prompt,
      createdAt: timestamp,
    };
    const admission = await this.store.mutate((database) => {
      const storedAgent = database.agents.find((item) => item.id === agentId);
      if (!storedAgent) {
        throw new HttpError(404, "Agent not found");
      }
      if (storedAgent.status === "stopped") {
        throw new HttpError(409, "Start the Agent before sending a message");
      }
      if (storedAgent.status === "busy") {
        throw new HttpError(409, "This Agent is already running");
      }
      const decision = admitRun(
        database,
        storedAgent,
        run,
        Array.from(prompt).length,
        timestamp,
      );
      if (decision.decision === "deny" && decision.reason === "input_too_large") {
        return { agent: null, inputDenied: true, decision };
      }
      database.runs.push(run);
      database.messages.push(message);
      if (decision.decision === "deny") {
        run.status = "denied";
        run.error = admissionDenialMessage(decision);
        run.completedAt = timestamp;
        return { agent: null, inputDenied: false, decision };
      }
      const snapshot = structuredClone(storedAgent);
      storedAgent.status = "busy";
      storedAgent.lastError = null;
      storedAgent.updatedAt = timestamp;
      return { agent: snapshot, inputDenied: false, decision };
    });
    if (admission.inputDenied) throw new HttpError(422, admissionDenialMessage(admission.decision));
    if (!admission.agent) return { run, message };
    const agentAtStart = admission.agent;
    const execution = this.executeRun(agentAtStart, run);
    this.activeExecutions.set(agentId, execution);
    void execution
      .finally(() => {
        if (this.activeExecutions.get(agentId) === execution) {
          this.activeExecutions.delete(agentId);
        }
      })
      .catch(() => undefined);
    return { run, message };
  }

  async systemInfo(): Promise<Record<string, unknown>> {
    return {
      arkConfigured: isArkConfigured(this.config),
      arkBaseUrl: this.config.arkBaseUrl,
      arkModel: this.config.arkModel || null,
      codexAvailable: await this.runner.isAvailable(),
      codexSandboxMode: this.config.codexSandboxMode,
      runtimeProvider: this.config.runtimeProvider,
      containerEngine:
        this.config.runtimeProvider === "container"
          ? this.config.containerEngine
          : null,
      runtime:
        this.config.runtimeProvider === "container"
          ? "Codex CLI in " + this.config.containerEngine + " Runtime"
          : "Codex CLI in application container",
    };
  }

  private async executeRun(agentAtStart: Agent, run: AgentRun): Promise<void> {
    await this.store.mutate((database) => {
      const storedRun = database.runs.find((item) => item.id === run.id);
      if (storedRun) {
        storedRun.status = "running";
        storedRun.startedAt = now();
        storedRun.runtimeInvoked = true;
      }
    });
    try {
      if (this.cancellationRequests.has(agentAtStart.id)) {
        throw new RunCancelledError();
      }
      const runtimeLimits = agentAtStart.runtimeLimits ?? unlimitedRuntimeLimits();
      const result = await this.runner.run({
        agentId: agentAtStart.id,
        workspacePath: agentAtStart.workspacePath,
        prompt: run.prompt,
        threadId: agentAtStart.codexThreadId,
        limits: {
          durationMs: runtimeLimits.maxRunDurationMs ?? this.config.codexTimeoutMs,
          outputBytes: runtimeLimits.maxRunOutputBytes ?? this.config.codexMaxOutputBytes,
          cpus: runtimeLimits.maxRunCpus ?? this.config.containerCpuLimit,
          memoryMb: runtimeLimits.maxRunMemoryMb ?? this.config.containerMemoryMb,
          processes: runtimeLimits.maxRunProcesses ?? this.config.containerPidsLimit,
        },
      });
      const completedAt = now();
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (!storedRun || !agent) return;
        storedRun.status = "completed";
        storedRun.output = result.output;
        storedRun.usage = result.usage;
        storedRun.completedAt = completedAt;
        if (result.usage) recordUsageReconciliation(database, agent, storedRun, completedAt);
        database.messages.push({
          id: randomUUID(),
          agentId: agent.id,
          runId: run.id,
          role: "assistant",
          content: result.output,
          createdAt: completedAt,
        });
        agent.status = "ready";
        agent.codexThreadId = result.threadId;
        agent.lastError = null;
        agent.updatedAt = completedAt;
      });
    } catch (error) {
      const completedAt = now();
      const operatorKill =
        error instanceof RunCancelledError &&
        this.operatorKillRequests.has(agentAtStart.id);
      const cancelled = error instanceof RunCancelledError && !operatorKill;
      const runtimeLimit = error instanceof RuntimeLimitError;
      const terminated = runtimeLimit || operatorKill;
      const contained = cancelled || terminated;
      const termination: RuntimeTerminationDetail | null = runtimeLimit
        ? { reason: error.reason, limit: error.limit, observed: error.observed }
        : operatorKill
          ? { reason: "operator_kill", limit: 0, observed: 0 }
          : null;
      const message =
        termination !== null
          ? runtimeTerminationMessage(termination)
          : error instanceof Error
            ? error.message
            : String(error);
      await this.store.mutate((database) => {
        const storedRun = database.runs.find((item) => item.id === run.id);
        const agent = database.agents.find((item) => item.id === agentAtStart.id);
        if (storedRun) {
          storedRun.status = cancelled ? "cancelled" : terminated ? "terminated" : "failed";
          storedRun.error = message;
          storedRun.completedAt = completedAt;
          if (termination !== null) storedRun.terminationReason = termination.reason;
        }
        if (agent) {
          if (agent.status !== "stopped") {
            agent.status = operatorKill ? "stopped" : contained ? "ready" : "error";
          }
          agent.lastError = contained ? null : message;
          agent.updatedAt = completedAt;
        }
        if (termination !== null && storedRun && agent) {
          recordRuntimeTermination(database, agent, storedRun, termination, completedAt);
          if (termination.reason !== "operator_kill") {
            maybeQuarantine(
              database,
              agent,
              {
                threshold: this.config.runtimeQuarantineThreshold,
                windowMs: this.config.runtimeQuarantineWindowMs,
              },
              completedAt,
            );
          }
        }
      });
    }
  }

  private async setStatus(id: string, status: Agent["status"]): Promise<Agent> {
    return this.store.mutate((database) => {
      const agent = database.agents.find((item) => item.id === id);
      if (!agent) {
        throw new HttpError(404, "Agent not found");
      }
      if (status === "ready" && agent.status === "busy") {
        throw new HttpError(409, "Stop the active run before starting this Agent");
      }
      agent.status = status;
      if (status === "ready") agent.lastError = null;
      agent.updatedAt = now();
      return structuredClone(agent);
    });
  }

  private async cancelExecution(agentId: string): Promise<void> {
    this.cancellationRequests.add(agentId);
    try {
      await this.runner.cancel(agentId);
      const execution = this.activeExecutions.get(agentId);
      if (execution) {
        await execution;
      }
    } finally {
      this.cancellationRequests.delete(agentId);
    }
  }
}
