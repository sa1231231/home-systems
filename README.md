# Personal Backend — Project Foundation & Build Guide

> This document is both the project README and the foundational context for Claude Code sessions working on this codebase. Read it fully before writing any code. When starting a new Claude Code session, paste or reference this document so the assistant inherits the design philosophy.

---

## What This Project Is

A personal automation backend that consolidates several SaaS workflows (CRM, email triage, task management, calendar) into a single, owned, deterministic substrate — with AI used as a narrowly-scoped tool for fuzzy classification work, not as an orchestrator.

The system replaces "Open Claw," a previous attempt that used an always-on LLM agent to orchestrate everything via markdown-as-memory. That approach failed because LLMs are probabilistic and unreliable as orchestrators: the agent constantly forgot its instructions, drifted from policy, required heavy daily maintenance, and cost more than the SaaS products it was meant to replace.

This project takes the opposite architectural stance.

---

## Core Design Philosophy

### The Single Most Important Principle

**Own the substrate, rent the intelligence.**

Data, business logic, API surface, rules, and infrastructure are owned and live in code/storage we control. AI is a *commodity input* consumed through standard interfaces (HTTP API, MCP). The substrate is permanent and stable. The AI layer is interchangeable and replaceable.

### Three Tiers of Functionality

Every capability in the system fits into one of three tiers. Be explicit about which tier any given feature belongs to.

**Tier 1 — Pure deterministic plumbing.** Sync jobs, rule-based filters, scheduled tasks, CRUD operations, backups. No LLM in the loop. Plain code. Should run for months without intervention. Examples: nightly Dex→Postgres sync, archive emails matching a known sender pattern, daily R2 backup.

**Tier 2 — AI-on-demand queries.** User-initiated work where Claude (via the app or Claude Code, with our MCP server connected) queries our data and synthesizes answers or drafts. The AI is a query/synthesis interface, not an orchestrator. It runs when the user asks, not on a cron. Examples: "who haven't I talked to in 90 days?", "draft a follow-up to these contacts", "summarize this week's calendar."

**Tier 3 — Bounded AI calls inside deterministic workflows.** Crons that need fuzzy classification call the Anthropic API as a *function* with structured inputs and outputs. The AI returns structured data; deterministic code decides what to do with it. The AI never takes action directly. Examples: classify the importance of an email that didn't match any rule, extract sentiment from a contact note.

### The Gap-Filling Principle

AI is the tool of last resort, deployed in narrow gaps, with the explicit goal of making itself unnecessary in that gap over time.

Before reaching for AI in any code path, answer:
1. *Why can't deterministic code do this?* If "it'd be tedious to write the rules," that's the wrong reason. Write the rules.
2. *What's the structured output schema?* If you can't specify the exact response shape, refine the task until you can.
3. *How will this AI call eventually become a rule?* Every AI invocation should have a path to retirement via the approval/promotion flow.

**AI outputs must always be reduced to the smallest constrained type that captures the necessary information.** Enums beat strings. Bounded numbers beat unbounded. Structured objects with typed fields beat free-form. The narrower the AI's output type, the more easily downstream code stays deterministic.

### Separate "Doing" from "Thinking"

The Railway backend's job is to *do things reliably*: sync data, apply rules, store state, expose queries. The LLM's job is to *think*: classify under uncertainty, extract from natural language, synthesize answers from data, draft text for human review. These are kept architecturally separate.

**The LLM never orchestrates. The LLM is a function call inside an orchestration that lives in plain code.**

### The Promotion Loop

The system gets cheaper and more reliable over time, not more expensive and fragile. The mechanism:

1. AI classifications go into a `needs_review` table
2. User approves/corrects via a digest interface
3. Approved patterns get promoted to deterministic rules in a `rules` table
4. The rules engine handles future cases matching those rules *before* the AI is called
5. AI caseload shrinks; cost drops; reliability rises

**Rules live in data (a Postgres table), not code.** Adding a rule is a database insert, not a deploy. Rules have provenance (when created, by what approval, from what AI classification). Rules are never written by AI — only by user approval. This is the "doesn't get overwritten" property.

---

## What This Project Is NOT

Several things from Open Claw must explicitly NOT be carried into this project. If you find yourself adding any of these, stop and reconsider — you're recreating the problems we're moving away from.

**No always-on agent.** No background LLM process that "wakes up" on a cron, re-reads its identity from markdown files, and decides what to do. The orchestration is plain TypeScript; the AI is called as a function when needed.

**No markdown-as-memory.** No SOUL.md, IDENTITY.md, MEMORY.md, HEARTBEAT.md, or similar files acting as runtime state for an agent. State lives in Postgres. Documentation lives in `docs/`. These are different things and shouldn't be conflated.

**No self-healing or auto-maintenance machinery.** If the system needs daily maintenance to stay functional, the architecture is wrong. Build it so it doesn't drift in the first place.

**No "the LLM will figure it out" code paths.** Every LLM call has a defined input schema, defined output schema, and a deterministic handler for the result. No free-form "agent decides what to do next."

**No frameworks that bundle AI with infrastructure.** Use the Anthropic SDK directly. Use the standard MCP SDK. Don't adopt agent frameworks that wrap these in opinionated abstractions — that's the path to lock-in.

**No premature abstraction.** No provider-agnostic wrappers "in case we switch AI vendors later." When that day comes, we'll know enough to write the right wrapper. Until then, call the SDK directly.

**No bloat from Open Claw.** Don't port: the orchestration loop, the maintenance scripts, the markdown memory files, the `.openclaw/` or `.clawhub/` directories, the heartbeat system, the auto-commit machinery. Reference the old repo for specific working snippets (OAuth flows, API parsers, configuration values) and lessons learned, but build fresh.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Railway Backend                                    │
│                                                     │
│  ┌──────────────┐    ┌────────────────┐             │
│  │ Cron Jobs    │───▶│ Rules Engine   │             │
│  │ (scheduled)  │    │ (deterministic)│             │
│  └──────────────┘    └────────┬───────┘             │
│                               │                     │
│                               ▼                     │
│                      ┌─────────────────┐            │
│                      │ Unmatched?      │            │
│                      │ Call Anthropic  │            │
│                      │ API as function │            │
│                      │ (Tier 3)        │            │
│                      └────────┬────────┘            │
│                               │                     │
│                               ▼                     │
│                      ┌─────────────────┐            │
│                      │ needs_review    │            │
│                      │ table           │            │
│                      └────────┬────────┘            │
│                               │                     │
│                               ▼                     │
│                      ┌─────────────────┐            │
│                      │ Daily digest    │──▶ User    │
│                      │ + approval UI   │            │
│                      └─────────────────┘            │
│                                                     │
│  ┌────────────────────────────────────────┐         │
│  │ Postgres                               │         │
│  │ - Domain tables (contacts, emails,...) │         │
│  │ - rules                                │         │
│  │ - changelog (with before/after state)  │         │
│  │ - needs_review                         │         │
│  │ - snapshots metadata                   │         │
│  └────────────────────────────────────────┘         │
│                                                     │
│  ┌────────────────────────────────────────┐         │
│  │ HTTP API (typed endpoints,             │         │
│  │ per-operation rate limits, audit log)  │         │
│  └────────────────────────────────────────┘         │
│                                                     │
│  ┌────────────────────────────────────────┐         │
│  │ MCP Server (read + bounded write tools)│         │
│  └─────────────────┬──────────────────────┘         │
└────────────────────┼────────────────────────────────┘
                     │
                     ▼
        ┌─────────────────────────┐
        │ Claude (app/Code)       │  ← Tier 2: interactive
        │ - On-demand queries     │
        │ - Drafting              │
        │ - Approval workflows    │
        │ - "Promote to rule"     │
        └─────────────────────────┘

External backups: R2 (daily Postgres dumps + on-demand exports)
```

### Components

- **Railway**: Compute. New project, separate from existing client work.
- **Postgres on Railway**: Single source of truth. All structured data. Use `jsonb` columns for genuinely variable-schema fields (e.g., raw external API responses).
- **R2**: Backups (daily pg_dump) and large blob storage.
- **Anthropic API**: Called from cron-side classification functions (Tier 3).
- **MCP Server**: Exposes read + bounded-write tools to Claude clients (Tier 2).
- **Claude in the app / Claude Code**: Interactive layer. Connects to our MCP server.

### Why Postgres (not MongoDB)

This project's data is highly structured (contacts, emails, rules, changelog all have stable schemas), needs relational queries (joins across tables), needs ACID transactions (changelog write + state mutation must be atomic), and benefits from the `jsonb` escape hatch for occasional variable-schema fields. MongoDB would force either aggressive denormalization (consistency problems) or application-side joins (complexity).

---

## Safety Substrate

Every write operation in the system passes through these safety mechanisms. They are not optional and not added later — they're foundational and built in from the first endpoint.

### Constrained Action Space

Policy lives at the API boundary, not in prompts. The HTTP API and MCP tools expose narrow, typed endpoints — never broad "update anything" operations.

Design rules:
- **Inputs are typed and validated.** Enums for categorical fields, regex for IDs, bounded ranges for dates and numbers, max lengths for strings. Reject non-conforming input.
- **Operations are atomic.** No "update these 5 fields, 3 succeed and 2 fail" endpoints. One endpoint = one logical change = succeeds or fails as a unit.
- **Side effects are explicit in the name.** `archive_email` not `process_email`. The endpoint name should fully describe what happens.
- **Idempotency where possible.** Calling `tag_contact(id, "lead")` twice should equal calling it once.
- **Rate limits per operation.** Each endpoint has a daily and per-session cap. Prevents runaway behavior.
- **Audit log everything.** Every write logs: caller (Claude session ID or cron name), timestamp, input, before-state, after-state, operation.

### Tiered Operations by Reversibility

Group every write operation into one of three tiers and design its permissions accordingly:

**Tier A — fully reversible, low blast radius** (tagging, adding notes, reminders, moving Trello cards): allowed autonomously, logged to changelog, easily undoable.

**Tier B — reversible but annoying** (archiving emails, marking read, bulk tagging): runs autonomously but surfaces in daily review; user can undo by session.

**Tier C — destructive or external** (sending emails, deleting things, modifying calendar events others see): NEVER autonomous. Use a `propose_*` pattern that creates a pending action requiring explicit user approval.

The litmus test for "is this Tier A?": *Would I be comfortable with this operation running 100 times in a row without my review, because the worst case is fine?* If no, it's not Tier A.

### Changelog and Rollback

Every write to the database produces a changelog row BEFORE executing the mutation. The changelog records:
- Operation name
- Target ID
- Full before-state of mutated fields (not diffs — full prior values)
- Full after-state
- Session ID
- Timestamp
- Caller (Claude session, cron name, etc.)
- Triggering intent (the prompt or rule that caused this)

The changelog is **append-only** — no updates, no deletes. Retain for at least 90 days.

Three rollback mechanisms layered on top:

1. **Operation-level undo**: `undo_last_n(operation_type, n)` reverses recent operations.
2. **Session-level rollback**: `rollback_session(session_id)` reverses all writes from a single session as a unit.
3. **Point-in-time snapshots**: Daily pg_dump to R2 for catastrophic recovery.

For external services (Gmail, Trello, etc.), every endpoint that modifies external state must:
1. Snapshot relevant external state into the changelog *before* writing
2. Perform the external write
3. Mark changelog entry as success or failure based on the result

The `undo` for external writes replays the snapshot back to the external service.

### Bounded Blast Radius

Every operation has explicit limits enforced at the API layer:
- Per-call limits (e.g., `bulk_tag` accepts at most 25 contacts per call)
- Per-session limits (e.g., session caps at 100 total writes, then must end)
- Per-day limits per operation type (e.g., `archive_email` capped at 200/day)
- Velocity caps (unusual write rates pause and require human confirmation)

Combined with rollback: worst case is bounded AND recoverable.

### Recent Changes View

A simple webpage or API endpoint showing the last 24 hours of writes in human-readable form, with one-click undo per entry or per session. This view is built early — it's how you maintain trust in the system. Building it forces the changelog to actually contain enough information to be useful.

### Progressive Autonomy

Permissions start strict and earn relaxation through demonstrated reliability:
- New capabilities start at Tier C (propose-and-approve) by default
- Operations with high success rates and no corrections over weeks/months get promoted toward Tier A
- Operations with frequent corrections get tightened or rule-ified

Each operation has a `permission_tier` field in config. Monthly review ritual: look at the audit log, decide what to promote/demote.

---

## API Design Patterns

### Endpoint Design

Every write endpoint should be answerable to: "What's the worst that happens if Claude calls this 100 times in a row?" If the answer isn't "fine," redesign the endpoint to be narrower.

Examples of well-designed endpoints:
- `tag_contact(contact_id, tag)` where `tag` is an enum
- `add_note(contact_id, text)` where text is appended, never overwrites
- `set_followup_date(contact_id, date)` where date is bounded (future, within 1 year)
- `flag_for_review(contact_id, reason)` — doesn't change the contact, just queues it
- `propose_email_send(to, subject, body, reasoning)` — creates a draft, doesn't send

Examples of endpoints that should NOT exist (or should require human approval per call):
- `update_contact(contact_id, fields)` — too broad, no constraint on what changes
- `bulk_update(query, changes)` — unbounded blast radius
- `delete_anything` — destructive, irreversible from our side
- `send_email` (autonomous) — external + destructive + Tier C

### Tag and Taxonomy Management

For categorical fields like tags, two-tier system:
1. **Canonical tags**: Fixed enum, controlled by user. AI can apply freely.
2. **Suggested tags**: AI calls `suggest_new_tag(target_id, proposed_tag, reasoning)` which adds to a review queue. User approves once → joins canonical set.

This bounds the AI's tagging without preventing the system from learning your taxonomy over time.

### Structured AI Outputs

When calling the Anthropic API from cron-side classification functions:
- Use tool use / structured output features to force JSON conformance
- Define explicit schemas (Zod schemas, JSON Schema) for every AI call
- Treat malformed AI output as a classification failure (log it, skip it, surface in digest) — never as free-form instruction to interpret
- Log every AI call's full input and output to a separate `ai_calls` audit table for later analysis

---

## Roadmap

Roadmap and outstanding work live on **GitHub Issues**, not in this file. Use the `roadmap` label for the current punch list; one tracker issue per active workflow. This document is the design substrate (philosophy, architecture, patterns, safety rules) — read it for *how* the system should be built, not *what's next*.

---

## Repo Structure

Initial layout. Evolve as needed but keep it boring and predictable.

```
.
├── README.md                  # This document
├── docs/
│   ├── architecture.md        # Detailed architecture notes
│   ├── policies/              # Distilled policies (email, calendar, contacts)
│   ├── api.md                 # API endpoint reference
│   ├── salvage-notes.md       # References to old Open Claw code worth checking
│   └── decisions/             # ADRs for significant choices
├── drizzle/                   # Postgres schema migrations (drizzle-kit)
├── src/
│   ├── api/                   # HTTP API layer (Express)
│   ├── crons/                 # Scheduled jobs
│   ├── rules/                 # Rules engine + rule definitions loader
│   ├── ai/                    # Anthropic SDK wrappers, classification functions
│   ├── mcp_server/            # MCP server exposing tools
│   ├── integrations/          # External service clients (Gmail, Trello, Dex)
│   ├── changelog/             # Audit log writer + rollback logic
│   ├── db/                    # Drizzle schema + db client
│   ├── schemas/               # Zod schemas for I/O validation
│   └── shared/                # Common utilities, helpers
├── tests/
├── package.json
├── tsconfig.json
└── .env.example
```

What's NOT in the structure (and shouldn't be added):
- No `memory/` directory
- No `SOUL.md`, `IDENTITY.md`, `HEARTBEAT.md`, etc.
- No `.openclaw/` or `.clawhub/` directories
- No self-healing scripts
- No agent loop runner

---

## Working with Claude Code on This Project

When starting a session, give Claude Code this README as context. Then state what you're working on. Some norms:

**Boundaries to enforce in code review:**
- Any new AI call must have a structured output schema. Push back if it doesn't.
- Any new write endpoint must have rate limits, validation, and changelog writes. Push back if it doesn't.
- Any new "agent-style" code (autonomous decision-making, free-form interpretation) gets reframed as a Tier 3 function call with structured I/O.
- Any markdown file proposed as runtime state gets reframed as a Postgres table.

**Reference, don't copy, from Open Claw:**
- The old repo is archived. Read it for specific working code (OAuth flows, API parsers) and configuration values
- Don't lift architectural patterns from it
- Maintain `docs/salvage-notes.md` as a curated list of "look at this specific file/function in the old repo"

**Iterate the design:**
- The first cron written will reveal something this design didn't account for. Update the design.
- The MCP schema drafted first will need revision once used. Revise.
- ADRs go in `docs/decisions/` for significant choices

---

## Tech Stack (defaults — revisit if there's a strong reason)

Aligned with the `servicecall-api` repo where it makes sense, so logging, testing, build, and deploy patterns stay consistent across the two Railway apps. The deliberate divergence: this project uses **Postgres**, not MongoDB. The two repos are otherwise unrelated — alignment is for operational consistency, not for sharing code.

- **Language**: TypeScript (Node.js 20+, ES modules)
- **API framework**: Express 5 (matches `servicecall-api`)
- **Database**: Postgres (Railway managed) — *divergence from `servicecall-api`, which uses MongoDB*
- **DB toolkit**: Drizzle ORM (TS-first, schema-as-code, close to SQL — replaces SQLAlchemy/Alembic)
- **Migrations**: drizzle-kit
- **Validation**: Zod (replaces Pydantic — used for HTTP input, AI output, and config schemas)
- **AI**: `@anthropic-ai/sdk` (matches `servicecall-api`)
- **MCP**: Official `@modelcontextprotocol/sdk` (TypeScript)
- **Task scheduling**: Railway cron jobs (or `node-cron` in-process for finer control)
- **Backups**: `pg_dump` → R2 via `@aws-sdk/client-s3` (R2 is S3-compatible; matches `servicecall-api`'s S3 client)
- **Testing**: vitest (matches `servicecall-api`); Playwright if/when end-to-end browser flows show up
- **Dev runner**: `tsx` watch (matches `servicecall-api`)
- **Build**: `tsc` → `dist/`, run with `node dist/index.js`
- **Linting/formatting**: Biome (single tool, fast — closest TS equivalent to `ruff`)

---

## Success Criteria for This Project

The project is succeeding if, six months from now:
- The system runs without daily maintenance
- AI calls per workflow have decreased over time as rules accumulate
- Monthly cost is significantly lower than the SaaS products it replaced
- Cutting over a new workflow is straightforward, not a multi-week project
- When something does go wrong, rollback is one command and takes under a minute
- The Claude session experience for queries is faster and more useful than the equivalent SaaS UIs

The project is failing if:
- A `PHASE-N-COMPLETION.md` file ever needs to be written
- Daily maintenance commits start appearing
- Any file resembling `SOUL.md`, `HEARTBEAT.md`, or `IDENTITY.md` exists
- AI is being used to "decide what to do" anywhere in autonomous code paths
- Permissions have only ever expanded, never been earned through demonstrated reliability

---

## Lessons from Open Claw (Worth Internalizing)

1. **LLMs are bad orchestrators.** They forget instructions, drift from policy, and make non-deterministic decisions. Use them for what they're good at (classification, synthesis, drafting) inside structures that don't depend on them being consistent.

2. **Markdown is documentation, not state.** When state lives in markdown files that an agent re-reads each run, the agent is reconstructing itself probabilistically every time. State belongs in a database.

3. **Self-healing is a symptom, not a feature.** If a system needs to heal itself daily, the architecture is wrong. Build it so it doesn't break in the first place.

4. **Frameworks are liabilities; protocols are assets.** HTTP, SQL, JSON, MCP — these set you free. Agent frameworks lock you in. Prefer the protocol every time.

5. **The interesting parts of "AI automation" are mostly not the AI.** Schemas, rules engines, audit logs, rollback mechanisms, approval flows — that's where the real work and the real value live. The AI is a small, well-bounded component inside infrastructure.

6. **Constrain at the API, not in the prompt.** Prompts are suggestions to a probabilistic system. APIs are walls. Policy belongs in the wall.

7. **The system should get better over time, not worse.** Open Claw's complexity grew. This system's AI usage should shrink as rules accumulate. If complexity is growing, you're rebuilding Open Claw.
