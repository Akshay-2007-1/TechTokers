export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
    this.name = "RunCancelledError";
  }
}

export type RuntimeTerminationReason = "duration_exceeded" | "output_exceeded";

/**
 * Thrown by an AgentRunner when a per-Run resource limit forces it to kill the
 * Runtime in progress. Distinct from a Codex crash so the control plane can
 * record a `terminated` Run rather than a `failed` one.
 */
export class RuntimeLimitError extends Error {
  constructor(
    public readonly reason: RuntimeTerminationReason,
    public readonly limit: number,
    public readonly observed: number,
  ) {
    super(
      reason === "duration_exceeded"
        ? "Run terminated: exceeded the " + limit + " ms runtime limit"
        : "Run terminated: exceeded the " + limit + " byte output limit",
    );
    this.name = "RuntimeLimitError";
  }
}
