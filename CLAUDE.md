# TechTokers — TikTok TechJam: Agent Launchpad

## What this is

Starter kit for the TikTok TechJam **"Agent Launchpad: Design and Build
Lightweight Agent Middleware"** track. The platform (React UI, Fastify control
plane, Codex CLI Runtime in disposable containers, persistent workspaces,
model connection) is already built and must keep working as-is. The actual
deliverable is **one coherent middleware capability** layered on top of it —
not a rebuild of the platform. See `docs/HACKATHON_EXTENSION_GUIDE.md` for the
full brief and `docs/ARCHITECTURE.md` for the extension-seam table.

Candidate directions (pick/combine one, don't try all):

- **Glass Box** — trace/audit/observability. Make a Run diagnosable: emit
  correlated events, show a timeline. Seam: `AgentRunner`.
- **Bouncer** — identity & authorization. Separate human vs. Agent principal,
  scoped/revocable permissions, backend policy checks. Seam: API routes +
  Agent ownership.
- **Kill Switch** — threat modeling & safety. Contain one specific dangerous
  action with a real control. Seam: `AgentRunner`.
- **Multi-Agent Coordination** — several Agents sharing a session/turn order.

Track not finalized yet as of 2026-08-25 — leaning Glass Box as the more
approachable entry point (clear success criterion, no auth modeling).

## Setup

```bash
npm install
cp .env.example .env
# fill in ARK_API_KEY / ARK_MODEL / ARK_BASE_URL — see below
```

**Model provider:** the env vars are named `ARK_*` but the code
(`apps/server/src/config.ts`, `writeCodexConfig`) generates a generic Codex
CLI `config.toml` with `wire_api = "responses"` — any Responses-API-compatible
provider works, not just BytePlus/Volcengine Ark. Team is currently using
OpenAI instead of Ark:

```dotenv
ARK_API_KEY=sk-...           # your own OpenAI key, not shared
ARK_MODEL=gpt-4.1            # or whichever model you have access to
ARK_BASE_URL=https://api.openai.com/v1
```

Swapping to BytePlus Ark later (or back) is just these 3 values, no code
changes. If using Ark, avoid the `-GA` / `2.1-turbo` model tier — capped at
500 RPM, throttles hard mid-Run. Prefer the 15,000+ RPM tier.

**Known gotcha:** don't blindly `source .env` before `npm run poc`. That
script (`scripts/start-local-poc.sh`) computes its own local host paths for
`APP_DATA_DIR` / `AGENT_WORKSPACE_ROOT` / `CODEX_HOME` *unless those vars are
already set* — and `.env.example`'s defaults for them are container-internal
paths (`/app/data`) meant for Docker Compose, not local `npm run poc`. Sourcing
the whole file exports those and the script fails with `mkdir: cannot create
directory '/app': Permission denied`. Only export what the script needs:

```bash
export ARK_API_KEY="$(grep -E '^ARK_API_KEY=' .env | cut -d= -f2-)"
export ARK_MODEL="$(grep -E '^ARK_MODEL=' .env | cut -d= -f2-)"
export ARK_BASE_URL="$(grep -E '^ARK_BASE_URL=' .env | cut -d= -f2-)"
npm run poc
```

Then open http://localhost:3000, create an Agent, and confirm the Playground
task works (baseline acceptance test is in `README.md`). Confirmed working as
of 2026-08-25.

## Key files

- `apps/server/src/types.ts`, `app.ts`, `agent-service.ts` — control plane.
- `apps/server/src/codex-runner.ts`, `container-codex-runner.ts` — the two
  `AgentRunner` implementations; the main middleware seam for most tracks.
- `apps/web/src/App.tsx` — smallest UI integration point.
- `docs/ARCHITECTURE.md` — extension seams per track.
- `docs/HACKATHON_EXTENSION_GUIDE.md` — full challenge brief, deliverables,
  evaluation criteria, 3-day plan.

## Rules

- Never commit `.env`, API keys, or secrets — `.env` is gitignored, keep it
  that way. Each person uses their own model API key locally.
- `npm run check` must pass before submitting (typecheck + tests + build).
- No external training data / no hidden-test access — not applicable to this
  track (that's the other TechJam challenge), but don't rebuild the base
  platform (CRUD, Playground, Codex integration) — that's out of scope per the
  brief.
