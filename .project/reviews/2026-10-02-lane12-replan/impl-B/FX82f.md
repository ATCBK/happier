# FX82f — controlled quiet Account and clock fan-out corrections

Partial completion: the quiet Home now measures below 1% Chromium duty, with no main-store writes and only the expected minute-driven row updates. Three owner-level identity/subscription corrections have RED → GREEN proof. **The lane remains blocked on the requested busy shared-Account comparison and the public UI compiler gate.** Automatic approval review refused access to the existing shared Account's CLI key; the exact credential-read permission question remains pending. No shared-Account comparison or complete program performance verdict is claimed.

## Deliverables

These are this lane's hunks, layered on the moving shared checkout; other hunks in the same files are not claimed.

- `apps/ui/sources/components/workflows/library/workflowLibraryReads.ts`: `useWorkflowRunWindow` retains its returned projection when its existing fields and callbacks are unchanged. Account/Home identity, enablement, status, row membership, row content, cursors and callbacks remain invalidation inputs. The Run status cell and canonical Run store retain their existing authority.
- `apps/ui/sources/components/sessions/shell/useSessionListRenderModels.ts`: deferred parents stop subscribing to relative/runtime row clocks. Production already selects `rowViewModelMode: 'deferred'`; the mounted row boundaries retain their own shared-clock reads. The existing eager/list mode still reads the clock.
- `apps/ui/sources/sync/domains/session/listing/useSessionListQuerySourceState.ts`: the canonical Home normalizer returns one immutable empty result. Re-rendering an ordinary caller with no query Homes therefore retains paging callbacks and the query projection rather than manufacturing a changed input. Nonempty normalization and empty-selection completeness rules are unchanged.
- Tests: `useSessionListRenderModels.test.tsx`, `useVisibleSessionListPaneState.workflowRuns.test.tsx`, and `workflowLibraryReads.test.tsx`. The first two exercise real stores, production hooks and composed pane wiring; the third also checks an enabled Run window's stable projection across a parent render. An exposed legacy raw-store-key assertion now observes the same destination Run through the hook's canonical rows.
- Reusable measurement script, aggregate traces, CPU profiles, loaded-module probes, screenshot and command logs: `../qa-shots/FX82f/`.

Visible changes: none. No components, styles, controls, copy, layout, accessibility states or freshness policy were added. UI craft kept the work in the existing Home/list owners; minute age labels still update. No product documentation changes are needed because user flows and wire/persistence/security contracts are unchanged.

## Quiet fixture and runtime basis

Observed: exactly one new QA Account, `ed4541ec-dfe9-4420-8adb-b08cca963029`, was authenticated on Home `srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN`. Its recovery material was written only to `/home/leeroy.guest/.happier/stacks/agent-qa-l12-b/qa/fx82f-account.key`; permission inspection returned mode **600**. No credential value was printed or included in evidence. The Account has five fixed inactive E2EE Session rows and one saved Project. The Project references an offline fixture Machine identifier; no Machine was created or daemon re-paired.

The dedicated browser launcher selected **nl1**, Chromium PID **1282814**, controller CDP **45365**, for `agent-qa-l12-b`. Automation attached to this owned remote browser. Borrowed development UI came from `/apps/ui/index.ts.bundle` with `happier_hmr=0`; only browser-page reloads loaded changed source. Observed stack identities were server selected/loaded `b65d8e28cc58dde2` and daemon selected/loaded `5b51fcc37b7052a7`. No Stack, daemon, Metro or database lifecycle action occurred.

`loaded-final.log` verifies all three changed owners in the loaded Metro module functions/factory, the expected Account, five readable rows, one Project and data readiness. The detailed Session entity map remains empty because the list uses its row projection and deferred detail hydration; this is not missing acquisition. The five rendered rows, not detailed Session entities, define this fixture's readiness. With no Machine paired to this Account, Home shows its existing getting-started content rather than the Machine-backed `home-hub` surface. This fixture does not establish idle behavior for every configured Home widget.

## Measurements and attribution

Each capture is sequential and lasts 120 seconds after list readiness. All captures retain five rows and one Project. React counts are committed function-fiber executions detected from changed `actualStartTime`, seeded from existing roots; DOM nodes and unchanged retained work flags are excluded. CPU duty is CDP `TaskDuration / Timestamp`; its precise counter window is separate from the React window. Wrappers delegate to real implementations and restore capture subscriptions/listeners in `finally`. The saved data contains counts, component/field names and source stacks, without record contents, credentials, ciphertext or opened keys.

| Capture | Commits/min | Function executions/min | Main-store writes | Chromium duty |
| --- | ---: | ---: | ---: | ---: |
| `quiet-before` | 2.000 | 426.993 | 0 | 4.951% |
| `quiet-after` — first two owners loaded | 1.000 | 300.996 | 0 | 0.148% |
| `quiet-final` — all three owners loaded | 1.000 | 300.996 | 0 | 0.577% |

`quiet-comparison.log` recomputes rates on nl3 from a strictly bounded numeric/source-name projection of the local captures. A full-artifact base64 transfer was rejected by automatic approval review; it did not execute, and the accepted replacement transfers only allowlisted aggregates. No whole diagnostic blob was emitted.

Every before commit is accounted for: two shared-clock wakes produced 427 executions each, including the Sessions pane/chrome/list, and each was followed by a 50 ms VirtualizedList batching commit with zero observed function executions. A bounded projection observer found the Run window object changing identity while none of its fields changed; that invalidated the pane, its query presentation and summary. The same investigation found the parent render-model owner subscribing despite delegating row view models.

Every final commit follows the shared clock: wake/commit at **48,403/48,479 ms**, then **108,404/108,480 ms**. Each has 301 function executions, five row boundaries and one membership subscriber, but **zero `SessionsListPaneContentView` executions**. There are no subsequent virtualizer commits. The remaining minute cadence serves visible relative-age labels through the established clock; removing it would freeze valid presentation. This is approximately zero unchanged-data work, not a literal zero-commit promise while time labels change.

All three captures record eight incoming and eight outgoing socket frames, each one byte: heartbeats, without incoming Account mutation payloads. Main Zustand publication counts are zero, so its writer census is empty. This does not claim that every auxiliary store or browser-internal task was instrumented. Final timer counts: eight web-client identity heartbeats, four web lifecycle heartbeats, four reconnect-probe timers, two shared presentation-clock wakes and the one diagnostic stop timer. None of the nonpresentation timers is associated with another React commit or main-store write in this window.

These are measured absolute workloads, not a production-build estimate or an exact causal CPU speedup percentage. Development/runtime activity and the shared moving source can affect duty. The per-commit disappearance of unchanged pane work is the narrower demonstrated improvement.

## Source validation

Remote computation/workspace transfer used the user/orchestrator's standing 2026-10-10 authorization. Source tests, compiler attempts, searches and aggregate analysis went through `./apps/stack/bin/hstack-exec`, never `--local`. Commands used the wrapper's synchronization barrier and continuously moving mirrors. Tests selected **windows1-linux** and **nl3**, both `/home/happier/happier-dev`.

- `owners-red.log`: valid combined RED, exit 1. The deferred parent renders **4 versus 3** after the real shared-clock wake; the composed pane publishes **4 versus 2**. Internal stores, selectors, normalization and hooks are real; HTTP, native/navigation and OS time are the substituted boundaries. Removing consumed clock/projection wiring exposes the assertion rather than leaving a helper-only test green.
- `owners-green.log`: parent regression passes; pane still fails. `pane-diagnostic.log` identifies its remaining changed `query` field after the Run window becomes stable. The canonical empty Home result then fixes that second originating identity.
- `owners-final-green.log`: exit 0, both deciding regressions pass. `corridor-green.log` also reruns their final simplified assertions successfully.
- `corridor-green.log`: **74 pass, 1 fail across 5 files**. The failure is the old unqualified `workflowRunsById['writes-here']` assertion, exposed by the current scoped Run store. The four other files pass: parent render models, composed pane/filter/Board behavior, shared clock freshness/disablement, and the three-Home/150-row store composition. The test now checks the real destination row returned from the scoped owner; this does not weaken its origin-versus-destination assertion.
- `workflow-corridor-green.log`: reruns the complete Workflow library/Run owner after that assertion correction and the enabled-window identity check.
- `query-corridor.log`: exit 0, **18 tests pass**, including query admission, empty completeness and index contracts.
- Earlier non-RED attempts are retained: a TTY launch failed at sandbox UID setup; the public parent runner waited on a foreign dependency lock and was cancelled, exit 130; the first two direct source invocations used a doubled config path and exited 1 before test execution. The corrected source invocation uses `--root apps/ui --config vitest.config.ts`.
- `diff-check.log`: the wrapper refused remote Git checking because Git must run on the primary checkout. No local validation escape was used; no diff-check pass is claimed.

The public UI package compiler gate remains pending in this draft: `ui-typecheck.log` never reached compilation behind a foreign dependency lock on nl3 and was cancelled through its verified owned process group, exit 130. `ui-typecheck-linux1.log` is the replacement public check, waiting for `compilation-ui` admission. No foreign process or lock was modified. Focused tests do not waive compiler clearance.

## Owner audit, outstanding work and risk

The canonical Run status cell/store, query Home normalizer and parent/row render-model split remain the sole owners. Existing pane/view projection memos and per-row subscriptions are reused. The shared clock remains the one time authority; eager render-model callers and visible row boundaries intentionally retain time reads. Saved-definition reads are a distinct demand surface and are unchanged. No parallel store, reader, key cache, timer, registry, gate or persistence mechanism was introduced. Other lanes' scoped Run-key and composed-harness hunks were preserved.

The self-attack caught the second empty-query identity after the first fix, the exposed unqualified store assertion, the initial detail-store readiness mistake and the doubled Vitest config path. These failures are retained instead of being presented as RED or passes. Changed row data, inactive surfaces, Account retirement, enablement, pagination, origin/destination distinction and sibling row isolation are covered by the executed corridor; final loaded-source measurement checks the environment gap.

[blocked] Busy shared-Account measurement: the proposed read of `/home/leeroy.guest/.happier/stacks/agent-qa-l12-b/cli/servers/stack_agent-qa-l12-b__id_default/access.key` was rejected by automatic approval review as an existing credential source not explicitly named in the authorization. No read occurred. The exact permission question was sent asynchronously. After approval, authenticate this lane's remote browser to Account `5e3a0581-6f3d-4e73-bf40-383db0be6c3e` without emitting its key, acquire its Home, and measure actual incoming-update cost once. The quiet result is not a substitute for that requirement.

[blocked] UI compiler clearance: await the public typecheck's terminal compilation result on an admitted target and reconcile any errors with their owners. There is no successful package compilation claim.

Cleanup is pending in this draft. The quiet Account and its protected recovery file are retained for the orchestrator; deleting them is not part of this lane. Residual risk is the missing busy shared-Account comparison and compiler clearance, development/browser-only performance evidence, the Machine-free Home fixture, and unmeasured native/mobile/macOS/Windows performance.

RELOAD NEEDED: apps/ui/sources/components/workflows/library/workflowLibraryReads.ts; apps/ui/sources/components/sessions/shell/useSessionListRenderModels.ts; apps/ui/sources/sync/domains/session/listing/useSessionListQuerySourceState.ts. The lane's browser loaded all three; any other application or Stack reload remains orchestrator-owned.
STATUS: BLOCKED
