# FX88e — foreground acquisition extended; cold body target remains unmet

**PARTIAL / acceptance blocked.** The real-wiring regression is RED → GREEN and the final combined route/withdrawal corridor passes **17/17**. Saved Secret, Artifact, Workflow Run, Authoring Memory and Project-row startup acquisition now yield to FX88d's existing foreground phase. The latest unprofiled body is still **18.653 s from navigation / 7.083 s after the bundle**, above the required 3 s. The final busy replay measured **48.784%**, above 37.8%; its changing corpus prevents a causal regression verdict. The public UI compiler failed, adjacent tests have failures, and no live secondary-Home membership withdrawal was performed. None of those missing gates is reported as passed.

## Delivered changes and canonical owners

- `apps/ui/sources/sync/syncEngine.ts` exposes the existing `awaitBootstrapForegroundAcquisition` phase to its actual background consumers. Its scoped Artifact authority waits before acquiring content; Settings-triggered Authoring Memory and Project-row bootstrap also yield before starting their independent reads. Their explicit mutation/demand owners remain available. FX88d's core readiness, shared list/reconnect priority, quiet placeholder fix and synchronous retirement correction remain in place.
- `apps/ui/sources/sync/engine/settings/savedSecretCatalogEngine.ts` waits before resolving mode and materializing catalog resources. Its existing scoped loader still owns freshness, publication, maintenance and retry.
- `apps/ui/sources/sync/ops/actions/actionAccountContext.ts` makes its existing Artifact parameter/preparation owner join that phase, covering exact and paged Action-owned Artifact reads rather than only Sync's inventory path. The captured Account still decides currentness.
- `apps/ui/sources/sync/domains/workflows/workflowRunListActions.ts` defers the canonical Run list projection, including shell attention and restored names. It captures the existing Account lifetime before waiting and preserves explicit-null admission and cancellation behavior.
- `apps/ui/sources/sync/sync.routeAcquisitionPriority.test.tsx` composes real Sync, workspace route admission, scoped HTTP, Saved Secret catalog, Artifact operations and the Workflow attention window. Held exact reads prove that those independent owners and Settings-triggered projections cannot bypass foreground acquisition; release proves background work resumes. Plain, E2EE and exact-HTTP-failure cases remain.
- `docs/surface-states.md` updates the existing internal owner description as **0.3 development source**. No public release availability, wire shape, persistence format, gate, queue, scheduler, timeout, cache or style was added.

Visible change for the design round: the existing routed Session body receives priority over more unrelated startup work. Existing loading/error/body components, layout, styles and copy are reused. This lane makes no full-page light/dark/phone design-fidelity claim.

## Primary diagnosis and loaded measurements

Artifacts are under `impl-B/qa-shots/FX88e/`. Measurements are observations of the moving QA Account and development UI, not matched frozen-workload comparisons.

| Capture | Body from navigation | Bundle end | Body after bundle |
| --- | ---: | ---: | ---: |
| `cold-baseline.json` (CPU profiling enabled) | 21.446 s | 7.267 s | 14.179 s |
| `cold-after.json` (first loaded catalog/Artifact/Run correction, profiling enabled) | 22.653 s | 11.409 s | 11.244 s |
| `cold-unprofiled-final.json` (before the Authoring Memory/Project bootstrap correction) | 15.438 s | 9.329 s | 6.109 s |
| `cold-core-final.json` (latest complete source, no CPU profiler or method wrappers) | 18.653 s | 11.570 s | 7.083 s |

Observed startup split:

- CPU samples in the baseline attribute approximately 0.86 s to Workflow accepted-snapshot base64 validation/decoding and 0.26 s to its Poly1305 opening, plus schema/signing-input work. Those Run projections started while Profile/Settings prerequisites were pending. This falsifies an explanation confined to saved-secret key opening.
- Network timing varies between captures. The earlier instrumented diagnostic `cold-network-before.json` records a Profile pre-send wait of 3.309 s and about 223 ms from send to response headers; its instrumentation was superseded by the fresh-browser baseline and it is not a matched performance control. The retained clean baseline records 85.9 ms before send and about 3.800 s after send. Neither sample establishes a universal server-only or client-only cause.
- In `cold-after.json`, Profile pre-send wait is 1.767 ms, Profile HTTP is about 87 ms total, Settings HTTP about 174 ms, and the target key initializes at 21.4209–21.4213 s. Background Artifact list acquisition starts later, at 21.905 s. This proves the observed startup ordering, not a matched total-latency improvement.
- In the latest unprofiled replay, Profile starts at 16.275 s, **4.705 s after bundle completion**; it completes at 16.372 s. Settings runs 16.682–16.758 s; exact Session HTTP runs 17.097–17.273 s; body appears at 18.653 s. The remaining gap therefore includes substantial initialization before Profile is issued and about 1.380 s after exact HTTP. More work at startup/route initialization is required; another key-opening scheduler would not explain that pre-Profile interval.
- The final unprofiled replay verifies loaded factories for the Saved Secret engine, Action Artifact context and Workflow Run list owner all contain the shared foreground wait. Final source tests additionally exercise the new Settings-triggered ordering. No server, daemon, Expo or database lifecycle was performed.

The phase still ends when exact acquisition, including key installation, settles. It does **not** certify that the React body has committed. Background content can resume in that remaining render interval; the stricter body-ready interpretation and the 3 s body target remain unclosed.

## Validation actually run

All source searches, tests and compiler invocations used `./apps/stack/bin/hstack-exec`, AUTO or authorized explicit targets, under the standing **2026-10-10 remote-computation/workspace-transfer authorization**. The canonical wrapper flushed the continuously moving mirrors. No `--local`, direct local whole-package compiler, Git mutation, foreign-process cancellation or Stack lifecycle was used. Small controller-local reads inspect the requested ignored artifacts and local logs; Playwright attaches locally to the authorized remote QA browser.

- Initial catalog priority RED: linux1 handle **32335**, exit **1**, `/tmp/happier-fx88e-priority-red-linux1.log`. The composed test observes Saved Secret materials while the routed exact response is held. Earlier nl3 handle **51699** was canceled before tests while waiting for dependency refresh; it is not RED evidence.
- Initial GREEN attempts **70018 / 26016** fail during cold `sync-load` at the existing 120 s test limit; the full attempt then reports overlapping act activity and invalid later-case state. These are failed runs, not product GREEN. The harness now transforms the app graph during collection with the canonical network boundary installed first; per-case module resets still rebuild the actual wiring. No timeout was increased. AUTO/mac3-linux **32817** then passes **3/3**, `/tmp/happier-fx88e-priority-final.log`.
- Settings-triggered projection RED: AUTO/mac3-linux **30168**, exit **1**, `/tmp/happier-fx88e-core-priority-red.log`. Authoring Memory HTTP starts while exact Session acquisition is held.
- **Final composed GREEN: AUTO/mac3-linux handle 71136, exit 0, 17/17**, `/tmp/happier-fx88e-composed-final.log`. This includes `sync.routeAcquisitionPriority.test.tsx` (3), `concurrentSessionCache.telemetry.test.ts` and `sessionListOrdinaryFrontier.dom.test.tsx` (14 combined). It is the requested fresh final-byte rerun of both unfinished FX88d corridors, including synchronous direct-revoke retirement. A prior standalone linux1 rerun **20836** also passed **14/14**; the earlier wrong-path/windows1 admission attempt **77399** was canceled and supplies no executed test evidence.
- Adjacent final run **2442**, AUTO/mac3-linux, exit **1**, `/tmp/happier-fx88e-adjacent-final.log`: **29 passed / 3 failed**. Workflow library reads pass; Saved Secret retained-source freshness and personal/legacy-inference history cases fail. The earlier nl3 run **6384** reports **36 passed / 7 failed**, adding Action-context cases with a literal invalid token fixture and unfiltered network-count expectations. These failures were not hidden, skipped or changed to force green; attribution of the Saved Secret failures remains unproven. Related resource-operation compiler errors are outside this lane's edits.
- Public UI typecheck **71038**, AUTO, exit **1**, `/tmp/happier-fx88e-ui-typecheck.log`: diagnostics span destination routing, automation contribution shapes, Saved Secret resource operations and other test consumers. **Final current-source rerun 68978 also exits 1**, `/tmp/happier-fx88e-ui-typecheck-final.log`; AUTO reselected mac3-linux after nl3 admission. Targeted raw-log checks on both runs found no diagnostic in the five changed production/test paths. This is not a package compiler pass.
- Scoped `git diff --check` passes. Internal documentation changed only an existing prose paragraph; no published documentation build was required.

## Duty and live withdrawal coverage

- `quiet-final.json`, before the last Settings ordering correction: **120.004 s, 0.02432% duty, zero publications**. Final-source `quiet-core-final.json`: **120.003 s, 0.02356% duty, zero publications**, five indexed/full Sessions remain five. This is a normally hydrated quiet Account, not the predecessor's held metadata-null diagnostic. The existing still-placeholder implementation was not edited.
- `busy-final.json`, before the last Settings ordering correction: **120.005 s, 38.51557% duty, 148 publications**, full Sessions stay 10 while rows grow **233 → 303**. Final-source `busy-core-final.json`: **120.045 s, 48.78385% duty, 172 publications**, full Sessions stay 15 while rows grow **236 → 305**, with one metadata-null row at both ends. Both exceed the requested threshold. Different changing corpora and startup conditions prevent attributing the delta from FX88d's 37.7603% to this patch; they do not waive the failed threshold.
- A live secondary-Home Team/Group withdrawal was not performed. The lane browser has two registered Homes but only the QA Home is authenticated; the other is signed out, verified through the normal scoped credential owner without returning credentials. Creating another Account on that same QA Home would not establish a second authenticated Home for the observer. No second Account/key file, Team, Group or membership fixture was created. The missing prerequisite is another authorized authenticated Home for the observer; no forbidden key source or Stack lifecycle was used to manufacture it.

## Self-attack, ownership and residual risk

The self-check rejected a confounded first instrumentation attempt, used a fresh browser for the retained baseline, added an unprofiled final replay, preserved explicit-null Workflow scope admission and kept captured Account currentness separate from the focused Sync phase's boolean result. Source inspections and the composed regression identified the independent Settings-triggered bypass rather than adding another queue. Exact demanded secret reads and explicit Authoring Memory/Project mutations retain their existing owners; they are genuine demand paths rather than alternate startup schedulers. FX88d's quiet renderer, shared acquisition and Home-qualified retirement changes were preserved.

The remote lane browser is `fx88e-final`, target **nl1**, `agent-qa-l12-b`, Chromium PID **2934033**, CDP **43669**, borrowed Expo **19364**, QA Home **3026**. Authentication used only the documented `unified-work-live/state/dev-test-account.key` and the allowed quiet `qa/fx82f-account.key`, read directly into the Recovery key field in memory. No forbidden access/recovery file was read. No Account key/token, Session payload or decrypted Account content was printed or saved. Diagnostic artifacts retain aggregate state, code locations and timings only.

Acceptance coverage and residual work:

- [blocked] Cold body latency: the latest body remains 7.083 s after the bundle. The missing deciding fact is the precise owner of the remaining pre-Profile initialization interval; trace that startup interval and reduce its real work before claiming the 3 s target.
- [blocked] Strict body-ready deferral: unrelated startup key/content work yields to exact acquisition, but no body-commit readiness guarantee was added. Close this through the existing presentation/demand owner while preserving FX88d's Profile-independent exact-acquisition phase.
- Quiet duty passes. [blocked] Busy duty does not: profile the changing busy interval and attribute its main-thread work before claiming non-regression.
- [blocked] Package and adjacent gates: resolve/adjudicate the named compiler and Saved Secret failures with their current owners, then rerun the affected checks. No failure was reclassified as a pass.
- [blocked] Live Team/Group withdrawal: supply the observer's other authorized authenticated Home, then run the disposable fixture journey. The composed withdrawal corridor is green but does not substitute for that live journey.

Native/physical-device performance and the design round remain unmeasured. No source changes or checks remain running in this lane; browser cleanup is recorded below.

Cleanup: TTY browser owner **71512** terminated after SIGINT, exit 1, with no cleanup error output. Its CDP **43669** is unreachable. Earlier owned browser **33793** likewise terminated after SIGINT; CDP **42667** is unreachable. No `fx88e` checkout browser launcher remains. Only lane-owned browser lifetimes were retired; no Stack runtime lifecycle was used.

RELOAD NEEDED: `apps/ui/sources/sync/syncEngine.ts`, `apps/ui/sources/sync/engine/settings/savedSecretCatalogEngine.ts`, `apps/ui/sources/sync/ops/actions/actionAccountContext.ts`, `apps/ui/sources/sync/domains/workflows/workflowRunListActions.ts` for other clients. This lane deliberately reloaded its browser to observe the changes; no Stack lifecycle was performed.
STATUS: BLOCKED
