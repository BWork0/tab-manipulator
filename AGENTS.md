# AGENTS.md

## Project overview

Tab Manipulator is a privacy-focused, cross-browser extension for automatic tab rotation and scheduled tab refresh. It uses WXT, Vanilla TypeScript, and one shared source tree for Chromium and Firefox builds.

## Read these first

Before planning or implementing product work, read:

1. [`docs/PRD.md`](docs/PRD.md) — product scope, requirements, acceptance criteria, architecture constraints, and release expectations.
2. [`docs/TASKS.md`](docs/TASKS.md) — ordered implementation tasks, dependencies, likely files, and task-level acceptance checks.
3. Relevant sections of [`.docs/docs.txt`](.docs/docs.txt) and [`.docs/api-reference.txt`](.docs/api-reference.txt) — the local WXT documentation.

Treat the PRD as the source of truth for product behavior. Treat the task list as the implementation plan. If they conflict, follow the PRD and update the task list to match. Do not silently expand the MVP beyond the PRD.

## Working with the task list

- Choose work whose dependencies in `docs/TASKS.md` are complete.
- Reference the task ID in implementation notes, commits, or pull requests when practical.
- Meet both the task acceptance checks and the linked PRD requirements.
- Check a task box only after its implementation and required verification are complete.
- Record newly discovered work in the appropriate phase instead of hiding it inside an unrelated task.
- Do not mark release or manual-QA tasks complete without the stated evidence.

## Repository structure

```text
src/entrypoints/   WXT background, popup, and options entrypoints
src/core/          Pure product logic; no direct browser API calls
src/platform/      Browser API adapters and capability checks
src/storage/       Typed settings and runtime-state persistence
src/messaging/     Shared typed cross-context message protocol
public/            Static extension assets copied by WXT
docs/PRD.md        Product requirements and acceptance criteria
docs/TASKS.md      Implementation task list and traceability
.docs/             Local WXT documentation
```

Some planned directories do not exist yet. Create them when the corresponding task calls for them.

## Implementation rules

- Use WXT and Vanilla TypeScript; do not introduce a UI framework without an explicit product decision.
- Use one shared codebase for Chromium and Firefox.
- Keep core decision-making pure and independently testable.
- Isolate browser operations behind platform or application-service boundaries and use `wxt/browser`.
- Keep browser runtime code inside the `main` function of WXT JS/TS entrypoints or functions invoked from it.
- Configure the generated manifest through `wxt.config.ts` and entrypoint metadata. Do not add or edit a source `manifest.json`.
- Do not edit generated `.wxt/` or `.output/` files.
- Use `wxt/utils/storage` for typed persistent state unless a task explicitly establishes another approach.
- Treat persisted runtime state as the source of truth; background globals are disposable caches.
- Revalidate tab and window IDs before acting. IDs must not be trusted after a browser restart.
- Make commands and scheduler callbacks idempotent. Never replay a backlog of missed rotations or refreshes.
- Use a cross-browser-safe async messaging response pattern.

## Scope and privacy guardrails

The MVP may request only these extension permissions:

- `tabs`
- `storage`
- `alarms`

Do not add content scripts, `scripting`, broad host permissions, analytics, remote logging, or network services unless the PRD is deliberately revised first. Browsing metadata and settings must remain local to the extension.

## Scheduling constraints

- Refresh intervals must be at least 30 seconds and use browser alarms.
- Rotation at 30 seconds or longer uses browser alarms.
- Rotation below 30 seconds uses the PRD's best-effort timeout behavior.
- After suspension, sleep, or restart, perform at most one due action and schedule the next action from the current time.
- Ambiguous target recovery must enter `needs-attention` without activating or refreshing a tab.

## Development commands

Use pnpm because the repository contains `pnpm-lock.yaml`.

```sh
pnpm install
pnpm dev
pnpm dev:firefox
pnpm compile
pnpm format
pnpm format:check
pnpm format:staged
pnpm hooks:install
pnpm build
pnpm build:firefox
pnpm zip
pnpm zip:firefox
```

Testing commands will be added by task T004. Once available, run the relevant unit/integration tests with every behavior change.

## Required formatting workflow

- Treat formatting as a required part of every code or documentation change.
- Ensure the repository hook is active before the first commit by running `pnpm hooks:install` and verifying that `git config --get core.hooksPath` returns `.githooks`.
- Stage only the files intended for the current task. The pre-commit hook runs `pnpm format:staged`, formats those staged files with Prettier, and re-stages the formatted results.
- If the hook cannot run in the current environment, run `pnpm format:staged` manually before committing and report why the hook was unavailable.
- Run `pnpm format:check` after formatting and before every push or pull request.
- Do not bypass the formatting hook with `git commit --no-verify` unless the user explicitly authorizes it for a diagnosed hook failure.
- Do not run `pnpm format` across the entire repository during an unrelated task. Use it only when establishing or intentionally changing the shared formatting baseline.
- Never format generated, dependency, local-documentation, or other paths excluded by `.prettierignore`.
- Keep formatting-only changes separate from behavioral changes when they are not required by the same task.

## Verification expectations

- Run `pnpm compile` after TypeScript changes.
- Run `pnpm format` once when establishing or deliberately updating the formatting baseline.
- Let the pre-commit hook run `pnpm format:staged` so only staged source files are rewritten and re-staged.
- Run `pnpm format:check` before pushing or opening a pull request.
- Keep the GitHub quality workflow passing; it independently checks formatting and TypeScript on pushes and pull requests.
- Run focused tests while developing, then the full automated suite before completing a task.
- Build both Chromium and Firefox after manifest, entrypoint, permission, or browser-adapter changes.
- Inspect generated manifests when changing WXT configuration.
- Test failure paths and recovery behavior, not only the successful path.
- Preserve unrelated user changes and avoid modifying generated artifacts.
- Report commands run, results, and any unverified manual acceptance criteria when handing off work.

## Documentation updates

Update `docs/PRD.md` when approved product behavior or scope changes. Update `docs/TASKS.md` when implementation sequencing, dependencies, or acceptance checks change. Keep requirement IDs and task traceability intact.

## Commit Messages and Pull Requests

- After initializing or cloning the Git repository, run `pnpm hooks:install` once. Future dependency installs configure the same hook automatically.
- Follow the [Chris Beams](http://chris.beams.io/posts/git-commit/) style for
  commit messages.
- Every pull request should answer:
  - **What changed?**
  - **Why?**
  - **Breaking changes?**

- Comments should be complete sentences and end with a period.
