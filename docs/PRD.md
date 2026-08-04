# Product Requirements Document: Tab Manipulator MVP

**Status:** Draft for implementation  
**Version:** 1.0  
**Date:** 2026-08-04  
**Product:** Tab Manipulator (working title)  
**Implementation baseline:** WXT 0.21.x, Vanilla TypeScript, Manifest V3

## 1. Document purpose

This document defines the first shippable release of Tab Manipulator: a privacy-focused browser extension that automatically rotates through tabs and refreshes selected tabs on a schedule. It converts the broad feature set in `prd-background/notes.txt` into a bounded MVP that can be built from the existing WXT Vanilla TypeScript starter.

The companion implementation plan is [`TASKS.md`](./TASKS.md).

## 2. Source material and decisions

This PRD is based on:

- `prd-background/notes.txt`, the initial requirements-engineering document.
- Prior architecture decisions recommending one WXT + Vanilla TypeScript repository, separate Chromium and Firefox builds, UI-independent core logic, a browser capability adapter, and persistent scheduler state.
- `.docs/docs.txt` and `.docs/api-reference.txt`, the local WXT documentation. Relevant guidance includes file-based entrypoints, manifest generation through `wxt.config.ts`, `wxt/browser`, `wxt/utils/storage`, browser-specific builds, and WXT's Vitest integration.
- The current repository, which is an unmodified WXT Vanilla TypeScript starter with `srcDir: 'src'`.

Resolved product decisions:

1. Use one WXT + Vanilla TypeScript codebase for all targets.
2. Ship Chrome/Edge and Firefox artifacts from the same source. Brave and Opera use the Chromium artifact on a best-effort compatibility basis.
3. Use Manifest V3 for both Chromium and Firefox builds. Because WXT defaults Firefox to MV2, Firefox scripts must pass `--mv3` explicitly.
4. Support reliable refresh intervals of 30 seconds or longer. Ten-second rotation remains available as a best-effort foreground-browser mode because extension background scheduling cannot guarantee exact sub-30-second execution.
5. Do not use a content script or broad host permissions in the MVP.
6. Persist both user settings and sufficient runtime state to recover safely after background suspension, browser sleep, and browser restart.

## 3. Problem statement

People who monitor dashboards, test sites, handle support queues, or compare frequently changing pages repeatedly switch between and reload the same tabs. Existing browser controls make those actions manual, inconsistent, and difficult to maintain across many tabs. Users need a lightweight way to define a tab set once, start automation quickly, see whether it is active, and stop it immediately without sending browsing data outside the browser.

## 4. Product objective

Deliver an extension that lets a user, from the toolbar popup:

1. Choose tabs in the current window.
2. Start, pause, resume, or stop automatic rotation.
3. schedule automatic refreshes or refresh the chosen tabs immediately.
4. Exclude pinned tabs and filter tabs using simple URL/domain rules.
5. Understand the current automation state at a glance.

The product must remain useful after the background context is suspended and must recover conservatively after browser or device restart.

## 5. Goals and success criteria

### 5.1 Goals

- Provide a zero-configuration path to start 10-second rotation or 5-minute refresh.
- Reduce repeated manual tab switching and reloading.
- Make automation state and target scope visible and instantly controllable.
- Preserve privacy by processing all configuration and browsing metadata locally.
- Keep the idle resource cost negligible, including with 50 or more open tabs.
- Produce testable Chrome/Edge and Firefox MV3 builds from one repository.

### 5.2 MVP success criteria

The MVP is ready for release when:

- All functional requirements marked P0 pass their acceptance criteria in current stable Chrome, Edge, and Firefox.
- Rotation completes at least 99% of expected ticks during a 60-minute active-browser test at intervals of 30 seconds or more.
- A delayed alarm or device wake never triggers more than one catch-up action per schedule.
- A background restart restores valid automation without acting on an unrelated tab.
- The popup remains interactive with 100 open tabs and renders its initial state in under 500 ms on the reference test machine.
- Idle operation produces no continuous polling and no network traffic.
- Chromium and Firefox MV3 production builds compile and their generated manifests contain only the approved permissions.

These measurements are release-test criteria. The extension will not collect product analytics in the MVP.

## 6. Users and primary scenarios

| Persona           | Need                                               | MVP scenario                                                                            |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Dashboard monitor | Cycle status pages and keep them current           | Select dashboards, rotate every 30 seconds, refresh every 5 minutes                     |
| Developer / QA    | Repeatedly reload local or staging pages           | Select current tabs, choose a 30-second custom refresh, refresh immediately when needed |
| Support agent     | Keep a small knowledge or ticket set accessible    | Rotate selected unpinned tabs and pause instantly during a call                         |
| Researcher        | Review a defined subset of many tabs               | Select only relevant tabs and rotate left-to-right                                      |
| Casual power user | Start common automation without configuration work | Use the default 10-second rotation or 5-minute refresh presets                          |

## 7. MVP scope

### 7.1 Included

- Current-window tab discovery and multi-selection.
- One active rotation session at a time, scoped to the window from which it was started.
- Rotation directions: left-to-right, right-to-left, and random.
- Rotation start, pause, resume, and stop.
- Rotation presets of 10 seconds, 30 seconds, 1 minute, and a custom value.
- Refresh schedules for selected tabs with presets of 30 seconds, 1 minute, 5 minutes, and a custom value of at least 30 seconds.
- Immediate `Refresh now` action for selected tabs.
- A shared include/exclude-pinned setting.
- Simple allowlist and blocklist rules by domain or wildcard URL pattern.
- Settings and runtime-state persistence.
- Conservative restart and sleep/wake recovery.
- Toolbar badge/icon state plus detailed popup status.
- Advanced options page for defaults and filters.
- Keyboard-accessible, screen-reader-labelled popup and options UI.
- English copy with an architecture that can adopt browser i18n later.
- Chrome/Edge MV3 and Firefox MV3 builds.

### 7.2 Explicitly deferred

- Cron expressions or time-of-day schedules.
- Multiple independent or cross-window rotation groups.
- Saved workspaces and session restoration.
- Bulk tab actions such as close duplicates, mute, pin, move, or suspend.
- Title, regular-expression, audible, muted, or page-content rules.
- Unsaved-form or media-playback detection.
- Smart suspension and battery-aware eco mode.
- Browser tab-group integration and multi-monitor awareness.
- Keyboard shortcuts.
- Notifications, statistics, analytics, cloud sync, and import/export.
- Safari packaging and store submissions.

## 8. User experience

### 8.1 Popup layout

The popup has four logical regions:

1. **Status:** `Idle`, `Rotating`, `Rotation paused`, `Refreshing`, `Rotating + refreshing`, or `Needs attention`, with the next due action when known.
2. **Tab selection:** current-window tabs with favicon when available, title, domain, pinned indicator, `Select all`, and `Clear`. Restricted pages remain visible but disabled with an explanation.
3. **Rotation:** interval, direction, include-pinned summary, and a context-sensitive primary control (`Start`, `Pause`, `Resume`, or `Stop`). Stop remains available while running or paused.
4. **Refresh:** interval, `Start refresh`/`Stop refresh`, and `Refresh now`.

An `Advanced settings` link opens the options page. The popup remembers the last valid tab selection for the current browser session where possible, but it revalidates every tab before an action.

### 8.2 Defaults

- Rotation interval: 10 seconds.
- Rotation direction: left-to-right.
- Refresh interval: 5 minutes.
- Pinned tabs: excluded.
- Allowlist: empty, meaning all otherwise eligible URLs.
- Blocklist: empty.

### 8.3 Validation and feedback

- Rotation needs at least two eligible selected tabs.
- Refresh needs at least one eligible selected tab.
- A custom rotation interval must be at least 10 seconds.
- A custom refresh interval must be at least 30 seconds.
- Validation appears next to the relevant control and is announced to assistive technology.
- Actions report partial success, for example `Refreshed 3 tabs; skipped 1 restricted page`.
- Sub-30-second rotation copy states that browser background behavior can delay ticks.

### 8.4 Toolbar indicator

- No badge when idle.
- `ON` with a blue background when any automation is running.
- `II` with an amber background when all active automation is paused.
- `!` with a red background when recovery needs user attention or the last action failed.
- The icon title exposes a textual summary for accessibility.

## 9. Functional requirements

### 9.1 Tab discovery and eligibility

**FR-001 (P0): List current-window tabs.** The popup must query the current window on open and show tabs in browser index order.

Acceptance criteria:

- New, closed, moved, or updated tabs are reflected when the popup is reopened or manually refreshed.
- A tab item has a stable selection key for the lifetime of that browser session.
- The UI does not crash when a title, URL, favicon, or tab ID is absent.

**FR-002 (P0): Select a target set.** Users must be able to select individual tabs, select all eligible tabs, and clear the selection.

Acceptance criteria:

- Starting an action captures only currently selected, eligible tabs.
- Selection changes do not silently alter an already-running schedule.
- The active popup tab may be selected and refreshed like any other ordinary web tab.

**FR-003 (P0): Exclude unsupported pages.** The system must reject browser-internal pages and any URL that the extension API cannot update or reload.

Acceptance criteria:

- Unsupported tabs are disabled in the selector with a reason.
- One unsupported tab does not prevent valid selected tabs from being processed.
- No content script or host permission is requested to work around browser restrictions.

### 9.2 Rotation

**FR-010 (P0): Start rotation.** A user can start a rotation session for at least two selected eligible tabs in the current window.

Acceptance criteria:

- The first tick occurs after the chosen interval, not immediately.
- The captured session stores target identity, order, source window, interval, direction, cursor, state, and next-run timestamp.
- Starting a new rotation replaces an existing rotation only after an explicit confirmation in the popup.

**FR-011 (P0): Rotate by direction.** Each tick activates exactly one next eligible tab.

Acceptance criteria:

- Left-to-right follows ascending current tab index and wraps.
- Right-to-left follows descending current tab index and wraps.
- Random never intentionally selects the currently active rotation target when another target is available.
- Tab reordering is reflected on a later tick without corrupting the stored target set.

**FR-012 (P0): Pause, resume, and stop rotation.** Users can control a rotation immediately from the popup.

Acceptance criteria:

- Pause preserves targets and cursor and cancels the next scheduled tick.
- Resume schedules the next tick from the resume time; it does not immediately catch up.
- Stop cancels the scheduler and removes the live rotation session.
- Repeated control messages are idempotent.

**FR-013 (P0): Handle tab changes safely.** Rotation must tolerate a target being closed, moved, pinned, filtered, or made unavailable.

Acceptance criteria:

- Ineligible or missing targets are removed or skipped without activating another browser window unexpectedly.
- Rotation continues when at least two eligible targets remain.
- When fewer than two remain, rotation stops and the popup explains why.
- A manual focus change does not stop rotation; the next tick continues from the stored cursor.

### 9.3 Refresh

**FR-020 (P0): Start and stop scheduled refresh.** A user can create one refresh schedule for the selected target set and stop it later.

Acceptance criteria:

- The minimum scheduled interval is 30 seconds.
- The schedule stores targets, interval, state, last-run time, and next-run time.
- A new schedule replaces the existing refresh schedule only after explicit confirmation.
- Stop cancels the alarm and clears the live schedule.

**FR-021 (P0): Execute refresh safely.** When due, the system reloads every still-eligible target once.

Acceptance criteria:

- Failure to reload one tab does not prevent attempts on the rest.
- The result records success and skip/error counts without storing page content.
- A delayed alarm performs at most one refresh pass and calculates the next run from the current time.
- The extension never attempts to defeat authentication, anti-bot behavior, or browser page restrictions.

**FR-022 (P0): Refresh now.** A user can reload the current selection without creating or changing a schedule.

Acceptance criteria:

- The command uses the same eligibility and filter rules as scheduled refresh.
- The popup shows success, skipped, and failed counts.
- The scheduled next-run time, if any, is unchanged.

### 9.4 Filtering and pinned tabs

**FR-030 (P0): Respect pinned-tab preference.** One setting controls whether pinned tabs are eligible for rotation and refresh.

Acceptance criteria:

- The default is excluded.
- Changing the setting revalidates active schedules on their next action and updates the selector immediately on next render.
- If a change reduces rotation below two targets, FR-013 applies.

**FR-031 (P0): Apply URL/domain allowlist and blocklist.** Users can enter newline-separated domain names or wildcard URL patterns on the options page.

MVP rule semantics:

- A plain domain such as `example.com` matches that domain and its subdomains.
- A URL pattern may use `*` as a wildcard, for example `https://*.example.com/*`.
- Matching is case-insensitive for scheme and host and case-sensitive for the remainder of the URL.
- An empty allowlist allows every otherwise eligible URL.
- A non-empty allowlist requires at least one allow match.
- A block match always wins over an allow match.
- Invalid rules are rejected during save and identify the offending line.

Acceptance criteria:

- One shared pure matcher is used by tab selection, rotation, and refresh.
- Rules are trimmed, deduplicated, and saved only after the entire set validates.
- Active schedules re-evaluate rules before every action.

### 9.5 Persistence and scheduling

**FR-040 (P0): Persist settings.** Defaults, pinned behavior, and filters must persist in extension-local storage.

Acceptance criteria:

- Storage is typed and versioned so future migrations can be added.
- A missing or invalid value falls back to a documented default without crashing.
- Settings updates are atomic from the UI's perspective.

**FR-041 (P0): Persist runtime state.** Active schedules must write their state after every lifecycle transition and completed tick.

Acceptance criteria:

- Background globals are treated as a cache, not the source of truth.
- Persisted state includes a schema version and timestamps.
- Tab and window IDs are never assumed valid after a full browser restart.

**FR-042 (P0): Use a hybrid scheduler.** The extension must select the scheduling mechanism based on interval and operation.

- Refresh and rotation intervals of 30 seconds or more use `browser.alarms`.
- Rotation below 30 seconds uses a `setTimeout` loop while the background context remains active and persists `nextRunAt` after every tick.
- Refresh below 30 seconds is not supported.

Acceptance criteria:

- Duplicate alarms/listeners do not cause duplicate actions.
- Scheduler callbacks are safe to run more than once.
- Time drift is bounded by recalculating from the actual action time rather than replaying missed ticks.

**FR-043 (P0): Recover conservatively.** The background entrypoint must recover schedules on startup and when it is loaded after suspension.

Recovery rules:

1. Revalidate stored tab IDs against URL descriptors.
2. If IDs are invalid after browser restart, look for a single browser window containing the best exact matches for the stored target URLs and relative order.
3. Resume only when every required target resolves unambiguously and the minimum target count still applies.
4. Otherwise set the schedule to `needs-attention`, take no automated action, and ask the user to review targets.
5. Never replay multiple missed rotations or refresh passes after sleep; run at most one due action, then schedule from now.

### 9.6 Status and communication

**FR-050 (P0): Keep popup and background state consistent.** All mutating browser actions run in the background context. Popup and options pages communicate through a typed message contract.

Acceptance criteria:

- Every command returns a typed success or error response.
- The popup renders from a background state snapshot on open and after a command.
- Closing the popup does not interrupt active automation.
- Unknown or malformed messages are rejected without side effects.

**FR-051 (P0): Expose automation state.** The badge, icon title, and popup must reflect persisted state and the most recent result.

Acceptance criteria:

- State is updated after every start, pause, resume, stop, recovery, success, and terminal error.
- Clearing the final active schedule clears the badge.
- A badge update failure does not fail the underlying rotation or refresh action.

## 10. Data model

The exact TypeScript names may change, but the implementation must preserve these concepts:

```ts
type RotationDirection = 'forward' | 'backward' | 'random';
type RunState = 'running' | 'paused' | 'needs-attention';

interface TabDescriptor {
  tabId?: number; // Valid only after runtime revalidation
  windowId?: number; // Valid only after runtime revalidation
  url: string;
  title?: string;
  index: number;
  pinned: boolean;
}

interface RotationSession {
  schemaVersion: 1;
  id: string;
  state: RunState;
  targets: TabDescriptor[];
  intervalMs: number;
  direction: RotationDirection;
  cursor: number;
  lastRunAt?: number;
  nextRunAt: number;
  attentionReason?: string;
}

interface RefreshSchedule {
  schemaVersion: 1;
  id: string;
  state: RunState;
  targets: TabDescriptor[];
  intervalMs: number;
  lastRunAt?: number;
  nextRunAt: number;
  attentionReason?: string;
}

interface Settings {
  schemaVersion: 1;
  rotationIntervalMs: number;
  rotationDirection: RotationDirection;
  refreshIntervalMs: number;
  includePinned: boolean;
  allowlist: string[];
  blocklist: string[];
}
```

Runtime records use WXT local storage (`wxt/utils/storage`) and have separate keys from durable user settings. A future saved-workspace model must store URLs and ordering, never rely on historical tab IDs.

## 11. Technical architecture constraints

The implementation should follow this boundary:

```text
src/
├── entrypoints/
│   ├── background.ts
│   ├── popup/
│   └── options/
├── core/
│   ├── rotation-engine.ts
│   ├── refresh-engine.ts
│   ├── rule-engine.ts
│   ├── scheduler.ts
│   └── types.ts
├── platform/
│   ├── browser-api.ts
│   └── capabilities.ts
├── storage/
│   ├── runtime-store.ts
│   └── settings-store.ts
└── messaging/
    └── protocol.ts
```

Constraints:

- Core matching and next-target decisions must be pure functions and browser-API independent.
- Browser calls use `wxt/browser` and are isolated in entrypoint or platform modules.
- No browser runtime code may execute outside the `main` function of a WXT JS/TS entrypoint.
- WXT generates manifests from `wxt.config.ts` and entrypoint metadata; do not add a source `manifest.json`.
- Remove the starter content entrypoint because the MVP does not inject page code.
- Use the native runtime message API with shared discriminated-union types unless implementation proves a wrapper necessary.
- Use Vitest with WXT's test plugin and fake browser for unit tests.

## 12. Permissions and privacy

### 12.1 Required permissions

| Permission | Reason                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| `tabs`     | Read tab title/URL/pinned/index state, activate tabs, and reload targets |
| `storage`  | Persist settings and runtime schedule state                              |
| `alarms`   | Schedule reliable 30-second-or-longer work across background suspension  |

The MVP must not request `scripting`, content-script matches, broad `host_permissions`, browsing history, identity, or network access.

### 12.2 Privacy requirements

- No browsing metadata, settings, error details, or usage data leaves the device.
- No analytics or remote logging.
- No remote executable code.
- Stored URLs and titles remain in extension-local storage and are limited to active schedule targets.
- Stopping a schedule removes its runtime target descriptors.
- User-facing copy explains why the `tabs` permission is needed.

## 13. Non-functional requirements

### Performance

- No background polling when no automation is active.
- Rule matching and tab reconciliation must be linear in the number of relevant tabs/rules for ordinary use.
- Tab lists of 100 items must remain responsive; virtualization is not required unless measurement shows it is needed.
- Persist only after state transitions or ticks, not on a continuous timer.

### Reliability

- All commands and scheduler callbacks are idempotent.
- Browser API errors are caught per target and converted to structured results.
- No action may target a tab solely because it reused an old numeric ID.
- System clock changes and delayed alarms must not cause action storms.

### Accessibility

- All controls are reachable and operable by keyboard.
- Visible focus styles meet WCAG 2.2 AA expectations.
- Inputs have programmatic labels; state changes and validation feedback use an appropriate live region.
- Color is not the only indicator of state.
- Popup and options layouts work at 200% zoom without clipped controls.

### Compatibility

- Latest stable Chrome, Edge, and Firefox are release targets.
- Brave and Opera receive smoke testing with the Chromium build but do not block the first release.
- Unsupported APIs are represented through a capability check and a user-readable unavailable state.

### Maintainability

- TypeScript strict compilation passes.
- Core behavior is unit-tested independently of DOM rendering.
- Generated `.output` and `.wxt` files are not edited manually.

## 14. Edge-case behavior

| Situation                                            | Required behavior                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- |
| Target closes during rotation                        | Remove it; continue with two or more, otherwise stop with explanation         |
| Target moves within window                           | Re-query current indices before direction-based choice                        |
| Target moves to another window                       | Skip/remove it; never focus another window implicitly                         |
| Target becomes pinned while pinned tabs are excluded | Revalidate and skip/remove it                                                 |
| User manually activates another tab                  | Keep the session; next tick follows stored cursor                             |
| Browser sleeps past several due times                | Perform at most one due action, then schedule from now                        |
| Background restarts                                  | Load persisted state, revalidate, restore exactly one scheduler registration  |
| Browser restarts and targets are ambiguous           | Enter `needs-attention`; do nothing automatically                             |
| Refresh partially fails                              | Continue remaining targets and report counts                                  |
| Storage is corrupt or from an unknown schema         | Preserve raw data if feasible, reset to safe defaults, show `needs-attention` |
| System time moves backward/forward                   | Clamp due calculations and avoid catch-up loops                               |

## 15. Testing and release acceptance

### Automated coverage

- Rule parsing, normalization, precedence, and matching.
- Forward, backward, and random target selection.
- Closed/moved/pinned target reconciliation.
- Scheduler selection at the 30-second boundary.
- Pause/resume/stop idempotency.
- Delayed-alarm and no-catch-up behavior.
- Storage defaults, version handling, and recovery decisions.
- Typed message validation and command results.
- Popup form validation and accessible state rendering where practical.

### Manual browser matrix

For Chrome, Edge, and Firefox:

- Install the unpacked development build.
- Start, pause, resume, and stop all rotation modes.
- Run 10-second and 30-second rotation tests.
- Start/stop scheduled refresh and run `Refresh now`.
- Close, move, reorder, and pin a target during automation.
- Suspend/reload the extension background context.
- Sleep/wake the device or simulate a delayed alarm.
- Restart the browser with restorable tabs and verify conservative recovery.
- Verify keyboard-only use, screen-reader labels, zoom, and badge state.
- Inspect the generated manifest and confirm the permission list.

### Build acceptance

- `pnpm compile` passes.
- Unit tests pass.
- `pnpm build` produces a Chromium MV3 build.
- `pnpm build:firefox` produces a Firefox MV3 build.
- Production ZIP commands produce store-ready archives without development-only assets.

## 16. Rollout plan

1. **Prototype:** core rotation, refresh, storage, and scheduler tests with minimal popup controls.
2. **Internal alpha:** complete popup/options UX and exercise background suspension/recovery.
3. **Cross-browser beta:** Chrome, Edge, and Firefox manual matrix; Brave/Opera smoke tests.
4. **Release candidate:** permission/privacy review, accessibility pass, long-run reliability test, store metadata.

## 17. Risks and mitigations

| Risk                                       | Impact                                         | Mitigation                                                                                                    |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Sub-30-second background timing is delayed | Ten-second rotation may drift                  | Label it best-effort, persist every tick, resume safely, make 30 seconds the reliable recommendation          |
| Tab/window IDs become stale                | Wrong tab could be activated or reloaded       | Pair IDs with URL descriptors, revalidate every action, stop on ambiguous recovery                            |
| Firefox/Chromium API behavior differs      | One target may fail or manifest may be invalid | Use `wxt/browser`, capability adapter, explicit Firefox MV3 scripts, generated-manifest tests, browser matrix |
| Broad `tabs` permission concerns users     | Lower install conversion                       | Explain the requirement clearly and request no host/content permissions                                       |
| Large tab counts slow popup                | Poor UX for power users                        | Render simple rows, avoid favicon blocking, measure at 100 tabs, virtualize only if necessary                 |
| Repeated refresh burdens sites or devices  | Resource/network impact                        | Minimum 30 seconds, clear active state, fast stop, no missed-run replay                                       |

## 18. Open release decisions

These do not block implementation of the MVP core but must be resolved before store submission:

- Final product name, description, and icon design.
- Stable Firefox extension ID and store publisher identity.
- Exact minimum supported browser versions.
- Whether the 10-second rotation preset should remain the default after beta reliability testing; fallback default is 30 seconds.
- Whether Chrome and Edge launch simultaneously or sequentially.
