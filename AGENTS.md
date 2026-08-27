# Repository Guidelines

## Project Structure & Module Organization

This npm-workspaces monorepo contains two TypeScript applications:

- `apps/server/src/` is the Fastify control plane, persistence, configuration,
  and Codex Runtime implementations. Keep API validation close to routes in
  `app.ts`; Runtime extensions generally belong behind `AgentRunner`.
- `apps/web/src/` is the Vite/React browser UI. `App.tsx` is the main
  integration point, while `api.ts`, `types.ts`, and `styles.css` contain the
  client boundary, shared UI shapes, and styling.
- `docs/` holds architecture, deployment, and hackathon guidance; `deploy/`
  contains Volcengine Terraform; `scripts/` contains local and deployment
  helpers. Server tests live beside implementation as `*.test.ts`.

The base CRUD, Playground, and Codex integration are working platform code.
Build one focused middleware capability on top rather than rebuilding them.

## Build, Test, and Development Commands

```bash
npm install                 # install all workspace dependencies
npm run dev                 # start Fastify (:3000) and Vite (:5173)
npm test                    # run server Vitest tests
npm run typecheck           # type-check both workspaces
npm run build               # build web, then server
npm run check               # type-check, test, and build
npm run poc                 # start the container-backed local POC
```

For infrastructure changes, run `terraform fmt -check -recursive
deploy/volcengine`; verify Compose edits with `docker compose config`.

## Coding Style & Naming Conventions

Use TypeScript ESM with two-space indentation, semicolons, double quotes, and
trailing commas, matching the existing source. Prefer explicit types at module
boundaries and `type` imports where applicable. Use `camelCase` for values and
functions, `PascalCase` for components and types, and kebab-case file names
such as `container-codex-runner.ts`. Keep browser API calls in `apps/web/src/api.ts`
and validate server inputs with Zod.

## Testing Guidelines

Use Vitest for server behavior. Add or update a colocated `*.test.ts` file for
API, lifecycle, persistence, or Runtime changes; name tests by observable
behavior. Run `npm test` during iteration and `npm run check` before handoff.

## Commits, Pull Requests & Security

Git history uses concise imperative subjects (for example, `Add CLAUDE.md with
project context and setup notes`). Keep commits focused. Pull requests should
explain both behavior and rationale, link relevant issues, include UI
screenshots when applicable, and update English docs and `.env.example` for
configuration changes. Never commit `.env`, API keys, local state, workspaces,
build output, or Terraform state; report vulnerabilities through `SECURITY.md`.
