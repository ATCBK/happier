# FX82d — linked metadata reuse; overall settled-idle goal remains unverified

Partial implementation. The canonical UI linked-Session reader now reuses its non-authoritative parse for the same immutable metadata input. Real-store RED → GREEN and the adjacent corridor pass. Existing Usage owners already suppress the tested unchanged ticks and isolate sibling progress; no replacement Usage mechanism was added. The public UI compiler gate and a matched, fully acquired before/after idle comparison remain outstanding. No overall CPU improvement or near-zero idle result is claimed.

## Deliverables and ownership

- `apps/ui/sources/sync/domains/session/external/readExternalSessionLink.ts`: a weak-keyed projection at the existing shared UI reader reuses both successful and null results. Replacement metadata goes through the same Protocol reader again. Primitive inputs retain the null outcome. No schema, released shape, authorization decision, encryption custody, poll, timer, fixed capacity, styles or controls changed. Retention follows the immutable input's lifetime.
- `apps/ui/sources/activity/source/createActivityAttentionStoreSourceSelector.test.ts`: the real store, real Activity selector, real row producer and call-through Protocol parser prove reuse across independently created Activity readers and invalidation after metadata replacement.
- `apps/ui/sources/sync/store/hooks.sessionListRowProjection.test.tsx`: strengthens the existing three-Home/150-row composed React test with real linked metadata and parse counts. One row's status change renders only that row; 20 subsequent changes leave every other row at one render. There are 171 total row renders and 150 parses, including mount, rather than reparsing on each target-row render.
- `apps/ui/sources/sync/api/account/usageQueryResource.test.ts`: strengthens the existing real Resource test with subscriber publication counts. Equivalent Profile refreshes, unrelated store ticks, loading-only provider rows and unchanged quota admission publish nothing; an explicit refresh still publishes its actual activity.
- Sanitized scripts, counters, source-test logs and profiles live in `../qa-shots/FX82d/`. Only this report and that assigned evidence location were created.

Split-brain audit: all UI presentation calls to `readNonAuthoritativeLinkedExternalSessionV1FromMetadata` already converge through the changed reader. Activity, list metadata comparisons, list view state, row presentation, follow presentation and external-session runtime consumers use it. Protocol remains the parser and reconciliation authority. Direct `resolveLinkedExternalSessionMetadataV1(..., 'stored')` consumers in resume/action selection and runtime-local metadata preservation deliberately remain authoritative effect/admission paths; they are not replaced with a presentation cache. No second schema or decision-maker was introduced. Usage's Account Resource, generic Resource digest/no-op admission, and widget slice selection remain their existing owners.

The load-bearing assumption is the established UI store contract that metadata inputs are immutable. Replacement metadata is exercised through the real store and selector. The follow-policy writer was inspected and delegates to the immutable Protocol update owner; its neighboring tests pass. This cache is not authority for an Action, Account mode, decryption or disclosure.

Visible changes: none. UI-craft influenced the scope: existing Home/list components remain the live measurement surfaces, with no new components, styles, tokens, copy or layout. Product documentation is unchanged because accepted formats, visible flows and security outcomes are unchanged; this is source performance work, not a release-availability claim.

## Source verification

All source validation used `./apps/stack/bin/hstack-exec` without `--local`, against the continuously moving canonical mirror and launcher synchronization barrier. The orchestrator/user's standing 2026-10-10 remote-computation/workspace-transfer authorization applies. Source tests selected nl3, `/home/happier/happier-dev`.

- `link-red.log`: the real Activity composition parses the same metadata **11 times** where one is required. Removing reuse at the consumed reader restores this missing-behavior failure; the test reaches it through production selector/row wiring rather than a substituted internal helper.
- `link-green.log`: the first broader attempt exposed a fixture-observation mistake: the real row producer had already warmed the new reader before the spy was installed, producing zero observed parses. That is not production RED. The spy now surrounds the real producer too.
- `composed-green.log`: **4 tests pass in 4 files**, covering the changed Activity composition, 150-row render/parse contract, unchanged Usage subscriber suppression and real sibling Usage body selection. Mocked boundaries are HTTP and platform adapters; internal stores, Resource admission, selectors, parsing and React wiring remain real.
- `corridor-green.log`: **59 tests pass across 5 files**, one existing opt-in timing measurement is skipped. This includes all Activity selector cases, row projection cases, Usage invalidation, widget Resource selection and external-session follow updates. The shared Home harness logs unrelated authoring-memory/project-row 404s; they are preserved, not claimed as successful endpoint coverage.
- Scoped `git diff --check`: **exit 0**, `diff-check.log`.

The public UI gate is **[blocked]**. `ui-typecheck.log` waited on the foreign nl3 dependency-refresh lock, PID 1518314, and did not reach compilation. Its own controller process group was identified by the exact FX82d command, parent chain and FX82d log file descriptors, then cancelled with terminal exit 130. Automatic approval review initially rejected cancellation for missing ownership evidence; the read-only ownership checks resolved that concern, and the subsequent cancellation was accepted. The foreign dependency process and lock were untouched. The alternate linux1 public UI typecheck also did not reach compilation: `ui-typecheck-linux1.log` records `compilation-ui` admission waits with 17–21 ahead; its own TTY handle was cancelled, exit 130. No compiler clearance is inferred from focused Vitest success.

## Live investigation and measurement limits

The authorized QA browser owner selected nl1 for `agent-qa-l12-b`, remote Chromium PID 1082597, controller CDP 33263. Browser automation attached from the controller through the canonical owner. The expected QA Account was checked and authenticated using its existing QA challenge helper without emitting credential material, ciphertext, opened keys or decrypted records. No Stack, daemon, database, Metro or export lifecycle operation was performed. Only browser-page navigation/reloads occurred.

The loaded endpoint serves `/apps/ui/index.ts.bundle` with development mode enabled. No production-mode representation was available through that endpoint; none was built or started. Development overhead is estimated from profile frames, not from a production A/B run.

Duty is Chromium `TaskDuration / Timestamp`; parse and render rates use their actual observer window. React counts are committed function-fiber executions detected from changed `actualStartTime`, excluding the first observed commit, not aborted render attempts or DOM node counts. The original `before.json` counted retained PerformedWork flags and overcounted renders; its render total is discarded. The corrected counters are in the later before captures. The first `after.json` lacked a React hook after reconnection, so its zero render count is unavailable evidence. `rendered-after` and `warm-after` overlapped and are discarded for before/after comparisons. The sole final capture reloads with the hook, waits for observed background hydration to settle, and guards against overlapping observers.

Observed pre-change captures illustrate why acquisition must not be mistaken for an idle baseline:

| Capture | Session count | Row count | Duty | Observation |
| --- | --- | --- | ---: | --- |
| `before` | 49 → 172 | 236 → 529 | 98.87% | Initial acquisition, render total invalid |
| `warm-before` | 320 → 320 | 713 → 713 | 98.76% | Stable entity counts, 4 newly observed hydration jobs still pending at end |
| `settled-before` | 358 → 358 | 715 → 715 | 98.34% | 4 jobs start, 3 complete; still not fully settled |
| `final-before` | 373 → 384 | 716 → 717 | 51.36% | Duty fell before the correction was loaded; 11 jobs start, 10 complete |
| `acquired-before` | 386 → 402 | 717 → 717 | 51.18% | Observed active hydration 0 → 1; not a fully acquired interval |

`acquired-before-summary.log` derives **36,004 linked reads/minute**, **36,196 Protocol reader calls/minute**, **58,123 committed function renders/minute** and **107 commits/minute**. These are all-app/presentation counts in a changing workload, not Session-row-only counts. Selected component counts in its 60.605-second observer window: Activity membership provider 24, Activity notification runtime 36, Activity badge runtime 36, active list subscriber 43, visible list content 44, Session list wrapper rows 1,848, inner SessionItem 98 and Usage body 6.

Its actual triggers are recorded, rather than attributed to one inferred idle loop:

- 60 store notifications: 24 row-map-only patches, 12 Session-plus-row publications, one Session-only publication, organization loading/snapshot publications, Artifact list/body publications, Workflow Run upserts and automation-window refreshes. Store-call stacks identify `applyServerScopedSessionListRows`, `applySessions`, `fetchAndApplyArtifactBodies`, `materializeWorkflowRunAccountChange` and `refreshAutomationRunsWindow` callers. These writes are not an unchanged-store interval.
- The Account-change observer sees one mixed Session/automation/Account/Artifact/share/secret-resource wake with `usageQueryAffects: true`. This is a real broad invalidation, not proof that the Usage owner self-retriggers. The composed unchanged-input and sibling tests above distinguish those cases.
- Timers include 404 background-hydration yields, 185 hydration flushes, 118 crypto yields, virtualized-list batching, canonical runtime freshness wakes and machine ephemeral accumulation. These are reachable work/lifecycle owners, not justification to remove yields or add polling/caps.
- Source dependencies and sampled caller chains connect changed Session/list inputs to the Activity selector, visible list projection and row presentation. Unrelated root notifications are already short-circuited by the existing Activity selector; a changed personal-membership context can create a new selector, which previously reparsed the same linked input. The real-store multi-reader RED exposes that repeated parsing independently of timer assumptions.

`final-before-analysis.log` attributes **2.310 sampled seconds** to recognized React development logging/JSX-validation ancestry, **7.00% of sampled non-idle time**. Its exclusive categories also include linked parsing 0.467 s, Usage 0.547 s, key opening 3.360 s, Workflow projection 3.001 s, other React 8.093 s, GC 2.149 s, and uncategorized/program work. Sampling duration and Performance counter duration differ; these sampled seconds are not added to TaskDuration or treated as predicted production savings. Recognized development frames explain a share, not all residual duty.

The first corrected-reader acquisition capture (`after.json`) observes 26,124 UI linked reads and 1,479 Protocol reader calls, but 99.18% duty, 181 → 307 Sessions, and unfinished background hydration. It verifies loaded reuse only; it cannot establish a matched idle CPU improvement.

The final sequential capture (`final-after.log`, `.json`, `.cpuprofile`) verifies the new reader, React hook and visible Home in its loaded basis. It starts after **24/24 observed background jobs completed**, with active count zero. It then records a 60.306-second observer window / 60.560-second counter window:

| Metric | Late before (`acquired-before`) | Final source (`final-after`) |
| --- | ---: | ---: |
| Duty | 51.18% | 55.57% |
| UI linked reads/min | 36,004 | 35,958 |
| Protocol linked reader calls/min | 36,196 | 830 |
| Committed function renders/min | 58,123 | 51,173 |
| Commits/min | 107 | 128 |
| Sessions | 386 → 402 | 306 → 316 |
| Rows | 717 → 717 | 713 → 713 |
| Observed hydration active | 0 → 1 | 0 → 1 |

These are **not matched idle workloads**. The final window has 79 store notifications, a mixed Account/Artifact/Session/automation/Machine wake, and 15 newly launched hydration jobs, of which 14 finish before the window ends. Stable row counts do not mean unchanged content. Final selected component counts: Activity membership provider 27, Activity badge and notification runtimes 32 each, active/visible list owners 47, list wrapper rows 846, inner SessionItem 47 and Usage query body 6. The repeated-reader source contract and loaded call counts establish parse reuse; the duty and render totals do not establish an overall improvement.

`final-after-analysis.log` attributes recognized development-only work to 2.256 sampled seconds, **5.67% of non-idle samples**. Linked-parser ancestry drops to 0.001 sampled seconds; Usage remains 0.456 s, key opening 4.922 s, Workflow projection 2.946 s, other React 8.743 s, GC 1.568 s, with substantial uncategorized/program work. The diagnostic tree walk itself appears in sampled `visit` frames (one leading chain is 0.610 s), so the capture also carries observer overhead. The remaining duty is not explained solely by development logging or linked parsing, and no production CPU prediction is made.

Cleanup: `probe-cleanup.log` verifies no active capture, background observer, timer wrapper or render observer, and confirms the retained source reader is still loaded. The owned browser launcher was closed via its TTY, terminal exit 1. Automatic approval review initially paused that close for missing handle ownership; exact `browser start fx82d` process-tree and `/dev/pts/37` descriptor checks established ownership, then the same close was accepted. CDP 33263 is unreachable (`curl` exit 7). `browser-cleanup.log` records the canonical exact-target nl1 verification of the owned PID/profile after closure. No foreign process, lock, Stack, daemon or database was changed. The lane's source-test, analyzer and compiler launchers are terminal.

## Remaining work and risk

[blocked] Obtain the public UI typecheck's actual compilation result after dependency preparation/admission becomes available. Focused source GREEN does not close this gate.

[blocked] A matched fully acquired before/after Home interval has not been established. The observed pre-change duty naturally dropped from approximately 99% to 51% without the new reader loaded, and the shared source/corpus continued moving. Treat any subsequent duty change as a measurement, not a causal speedup claim. Artifact and Workflow projection work remain visible outside this lane's corrected reader; no cross-Action key cache, omitted Artifact read, new freshness policy or lifecycle action was introduced to manufacture idle.

The in-place self-attack exposed warmed-fixture observation, invalid retained-fiber render flags, missing reload-local observer setup and overlapping probes; those samples were corrected or excluded rather than used as proof. Neighboring follow replacement, Activity signature changes, Home-qualified row identity, unchanged Usage ticks, sibling progress and authority loss are covered by executed tests. Native/mobile/macOS/Windows performance and production-build comparison are unmeasured release evidence. The remaining implementation risk is the immutable-input assumption and missing integrated compiler gate; the remaining program risk is unresolved fully settled idle duty.

RELOAD NEEDED: apps/ui/sources/sync/domains/session/external/readExternalSessionLink.ts. Browser-page reloads loaded this source; any Stack reload remains orchestrator-owned.
STATUS: BLOCKED
