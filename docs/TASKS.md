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

- [x] Implement wraparound forward and backward selection from current indices.
- [x] Implement random selection without an immediate repeat when alternatives exist.
- [x] Keep the cursor deterministic for forward/backward modes after removed or reordered tabs.
- [x] Stop with a typed reason when fewer than two eligible targets remain.
- [x] Inject the random-number source in tests.

**Requirements:** FR-011, FR-013  
**Depends on:** T013  
**Likely files:** `src/core/rotation-engine.ts`, `tests/core/rotation-engine.test.ts`  
**Acceptance:** Direction, wrap, reorder, removal, and random non-repeat cases pass deterministic unit tests.

### T015 — Implement refresh planning and aggregation

- [x] Produce a refresh plan from the captured targets and current tab snapshot.
- [x] Preserve independent skip/failure outcomes per target.
- [x] Aggregate result counts for popup feedback without storing page content.
- [x] Add tests proving one failed target does not suppress the rest.

**Requirements:** FR-021, FR-022  
**Depends on:** T013  
**Likely files:** `src/core/refresh-engine.ts`, `tests/core/refresh-engine.test.ts`  
**Acceptance:** Plans contain each eligible target at most once and produce accurate aggregate counts.

## Phase 2: Persistence, platform adapter, and scheduling

### T020 — Build the settings store

- [x] Define a WXT `storage.defineItem` key for versioned settings with documented defaults.
- [x] Validate values at the storage boundary and safely replace invalid fields with defaults.
- [x] Expose typed read, update, and watch operations.
- [x] Reserve a migration path for later schema versions.
- [x] Add fake-browser tests for defaults, updates, corrupt values, and watcher behavior.

**Requirements:** FR-040  
**Depends on:** T004, T010, T012  
**Likely files:** `src/storage/settings-store.ts`, `tests/storage/settings-store.test.ts`  
**Acceptance:** Settings survive a fake background reload and invalid input cannot escape the store as a valid `Settings` object.

### T021 — Build the runtime schedule store

- [x] Create separate WXT storage items for rotation and refresh runtime records.
- [x] Provide atomic-looking get/set/update/clear operations per record.
- [x] Validate schema version, timestamps, intervals, states, and target descriptors on read.
- [x] Preserve or report corrupt/unknown data before returning a safe `needs-attention` state.
- [x] Add tests for lifecycle transitions and clearing target URLs when stopped.

**Requirements:** FR-041; privacy requirements  
**Depends on:** T004, T010  
**Likely files:** `src/storage/runtime-store.ts`, `tests/storage/runtime-store.test.ts`  
**Acceptance:** Runtime state remains the source of truth across module reinitialization and is removed when its schedule stops.

### T022 — Implement the browser API adapter and capabilities

- [x] Wrap current-window tab queries, all-window recovery queries, activation, reload, badge/title updates, and options-page opening.
- [x] Convert browser exceptions into stable domain error codes.
- [x] Detect required API availability and return capability states instead of assuming parity.
- [x] Keep target-specific branches inside the adapter/capability modules.
- [x] Add fake-browser tests for success, missing API, and rejected browser operations.

**Requirements:** FR-001, FR-003, FR-051; compatibility  
**Depends on:** T004, T010  
**Likely files:** `src/platform/browser-api.ts`, `src/platform/capabilities.ts`, `tests/platform/browser-api.test.ts`  
**Acceptance:** Core modules have no direct dependency on `wxt/browser`; popup code does not perform mutating tab operations.

### T023 — Implement typed messaging protocol and validation

- [x] Define discriminated command types for snapshot, tab list, start/pause/resume/stop rotation, start/stop refresh, refresh-now, and settings updates.
- [x] Define typed success and error responses.
- [x] Add runtime guards for untrusted message values.
- [x] Use a cross-browser-safe async response pattern (`sendResponse` plus the required listener return value) rather than relying on promise-return behavior that differs between runtimes and test doubles.
- [x] Reject unknown messages with no side effects.
- [x] Test all valid command shapes and representative malformed messages.

**Requirements:** FR-050  
**Depends on:** T010  
**Likely files:** `src/messaging/protocol.ts`, `tests/messaging/protocol.test.ts`  
**Acceptance:** Popup/options/background share the same protocol types and malformed messages never reach command handlers.

### T024 — Implement the hybrid scheduler abstraction

- [x] Define schedule, cancel, recover, and due-event interfaces with injectable clock/timer dependencies.
- [x] Use alarms for all refresh schedules and all intervals at or above 30 seconds.
- [x] Use an in-memory timeout only for rotation below 30 seconds.
- [x] Enforce deterministic alarm names and single listener registration.
- [x] Recalculate `nextRunAt` from actual action completion/resume time and never replay a backlog.
- [x] Test the 29,999/30,000 ms boundary, delayed callbacks, cancellation, duplicate callback delivery, and clock changes.

**Requirements:** FR-042  
**Depends on:** T010, T021, T022  
**Likely files:** `src/core/scheduler.ts`, `src/platform/alarm-scheduler.ts`, `tests/core/scheduler.test.ts`  
**Acceptance:** Exactly one scheduling mechanism owns a given due action and duplicate delivery cannot execute the same due timestamp twice.

### T025 — Implement conservative startup recovery

- [x] Revalidate persisted live IDs and URL descriptors on background load.
- [x] When IDs are stale, score open windows by exact URL matches and relative order.
- [x] Resume only a unique, complete match; otherwise store `needs-attention` and schedule nothing.
- [x] Perform at most one due action after wake/reload, then schedule from now.
- [x] Restore exactly one alarm/timeout for each recoverable schedule.
- [x] Add tests for same-session background reload, clean browser restart, duplicate URL ambiguity, partial restoration, and expired due times.

**Requirements:** FR-043; edge-case table  
**Depends on:** T013, T021, T022, T024  
**Likely files:** `src/core/recovery.ts`, `tests/core/recovery.test.ts`  
**Acceptance:** No ambiguous test case activates or reloads a tab; recoverable cases do not create duplicate scheduled callbacks.

## Phase 3: Background application services

### T030 — Implement rotation lifecycle service

- [x] Validate start input and capture the current target descriptors/order.
- [x] Confirm replacement intent when another rotation is active through a specific command flag.
- [x] Implement start, pause, resume, stop, and due-tick handlers.
- [x] Reconcile before every tick, activate exactly one target, persist the new cursor/timestamps, and schedule the next tick.
- [x] Make repeated control commands idempotent.
- [x] Stop and report when fewer than two eligible targets remain.

**Requirements:** FR-010–013, FR-030, FR-031, FR-041–043  
**Depends on:** T014, T020–T025  
**Likely files:** `src/services/rotation-service.ts`, `tests/services/rotation-service.test.ts`  
**Acceptance:** Service tests cover the full lifecycle, per-tick persistence, filtering changes, tab closure, and action failure.

### T031 — Implement refresh lifecycle service

- [x] Validate 30-second minimum and selected targets at schedule start.
- [x] Confirm replacement intent when another refresh schedule is active.
- [x] Implement start, stop, due-run, and refresh-now handlers.
- [x] Reconcile before every pass, attempt all valid targets independently, persist result/timestamps, and schedule the next pass.
- [x] Keep refresh-now independent of an existing schedule's next due time.
- [x] Make repeated stop/due commands idempotent.

**Requirements:** FR-020–022, FR-030, FR-031, FR-041–043  
**Depends on:** T015, T020–T025  
**Likely files:** `src/services/refresh-service.ts`, `tests/services/refresh-service.test.ts`  
**Acceptance:** Tests prove partial failure handling, no catch-up replay, unchanged scheduled due time after refresh-now, and safe target removal.

### T032 — Implement automation snapshot and badge service

- [x] Combine persisted rotation, refresh, capability, and recent-result state into one popup snapshot.
- [x] Map idle/running/paused/needs-attention combinations to the PRD badge text, color, and title.
- [x] Clear the badge when the final schedule stops.
- [x] Treat badge errors as non-fatal and observable in structured logs/results.
- [x] Add tests for each state combination.

**Requirements:** FR-051; section 8.4  
**Depends on:** T021, T022, T030, T031  
**Likely files:** `src/services/status-service.ts`, `tests/services/status-service.test.ts`  
**Acceptance:** Every defined popup status has a deterministic badge/title representation and automation still succeeds if badge update fails.

### T033 — Wire the WXT background entrypoint

- [x] Register runtime-message and alarm listeners once inside `defineBackground`.
- [x] Dispatch validated messages to rotation, refresh, settings, tab-list, and snapshot handlers.
- [x] Trigger conservative recovery without making the WXT entrypoint `main` function async.
- [x] Handle `runtime.onStartup`/`onInstalled` only where needed and without duplicate work.
- [x] Convert uncaught command errors to typed responses and safe persisted attention state.

**Requirements:** FR-043, FR-050  
**Depends on:** T023–T032  
**Likely files:** `src/entrypoints/background.ts`, `src/background/create-app.ts`, `tests/background/background.test.ts`  
**Acceptance:** Closing the popup never stops automation; simulated background reinitialization restores listeners and scheduling exactly once.

## Phase 4: Popup experience

### T040 — Build the accessible popup shell and status region

- [x] Replace starter HTML/CSS with a compact extension popup layout.
- [x] Add semantic headings/regions, visible focus styles, and a polite live region.
- [x] Render all status variants and the next due action from a background snapshot.
- [x] Add loading, empty, unsupported, and command-error states.
- [x] Make the layout usable at 200% zoom and in light/dark browser themes.

**Requirements:** Sections 8.1, 8.3, 13 accessibility; FR-051  
**Depends on:** T003, T023, T032, T033  
**Likely files:** `src/entrypoints/popup/index.html`, `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`  
**Acceptance:** Keyboard and screen-reader smoke checks pass; state is conveyed by text as well as color.

### T041 — Build current-window tab selection

- [x] Request the current tab list from the background on popup open.
- [x] Render favicon opportunistically without blocking initial interaction.
- [x] Show title, domain, pinned state, selection state, and disabled reason.
- [x] Implement individual, select-all-eligible, and clear controls.
- [x] Keep selection local to the open popup and revalidate it when a command runs.
- [x] Measure the initial render with 100 synthetic tab rows.

**Requirements:** FR-001–003; performance  
**Depends on:** T040  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/tab-list.ts`  
**Acceptance:** Eligible selection works by mouse and keyboard; restricted/missing-data tabs render safely; reference render is under 500 ms.

**Verification evidence (2026-08-06):**

- Focused popup tests passed six interaction, fallback, error, revalidation, deferred-favicon, and performance cases. Native checkbox/button controls cover mouse and keyboard operation without custom key handling.
- The 100-row LinkeDOM render measured 4.71 ms on Windows 10.0.19045 with Node.js 24.10.0 on an Intel64 Family 6 Model 167 processor, below the 500 ms acceptance threshold.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, the complete automated suite, and Chromium/Firefox MV3 production builds.

### T042 — Build rotation controls

- [x] Add 10-second, 30-second, 1-minute, and custom interval controls.
- [x] Add forward, backward, and random direction controls.
- [x] Validate at least two selected eligible targets and a 10-second minimum.
- [x] Implement start, replacement confirmation, pause, resume, and stop commands.
- [x] Explain best-effort timing for sub-30-second rotation.
- [x] Refresh the snapshot and announce the result after every command.

**Requirements:** FR-010–013; sections 8.2–8.3  
**Depends on:** T041  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/rotation-controls.ts`  
**Acceptance:** Controls always reflect persisted background state and double-click/repeated commands do not create duplicate sessions.

**Verification evidence (2026-08-06):**

- Focused popup tests passed 23 rotation, tab-selection, and status cases, including persisted-state rendering, minimum/target validation, replacement confirmation, lifecycle commands, typed failures, and double-submit suppression.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 235 automated tests, and Chromium/Firefox MV3 production builds.

### T043 — Build refresh controls

- [x] Add 30-second, 1-minute, 5-minute, and custom interval controls.
- [x] Validate at least one selected eligible target and a 30-second minimum.
- [x] Implement start, replacement confirmation, stop, and refresh-now commands.
- [x] Show aggregate success/skipped/failed results.
- [x] Refresh the snapshot and announce the result after every command.

**Requirements:** FR-020–022; sections 8.2–8.3  
**Depends on:** T041  
**Likely files:** `src/entrypoints/popup/main.ts`, `src/entrypoints/popup/style.css`, optional `src/ui/refresh-controls.ts`  
**Acceptance:** Refresh-now does not alter an active schedule and partial results are understandable without inspecting developer tools.

**Verification evidence (2026-08-06):**

- Eight focused refresh-control tests passed persisted preset/custom rendering, minimum and target validation, start/replacement/stop commands, refresh-now schedule independence, visible and announced partial counts, typed failure recovery, and double-submit suppression.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 243 automated tests, and Chromium/Firefox MV3 production builds.

### T044 — Add advanced-settings navigation and final popup polish

- [x] Open the WXT options page through the browser adapter.
- [x] Show the active pinned/filter summary near automation controls.
- [x] Ensure command controls disable while an operation is pending.
- [x] Prevent double submission and restore focus after confirmation/error states.
- [x] Remove any remaining starter assets that are no longer used.

**Requirements:** Section 8.1; FR-050  
**Depends on:** T042, T043  
**Likely files:** `src/entrypoints/popup/*`, `src/assets/*`, `public/wxt.svg`  
**Acceptance:** Popup has no dead links, starter branding, duplicated actions, or focus traps.

**Verification evidence (2026-08-06):**

- Thirty-eight focused popup tests passed options-page adapter navigation, active pinned/filter summaries, shared pending-state control disabling, duplicate-submission suppression, and focus restoration after confirmations and errors.
- Source and generated Chromium/Firefox popup output contain no starter logo/counter assets or dead source links; only the product icon set remains.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 250 automated tests, and Chromium/Firefox MV3 production builds.

## Phase 5: Options experience

### T050 — Create the WXT options entrypoint

- [x] Add the one-level `src/entrypoints/options/` HTML entrypoint and TypeScript/CSS assets.
- [x] Load the current typed settings on open.
- [x] Include clear save state, unsaved-change behavior, and accessible status feedback.
- [x] Avoid putting runtime browser calls outside the WXT entrypoint execution path.

**Requirements:** FR-040; section 8.1  
**Depends on:** T020, T023, T033  
**Likely files:** `src/entrypoints/options/index.html`, `src/entrypoints/options/main.ts`, `src/entrypoints/options/style.css`  
**Acceptance:** WXT generates `options.html`; settings load and the page works in Chromium and Firefox builds.

**Verification evidence (2026-08-06):**

- Six focused options tests passed typed background-protocol loading and rendering, saved and unsaved states, unload warning and discard behavior, atomic save with duplicate-submit suppression, failed-save draft preservation, and load retry.
- Chromium and Firefox MV3 production builds generated `options.html`; both manifests reference it through `options_ui.page` with tab-based opening enabled.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 256 automated tests, and Chromium/Firefox MV3 production builds.

### T051 — Implement defaults and pinned-tab settings

- [x] Add default rotation interval/direction and refresh interval controls.
- [x] Add the shared include-pinned toggle with excluded as the default.
- [x] Reuse the same interval validators as the popup.
- [x] Save a complete validated settings update through the background.
- [x] Verify active schedules revalidate on their next action after a setting changes.

**Requirements:** FR-030, FR-040  
**Depends on:** T050  
**Likely files:** `src/entrypoints/options/main.ts`, shared `src/ui/validation.ts`  
**Acceptance:** Values persist across browser restart and invalid values cannot overwrite the last valid settings.

**Verification evidence (2026-08-06):**

- Fifty-two focused tests passed editable preset/custom defaults, excluded-by-default pinned behavior, shared popup/options interval validation, complete background updates, invalid-update preservation, and next-action pinned revalidation for active rotation and refresh schedules.
- The settings-store reload test persisted custom rotation and refresh intervals, direction, and pinned behavior across a simulated background module restart.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 266 automated tests, and Chromium/Firefox MV3 production builds.

### T052 — Implement allowlist/blocklist editor

- [x] Add labelled multiline allowlist and blocklist inputs with syntax examples.
- [x] Validate the entire rule set before save and identify each invalid line.
- [x] Normalize/deduplicate only after validation succeeds.
- [x] Explain empty allowlist and blocklist-wins precedence.
- [x] Add UI-level tests or deterministic DOM tests for validation feedback.

**Requirements:** FR-031, FR-040  
**Depends on:** T012, T050  
**Likely files:** `src/entrypoints/options/main.ts`, `src/entrypoints/options/style.css`  
**Acceptance:** Invalid rules preserve the last saved settings; valid rules produce the same result in options preview and background actions.

**Verification evidence (2026-08-08):**

- Ten focused options tests passed labelled multiline markup, full-set validation with every offending line, invalid-draft preservation, post-validation normalization/deduplication, canonical saved rendering, and shared matcher preview behavior.
- The background boundary regression rejected invalid allowlist and blocklist rules after a valid update without issuing another settings-store write.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 271 automated tests, and Chromium/Firefox MV3 production builds.

### T053 — Add privacy and permission explanation

- [x] Explain local-only storage, no analytics/network transfer, and why `tabs` is required.
- [x] State that stopping schedules deletes their runtime tab descriptors.
- [x] Link no remote resources from the options page.
- [x] Confirm copy is accurate against the generated manifest.

**Requirements:** Section 12  
**Depends on:** T050, T002  
**Likely files:** `src/entrypoints/options/index.html`, `src/entrypoints/options/main.ts`  
**Acceptance:** The page's permission list exactly matches both production manifests and no outbound request is generated during use.

**Verification evidence (2026-08-08):**

- Three focused privacy tests passed local-only/no-analytics copy, runtime-descriptor cleanup copy, exact permission names and `tabs` rationale, packaged resource references, and absence of network clients in the options source.
- Direct inspection confirmed the Chromium and Firefox MV3 manifests both declare exactly `tabs`, `storage`, and `alarms`, matching the options-page list; neither manifest contains host permissions or content scripts.
- Both built options pages referenced only packaged scripts and styles. The generated module-preload helper accesses only its extension-local validation chunk, so use produces no outbound request.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 274 automated tests, and Chromium/Firefox MV3 production builds.

## Phase 6: Integration, quality, and release

### T060 — Complete integration and regression tests

- [x] Cover start-to-tick-to-stop for rotation and refresh through the message boundary.
- [x] Cover background reinitialization, delayed alarms, ambiguous recovery, stale IDs, and partial browser API failures.
- [x] Cover settings changes affecting the next active-schedule action.
- [x] Assert badge changes and runtime-record cleanup.
- [x] Ensure fake-browser state resets between cases.

**Requirements:** Section 15 automated coverage  
**Depends on:** T033, T044, T052  
**Likely files:** `tests/integration/*`  
**Acceptance:** The test suite is deterministic, leaves no timers/listeners open, and exercises every P0 requirement at least once.

**Verification evidence (2026-08-08):**

- Four production-composed background integration tests passed message-boundary rotation and refresh lifecycles, delayed duplicate alarm delivery, per-target refresh failure isolation, next-action pinned-setting revalidation, and stale-ID ambiguous recovery after background reinitialization.
- Integration cleanup assertions proved no injected timeout remained after a case, while fake-browser state and listeners reset before and after every case. The flows also verified running, failed-action, attention, and idle badge changes plus persisted runtime-record deletion on stop.
- The complete 278-test suite passed and covers every P0 group through tab-list/popup tests (FR-001–003), rotation tests (FR-010–013), refresh tests (FR-020–022), settings/rule tests (FR-030–031), storage/scheduler/recovery tests (FR-040–043), and messaging/background/status tests (FR-050–051).
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 278 automated tests, and Chromium/Firefox MV3 production builds.

### T061 — Verify performance and idle behavior

- [x] Measure popup load/render with 100 tabs and document the reference environment/result.
- [x] Run rotation and refresh with 50+ tabs and check for action storms or UI stalls.
- [x] Confirm there is no timer, alarm, listener loop, or storage write polling while idle.
- [x] Confirm favicon failures do not delay interaction.
- [x] Profile storage writes during an active schedule to verify they occur only on state changes/ticks.

**Requirements:** Sections 5.2 and 13 performance  
**Depends on:** T060  
**Likely files:** Implementation notes or `docs/QA.md`; code only if defects are found  
**Acceptance:** PRD performance thresholds pass or a measured blocker is documented and fixed before release.

**Verification evidence (2026-08-08):**

- The 100-row LinkeDOM popup render measured 9.09 ms on Windows 10.0.19045 with Node.js 24.10.0 on an Intel64 Family 6 Model 167 processor, below the 500 ms PRD threshold. Deferred favicon failure left selection controls interactive.
- The production-composed fake-browser lifecycle processed 55 tabs in 75.75 ms with one activation and 55 unique reload attempts. Duplicate rotation and refresh alarm deliveries did not create an extra action pass.
- Idle startup created no timeout, browser alarm, or storage mutation and registered each background listener once even when application startup was requested twice.
- Storage profiling observed writes only when rotation/refresh records were started or ticked; intervening snapshot and tab-list reads performed no storage mutation. Stops removed both alarms and left no timeout.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 280 automated tests, and Chromium/Firefox MV3 production builds. Detailed environment and measurement notes are recorded in `docs/QA.md`.

### T062 — Run accessibility review

- [x] Use every popup and options action by keyboard only.
- [x] Verify accessible names, group labels, status announcements, validation association, and focus restoration.
- [x] Check visible focus and non-color state indicators in light and dark mode.
- [x] Check both pages at 200% zoom.
- [x] Fix all release-blocking WCAG 2.2 AA issues.

**Requirements:** Section 13 accessibility  
**Depends on:** T044, T052, T053  
**Likely files:** Popup/options HTML, TypeScript, and CSS  
**Acceptance:** The accessibility checklist passes in at least Chrome and Firefox with no keyboard trap or unlabeled control.

### T063 — Execute the cross-browser manual matrix

- [x] Test current stable Chrome, Edge, and Firefox using fresh profiles.
- [x] Exercise every flow listed in PRD section 15, including restart and sleep/wake recovery.
- [x] Smoke-test the Chromium artifact in Brave and Opera when available.
- [x] Record browser versions, build hashes, failures, and retest outcomes.
- [x] Verify sub-30-second timing copy is visible and truthful in each target.

**Requirements:** Section 15 manual browser matrix  
**Depends on:** T060–T062  
**Likely files:** `docs/QA.md` or release checklist  
**Acceptance:** Chrome, Edge, and Firefox have no open P0 defects; Brave/Opera findings are classified as blocking or best-effort.

**Verification evidence (2026-08-10):**

- Fresh-profile real-browser runs passed in Chrome 151.0.7922.76, Edge 151.0.4129.72, and Firefox 153.0.3 with no open P0 defect. Brave 151.1.93.134 and Opera 134.0.5954.46 passed the full Chromium matrix. Opera's retained headless 200% zoom measurement was cleared by a headed visual retest and classified as an automation-environment observation rather than a product defect.
- Every PRD section 15 functional flow passed, including all rotation directions and lifecycle actions, real 10/30-second ticks, refresh-now/scheduled refresh, tab mutation and cross-window movement, background reload, overdue restart recovery, keyboard activation, accessible names, and badge state. The 200% zoom check passed in the required targets and Brave, and the headed Opera retest showed no visible clipping.
- Chromium artifact SHA-256 was `d34635341c8e0d8371fa80d2e096987e6a4cb34051eb29a7bbbe86ca4a252047`; Firefox artifact SHA-256 was `24523d231640419176dad495163b1b92c74293dbd4ab6c380e3b91256f797edb`.
- The visible timing disclosure accurately identified sub-30-second rotation as best effort and 30 seconds or longer as the reliable recommendation in every installed target.
- Detailed failures, retest outcomes, Firefox QA-ID isolation, browser versions, and commands are recorded in `docs/QA.md`.

### T064 — Audit manifests, permissions, privacy, and packages

- [x] Inspect generated Chromium and Firefox manifests rather than only source config.
- [x] Confirm MV3, permissions, icons, action popup, options page, and absence of content scripts/host permissions.
- [x] Observe network activity during representative usage and confirm no extension-originated traffic.
- [x] Verify stopping schedules removes runtime URL/title descriptors.
- [x] Build production ZIPs and inspect their contents for source maps, tests, docs, or starter assets that should not ship.

**Requirements:** Sections 11–12; build acceptance  
**Depends on:** T063  
**Likely files:** `wxt.config.ts`, `package.json`, source/assets if defects are found  
**Acceptance:** Both archives contain only necessary production artifacts and match the privacy/permission claims.

**Verification evidence (2026-08-10):**

- Direct generated-manifest inspection confirmed MV3, exactly `tabs`, `storage`, and `alarms`, all five icon sizes, the action popup, the options page, and no content scripts or host permissions for Chromium and Firefox. Firefox also declares required data collection as `none`.
- A fresh-profile Edge run exercised representative popup/options, rotation, and refresh actions without non-local extension resource activity; after both schedules stopped, extension storage contained no runtime target URL/title descriptor.
- The Chromium and Firefox extension ZIPs each contain 14 files exactly matching their production output directories, with no source maps, tests, docs, coverage, raw requirements, QA runners, or starter assets. The Firefox review-source ZIP was reduced to the 49 inputs needed to rebuild.
- `pnpm audit:privacy`, focused privacy/storage/integration tests, TypeScript compilation, production ZIP builds, exact archive/member comparisons, and artifact hashing passed. Detailed commands and hashes are recorded in `docs/QA.md`.

### T065 — Resolve store-blocking product decisions

- [x] Replace the working title and placeholder copy with the final product name/description.
- [x] Add the stable Firefox extension ID.
- [x] Record minimum browser versions.
- [x] Decide whether 10 or 30 seconds is the production default using beta timing results.
- [x] Confirm launch order and store ownership for Chrome, Edge, and Firefox.

**Requirements:** PRD section 18  
**Depends on:** T063  
**Likely files:** `package.json`, `wxt.config.ts`, popup/options copy, release notes  
**Acceptance:** No placeholder identity or unresolved store metadata remains in production packages.

**Verification evidence (2026-08-10):**

- Production identity is finalized as Tab Manipulator 1.0.0 with the privacy-specific store description and existing green linked-tab icon set. The release record assigns all three store listings to BWork0 and defines the sequential Chrome, Edge, then Firefox launch order.
- Generated and packaged Chromium manifests declare Chrome/Edge 120 as the minimum. Generated and packaged Firefox manifests declare Firefox 140 as the minimum and use the stable `tab-manipulator@bwork0.github.io` extension ID. Both packages retain exactly `tabs`, `storage`, and `alarms`.
- The production default is now 30-second rotation. T063 observed both 10-second and 30-second ticks in every required browser, while the documented background-suspension constraint supports 30 seconds as the reliable default and retains 10 seconds as a labelled best-effort preset.
- `pnpm validate` passed formatting, formatting safeguards, TypeScript compilation, all 286 automated tests, and both production builds. Chromium and Firefox 1.0.0 ZIP builds passed direct package-manifest assertions for final identity, versions, minimum browsers, permissions, and Firefox ID.

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
