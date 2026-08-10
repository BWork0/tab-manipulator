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
