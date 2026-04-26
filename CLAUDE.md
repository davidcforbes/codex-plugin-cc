# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository purpose

This repo ships a single Claude Code plugin, `codex` (published via `.claude-plugin/marketplace.json` as `openai-codex`), that wraps the local Codex CLI / Codex app-server so users can invoke Codex from inside Claude Code (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`, `/codex:status`, `/codex:result`, `/codex:cancel`, `/codex:setup`).

The plugin source lives at `plugins/codex/`. The repo root only holds tooling (tests, version bumper, tsconfig, CI). The plugin is pure Node ESM (`"type": "module"`, Node ≥ 18.18); no runtime dependencies are bundled — it shells out to the user's globally installed `codex` binary.

## Common commands

```bash
npm test              # node --test tests/*.test.mjs (the canonical test runner)
npm run build         # typecheck only — runs prebuild then tsc -p tsconfig.app-server.json (noEmit)
npm run check-version # verify package.json / package-lock.json / marketplace.json / plugin.json all agree
npm run bump-version <version>  # bump every version-bearing file in lockstep
```

Run a single test file: `node --test tests/commands.test.mjs`. Filter by test name: `node --test --test-name-pattern="<regex>" tests/*.test.mjs`.

`prebuild` (auto-runs before `build`) regenerates `plugins/codex/.generated/app-server-types/` via `codex app-server generate-ts`. Building therefore requires a working `codex` binary on PATH. Those generated `.ts` files are gitignored and only consumed by JSDoc `@typedef` imports in `plugins/codex/scripts/lib/*.mjs` for type-checking.

## Architecture

### Two long-lived processes

1. **Companion** (`plugins/codex/scripts/codex-companion.mjs`) — the single CLI entrypoint behind every slash command. Sub-commands: `setup`, `review`, `adversarial-review`, `task`, `status`, `result`, `cancel`. Each slash-command markdown in `plugins/codex/commands/` shells out to the companion with `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" <subcommand> "$ARGUMENTS"`.
2. **Broker** (`plugins/codex/scripts/app-server-broker.mjs`) — a per-workspace JSON-RPC bridge that owns one `codex app-server` child process. Multiple concurrent companion invocations (foreground + background reviews + rescue tasks) share this single app-server through a Unix socket / Windows named pipe whose path is exchanged via the `CODEX_COMPANION_APP_SERVER_ENDPOINT` env var. The broker is started lazily by `lib/broker-lifecycle.mjs` and survives across slash-command invocations within a session.

Streaming RPC methods (`turn/start`, `review/start`, `thread/compact/start`) are tracked by `threadId` so the broker can fan notifications back to the right client. `turn/interrupt` is special-cased.

### `plugins/codex/scripts/lib/` modules (each has a single responsibility)

- `app-server.mjs` + `app-server-protocol.d.ts` — JSON-RPC client and protocol typedefs (the `.d.ts` re-exports types from the generated app-server bindings).
- `broker-endpoint.mjs`, `broker-lifecycle.mjs` — endpoint URL parsing and broker spawn/handshake.
- `codex.mjs` — high-level Codex operations: `runAppServerTurn`, `runAppServerReview`, thread resume helpers, auth/availability checks. Holds the `TurnCaptureState` machine that consumes notification streams.
- `state.mjs` + `tracked-jobs.mjs` + `job-control.mjs` — per-workspace job persistence under `${CLAUDE_PLUGIN_DATA}/state/<workspace-slug>-<hash>/` (falls back to `os.tmpdir()/codex-companion`). Workspace identity is keyed on the canonical realpath, hashed to 16 hex chars. Jobs are capped at `MAX_JOBS = 50`.
- `git.mjs`, `workspace.mjs` — review-target resolution (working tree vs. `--base <ref>` branch diff) and workspace-root discovery.
- `prompts.mjs`, `render.mjs` — load `prompts/*.md` templates, render terminal output for each subcommand.
- `process.mjs`, `args.mjs`, `fs.mjs` — small utilities (process-tree termination, arg parsing, JSON IO).

### Hooks (`plugins/codex/hooks/hooks.json`)

- `SessionStart` / `SessionEnd` → `scripts/session-lifecycle-hook.mjs` (broker lifecycle bookkeeping; 5s timeout).
- `Stop` → `scripts/stop-review-gate-hook.mjs` (the optional review-gate; 900s timeout). Disabled by default; toggled via `/codex:setup --enable-review-gate` which writes `config.stopReviewGate` into the per-workspace state file.

### Slash-command contract

Each `plugins/codex/commands/*.md` is a directive to Claude, not a script — its body tells Claude exactly how to call the companion. Three rules consistently appear and must be preserved when editing them:

- **`/codex:review` and `/codex:adversarial-review` are review-only.** They must not fix issues, apply patches, or paraphrase Codex output. The command body says "return Codex's output verbatim".
- **Foreground vs. background is the user's choice, mediated by `AskUserQuestion`.** When `--wait` or `--background` is present, skip the prompt; otherwise estimate review size from `git diff --shortstat` and recommend background unless the change is tiny.
- **Background runs must use Claude Code's `Bash(..., run_in_background: true)`**, not the companion's own `--background` flag alone — the markdown explains this distinction.

Tests in `tests/commands.test.mjs` enforce these invariants by regex-matching the command markdown. If you change a command file, expect to update its assertions.

## Versioning

Four files carry the version and must stay in sync: `package.json`, `package-lock.json` (both `version` and `packages[""].version`), `.claude-plugin/marketplace.json` (`metadata.version` and `plugins[0].version`), and `plugins/codex/.claude-plugin/plugin.json`. Always use `npm run bump-version <version>` rather than editing them by hand; `npm run check-version` runs in CI.

## CI

`.github/workflows/pull-request-ci.yml` runs on Node 22: `npm ci`, `npm install -g @openai/codex` (so `prebuild` can generate types), then `npm test` and `npm run build`. There is no lint step.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:3216161c -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
