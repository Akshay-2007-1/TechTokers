import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, setAuthToken } from "./api";
import type {
  Agent,
  AgentBudgetPolicy,
  AgentBudgetStatus,
  AgentRuntimeLimits,
  AgentRun,
  GovernanceEvent,
  Message,
  SystemInfo,
  WorkspaceChangeSet,
} from "./types";

const starterPrompts = [
  "Create a small TypeScript CLI that prints a weather summary from sample JSON.",
  "Inspect this workspace and explain what you would improve first.",
  "Build a responsive single-page todo app with tests.",
];

const emptyForm = {
  name: "",
  description: "",
  instructions:
    "Help me build and test software in this workspace. Keep changes small and explain the result.",
  maxRuns: "",
  maxTotalTokens: "",
  maxPromptChars: "",
  maxRunSeconds: "",
  maxRunOutputKb: "",
  maxRunCpus: "",
  maxRunMemoryMb: "",
  maxRunProcesses: "",
  workspaceApprovalMode: "review" as "auto" | "review",
};

function budgetPolicyFromForm(form: typeof emptyForm): AgentBudgetPolicy {
  const limit = (label: string, raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(label + " must be a whole number 0 or greater, or blank for unlimited.");
    }
    return value;
  };
  return {
    maxRuns: limit("Maximum Runs", form.maxRuns),
    maxTotalTokens: limit("Total-token budget", form.maxTotalTokens),
  };
}

function agentPayloadFromForm(form: typeof emptyForm) {
  return {
    name: form.name,
    description: form.description,
    instructions: form.instructions,
    budgetPolicy: budgetPolicyFromForm(form),
    maxPromptChars: form.maxPromptChars === "" ? null : Number(form.maxPromptChars),
    runtimeLimits: runtimeLimitsFromForm(form),
    workspaceApprovalMode: form.workspaceApprovalMode,
  };
}

function runtimeLimitsFromForm(form: typeof emptyForm): AgentRuntimeLimits {
  const optionalNumber = (label: string, raw: string, min: number, max: number, scale = 1) => {
    if (raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(label + " must be positive, or blank to use the server default.");
    return Math.min(max, Math.max(min, Math.round(value * scale)));
  };
  const cpus = form.maxRunCpus.trim() === "" ? null : Number(form.maxRunCpus);
  if (cpus !== null && (!Number.isFinite(cpus) || cpus <= 0)) throw new Error("Max Run CPUs must be positive, or blank to use the server default.");
  return {
    maxRunDurationMs: optionalNumber("Max Run duration", form.maxRunSeconds, 1_000, 3_600_000, 1_000),
    maxRunOutputBytes: optionalNumber("Max Run output", form.maxRunOutputKb, 1_024, 67_108_864, 1_024),
    maxRunCpus: cpus === null ? null : Math.min(64, Math.max(0.1, cpus)),
    maxRunMemoryMb: optionalNumber("Max Run memory", form.maxRunMemoryMb, 64, 131_072),
    maxRunProcesses: optionalNumber("Max Run processes", form.maxRunProcesses, 16, 16_384),
  };
}

type UtilizationState = "unlimited" | "healthy" | "warning" | "exhausted";

function utilizationState(used: number, limit: number | null): UtilizationState {
  if (limit === null) return "unlimited";
  if (used >= limit) return "exhausted";
  return used / limit >= 0.8 ? "warning" : "healthy";
}

function highestUtilizationState(states: UtilizationState[]): UtilizationState {
  const rank: Record<UtilizationState, number> = {
    unlimited: 0,
    healthy: 1,
    warning: 2,
    exhausted: 3,
  };
  return states.reduce((highest, current) => rank[current] > rank[highest] ? current : highest);
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function StatusPill({ status }: { status: Agent["status"] }) {
  return (
    <span className={"status status-" + status}>
      <span className="status-dot" />
      {status}
    </span>
  );
}

function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

function BudgetFields({
  form,
  setForm,
}: {
  form: typeof emptyForm;
  setForm: (next: typeof emptyForm) => void;
}) {
  return (
    <div className="form-grid budget-fields">
      <label>
        Maximum Runs (optional)
        <input
          type="number"
          min="0"
          max="1000000"
          step="1"
          value={form.maxRuns}
          onChange={(event) => setForm({ ...form, maxRuns: event.target.value })}
        />
      </label>
      <label>
        Total-token budget (optional)
        <input
          type="number"
          min="0"
          max="1000000000"
          step="1"
          value={form.maxTotalTokens}
          onChange={(event) => setForm({ ...form, maxTotalTokens: event.target.value })}
        />
      </label>
    </div>
  );
}

function RuntimeLimitFields({ form, setForm, defaults }: { form: typeof emptyForm; setForm: (next: typeof emptyForm) => void; defaults?: SystemInfo["runtimeDefaults"] }) {
  const placeholder = (value: number | undefined, scale = 1) => value === undefined ? "server default" : String(Math.round(value / scale));
  return <div className="form-grid budget-fields">
    <p className="field-hint" style={{ gridColumn: "1 / -1", margin: 0 }}>Blank inherits the server default shown in grey; it is not unlimited.</p>
    <label>Max Run duration, seconds (optional)<input type="number" min="1" max="3600" placeholder={placeholder(defaults?.maxRunDurationMs, 1000)} value={form.maxRunSeconds} onChange={(event) => setForm({ ...form, maxRunSeconds: event.target.value })} /></label>
    <label>Max Run output, KB (optional)<input type="number" min="1" max="65536" placeholder={placeholder(defaults?.maxRunOutputBytes, 1024)} value={form.maxRunOutputKb} onChange={(event) => setForm({ ...form, maxRunOutputKb: event.target.value })} /></label>
    <label>Max Run CPUs (container only)<input type="number" min="0.1" max="64" step="0.1" placeholder={placeholder(defaults?.maxRunCpus)} value={form.maxRunCpus} onChange={(event) => setForm({ ...form, maxRunCpus: event.target.value })} /></label>
    <label>Max Run memory, MB (container only)<input type="number" min="64" max="131072" placeholder={placeholder(defaults?.maxRunMemoryMb)} value={form.maxRunMemoryMb} onChange={(event) => setForm({ ...form, maxRunMemoryMb: event.target.value })} /></label>
    <label>Max Run processes (container only)<input type="number" min="16" max="16384" placeholder={placeholder(defaults?.maxRunProcesses)} value={form.maxRunProcesses} onChange={(event) => setForm({ ...form, maxRunProcesses: event.target.value })} /></label>
  </div>;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [prompt, setPrompt] = useState("");
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [changeSet, setChangeSet] = useState<WorkspaceChangeSet | null>(null);
  const [budget, setBudget] = useState<AgentBudgetStatus | null>(null);
  const [governanceEvents, setGovernanceEvents] = useState<GovernanceEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  const [authInput, setAuthInput] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const pollingRunIds = useRef(new Set<string>());
  selectedIdRef.current = selectedId;

  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );
  const promptCharacterCount = Array.from(prompt).length;
  const promptLimit = selected?.maxPromptChars ?? null;
  const promptIsTooLong = promptLimit !== null && promptCharacterCount > promptLimit;
  const inputUtilization = utilizationState(promptCharacterCount, promptLimit);
  const budgetUtilization = budget
    ? highestUtilizationState([
        utilizationState(budget.runsUsed, budget.policy.maxRuns),
        utilizationState(budget.tokensUsed, budget.policy.maxTotalTokens),
      ])
    : "unlimited";

  const refreshAgents = useCallback(async () => {
    const { agents: next } = await api.listAgents();
    setAgents(next);
    setSelectedId((current) =>
      current && next.some((agent) => agent.id === current)
        ? current
        : (next[0]?.id ?? null),
    );
  }, []);

  const refreshMessages = useCallback(async (agentId: string) => {
    const result = await api.messages(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setMessages(result.messages);
    }
  }, []);

  const refreshBudget = useCallback(async (agentId: string) => {
    const result = await api.budget(agentId);
    if (mountedRef.current && selectedIdRef.current === agentId) {
      setBudget(result.budget);
      setGovernanceEvents(result.events);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    await Promise.all([refreshAgents(), api.system().then(setSystem)]);
  }, [refreshAgents]);

  useEffect(() => {
    mountedRef.current = true;
    void api
      .auth()
      .then(async ({ required }) => {
        if (!mountedRef.current) return;
        setAuthRequired(required);
        if (!required) await bootstrap();
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mountedRef.current = false;
    };
  }, [bootstrap]);

  useEffect(() => {
    setActiveRun(null);
    setShowSettings(false);
    if (!selectedId) {
      setMessages([]);
      setBudget(null);
      setGovernanceEvents([]);
      return;
    }
    void Promise.all([
      refreshMessages(selectedId),
      api.runs(selectedId),
      refreshBudget(selectedId),
      api.pendingWorkspaceChanges(selectedId),
    ])
      .then(([, result, , pending]) => {
        if (selectedIdRef.current !== selectedId) return;
        // A pending proposal is authoritative. It must win over simple run
        // ordering after a browser/server restart so the approval panel returns.
        const pendingRun = pending.changeSet
          ? result.runs.find((run) => run.id === pending.changeSet?.runId) ?? null
          : null;
        const active = pendingRun ?? result.runs[0] ?? null;
        setChangeSet(pending.changeSet);
        setActiveRun(active);
        if (active && ["queued", "running"].includes(active.status)) {
          void pollRun(active.id, selectedId).catch((reason) =>
            setError(reason instanceof Error ? reason.message : String(reason)),
          );
        }
      })
      .catch((reason) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      );
  }, [refreshBudget, refreshMessages, selectedId]);

  useEffect(() => {
    if (selected) {
      setForm({
        name: selected.name,
        description: selected.description,
        instructions: selected.instructions,
        maxRuns: selected.budgetPolicy.maxRuns === null ? "" : String(selected.budgetPolicy.maxRuns),
        maxTotalTokens:
          selected.budgetPolicy.maxTotalTokens === null
            ? ""
            : String(selected.budgetPolicy.maxTotalTokens),
        maxPromptChars:
          selected.maxPromptChars === null ? "" : String(selected.maxPromptChars),
        maxRunSeconds: selected.runtimeLimits.maxRunDurationMs === null ? "" : String(Math.round(selected.runtimeLimits.maxRunDurationMs / 1000)),
        maxRunOutputKb: selected.runtimeLimits.maxRunOutputBytes === null ? "" : String(Math.round(selected.runtimeLimits.maxRunOutputBytes / 1024)),
        maxRunCpus: selected.runtimeLimits.maxRunCpus === null ? "" : String(selected.runtimeLimits.maxRunCpus),
        maxRunMemoryMb: selected.runtimeLimits.maxRunMemoryMb === null ? "" : String(selected.runtimeLimits.maxRunMemoryMb),
        maxRunProcesses: selected.runtimeLimits.maxRunProcesses === null ? "" : String(selected.runtimeLimits.maxRunProcesses),
        workspaceApprovalMode: selected.workspaceApprovalMode,
      });
    }
  }, [selected]);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, activeRun]);

  useEffect(() => {
    if (!selected || activeRun?.status !== "awaiting_approval") { setChangeSet(null); return; }
    void api.workspaceChanges(selected.id, activeRun.id).then((result) => setChangeSet(result.changeSet)).catch(() => setChangeSet(null));
  }, [activeRun, selected]);

  const decideChanges = async (approve: boolean) => {
    if (!selected || !activeRun) return;
    const result = await api.decideWorkspaceChanges(selected.id, activeRun.id, approve);
    setChangeSet(result.changeSet);
    if (result.changeSet.status === "approved" || result.changeSet.status === "denied") {
      setActiveRun({ ...activeRun, status: "completed" });
    } else {
      setActiveRun({ ...activeRun, status: "failed", error: "Workspace changes were not applied: " + result.changeSet.status });
    }
  };

  const createAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { agent } = await api.createAgent(agentPayloadFromForm(form));
      await refreshAgents();
      setSelectedId(agent.id);
      setShowCreate(false);
      setForm(emptyForm);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const saveAgent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateAgent(selected.id, agentPayloadFromForm(form));
      await Promise.all([refreshAgents(), refreshBudget(selected.id)]);
      setShowSettings(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const setWorkspaceMode = async (workspaceApprovalMode: "auto" | "review") => {
    if (!selected) return;
    setError(null);
    try {
      await api.updateAgent(selected.id, {
        name: selected.name, description: selected.description, instructions: selected.instructions,
        budgetPolicy: selected.budgetPolicy, maxPromptChars: selected.maxPromptChars, workspaceApprovalMode,
        runtimeLimits: selected.runtimeLimits,
      });
      setForm({ ...form, workspaceApprovalMode });
      await refreshAgents();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  const toggleAgent = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      if (selected.status === "stopped") {
        await api.startAgent(selected.id);
      } else {
        await api.stopAgent(selected.id);
      }
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const killAgent = async () => {
    if (!selected || !window.confirm("Kill force-terminates a running task and stops this Agent. Use Stop for an ordinary pause.")) return;
    setBusy(true); setError(null);
    try { await api.killAgent(selected.id); await Promise.all([refreshAgents(), refreshBudget(selected.id)]); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const deleteAgent = async () => {
    if (!selected) return;
    if (!window.confirm("Delete " + selected.name + "? Its workspace will be archived.")) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.deleteAgent(selected.id);
      await refreshAgents();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pollRun = async (runId: string, agentId: string) => {
    if (pollingRunIds.current.has(runId)) return;
    pollingRunIds.current.add(runId);
    try {
      while (mountedRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        if (!mountedRef.current) return;
        const result = await api.run(runId);
        if (selectedIdRef.current === agentId) setActiveRun(result.run);
        if (!["queued", "running"].includes(result.run.status)) {
          await Promise.all([refreshMessages(agentId), refreshAgents(), refreshBudget(agentId)]);
          return;
        }
      }
    } finally {
      pollingRunIds.current.delete(runId);
    }
  };

  const sendMessage = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !prompt.trim()) return;
    const content = prompt.trim();
    setPrompt("");
    setError(null);
    try {
      const result = await api.sendMessage(selected.id, content);
      if (selectedIdRef.current === selected.id) {
        setMessages((current) => [...current, result.message]);
        setActiveRun(result.run);
      }
      if (result.run.status === "denied") {
        // The server rejected the Run before invoking the Runtime; the Agent
        // never went busy, so don't flip it locally or start polling.
        void refreshBudget(selected.id).catch(() => undefined);
        return;
      }
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "busy" } : agent,
        ),
      );
      await pollRun(result.run.id, selected.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setActiveRun(null);
      await refreshAgents();
    }
  };

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAuthToken(authInput);
    try {
      await bootstrap();
      setAuthRequired(false);
      setAuthInput("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("The access token is not valid.");
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setBusy(false);
    }
  };

  if (authRequired === null) {
    return (
      <main className="auth-screen">
        <section className="auth-card" aria-live="polite">
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Connecting to the control plane</h1>
          {error ? <div className="error-banner" role="alert">{error}</div> : <Spinner />}
        </section>
      </main>
    );
  }

  if (authRequired) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={unlock}>
          <div className="brand-mark">A</div>
          <span className="eyebrow">Agent Launchpad</span>
          <h1>Enter the access token</h1>
          <p>This shared demo token is configured by the platform operator.</p>
          {error && <div className="error-banner" role="alert">{error}</div>}
          <label>
            Access token
            <input
              autoFocus
              type="password"
              value={authInput}
              onChange={(event) => setAuthInput(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="button button-primary" disabled={busy || !authInput.trim()}>
            {busy ? <Spinner /> : "Open Launchpad"}
          </button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <strong>Agent Launchpad</strong>
            <span>
              {system?.runtimeProvider === "container"
                ? "Local container · Codex CLI"
                : "ECS / Docker · Codex CLI"}
            </span>
          </div>
        </div>

        <button
          className="button button-primary create-button"
          onClick={() => {
            setForm(emptyForm);
            setShowCreate(true);
          }}
        >
          <span>＋</span> Create Agent
        </button>

        <div className="sidebar-label">
          <span>Your Agents</span>
          <span>{agents.length}</span>
        </div>
        <nav className="agent-list">
          {agents.map((agent) => (
            <button
              className={"agent-card " + (agent.id === selectedId ? "selected" : "")}
              key={agent.id}
              onClick={() => setSelectedId(agent.id)}
            >
              <div className="agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</div>
              <div className="agent-card-copy">
                <strong>{agent.name}</strong>
                <span>{agent.description || "Coding Agent"}</span>
              </div>
              <span className={"mini-dot mini-" + agent.status} />
            </button>
          ))}
          {agents.length === 0 && (
            <div className="empty-sidebar">
              <span>◇</span>
              Create your first coding Agent.
            </div>
          )}
        </nav>

        <div className="runtime-card">
          <span className="eyebrow">Runtime</span>
          <strong>{system?.runtime ?? "Checking…"}</strong>
          <span>
            {system?.arkModel ?? "Ark model not configured"}
            {system?.containerEngine ? " · " + system.containerEngine : ""}
          </span>
        </div>
      </aside>

      <main className="main">
        {!system?.arkConfigured || !system?.codexAvailable ? (
          <div className="config-banner">
            <span>!</span>
            <div>
              <strong>Runtime configuration needed</strong>
              <p>
                {!system?.arkConfigured
                  ? "Set ARK_API_KEY and ARK_MODEL in .env before using the Playground."
                  : system.runtimeProvider === "container"
                    ? "The local container engine or Agent Runtime image is unavailable. Rerun npm run poc."
                    : "Codex CLI was not found. Use the Docker image or install @openai/codex."}
              </p>
            </div>
          </div>
        ) : null}

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        )}

        {selected ? (
          <>
            <header className="agent-header">
              <div>
                <div className="header-title-row">
                  <h1>{selected.name}</h1>
                  <StatusPill status={selected.status} />
                </div>
                <p>{selected.description || "A Codex coding Agent in an isolated workspace."}</p>
              </div>
              <div className="header-actions">
                <button
                  className="button button-ghost"
                  onClick={() => setShowSettings((value) => !value)}
                  disabled={busy || selected.status === "busy"}
                >
                  Settings
                </button>
                <button
                  className="button button-ghost"
                  onClick={toggleAgent}
                  disabled={busy}
                >
                  {selected.status === "stopped" ? "Start" : "Stop"}
                </button>
                <button className="button button-danger" onClick={killAgent} disabled={busy || selected.status === "stopped"} title="Kill is the containment action; it terminates an active Run and records an operator-kill audit event.">Kill</button>
                <button
                  className="button button-danger"
                  onClick={deleteAgent}
                  disabled={busy || selected.status === "busy"}
                >
                  Delete
                </button>
              </div>
            </header>

            {budget && (
              <section className="budget-summary" aria-label="Agent budget">
                <strong>Budget</strong>
                <span>
                  {budget.runsUsed} / {budget.policy.maxRuns ?? "∞"} Runs · {budget.tokensUsed} / {budget.policy.maxTotalTokens ?? "∞"} tokens · {budgetUtilization}
                </span>
                {governanceEvents[0] && (
                  <span>
                    Latest evidence: {governanceEvents[0].reason} · {formatTime(governanceEvents[0].createdAt)}
                  </span>
                )}
              </section>
            )}

            {showSettings && (
              <form className="settings-panel" onSubmit={saveAgent}>
                <div className="settings-title">
                  <div>
                    <span className="eyebrow">Agent configuration</span>
                    <h2>Instructions and identity</h2>
                  </div>
                  <button type="button" onClick={() => setShowSettings(false)}>×</button>
                </div>
                <div className="form-grid">
                  <label>
                    Name
                    <input
                      value={form.name}
                      onChange={(event) => setForm({ ...form, name: event.target.value })}
                      required
                      maxLength={80}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      value={form.description}
                      onChange={(event) =>
                        setForm({ ...form, description: event.target.value })
                      }
                      maxLength={500}
                    />
                  </label>
                  <label>
                    Maximum prompt length
                    <input
                      type="number"
                      min={1}
                      max={50_000}
                      step={1}
                      placeholder="Unlimited"
                      value={form.maxPromptChars}
                      onChange={(event) =>
                        setForm({ ...form, maxPromptChars: event.target.value })
                      }
                    />
                  </label>
                </div>
                <label>
                  System instructions
                  <textarea
                    value={form.instructions}
                    onChange={(event) =>
                      setForm({ ...form, instructions: event.target.value })
                    }
                    rows={5}
                    maxLength={10_000}
                  />
                </label>
                <BudgetFields form={form} setForm={setForm} />
                <RuntimeLimitFields form={form} setForm={setForm} defaults={system?.runtimeDefaults} />
                <div className="panel-footer">
                  <code>{selected.workspacePath}</code>
                  <button className="button button-primary" disabled={busy}>
                    {busy ? <Spinner /> : "Save changes"}
                  </button>
                </div>
              </form>
            )}

            <section className="playground">
              <div className="playground-topbar">
                <div>
                  <span className="eyebrow">Playground</span>
                  <h2>Build something with your Agent</h2>
                </div>
                <div className="session-info">
                  <span className="pulse" />
                  {selected.codexThreadId ? "Session connected" : "New session"}
                </div>
              </div>

              <div className="messages">
                {messages.length === 0 && !activeRun ? (
                  <div className="welcome">
                    <div className="welcome-orbit">
                      <div>⌁</div>
                    </div>
                    <h3>What should {selected.name} build?</h3>
                    <p>
                      The Agent can inspect files, write code, run commands, and continue the
                      same Codex session across messages.
                    </p>
                    <div className="prompt-grid">
                      {starterPrompts.map((item) => (
                        <button key={item} onClick={() => setPrompt(item)}>
                          <span>↗</span>
                          {item}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((message) => (
                    <article className={"message message-" + message.role} key={message.id}>
                      <div className="message-meta">
                        <strong>{message.role === "user" ? "You" : selected.name}</strong>
                        <span>{formatTime(message.createdAt)}</span>
                      </div>
                      <div className="message-body">{message.content}</div>
                    </article>
                  ))
                )}
                {activeRun && ["queued", "running"].includes(activeRun.status) && (
                  <article className="message message-assistant thinking">
                    <div className="message-meta">
                      <strong>{selected.name}</strong>
                      <span>working in the Agent workspace</span>
                    </div>
                    <div className="thinking-row">
                      <Spinner />
                      Codex is reading, editing, or running commands…
                    </div>
                  </article>
                )}
                {(activeRun?.status === "failed" || activeRun?.status === "denied") && (
                  <article className="run-error">
                    <strong>{activeRun.status === "denied" ? "Run denied" : "Run failed"}</strong>
                    <span>{activeRun.error}</span>
                  </article>
                )}
                {changeSet && (
                  <article className="workspace-approval">
                    <span className="eyebrow">Workspace approval</span>
                    <strong>Changes are staged, not yet persistent.</strong>
                    <span className="workspace-change-list">{changeSet.changes.map((change) => `${change.kind}: ${change.path}`).join(" · ")}</span>
                    <div className="workspace-approval-actions">
                      <button className="button button-primary" type="button" onClick={() => void decideChanges(true)}>Approve changes</button>
                      <button className="button button-danger" type="button" onClick={() => void decideChanges(false)}>Deny changes</button>
                    </div>
                  </article>
                )}
                <div ref={messageEnd} />
              </div>

              <form className="composer" onSubmit={sendMessage}>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder={
                    selected.status === "stopped"
                      ? "Start this Agent to continue…"
                      : "Describe what you want the Agent to do…"
                  }
                  disabled={
                    selected.status === "stopped" ||
                    selected.status === "busy" ||
                    activeRun != null && ["queued", "running"].includes(activeRun.status)
                  }
                  rows={3}
                />
                <div className="composer-footer">
                  <label className="workspace-mode" title="Controls how workspace changes are handled">
                    <span>Changes</span>
                    <select value={selected.workspaceApprovalMode} onChange={(event) => void setWorkspaceMode(event.target.value as "auto" | "review")} disabled={selected.status === "busy"}>
                      <option value="review">Review</option>
                      <option value="auto">Auto</option>
                    </select>
                  </label>
                  <span>
                    Enter to send · Shift + Enter for newline · {system?.codexSandboxMode ?? "checking sandbox"} · {promptLimit === null
                      ? "No prompt limit"
                      : promptCharacterCount + " / " + promptLimit + " characters · " + inputUtilization}
                    {promptIsTooLong ? " · Prompt exceeds this Agent's limit" : ""}
                  </span>
                  <button
                    className="send-button"
                    disabled={
                      !prompt.trim() ||
                      selected.status === "stopped" ||
                      selected.status === "busy" ||
                      promptIsTooLong ||
                      (activeRun != null && ["queued", "running"].includes(activeRun.status))
                    }
                    aria-label="Send message"
                  >
                    ↑
                  </button>
                </div>
              </form>
            </section>
          </>
        ) : (
          <div className="no-agent">
            <div className="no-agent-art">A</div>
            <span className="eyebrow">Agent Launchpad</span>
            <h1>Your runtime is ready for an Agent.</h1>
            <p>Create a workspace, give Codex a job, and continue the conversation here.</p>
            <button
              className="button button-primary"
              onClick={() => {
                setForm(emptyForm);
                setShowCreate(true);
              }}
            >
              Create your first Agent
            </button>
          </div>
        )}
      </main>

      {showCreate && (
        <div className="modal-backdrop" onMouseDown={() => setShowCreate(false)}>
          <form
            className="modal"
            onSubmit={createAgent}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">New workspace</span>
                <h2>Create an Agent</h2>
                <p>Each Agent gets a persistent folder and a resumable Codex session.</p>
              </div>
              <button type="button" onClick={() => setShowCreate(false)}>×</button>
            </div>
            <label>
              Name
              <input
                autoFocus
                placeholder="Frontend Builder"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={80}
              />
            </label>
            <label>
              Description
              <input
                placeholder="Builds polished React prototypes"
                value={form.description}
                onChange={(event) =>
                  setForm({ ...form, description: event.target.value })
                }
                maxLength={500}
              />
            </label>
            <label>
              Maximum prompt length
              <input
                type="number"
                min={1}
                max={50_000}
                step={1}
                placeholder="Unlimited"
                value={form.maxPromptChars}
                onChange={(event) =>
                  setForm({ ...form, maxPromptChars: event.target.value })
                }
              />
            </label>
            <label>
              Workspace change mode
              <select value={form.workspaceApprovalMode} onChange={(event) => setForm({ ...form, workspaceApprovalMode: event.target.value as "auto" | "review" })}>
                <option value="review">Review every change</option>
                <option value="auto">Auto-apply ordinary code changes</option>
              </select>
            </label>
            <label>
              Instructions
              <textarea
                value={form.instructions}
                onChange={(event) =>
                  setForm({ ...form, instructions: event.target.value })
                }
                rows={6}
                maxLength={10_000}
              />
            </label>
            <BudgetFields form={form} setForm={setForm} />
            <RuntimeLimitFields form={form} setForm={setForm} defaults={system?.runtimeDefaults} />
            <div className="modal-footer">
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </button>
              <button className="button button-primary" disabled={busy}>
                {busy ? <Spinner /> : "Create Agent"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
