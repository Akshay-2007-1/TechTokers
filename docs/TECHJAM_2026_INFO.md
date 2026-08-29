# TikTok TechJam 2026 — info relevant to this project

Compiled 2026-08-28 from the public Devpost pages (rules + resources) and the
track problem statement already in this repo (`docs/hackathon-v2-*.xml`). The
canonical "Information Document" at <https://bit.ly/TikTokTechJam2026Info> is a
login-walled ByteDance Lark wiki and could not be scraped directly — but its
Track-5 content is the `hackathon-v2-*.xml` files, and the event-wide rules are
public on Devpost. **Verify anything time-critical against the live sources.**

---

## TL;DR

- **Our track:** CodeJam Track #5 v2 — *Agent Launchpad / Agent Middleware Challenge*. Pick **exactly one** of three sub-tracks (Glass Box / Bouncer / Kill Switch) and declare it in the README + opening slide.
- **72-hour scored build window:** **Aug 29, 2026 12:00 pm → Sep 1, 2026 12:00 pm (GMT+8)**.
- **Submission deadline:** **Sep 1, 2026, 12:00 pm GMT+8** (hard — no edits after).
- **Deliverables (only 3):** 3-min live demo · 1-page architecture diagram · code repo (runnable, setup steps, declared track, tests/evidence, limitations).
- A pre-existing project (like ours) is allowed **only if significantly updated during the submission window** — keep committing Aug 29–Sep 1.
- Prize pool ~US$34.5k; 1st = S$15,000, then S$8k / 5k / 3k / 3k, + S$500 People's Choice. One project wins at most one main prize.

---

## 1. Timeline (official, GMT+8)

| Milestone | Date / time |
| --- | --- |
| Registration Period | Aug 1 12:00 pm – **Sep 1 12:00 pm** |
| Early-bird registration deadline | Aug 23 11:59 pm |
| Problem statements — early bird | Aug 25 12:00 pm |
| Problem statements — public | Aug 27 12:00 pm |
| **72-hour Challenge & Submission Period** | **Aug 29 12:00 pm – Sep 1 12:00 pm** |
| Judging Period | Sep 1 3:00 pm – Sep 7 3:00 pm |
| Public Voting Period (People's Choice) | Sep 1 3:00 pm – Sep 7 3:00 pm |
| Finalists announced | Sep 8 12:00 pm |
| Winners announced | ~Sep 15 12:00 pm |

Post-deadline: the Sponsor may ask for **team-member bios within 48 h** — missing that can disqualify.

## 2. Eligibility & team

- Individuals: **18+**, **currently reside in Singapore**, **enrolled in a Singapore university** graduating **Dec 2026 or later**, valid government ID, not sanctions-listed.
- Teams: **up to 5** eligible individuals. Appoint one **Representative** who submits on the team's behalf and (if you win) receives and splits the prize.
- You may be on multiple teams and also enter solo.

## 3. Register / submit

1. Registration form: <https://bit.ly/TikTokTechJam2026Registration>
2. Click **"Join Hackathon"** on <https://tiktoktechjam2026.devpost.com/> (needs a free Devpost account).
3. Submit on the Devpost "Enter a Submission" page before the deadline. Draft submissions can be saved and edited until the deadline; nothing can change after.
4. People's Choice eligibility needs a Devpost registration and the public vote.

## 4. Submission requirements

- A **working** project built with the required tools that meets the problem statement.
- **Text description** listing: dev tools used · APIs used · assets used · libraries used.
- **Public code repo link (GitHub/GitLab/Bitbucket) with a README** — required.
- Any extra deliverables the problem statement requires (for us: the 3 below).
- **Testing access** for judges free of charge until judging ends; if anything is private, include credentials in the testing instructions. Judges may score on the write-up/video/images alone.
- All materials in **English** (or provide English translations).
- Original work, solely owned, no IP violations. Open-source use is fine if you comply with the licenses **and build something that enhances it** (the Starter Kit is exactly this case).
- Must not have been built with financial/preferential support from the Sponsor.

### The 3 required deliverables (nothing else — no report, pitch deck, or product video)

1. **Live Demo (3 minutes)** — the Agent working, and the selected middleware succeeding in its required failure/denial case.
2. **Architecture Diagram (1 page)** — middleware boundary, main components, data/decision flow, and the trust or failure boundary.
3. **Code Repository** — runnable source, setup instructions, **declared track**, tests/evidence, known limitations.

## 5. Judging

**Stage 1 (pass/fail):** does it fit the theme and actually use the required APIs/SDKs.

**Stage 2 — two rubrics apply.** The Devpost Official Rules list four *equally weighted* generic criteria; the Track-5 problem statement gives a weighted rubric. Optimise for the track rubric, but make sure the "innovation / problem insight" angle is sharp too.

Track-5 rubric (from the problem statement):

| Category | Weight | Judges look for |
| --- | ---: | --- |
| **Middleware works end to end** | **40%** | The selected track changes a real Agent Run and passes its stated success test. |
| **Technical design & integration** | **25%** | Clear boundary, sensible data/policy model, correct **backend** enforcement, focused use of cloud. |
| **Verification & robustness** | **20%** | Positive + negative evidence, useful errors, secret handling, cleanup, tests proportional to a POC. |
| **Demo & reproducibility** | **15%** | Clear 3-min story, 1-page architecture, a README another team can follow. |

Devpost generic criteria (equally weighted): Technical Execution · Innovation & Problem Insight · Feasibility & Practicality · Impact & Relevance.

Provided frontend / base CRUD / local Runtime / ECS are **prerequisites, not innovation points**. Visual polish counts only when it explains the middleware. Ties broken by the highest score on the first differing criterion.

**People's Choice** = most verified Devpost votes during the voting window; one vote per person per project; no vote buying / automation.

## 6. The challenge — Agent Launchpad (Track #5)

> Autonomous coding Agents can reason, call tools, run commands, and change files. The Starter Kit works but is **insecure, hard to diagnose, and only weakly isolated**. Improve **one** middleware layer instead of rebuilding the platform. A narrow feature that works end to end beats three incomplete ideas.

**Provided baseline (do not rebuild):** React Web UI (Agent CRUD + Playground) · Node/Fastify control plane (validated REST, lifecycle, async Runs, messages, errors) · Codex CLI Runtime (each turn in a disposable local Docker/Colima/Podman container, workspace + session persist) · Volcengine Ark model via the Responses API · optional Volcengine ECS (Terraform) — **not needed for judging**.

**Extension seams:** control plane = route guards / event emission / policy decisions / sandbox adapter. Runtime = instrument, authorize, harden, wrap, or replace the Runner.

### Sub-tracks (declare one)

**Track A — The Glass Box (Trace & Audit)**
Make a Run understandable. Minimum: stable Agent/Run/Trace/Span IDs; capture ≥3 step types (orchestration, model call, command exec, file change); **visual timeline or tree in the browser**; record status, duration, error detail, token usage; redact secrets before storage/UI.
*Required demo:* one success + one failure; open the trace and point to the failing step.
*Success test:* a judge answers "why did this Agent fail?" in <30 s using the UI. A generic log page without correlation fails.

**Track B — The Bouncer (Identity & Authorization)**
Separate the human from the Agent acting for them; enforce ownership **server-side**. Minimum: two users (A/B); each Agent has a distinct non-human principal linked to its owner; protect a mock DB/files/tool with backend policy checks; record human + Agent + action + resource + allow/deny; support one revoke/disable/permission-update.
*Required demo:* User A's Agent reads A's data OK, then is denied B's data by the **backend**.
*Success test:* changing a user ID in the browser request cannot bypass the decision. A login screen alone fails.

**Track C — The Kill Switch (Safety & Sandboxing)**
Contain a dangerous action and make the block visible. Minimum: one explicit threat scenario + the protected asset; harden the local Runtime with an explicit isolation/policy adapter (or veFaaS Cloud Sandbox); enforce **≥2 bounded controls** (timeout, filesystem scope, process/resource limit, network destination rule); expose blocked / terminated / cleaned-up states; prove a later safe Run still works.
*Required demo:* submit a malicious request (read a protected host file, hit a forbidden endpoint, delete a protected mock DB); show it blocked/isolated and cleaned up.
*Success test:* the protected asset is unchanged and the judge can see **which control** stopped it. The Starter Kit's default CPU/mem/PID/capability/workspace limits **don't count** — you must add a new threat-specific control. A keyword prompt filter fails.

### Required 3-minute demo flow

1. Show the selected track and the protected/observed boundary.
2. Create or select an Agent in the provided UI.
3. Run a normal coding task, show the expected result.
4. Trigger the track-specific failure / denial / malicious case.
5. Show the middleware evidence (trace, policy decision, or isolation/termination result).
6. State one limitation and one next step.

Mock users / mock protected DB are fine. The Agent interaction, the middleware decision, and the evidence must be **real**.

### Common functional requirements

- Keep Create Agent / lifecycle / Playground working.
- Middleware runs in a **real backend/runtime path** — static screens don't count.
- One positive case + one negative/failure/denial case.
- Use the one-line local Runtime + Ark. ECS optional; Track C may add veFaaS.
- **No API keys / AK-SK / passwords / unredacted secrets** in the browser, repo, logs, or demo.
- Include **automated evidence** for the core middleware decision/event.

### Acceptance checklist (must all pass)

- [ ] README names exactly one track.
- [ ] A reviewer can create/select an Agent and run a task from the browser.
- [ ] Middleware executes in a real backend/runtime path.
- [ ] Demo has a positive case **and** a failure/denial/malicious case.
- [ ] No secret in source, browser state, screenshots, logs, traces, or demo output.
- [ ] README has deployment steps and known limitations.
- [ ] Track-specific gate: Glass Box → correlated trace finds a failing step + reports usage · Bouncer → backend denies cross-user access, decision names human/Agent/action/resource · Kill Switch → malicious action contained, protected asset survives, cleanup visible.

A static mock, verbal-only design, or a browser-only check **does not pass**.

### Out of scope

Rebuilding the React UI / control plane / local Runtime / ECS automation / Codex-Ark connection · training or fine-tuning a model · general workflow editor / marketplace / multi-region control plane / billing · building a container scheduler / microVM / secure file-transfer from scratch · doing more than one track.

### FAQ

- **Different frontend framework?** Only if it directly enables your middleware; migration isn't judged and wastes time.
- **Mock users/data?** Yes — Track B should prefer a small deterministic mock over a third-party integration.
- **Track C must use veFaaS?** No — hardening the local container Runtime is fine, as long as the new boundary/controls are real and demonstrated.
- **Track A show Codex logs?** Logs can be an input, but you must correlate a Run into structured steps and make the failure diagnosable.
- **Add another track's features?** Allowed, but they don't compensate for an incomplete selected track; keep the demo/architecture focused.
- **Demo on ECS?** No — the default dev and judging path is the local POC.

### Suggested 3-day plan

| Day | Goal | Exit check |
| --- | --- | --- |
| 1 | Start the POC, pick one story, draw the boundary, define the smallest middleware data contract, finish the backend happy path. | A real local Run reaches your middleware and produces one inspectable decision/event. |
| 2 | Finish enforcement/instrumentation, add the minimum UI, implement the negative case. | Positive **and** negative cases work with no manual data editing during the demo. |
| 3 | Add tests, harden errors + cleanup, verify deploy, finish the 1-page architecture, rehearse the 3-min demo. | A teammate can deploy from the README and demo in 3 minutes. |

---

## 7. How this maps to `feature/agent-budget-guard`

Our feature (per-Agent `maxRuns` / `maxTotalTokens` admission control that denies a
Run **before** the Codex Runtime is invoked, with redacted `budget.run_admitted` /
`budget.run_denied` events and a `/api/agents/:id/budget` endpoint) does **not**
map cleanly onto any single sub-track. Before submitting we must **declare one**:

- **Track C (Kill Switch)** is the closest fit. Frame it as: *threat = a runaway or
  looping Agent (or prompt-injected task) draining the model budget / quota;
  protected asset = the API spend / rate quota; control = pre-invocation admission
  cap.* We already have **two bounded controls** (max Runs + max total tokens),
  **blocked/denied state** exposed (`run.status = "denied"`, `runtimeInvoked:false`,
  no container spawned), **cleanup is trivially visible** (nothing to clean — the
  Runtime never ran), and a **later safe Run works** (raise the limit / new Agent).
  Gaps vs the Track-C rubric: it's an *admission* control, not a *Runtime isolation*
  adapter, and the judges expect the new control to sit on/around the Runner — be
  ready to defend "admission control is the containment boundary here" or add one
  genuine runtime-side control (e.g. a hard per-Run wall-clock/output cap enforced
  in the Runner) so there's an isolation story too.
- **Track A (Glass Box)** flavour is present (redacted correlated events, queryable
  evidence) but Track A's bar is a **visual timeline/tree of ≥3 step types** and
  "answer why it failed in 30 s" — our budget events alone don't clear that.

Recommendation: **declare Track C**, and spend remaining time on (a) a crisp threat
narrative + demo, (b) the 1-page architecture diagram showing admission happening
in `sendMessage → admitRun()` inside the serialized `store.mutate`, before
`createRunner().run()`, and (c) README: name the track + Limitations section.

Open items from the PR review still relevant to the submission: README has no
declared track / Limitations section; `budgetEvents` grows unbounded; no
architecture diagram or demo script yet.

---

## 8. Links & contact

- Devpost: <https://tiktoktechjam2026.devpost.com/>
- Information doc & problem statements (login-walled): <https://bit.ly/TikTokTechJam2026Info>
- Registration form: <https://bit.ly/TikTokTechJam2026Registration>
- Telegram channel (updates): <https://t.me/TikTokTechJam2026>
- Questions: apac-earlycareers@tiktok.com
- Privacy notice: linked from the Devpost "resources" tab
