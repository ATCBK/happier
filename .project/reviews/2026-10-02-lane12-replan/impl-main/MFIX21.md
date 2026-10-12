# MFIX21 — warmed idle CPU

## Outcome

Five canonical-owner corrections were implemented and committed. The last fully warmed Home window reached **0.899 s task / 0.011 s script per 8 s**, down from Round 8's **7.935 s / 3.093 s**. Projects fell from **7.969 s / 3.300 s** to repeat plain windows of **1.735 s / 0.789 s** and **2.222 s / 0.502 s** before the final store-owner correction. The remaining Projects trace showed the machine heartbeat publishing the entire Zustand store once per second and waking 9,701 selector measures; that heartbeat-only global publication is now removed.

Final post-correction Home, Projects, and Action-detail windows could not be collected: after the QA browser forward died, a fresh `mfx21` target was placed on a browser host whose runtime pre-seeded an explicit unrelated Home (`https://leeroy-mbp.tailfce179.ts.net:8443`). The supplied `server=http://happier-agent-qa-l12-main.localhost:3023` intent did not supersede it, recovery requests went to that unreachable Home, and subsequent reloads rendered an empty root. Metro remained healthy (`HTTP 200` from port 19364), and neither Metro nor the stack was restarted. Thus Home's measured target is met; the final Projects and Action-detail target is **not claimed verified**.

No visual, interaction, copy, or styling behavior changed. Applying `happier-ui-craft` kept the work entirely in resource, projection, and subscription owners while preserving fresh presence and usage results.

## Iterations and measurements

All task/script figures are seconds in a plain warmed 8-second browser window. Profiles used the current source loaded by browser reload, without restarting the owner-managed Metro or stack.

| Iteration | Surface and measurement | Top owner / evidence | Canonical correction | Commit |
| --- | --- | --- | --- | --- |
| Round 8 basis | Home 7.935 / 3.093; Projects 7.969 / 3.300; Action detail 7.595 / 2.901 | usage `addUsageCostForMode` and plugin execution-origin remained sampled after MFIX17/MFIX19 | Starting point supplied by MQA2 | — |
| 1 | Reload hydration was finite; no steady result claimed at this point | `usageQueryResource` computed a cryptographic digest synchronously on the renderer | Move digest work to the platform async boundary | `1ac1b6ad3a` |
| 2 | Projects after reload 7.365 / 5.103; after +120 s 3.223 / 1.358; after +240 s 2.548 / 1.352 | machine-only concurrent refresh still fetched and hydrated sessions | Classify machine-only refreshes and bypass session fetch/hydration | `bf36b7a2dc` |
| 3 | Projects 1.735 / 0.789 and 2.222 / 0.502 | project checkout selection recreated equal projections | Reuse the exact-input project checkout projection | `7bc91a7401` |
| 4 | Home 0.899 / 0.011 once progressive hydration settled | superseded usage progress snapshots queued digest/materialization work | Coalesce superseded progress while one async digest is pending | `7d9eebde1a` |
| 5 | Final three-surface measurement blocked by the QA browser server-selection failure above | Projects trace: 4.052 s across 19,015 tasks, 9,701 selector measures, and 1.030 s function calls; CPU profile rooted repeated selectors under `applyMachines` | Keep same-active heartbeat timestamps fresh on retained presence records without publishing the global store; active transitions still publish | `6d74795e44` |

The last measured Projects floor was therefore not treated as a rendering-component problem: it was a store publication problem. Action detail shares the same global store subscription fanout, but because its post-fix window could not be run, that effect remains derived rather than measured.

## Ownership and split-brain audit

- Usage capture and progressive publication remain owned by `usageQueryResource`; consumers received no cache or local filter.
- Concurrent socket refresh remains owned by `concurrentSessionCache`; its update classifier is the single decision point for whether a refresh can affect sessions.
- Project checkout facts remain owned by `projectsTreeCheckoutFacts`; no component memoization was added.
- Machine semantic and presence publication remains owned by `sync/store/domains/machines.ts`. Timestamp-only same-active heartbeats update the already-retained presence records in place and do not call Zustand `set`; semantic changes and online/offline transitions still replace and publish state.
- The MFIX17/MFIX19 usage, session-list, and plugin-origin filters are intentionally retained because they protect distinct semantic work, not heartbeat publication. No duplicate heartbeat filter was added to Home, Projects, or Action detail.

## TDD and validation

- Usage async digest: owner test was written first, failed while digest work remained synchronous, then passed after the platform async boundary.
- Concurrent machine-only refresh: owner scenarios were written first and failed on session fetch/hydration, then passed after classification was enforced at the cache owner.
- Project checkout projection: the identity assertion failed before exact-input reuse and passed afterward.
- Usage coalescing RED observed four digest starts where only the current plus newest pending snapshot were permitted; GREEN observed two.
- Machine heartbeat RED observed one global store notification and a replaced state for a same-active timestamp update; GREEN observes zero notifications, stable state identity, fresh retained timestamps, and preserved active-transition publication.
- PASS on current source through `hstack-exec`: `projectsTreeCheckoutFacts.test.ts`, `machines.referenceStability.test.ts`, and `usageQueryResource.test.ts` — **3 files, 50 tests**.
- Earlier focused GREEN evidence: project selector **5/5**, machine owner **8/8**, and the concurrent refresh targeted scenario passed. The final combined invocation did not collect the concurrent file because its moving-tree harness selection did not enumerate it; the earlier focused pass is the applicable evidence.
- Package typecheck is not claimed: the shared moving worktree continues to contain broad concurrent UI changes and earlier MFIX19 typecheck evidence failed on unrelated `TS6307` project-file-list diagnostics.
- Live final gate: **blocked** as described above. Metro availability itself was verified; the blocker is the QA browser's unrelated explicit Home and empty recovery surface.

## Adversarial closeout

Alternative causes were separated from steady idle work: initial plugin activation and usage hydration were finite, and plain post-warm windows—not profiler totals—were used for the task-time comparison. The final Projects trace falsified the idea that the residual was local project rendering: its repeated selector fanout began at machine `applyMachines`. Neighboring active transitions, other-Home presence, removals, and retained timestamp reads remain covered by the machine owner tests. The correction adds no cache, timer, gate, or new decision-maker.

Residual risk is confined to missing post-`6d74795e44` live measurements on all three requested surfaces. Home was already below the target before that correction; Projects and Action detail should be remeasured once `mfx21` can select the QA Home, but are not represented here as verified below 1 s.

STATUS: DONE
