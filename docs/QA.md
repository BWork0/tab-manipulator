# Quality assurance evidence

This document records implementation-task evidence that is not fully represented by unit test pass/fail output. Cross-browser and release-gate results belong to their corresponding tasks in `docs/TASKS.md`.

## T061 — Performance and idle behavior

**Date:** 2026-08-08  
**Reference environment:** Windows 10.0.19045 (64-bit), Intel64 Family 6 Model 167 Stepping 1, Node.js 24.10.0, Vitest 4.1.10, LinkeDOM 0.18.13.

### Results

- A synthetic popup render of 100 eligible tab rows completed in **9.09 ms**, below the PRD's **500 ms** threshold. The assertion measures synchronous row construction and insertion before deferred favicon loading.
- Favicon URLs were still unset when the rows and selection controls became interactive. A simulated favicon load failure removed only the failed image; the select-all button and tab checkbox remained enabled.
- A production-composed background run with **55 tabs** completed rotation start, refresh start, read-only snapshot/tab-list commands, duplicate delivery of both due alarms, one rotation tick, and one full refresh pass in **75.75 ms** in the fake-browser environment. Duplicate alarms produced exactly one tab activation and exactly 55 unique reload attempts, with no timer-backed work or extra action pass.
- Idle startup scheduled **zero timeouts and zero browser alarms**, performed **zero storage mutations**, and registered one alarm, message, startup, and installed listener even when `start()` was called twice.
- Starting rotation and refresh produced one logical persisted state transition per schedule. WXT issued a data write and initial schema-version metadata write for each new record. Each due action then issued exactly one data write for its runtime record; read-only snapshot and tab-list commands issued no storage mutations between transitions or ticks.
- Stopping both schedules removed their alarms and left no tracked timeout. The automated suite resets fake-browser state and listeners after each case.

### Commands

```text
.\node_modules\.bin\vitest.cmd run tests/entrypoints/popup-tab-list.test.ts tests/performance/background-performance.test.ts --reporter=verbose
```

The two files passed all nine focused cases. These are deterministic implementation measurements; T063 owns real-browser manual matrix evidence, and T066 owns the 60-minute reliability test.

## T062 — Accessibility review

**Date:** 2026-08-08  
**Status:** Passed.

### Completed checks

- Reviewed the popup and options markup for programmatic control names, fieldset and custom group labels, description references, live status/alert regions, and non-color state text.
- Reviewed every popup controller path for keyboard focus behavior. Fixed rotation and refresh Stop commands so focus moves from the hidden Stop control to the restored Start control. Fixed refresh replacement failures so the visible confirmation retains focus after state synchronization.
- Associated rotation and refresh command controls with their inline validation messages. Associated Refresh now with both validation and aggregate-result feedback.
- Verified the light and dark text, status, and focus color pairs used by both pages. The measured contrast ratios range from **5.08:1** to **16.27:1**, meeting the WCAG 2.2 AA 4.5:1 threshold for normal text; focus indicators also remain visually distinct from their adjacent surfaces.
- Added deterministic entrypoint checks covering control and group names, valid `aria-describedby` targets, live feedback, `:focus-visible` rules, dark-mode rules, and narrow-viewport layouts. Focused popup tests cover confirmation entry/cancellation, validation focus, command-error focus, and focus restoration after Stop.

### Browser verification

- The user verified the popup and options actions by keyboard in Google Chrome and Mozilla Firefox, including focus restoration after stopping automation.
- The user confirmed accessible control behavior, visible focus, and non-color state indicators in light and dark mode.
- The user confirmed both pages remain usable at 200% zoom without clipped controls or horizontal page scrolling.
- The user confirmed the custom thin scrollbar fits the design in both browsers and that the corrected Firefox popup width contains the complete layout.
- No release-blocking WCAG 2.2 AA issue remains from the T062 review.

### Commands

```text
.\node_modules\.bin\vitest.cmd run tests/entrypoints/accessibility.test.ts tests/entrypoints/popup-rotation-controls.test.ts tests/entrypoints/popup-refresh-controls.test.ts --reporter=verbose
```

All 22 focused cases passed after the accessibility fixes.

## T063 — Cross-browser manual matrix

**Date:** 2026-08-10  
**Status:** Passed with no open P0 defects in Chrome, Edge, or Firefox.

### Reference artifacts and browsers

| Target  | Browser version | Artifact      | Aggregate SHA-256                                                  | Result                                           |
| ------- | --------------- | ------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| Chrome  | 151.0.7922.76   | `chrome-mv3`  | `d34635341c8e0d8371fa80d2e096987e6a4cb34051eb29a7bbbe86ca4a252047` | Passed                                           |
| Edge    | 151.0.4129.72   | `chrome-mv3`  | `d34635341c8e0d8371fa80d2e096987e6a4cb34051eb29a7bbbe86ca4a252047` | Passed                                           |
| Firefox | 153.0.3         | `firefox-mv3` | `24523d231640419176dad495163b1b92c74293dbd4ab6c380e3b91256f797edb` | Passed                                           |
| Brave   | 151.1.93.134    | `chrome-mv3`  | `d34635341c8e0d8371fa80d2e096987e6a4cb34051eb29a7bbbe86ca4a252047` | Best-effort full matrix passed                   |
| Opera   | 134.0.5954.46   | `chrome-mv3`  | `d34635341c8e0d8371fa80d2e096987e6a4cb34051eb29a7bbbe86ca4a252047` | Best-effort matrix and headed zoom retest passed |

Each installed target used a newly created temporary browser profile, local HTTP test pages, and the production WXT build. The Firefox restart case used a disposable copy of `firefox-mv3` with the QA-only ID `t063@tab-manipulator.invalid`; this was necessary because the production Firefox ID is deliberately unresolved until T065. The copy differed only by that test ID, was deleted after the run, and did not modify the generated output or source configuration.

### Completed checks

- Installed the target artifact in each fresh profile and confirmed current-window discovery, eligible selection, and stable popup initialization.
- Started, paused, resumed, and stopped forward, backward, and random rotation. Observed real target activation after both 10-second and 30-second intervals.
- Confirmed the sub-30-second disclosure says the mode is best effort, background suspension can delay it, and 30 seconds or longer is the reliable recommendation.
- Ran `Refresh now`, started a 30-second scheduled refresh, observed every selected local target reload, and stopped the schedule.
- Reordered, pinned, closed, and moved selected targets to another window while exercising persisted automation state.
- Stopped and restarted the Chromium service worker and reloaded the Firefox temporary add-on, then reopened the popup and verified conservative recovery.
- Restarted each required browser after the persisted rotation became overdue. Recovery performed at most one action and scheduled from the current time when targets restored uniquely, or entered `needs-attention` without acting when the browser did not restore a unique target set.
- Activated a popup action with the Enter key, confirmed every interactive control had an accessible name, verified no horizontal overflow at 200% browser zoom in the primary targets and Brave, completed a headed Opera zoom retest, and checked idle toolbar badge/title state after stop.
- Inspected both generated manifests during the run: each is MV3 and declares exactly `tabs`, `storage`, and `alarms`.

### Failures and retest outcomes

- No required-target product failure remained open. Chrome completed the final matrix without a product failure.
- Edge initially reopened the popup before the force-stopped service worker had finished rebuilding application state. A bounded popup reopen/retry, matching user behavior, passed repeatedly; persisted state returned to `Rotating`. Edge also produced the valid conservative `needs-attention` outcome when its headless session did not restore a unique source window.
- Firefox temporary-addon reinstall initially received a new random ID, so its old storage namespace was intentionally unavailable. Repeating the restart with the disposable QA-only fixed ID passed overdue recovery. Selecting a production Firefox ID remains T065 scope and was not changed here.
- Opera 134.0.5954.46 passed every functional check. In two fresh headless profiles, its 200% zoom viewport measured 295 CSS pixels wide while the fixed 22rem body remained 352 pixels wide, producing a 57-pixel `scrollWidth` difference. A subsequent headed Opera retest showed the popup rendering correctly with no visible clipping, so the retained measurement is classified as a headless-layout observation rather than an open product defect.
- Early driver setup failures involving local-tab load timing, Firefox browser-window reattachment, and native key dispatch were corrected in the QA scripts and retested through complete final passes.

### Commands

```text
pnpm.cmd build
pnpm.cmd build:firefox
node scripts/t063-browser-matrix.mjs chrome
node scripts/t063-browser-matrix.mjs edge
node scripts/t063-browser-matrix.mjs brave
node scripts/t063-browser-matrix.mjs opera
node scripts/t063-firefox-matrix.mjs
```

The reproducible real-browser runners are `scripts/t063-browser-matrix.mjs` and `scripts/t063-firefox-matrix.mjs`. Opera is covered by the Chromium runner as a non-blocking best-effort target under the PRD.

## T064 — Manifest, permission, privacy, and package audit

**Date:** 2026-08-10  
**Status:** Passed.

### Generated manifests

- Direct inspection of `.output/chrome-mv3/manifest.json` and `.output/firefox-mv3/manifest.json` confirmed Manifest V3 and exactly `tabs`, `storage`, and `alarms` in both permission lists.
- Both manifests contain the complete 16, 32, 48, 96, and 128-pixel icon set, `popup.html` as the action popup, and `options.html` as the tab-based options page.
- Chromium registers `background.js` as its service worker. Firefox registers the same background entrypoint through its MV3-compatible background script representation.
- Neither manifest contains `content_scripts`, `host_permissions`, or `optional_host_permissions`.
- The Firefox manifest now declares `browser_specific_settings.gecko.data_collection_permissions.required` as `none`, matching the extension's local-only privacy behavior. The stable Firefox ID remains deliberately deferred to T065.

### Privacy and runtime cleanup

- A fresh temporary Microsoft Edge profile loaded the production Chromium artifact and exercised tab discovery, rotation start/stop, Refresh now, refresh start/stop, and options-page loading against two local test pages.
- The browser observed no non-local popup or options resource activity. The explicit Refresh now requests reached only the two user-selected local test pages, as expected for the product action; the extension generated no analytics, logging, or service traffic.
- The same run inspected extension-local storage after both schedules stopped and found no record retaining target URL or title descriptors.
- Packaged-source inspection found no network client in application code. The only generated `fetch` token is Vite's module-preload fallback, which can load only the packaged validation chunk referenced by the extension pages.

### Production archives

| Artifact                            | Files | SHA-256                                                            |
| ----------------------------------- | ----: | ------------------------------------------------------------------ |
| `tab-manipulator-0.0.0-chrome.zip`  |    14 | `38b8bac98d49ccbc61497a5dd319df908f43f17348737c0df8e34565488522a0` |
| `tab-manipulator-0.0.0-firefox.zip` |    14 | `9429e9527660ca471657b31a0c6d16f324f9991b98e5a8b64f58d6613e90eb15` |
| `tab-manipulator-0.0.0-sources.zip` |    49 | `ed36eca1bb9ebbe5f11f89f550f755dc2ce494f545ff14a90b5046fc3c03a2c2` |

- Each production extension ZIP exactly matches its generated output directory and contains only the manifest, background bundle, popup/options documents and assets, shared chunks, and five product icons.
- Neither production ZIP contains source maps, tests, documentation, coverage output, raw requirements, QA runners, or starter assets.
- The Firefox review-source ZIP excludes coverage, tests, product/QA documentation, raw requirements, and QA-only scripts. It retains the package and lock files, WXT/TypeScript configuration, product source, icons, and the install-hook script required by `pnpm install`.

### Commands

```text
pnpm.cmd audit:privacy
pnpm.cmd compile
.\node_modules\.bin\vitest.cmd run tests/storage/runtime-store.test.ts tests/entrypoints/options-privacy.test.ts tests/integration/background-flows.test.ts --reporter=verbose
pnpm.cmd zip
pnpm.cmd zip:firefox
```

The manifest and archive audit compared each ZIP member list with its generated build, asserted exact permissions and required entrypoints/icons, rejected forbidden manifest fields and package paths, and hashed all final archives.

## T065 — Store-blocking product decisions

**Date:** 2026-08-10  
**Status:** Passed.

### Resolved metadata

- Final product identity is Tab Manipulator 1.0.0 with the description “Rotate selected tabs automatically and refresh them on a schedule, with all data kept on your device.” The existing green linked-tab artwork is approved for launch.
- The Firefox manifest uses the stable ID `tab-manipulator@bwork0.github.io`. Minimum browser versions are Chrome 120, Edge 120, and Firefox 140.
- BWork0 is the owner of record for all three store listings. Launch order is Chrome first, Edge after Chrome acceptance and smoke testing, then Firefox after Edge acceptance and smoke testing.
- New installations default to 30-second rotation. T063 observed successful 10-second and 30-second beta ticks in every required browser, but the reliable background-alarm boundary supports 30 seconds as the production default. The 10-second best-effort preset remains available.

### Verification

- `pnpm.cmd validate` passed format checking, formatting safeguards, TypeScript compilation, all 286 tests, and Chromium/Firefox MV3 production builds.
- `pnpm.cmd zip` and `pnpm.cmd zip:firefox` produced `tab-manipulator-1.0.0-chrome.zip` and `tab-manipulator-1.0.0-firefox.zip`. Direct inspection of each ZIP's manifest confirmed the final identity, version, browser minimum, Firefox ID where applicable, and exactly `tabs`, `storage`, and `alarms`.
- Chromium ZIP SHA-256: `a7a61f5cec4fdf839bd7975e5ecf171a01c14fcb54f15948279d569db5df83eb`.
- Firefox ZIP SHA-256: `f6cc2d79f1ad3f93d6a6c4a100ad27a538eddad6f8424749639f8cfb1729f748`.
- A metadata-only rerun of the T064 browser audit was attempted separately in Edge and Chrome. The local CDP runner timed out at `Runtime.enable` in Edge and `Extensions.loadUnpacked` in Chrome; prior T064 runtime/privacy evidence remains valid, and T065's direct generated/package manifest checks passed without a permission or runtime-code change.

## T066 — Final release gate

**Date:** 2026-08-10  
**Status:** Passed. No open P0 defect remains.

### Clean-checkout validation and reproducible archives

- A clean source snapshot of commit `2e8a2a9da59cefdc9cc092cbd5d3989a2aa602dc` was created with `git archive`. The existing dependency tree was exposed through a temporary junction, and the repository's normal `pnpm.cmd postinstall` step generated WXT types before validation.
- `pnpm.cmd validate` passed formatting, formatting safeguards, strict TypeScript compilation, all **286** unit/integration tests, and Chromium/Firefox MV3 production builds in that snapshot.
- `pnpm.cmd zip` and `pnpm.cmd zip:firefox` produced the Chromium, Firefox, and Firefox review-source archives. Repeating both ZIP commands in the same clean snapshot produced byte-identical SHA-256 hashes:

| Artifact                            | SHA-256                                                            | Repeated result |
| ----------------------------------- | ------------------------------------------------------------------ | --------------- |
| `tab-manipulator-1.0.0-chrome.zip`  | `a7a61f5cec4fdf839bd7975e5ecf171a01c14fcb54f15948279d569db5df83eb` | Identical       |
| `tab-manipulator-1.0.0-firefox.zip` | `f6cc2d79f1ad3f93d6a6c4a100ad27a538eddad6f8424749639f8cfb1729f748` | Identical       |
| `tab-manipulator-1.0.0-sources.zip` | `7a17246811a4614d2ed792e8f621ff66a82137f511168e072bd01a5f5af252f6` | Identical       |

### P0 and release-criterion traceability

| Scope or criterion                            | Passing evidence                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| FR-001–003: discovery, selection, eligibility | T011, T013, T022, and T041 tests; T060 integration suite; T063 browser matrix                             |
| FR-010–013: rotation                          | T014, T024, T030, and T042 tests; T060 integration suite; T063 browser matrix; T066 60-minute run         |
| FR-020–022: refresh                           | T015, T024, T031, and T043 tests; T060 integration suite; T063 browser matrix                             |
| FR-030–031: pinned tabs and filters           | T012, T013, T020, T051, and T052 tests; T060 integration suite; T063 browser matrix                       |
| FR-040–043: persistence and scheduling        | T020, T021, T024, T025, T030, T031, and T033 tests; focused delayed-alarm tests; T063 restart/wake matrix |
| FR-050–051: messaging and status              | T023, T032, T033, T040, and T044 tests; T060 integration suite; T063 browser matrix                       |
| Current stable required browsers              | T063 passed Chrome 151, Edge 151, and Firefox 153 with no open P0 defect                                  |
| 100-tab popup under 500 ms                    | T061 measured 9.09 ms and confirmed deferred favicon failures do not block interaction                    |
| Idle polling, writes, and network             | T061 observed no idle scheduling/storage polling; T064 observed no extension-originated network traffic   |
| Conservative restart recovery                 | T060 automated recovery coverage and T063 real-browser restart/wake cases passed                          |
| Permissions, privacy, and manifests           | T064 generated/package audit passed with only `tabs`, `storage`, and `alarms`                             |
| Accessibility                                 | T062 keyboard, accessible-name, live-region, focus, contrast, dark-mode, and 200% zoom review passed      |
| Production identity and store metadata        | T065 package assertions and release metadata passed                                                       |

All Phase 0–6 task dependencies before T066 are checked with automated or recorded manual evidence. Approved P1 tasks T070–T077 remain post-MVP and do not alter the P0 release gate.

### 60-minute active-browser rotation reliability

- The production Chromium MV3 build ran in headed Microsoft Edge 151.0.4129.72 with a fresh temporary profile and four local HTTP tabs. Rotation used the forward direction and a 30-second browser-alarm interval.
- The uninterrupted 60-minute observation recorded **120 of 120 expected activations (100%)**, above the PRD's 99% threshold. Five-minute checkpoints progressed from 10 ticks at 5 minutes to 110 ticks at 55 minutes; the boundary tick completed during the permitted 10-second grace period.
- The first tick occurred after **30,028 ms**. All four targets were visited, no immediate target repeat or extra activation occurred, and the session stopped to `Idle`.
- The aggregate production-build SHA-256 recorded by the runner was `d0e84d2f1817997173201a3adbf0a5e52b5f6244fbc95c12e869a36c42cff8d3`.

### Delayed alarms and no catch-up replay

- A focused **38-test** run passed scheduler, recovery, rotation-service, refresh-service, and production-composed integration coverage.
- The passing cases prove that a delayed callback schedules from actual completion time, recovery executes one overdue action, a delayed refresh performs one pass, and duplicate delivery of a consumed due timestamp causes no second action.
- T063 independently observed at most one overdue recovery action in every required real browser.

### Commands

```text
pnpm.cmd postinstall
pnpm.cmd validate
pnpm.cmd zip
pnpm.cmd zip:firefox
pnpm.cmd zip
pnpm.cmd zip:firefox
node scripts/t063-browser-matrix.mjs edge reliability-preflight 2
node scripts/t063-browser-matrix.mjs edge reliability 60
.\node_modules\.bin\vitest.cmd run tests/core/scheduler.test.ts tests/core/recovery.test.ts tests/services/rotation-service.test.ts tests/services/refresh-service.test.ts tests/integration/background-flows.test.ts --reporter=verbose
```
