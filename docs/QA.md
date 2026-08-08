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
