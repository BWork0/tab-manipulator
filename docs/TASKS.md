# Tab Manipulator MVP: Implementation Task List

**Source PRD:** [`PRD.md`](./PRD.md)  
**Status:** Ready for implementation  
**Date:** 2026-08-04

## How to use this file

- Complete tasks in phase order unless a dependency explicitly allows parallel work.
- Check a task only after its acceptance checks pass.
- Requirement IDs refer to `docs/PRD.md`.
- `Depends on` identifies hard prerequisites. Tasks with satisfied dependencies may be implemented in parallel.
- Do not edit generated `.wxt/` or `.output/` files.

## Definition of done

The MVP is done when all P0 requirements in the PRD are implemented, automated checks pass, Chromium and Firefox MV3 packages build, the manual browser matrix passes, and remaining store-submission decisions are recorded without hiding product defects.

## Phase 0: Baseline and project setup

### T001 — Capture the clean starter baseline

- [x] Run the existing TypeScript compile and Chromium/Firefox builds before changing source.
- [x] Record any pre-existing warnings or failures in the implementation PR or development notes.
- [x] Confirm the package manager is pnpm from `pnpm-lock.yaml`.

**Requirements:** Build acceptance  
**Depends on:** None  
**Likely files:** None  
**Acceptance:** Baseline commands and outcomes are documented; no generated output is committed as source.

**Baseline evidence (2026-08-04):**

- `pnpm.cmd --version` reported pnpm 11.7.0; `pnpm-lock.yaml` and the `packageManager` field confirm pnpm is required.
- `pnpm.cmd compile` passed with no TypeScript errors or warnings.
- `pnpm.cmd build` passed and produced the expected Chromium MV3 starter output.
- `pnpm.cmd build:firefox` passed and produced Firefox MV2 output with the existing script. WXT warned that new Firefox extensions require `data_collection_permissions` metadata and that an extension ID is required for MV3 and recommended for MV2. Firefox MV3 script configuration is tracked by T002, and the stable extension ID is tracked by T065.
- Direct `pnpm` invocation was blocked by the host PowerShell execution policy for `pnpm.ps1`; the installed `pnpm.cmd` shim ran all required baseline commands successfully.
- `.wxt/` and `.output/` are ignored, and `git ls-files .wxt .output` confirmed that no generated artifacts are tracked.

### T002 — Configure product metadata, permissions, and MV3 scripts

- [x] Rename the package and set the manifest name/description through `package.json` and `wxt.config.ts`.
- [x] Configure only `tabs`, `storage`, and `alarms` permissions.
- [x] Ensure there are no `host_permissions` or content-script matches.
- [x] Change Firefox dev/build/zip scripts to pass `--mv3` explicitly.
- [x] Add scripts for test and combined validation commands.

**Requirements:** Sections 11–13; build acceptance  
**Depends on:** T001  
**Likely files:** `package.json`, `wxt.config.ts`  
**Acceptance:** Generated Chromium and Firefox manifests are MV3 and contain only the approved permissions; both targets build.

### T003 — Remove starter-only behavior and establish source boundaries

- [x] Delete the counter component and WXT/TypeScript demo popup content.
- [x] Remove `src/entrypoints/content.ts` so no content script is generated.
- [x] Create the `core`, `platform`, `storage`, and `messaging` directories defined by the PRD.
- [x] Keep browser runtime calls inside WXT entrypoint `main` functions or explicitly called platform services.

**Requirements:** Section 11  
**Depends on:** T001  
**Likely files:** `src/components/counter.ts`, `src/entrypoints/content.ts`, `src/entrypoints/popup/*`, new `src/*` directories  
**Acceptance:** Starter logos/counter/logs are gone; the generated manifest has no content scripts.

### T004 — Add the WXT-aware unit test harness

- [x] Add Vitest as a development dependency.
- [x] Configure `WxtVitest()` in `vitest.config.ts`.
- [x] Add a smoke test that imports `wxt/browser` and resets the WXT fake browser between tests.
- [x] Add coverage output for core and storage modules without enforcing an arbitrary repository-wide percentage yet.

**Requirements:** Section 15 automated coverage  
**Depends on:** T002  
**Likely files:** `package.json`, `vitest.config.ts`, `tests/setup.ts`, `tests/smoke.test.ts`  
**Acceptance:** The test command passes in a clean checkout and recognizes WXT aliases/environment values.

### T005 — Add deterministic formatting safeguards

- [x] Configure Prettier for TypeScript, JavaScript, JSON, CSS, HTML, Markdown, and YAML source files.
- [x] Ignore generated output, dependencies, the local WXT documentation snapshot, the package-manager lockfile, and raw PRD background material.
- [x] Add repository-wide write/check scripts and a staged-file formatting script.
- [x] Add a shareable pre-commit hook that formats and re-stages only files already selected for commit.
- [x] Make hook installation automatic after dependency installation when a Git repository exists and safely skippable before Git initialization.
- [x] Add a GitHub quality workflow that rejects unformatted or type-invalid changes on pushes and pull requests.
- [x] Format the current source baseline and verify formatting and TypeScript compilation.

**Requirements:** Maintainability; commit workflow  
**Depends on:** None  
**Likely files:** `package.json`, `pnpm-lock.yaml`, `.prettierrc.json`, `.prettierignore`, `.githooks/pre-commit`, `.github/workflows/quality.yml`, `scripts/install-git-hooks.mjs`, `AGENTS.md`  
**Acceptance:** `pnpm format:check` and `pnpm compile` pass; hook installation exits safely without Git and configures `.githooks` after Git initialization; staged formatting does not rewrite unrelated unstaged files; the GitHub workflow runs the same formatting and type checks.

**Verification evidence (2026-08-05):**

- `pnpm format` established the source baseline, and `pnpm validate` passed formatting, safeguard verification, TypeScript compilation, unit tests, and Chromium/Firefox MV3 builds.
- `pnpm hooks:install` configured `core.hooksPath` as `.githooks`.
- `pnpm format:verify-safeguards` passed isolated checks for a safe non-Git install, Git hook-path configuration, and formatting/re-staging a staged file without rewriting an unrelated unstaged file.
- `.github/workflows/quality.yml` runs the same formatting, safeguard, and TypeScript checks on pushes and pull requests.

## Phase 1: Shared domain model and pure logic

### T010 — Define versioned domain and result types

- [x] Define `Settings`, `TabDescriptor`, `RotationSession`, `RefreshSchedule`, run states, directions, and schema versions.
- [x] Define structured per-target action results and aggregate success/skip/failure counts.
- [x] Define stable error codes suitable for UI messages without persisting sensitive page content.
- [x] Export documented defaults from one module.

**Requirements:** Sections 8.2, 10, 13  
**Depends on:** T003  
**Likely files:** `src/core/types.ts`, `src/core/defaults.ts`  
**Acceptance:** Types model every persisted and user-visible MVP state; TypeScript compilation passes.

### T011 — Implement URL eligibility checks

- [x] Define the schemes/pages that can be activated and reloaded on each supported browser.
- [x] Return a typed ineligibility reason rather than a boolean alone.
- [x] Handle missing, malformed, and browser-internal URLs safely.
- [x] Add unit tests for ordinary HTTP(S), local development URLs, extension pages, browser settings pages, and malformed input.

**Requirements:** FR-003  
**Depends on:** T010  
**Likely files:** `src/core/tab-eligibility.ts`, `tests/core/tab-eligibility.test.ts`  
**Acceptance:** Unsupported pages are rejected consistently without browser API calls.

### T012 — Implement the MVP rule parser and matcher

- [x] Parse newline-separated rules into normalized plain-domain and wildcard-pattern forms.
- [x] Enforce the documented casing behavior and wildcard grammar.
- [x] Trim, deduplicate, and report invalid lines.
- [x] Implement empty-allowlist behavior and blocklist precedence.
- [x] Add table-driven tests for exact domains, subdomains, schemes, paths, ports, wildcard rules, duplicates, and conflicts.

**Requirements:** FR-031  
**Depends on:** T010  
**Likely files:** `src/core/rule-engine.ts`, `tests/core/rule-engine.test.ts`  
**Acceptance:** All rule semantics in FR-031 have direct test coverage; invalid sets cannot produce a partial saved value.

### T013 — Implement tab filtering and reconciliation

- [x] Combine URL eligibility, allow/block rules, and pinned preference into one pure target filter.
- [x] Reconcile stored descriptors with a current tab snapshot using session IDs plus URL checks.
- [x] Update current tab index/order without adding tabs not captured at schedule start.
- [x] Treat moved-window, closed, mismatched-ID, and newly ineligible targets as explicit outcomes.
- [x] Add tests for duplicate URLs and stale/reused numeric IDs.

**Requirements:** FR-001–003, FR-013, FR-030, FR-041  
**Depends on:** T011, T012  
**Likely files:** `src/core/target-reconciler.ts`, `tests/core/target-reconciler.test.ts`  
**Acceptance:** The reconciler never accepts a numeric ID whose current URL does not match its descriptor.

### T014 — Implement rotation next-target logic

- [ ] Implement wraparound forward and backward selection from current indices.
- [ ] Implement random selection without an immediate repeat when alternatives exist.
- [ ] Keep the cursor deterministic for forward/backward modes after removed or reordered tabs.
- [ ] Stop with a typed reason when fewer than two eligible targets remain.
- [ ] Inject the random-number source in tests.

**Requirements:** FR-011, FR-013  
**Depends on:** T013  
**Likely files:** `src/core/rotation-engine.ts`, `tests/core/rotation-engine.test.ts`  
**Acceptance:** Direction, wrap, reorder, removal, and random non-repeat cases pass deterministic unit tests.

### T015 — Implement refresh planning and aggregation

- [ ] Produce a refresh plan from the captured targets and current tab snapshot.
- [ ] Preserve independent skip/failure outcomes per target.
- [ ] Aggregate result counts for popup feedback without storing page content.
- [ ] Add tests proving one failed target does not suppress the rest.

**Requirements:** FR-021, FR-022  
**Depends on:** T013  
**Likely files:** `src/core/refresh-engine.ts`, `tests/core/refresh-engine.test.ts`  
**Acceptance:** Plans contain each eligible target at most once and produce accurate aggregate counts.

## Phase 2: Persistence, platform adapter, and scheduling

### T020 — Build the settings store

- [ ] Define a WXT `storage.defineItem` key for versioned settings with documented defaults.
- [ ] Validate values at the storage boundary and safely replace invalid fields with defaults.
- [ ] Expose typed read, update, and watch operations.
- [ ] Reserve a migration path for later schema versions.
- [ ] Add fake-browser tests for defaults, updates, corrupt values, and watcher behavior.

**Requirements:** FR-040  
**Depends on:** T004, T010, T012  
**Likely files:** `src/storage/settings-store.ts`, `tests/storage/settings-store.test.ts`  
**Acceptance:** Settings survive a fake background reload and invalid input cannot escape the store as a valid `Settings` object.

### T021 — Build the runtime schedule store

- [ ] Create separate WXT storage items for rotation and refresh runtime records.
- [ ] Provide atomic-looking get/set/update/clear operations per record.
- [ ] Validate schema version, timestamps, intervals, states, and target descriptors on read.
- [ ] Preserve or report corrupt/unknown data before returning a safe `needs-attention` state.
- [ ] Add tests for lifecycle transitions and clearing target URLs when stopped.

**Requirements:** FR-041; privacy requirements  
**Depends on:** T004, T010  
**Likely files:** `src/storage/runtime-store.ts`, `tests/storage/runtime-store.test.ts`  
**Acceptance:** Runtime state remains the source of truth across module reinitialization and is removed when its schedule stops.

### T022 — Implement the browser API adapter and capabilities

- [ ] Wrap current-window tab queries, all-window recovery queries, activation, reload, badge/title updates, and options-page opening.
- [ ] Convert browser exceptions into stable domain error codes.
- [ ] Detect required API availability and return capability states instead of assuming parity.
- [ ] Keep target-specific branches inside the adapter/capability modules.
- [ ] Add fake-browser tests for success, missing API, and rejected browser operations.

**Requirements:** FR-001, FR-003, FR-051; compatibility  
**Depends on:** T004, T010  
**Likely files:** `src/platform/browser-api.ts`, `src/platform/capabilities.ts`, `tests/platform/browser-api.test.ts`  
**Acceptance:** Core modules have no direct dependency on `wxt/browser`; popup code does not perform mutating tab operations.

### T023 — Implement typed messaging protocol and validation

- [ ] Define discriminated command types for snapshot, tab list, start/pause/resume/stop rotation, start/stop refresh, refresh-now, and settings updates.
- [ ] Define typed success and error responses.
- [ ] Add runtime guards for untrusted message values.
- [ ] Use a cross-browser-safe async response pattern (`sendResponse` plus the required listener return value) rather than relying on promise-return behavior that differs between runtimes and test doubles.
- [ ] Reject unknown messages with no side effects.
- [ ] Test all valid command shapes and representative malformed messages.

**Requirements:** FR-050  
**Depends on:** T010  
**Likely files:** `src/messaging/protocol.ts`, `tests/messaging/protocol.test.ts`  
**Acceptance:** Popup/options/background share the same protocol types and malformed messages never reach command handlers.

### T024 — Implement the hybrid scheduler abstraction

- [ ] Define schedule, cancel, recover, and due-event interfaces with injectable clock/timer dependencies.
- [ ] Use alarms for all refresh schedules and all intervals at or above 30 seconds.
- [ ] Use an in-memory timeout only for rotation below 30 seconds.
- [ ] Enforce deterministic alarm names and single listener registration.
- [ ] Recalculate `nextRunAt` from actual action completion/resume time and never replay a backlog.
- [ ] Test the 29,999/30,000 ms boundary, delayed callbacks, cancellation, duplicate callback delivery, and clock changes.

**Requirements:** FR-042  
**Depends on:** T010, T021, T022  
**Likely files:** `src/core/scheduler.ts`, `src/platform/alarm-scheduler.ts`, `tests/core/scheduler.test.ts`  
**Acceptance:** Exactly one scheduling mechanism owns a given due action and duplicate delivery cannot execute the same due timestamp twice.

### T025 — Implement conservative startup recovery

- [ ] Revalidate persisted live IDs and URL descriptors on background load.
- [ ] When IDs are stale, score open windows by exact URL matches and relative order.
- [ ] Resume only a unique, complete match; otherwise store `needs-attention` and schedule nothing.
- [ ] Perform at most one due action after wake/reload, then schedule from now.
- [ ] Restore exactly one alarm/timeout for each recoverable schedule.
- [ ] Add tests for same-session background reload, clean browser restart, duplicate URL ambiguity, partial restoration, and expired due times.

**Requirements:** FR-043; edge-case table  
**Depends on:** T013, T021, T022, T024  
**Likely files:** `src/core/recovery.ts`, `tests/core/recovery.test.ts`  
**Acceptance:** No ambiguous test case activates or reloads a tab; recoverable cases do not create duplicate scheduled callbacks.

## Phase 3: Background application services

### T030 — Implement rotation lifecycle service

- [ ] Validate start input and capture the current target descriptors/order.
- [ ] Confirm replacement intent when another rotation is active through a specific command flag.
- [ ] Implement start, pause, resume, stop, and due-tick handlers.
- [ ] Reconcile before every tick, activate exactly one target, persist the new cursor/timestamps, and schedule the next tick.
- [ ] Make repeated control commands idempotent.
- [ ] Stop and report when fewer than two eligible targets remain.

**Requirements:** FR-010–013, FR-030, FR-031, FR-041–043  
**Depends on:** T014, T020–T025  
**Likely files:** `src/services/rotation-service.ts`, `tests/services/rotation-service.test.ts`  
**Acceptance:** Service tests cover the full lifecycle, per-tick persistence, filtering changes, tab closure, and action failure.

### T031 — Implement refresh lifecycle service

- [ ] Validate 30-second minimum and selected targets at schedule start.
- [ ] Confirm replacement intent when another refresh schedule is active.
- [ ] Implement start, stop, due-run, and refresh-now handlers.
- [ ] Reconcile before every pass, attempt all valid targets independently, persist result/timestamps, and schedule the next pass.
- [ ] Keep refresh-now independent of an existing schedule's next due time.
- [ ] Make repeated stop/due commands idempotent.

**Requirements:** FR-020–022, FR-030, FR-031, FR-041–043  
**Depends on:** T015, T020–T025  
**Likely files:** `src/services/refresh-service.ts`, `tests/services/refresh-service.test.ts`  
**Acceptance:** Tests prove partial failure handling, no catch-up replay, unchanged scheduled due time after refresh-now, and safe target removal.

### T032 — Implement automation snapshot and badge service

- [ ] Combine persisted rotation, refresh, capability, and recent-result state into one popup snapshot.
- [ ] Map idle/running/paused/needs-attention combinations to the PRD badge text, color, and title.
- [ ] Clear the badge when the final schedule stops.
- [ ] Treat badge errors as non-fatal and observable in structured logs/results.
- [ ] Add tests for each state combination.

**Requirements:** FR-051; section 8.4  
**Depends on:** T021, T022, T030, T031  
**Likely files:** `src/services/status-service.ts`, `tests/services/status-service.test.ts`  
**Acceptance:** Every defined popup status has a deterministic badge/title representation and automation still succeeds if badge update fails.

### T033 — Wire the WXT background entrypoint

- [ ] Register runtime-message and alarm listeners once inside `defineBackground`.
- [ ] Dispatch validated messages to rotation, refresh, settings, tab-list, and snapshot handlers.
- [ ] Trigger conservative recovery without making the WXT entrypoint `main` function async.
- [ ] Handle `runtime.onStartup`/`onInstalled` only where needed and without duplicate work.
- [ ] Convert uncaught command errors to typed responses and safe persisted attention state.

**Requirements:** FR-043, FR-050  
**Depends on:** T023–T032  
**Likely files:** `src/entrypoints/background.ts`, `src/background/create-app.ts`, `tests/background/background.test.ts`  
**Acceptance:** Closing the popup never stops automation; simulated background reinitialization restores listeners and scheduling exactly once.

## Phase 4: Popup experience

### T040 — Build the accessible popup shell and status region

- [ ] Replace starter HTML/CSS with a compact extension popup layout.
- [ ] Add semantic headings/regions, visible focus styles, and a polite live region.
- [ ] Render all status variants and the next due action from a background snapshot.
- [ ] Add loading, empty, unsupported, and command-error states.
- [ ] Make the layout usable at 200% zoom and in light/dark browser themes.

**Requirements:** Sections 8.1, 8.3, 13 accessibility; FR-051  
**Depends on:** T003, T023, T032, T033  
**Likely files:** `src/entrypoints/popup/index.html`, `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`  
**Acceptance:** Keyboard and screen-reader smoke checks pass; state is conveyed by text as well as color.

### T041 — Build current-window tab selection

- [ ] Request the current tab list from the background on popup open.
- [ ] Render favicon opportunistically without blocking initial interaction.
- [ ] Show title, domain, pinned state, selection state, and disabled reason.
- [ ] Implement individual, select-all-eligible, and clear controls.
- [ ] Keep selection local to the open popup and revalidate it when a command runs.
- [ ] Measure the initial render with 100 synthetic tab rows.

**Requirements:** FR-001–003; performance  
**Depends on:** T040  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/tab-list.ts`  
**Acceptance:** Eligible selection works by mouse and keyboard; restricted/missing-data tabs render safely; reference render is under 500 ms.

### T042 — Build rotation controls

- [ ] Add 10-second, 30-second, 1-minute, and custom interval controls.
- [ ] Add forward, backward, and random direction controls.
- [ ] Validate at least two selected eligible targets and a 10-second minimum.
- [ ] Implement start, replacement confirmation, pause, resume, and stop commands.
- [ ] Explain best-effort timing for sub-30-second rotation.
- [ ] Refresh the snapshot and announce the result after every command.

**Requirements:** FR-010–013; sections 8.2–8.3  
**Depends on:** T041  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/rotation-controls.ts`  
**Acceptance:** Controls always reflect persisted background state and double-click/repeated commands do not create duplicate sessions.

### T043 — Build refresh controls

- [ ] Add 30-second, 1-minute, 5-minute, and custom interval controls.
- [ ] Validate at least one selected eligible target and a 30-second minimum.
- [ ] Implement start, replacement confirmation, stop, and refresh-now commands.
- [ ] Show aggregate success/skipped/failed results.
- [ ] Refresh the snapshot and announce the result after every command.

**Requirements:** FR-020–022; sections 8.2–8.3  
**Depends on:** T041  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/refresh-controls.ts`  
**Acceptance:** Refresh-now does not alter an active schedule and partial results are understandable without inspecting developer tools.

### T044 — Add advanced-settings navigation and final popup polish

- [ ] Open the WXT options page through the browser adapter.
- [ ] Show the active pinned/filter summary near automation controls.
- [ ] Ensure command controls disable while an operation is pending.
- [ ] Prevent double submission and restore focus after confirmation/error states.
- [ ] Remove any remaining starter assets that are no longer used.

**Requirements:** Section 8.1; FR-050  
**Depends on:** T042, T043  
**Likely files:** `src/entrypoints/popup/*`, `src/assets/*`, `public/wxt.svg`  
**Acceptance:** Popup has no dead links, starter branding, duplicated actions, or focus traps.

## Phase 5: Options experience

### T050 — Create the WXT options entrypoint

- [ ] Add the one-level `src/entrypoints/options/` HTML entrypoint and TypeScript/CSS assets.
- [ ] Load the current typed settings on open.
- [ ] Include clear save state, unsaved-change behavior, and accessible status feedback.
- [ ] Avoid putting runtime browser calls outside the WXT entrypoint execution path.

**Requirements:** FR-040; section 8.1  
**Depends on:** T020, T023, T033  
**Likely files:** `src/entrypoints/options/index.html`, `src/entrypoints/options/main.ts`, `src/entrypoints/options/style.css`  
**Acceptance:** WXT generates `options.html`; settings load and the page works in Chromium and Firefox builds.

### T051 — Implement defaults and pinned-tab settings

- [ ] Add default rotation interval/direction and refresh interval controls.
- [ ] Add the shared include-pinned toggle with excluded as the default.
- [ ] Reuse the same interval validators as the popup.
- [ ] Save a complete validated settings update through the background.
- [ ] Verify active schedules revalidate on their next action after a setting changes.

**Requirements:** FR-030, FR-040  
**Depends on:** T050  
**Likely files:** `src/entrypoints/options/main.ts`, shared `src/ui/validation.ts`  
**Acceptance:** Values persist across browser restart and invalid values cannot overwrite the last valid settings.

### T052 — Implement allowlist/blocklist editor

- [ ] Add labelled multiline allowlist and blocklist inputs with syntax examples.
- [ ] Validate the entire rule set before save and identify each invalid line.
- [ ] Normalize/deduplicate only after validation succeeds.
- [ ] Explain empty allowlist and blocklist-wins precedence.
- [ ] Add UI-level tests or deterministic DOM tests for validation feedback.

**Requirements:** FR-031, FR-040  
**Depends on:** T012, T050  
**Likely files:** `src/entrypoints/options/main.ts`, `src/entrypoints/options/style.css`  
**Acceptance:** Invalid rules preserve the last saved settings; valid rules produce the same result in options preview and background actions.

### T053 — Add privacy and permission explanation

- [ ] Explain local-only storage, no analytics/network transfer, and why `tabs` is required.
- [ ] State that stopping schedules deletes their runtime tab descriptors.
- [ ] Link no remote resources from the options page.
- [ ] Confirm copy is accurate against the generated manifest.

**Requirements:** Section 12  
**Depends on:** T050, T002  
**Likely files:** `src/entrypoints/options/index.html`, `src/entrypoints/options/main.ts`  
**Acceptance:** The page's permission list exactly matches both production manifests and no outbound request is generated during use.

## Phase 6: Integration, quality, and release

### T060 — Complete integration and regression tests

- [ ] Cover start-to-tick-to-stop for rotation and refresh through the message boundary.
- [ ] Cover background reinitialization, delayed alarms, ambiguous recovery, stale IDs, and partial browser API failures.
- [ ] Cover settings changes affecting the next active-schedule action.
- [ ] Assert badge changes and runtime-record cleanup.
- [ ] Ensure fake-browser state resets between cases.

**Requirements:** Section 15 automated coverage  
**Depends on:** T033, T044, T052  
**Likely files:** `tests/integration/*`  
**Acceptance:** The test suite is deterministic, leaves no timers/listeners open, and exercises every P0 requirement at least once.

### T061 — Verify performance and idle behavior

- [ ] Measure popup load/render with 100 tabs and document the reference environment/result.
- [ ] Run rotation and refresh with 50+ tabs and check for action storms or UI stalls.
- [ ] Confirm there is no timer, alarm, listener loop, or storage write polling while idle.
- [ ] Confirm favicon failures do not delay interaction.
- [ ] Profile storage writes during an active schedule to verify they occur only on state changes/ticks.

**Requirements:** Sections 5.2 and 13 performance  
**Depends on:** T060  
**Likely files:** Implementation notes or `docs/QA.md`; code only if defects are found  
**Acceptance:** PRD performance thresholds pass or a measured blocker is documented and fixed before release.

### T062 — Run accessibility review

- [ ] Use every popup and options action by keyboard only.
- [ ] Verify accessible names, group labels, status announcements, validation association, and focus restoration.
- [ ] Check visible focus and non-color state indicators in light and dark mode.
- [ ] Check both pages at 200% zoom.
- [ ] Fix all release-blocking WCAG 2.2 AA issues.

**Requirements:** Section 13 accessibility  
**Depends on:** T044, T052, T053  
**Likely files:** Popup/options HTML, TypeScript, and CSS  
**Acceptance:** The accessibility checklist passes in at least Chrome and Firefox with no keyboard trap or unlabeled control.

### T063 — Execute the cross-browser manual matrix

- [ ] Test current stable Chrome, Edge, and Firefox using fresh profiles.
- [ ] Exercise every flow listed in PRD section 15, including restart and sleep/wake recovery.
- [ ] Smoke-test the Chromium artifact in Brave and Opera when available.
- [ ] Record browser versions, build hashes, failures, and retest outcomes.
- [ ] Verify sub-30-second timing copy is visible and truthful in each target.

**Requirements:** Section 15 manual browser matrix  
**Depends on:** T060–T062  
**Likely files:** `docs/QA.md` or release checklist  
**Acceptance:** Chrome, Edge, and Firefox have no open P0 defects; Brave/Opera findings are classified as blocking or best-effort.

### T064 — Audit manifests, permissions, privacy, and packages

- [ ] Inspect generated Chromium and Firefox manifests rather than only source config.
- [ ] Confirm MV3, permissions, icons, action popup, options page, and absence of content scripts/host permissions.
- [ ] Observe network activity during representative usage and confirm no extension-originated traffic.
- [ ] Verify stopping schedules removes runtime URL/title descriptors.
- [ ] Build production ZIPs and inspect their contents for source maps, tests, docs, or starter assets that should not ship.

**Requirements:** Sections 11–12; build acceptance  
**Depends on:** T063  
**Likely files:** `wxt.config.ts`, `package.json`, source/assets if defects are found  
**Acceptance:** Both archives contain only necessary production artifacts and match the privacy/permission claims.

### T065 — Resolve store-blocking product decisions

- [ ] Replace the working title and placeholder copy with the final product name/description.
- [ ] Add the stable Firefox extension ID.
- [ ] Record minimum browser versions.
- [ ] Decide whether 10 or 30 seconds is the production default using beta timing results.
- [ ] Confirm launch order and store ownership for Chrome, Edge, and Firefox.

**Requirements:** PRD section 18  
**Depends on:** T063  
**Likely files:** `package.json`, `wxt.config.ts`, popup/options copy, release notes  
**Acceptance:** No placeholder identity or unresolved store metadata remains in production packages.

### T066 — Final release gate

- [ ] Run compile, unit/integration tests, Chromium build/zip, and Firefox MV3 build/zip from a clean checkout.
- [ ] Confirm all P0 requirements and this task list are traceable to passing tests or recorded manual evidence.
- [ ] Complete a 60-minute rotation reliability test at a 30-second-or-longer interval.
- [ ] Confirm delayed alarms execute at most one catch-up pass.
- [ ] Record known limitations, especially best-effort 10-second rotation behavior.

**Requirements:** Sections 5.2, 15, and 16  
**Depends on:** T064, T065  
**Likely files:** Release checklist/release notes  
**Acceptance:** Every PRD release criterion passes, production archives are reproducible, and no P0 defect remains open.

## Requirement-to-task traceability

| Requirement               | Primary tasks                            |
| ------------------------- | ---------------------------------------- |
| FR-001–003                | T011, T013, T022, T041                   |
| FR-010–013                | T014, T024, T030, T042                   |
| FR-020–022                | T015, T024, T031, T043                   |
| FR-030–031                | T012, T013, T020, T051, T052             |
| FR-040–043                | T020, T021, T024, T025, T030, T031, T033 |
| FR-050–051                | T023, T032, T033, T040, T044             |
| Privacy/permissions       | T002, T003, T053, T064                   |
| Performance/accessibility | T041, T061, T062                         |
| Cross-browser/release     | T002, T004, T060, T063–T066              |
