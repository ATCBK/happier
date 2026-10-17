# FX89b — approval-to-native attribution

Blocked: sample 3 confirms substantial time after server receipt, including a 95.188-second daemon RPC candidate and 69.586 seconds from Script operation creation to native start, but the retained evidence cannot identify the responsible inner phase. No production correction, RED/GREEN proof, wiring-sensitivity check, package check or fresh live replay was completed. Only this report was written. A fresh correlated daemon capture is needed before changing admission, approval replay or Project preparation; no cache, timer, guard relaxation or speculative deduplication was added.

## Evidence and harness separation

Observed primary inputs are `impl-B/qa-shots/LV13b/lint-{1,2,3}.json`, `lint-phases.json`, `requests-scripts-resume.jsonl`, `lint.mjs` and `resume-lint3.mjs`. Timings below were recomputed from those files, not copied from LV13b's conclusions. FX89 and LV13b were read completely; current FX93 and FX88c reports were inspected for overlapping ownership. No claim that their current source was loaded for this historical sample is made.

| Sample | Approval mark → creation | Creation → native | Approval mark → native | Native duration |
| --- | ---: | ---: | ---: | ---: |
| 1 | 127.744 s | 75.000 s | 202.744 s | 4.070 s |
| 2 | 102.546 s | 40.322 s | 142.868 s | 4.068 s |
| 3 | 109.885 s | 69.586 s | 179.471 s | 4.056 s |

The harness records `approvedAt` with a browser evaluation **after** Playwright's approval click returns. It is an approval mark, not an instrumented pointer/handler or fetch-start timestamp. Sample 3's initial Script mark is 21:41:44.348Z, confirmation mark 21:41:48.521Z and resumed approval mark 21:45:48.434Z. The intervening 244.086 seconds includes waiting for the approval and harness/operator recovery and is excluded from 179.471 seconds. The original operation/request is retained. Creation is first observed 8.756 seconds after its `createdAt`; terminal settlement is observed 2.620 seconds after `settledAt`. Those observation lags are not added to the host timestamps or called native execution. First-output timing remains unavailable; no terminal contents were read.

## Sample 3 timeline

Operation `da91192c…`, Script request `06bfe4b1…`, terminal `035061d2…`. All absolute times in the table are UTC except the explicitly identified daemon-local record. “Observed” means a retained timestamp; “derived” identifies a reconstructed or associated boundary.

| Boundary | Time / duration | Evidence and limit |
| --- | --- | --- |
| Approval mark | 21:45:48.434Z | Observed in `lint-3.json`; after the click resolves. |
| Decision POST reaches server | 21:46:08.297Z; 19.863 s after mark | Observed incoming `req-79tg`, `/v1/actions/approval.request.decide`. Exactly one such ingress occurs between the mark and creation. Artifact-body correlation is absent. |
| Server authentication completes | 21:46:08.707Z; 374.045 ms measured | Observed uncorrelated authentication span at the candidate dispatch boundary. |
| Candidate dispatch | `e7f1d56f…`; 97.781 s | Observed dispatch ends at exactly 21:47:46.461Z, the decision HTTP completion. It is the only dispatch ending within one second of that response. Authentication plus dispatch differs from measured HTTP duration by <1 ms. This strongly supports the temporal association; it does not restore missing Artifact identity. |
| Machine resolution / authorization | 155.659 ms / 568.231 ms | Observed candidate spans. These and later spans nest; they must not be summed into an exclusive critical path. |
| Server relay round trip begins | Approximately 21:46:09.404Z; 97.057 s | Derived from `dispatch.daemon_forward` end 21:47:46.461Z minus elapsed 97056.749 ms. The span includes target-currentness guards and daemon work, not just network transit. |
| Target currentness | Three spans: 215.148 / 829.324 / 640.848 ms | Observed candidate spans ending 21:46:09.678Z, 21:46:10.621Z and 21:46:11.263Z; nested inside forwarding. |
| Daemon receives candidate RPC | Approximately 21:46:11.258Z | Derived from daemon completion below minus 95188 ms. This is RPC-manager receipt, **not** authenticated executor admission. |
| Daemon admits / replays Script | [blocked] exact phase boundaries unavailable | No Script or approval stage trace is present in the inspected daemon log; no original Script, operation, terminal or candidate decision UUID occurs there. Completion carries a separate transport UUID. |
| Script operation created | 21:47:38.319Z | Observed host `createdAt` from the original Script receipt, 90.022 s after decision ingress. This precedes the observed preparation phases; creation must not be reordered after setup. |
| Daemon candidate RPC completes | Local 23:47:46.446; duration 95188 ms; transport `68560ff5…` | Observed `[RPC] Request completed`, `daemon.actions.external.dispatch`, `outcomeCode: ok`, line 144303 of the daemon log below. Derived UTC association uses the consistent +02:00 local-clock offset and completion 15 ms before the candidate server relay end. It does not prove which inner Action phase consumed the duration. `ok` is RPC completion, not native Script success. |
| Decision HTTP completes | 21:47:46.461Z; measured 98155.870 ms | Observed `req-79tg`, HTTP 200. It completes 8.142 s after Script creation and before native start; this response is not a native completion receipt. |
| Preparing first observed | 21:47:49.553Z | Observed browser operation snapshot; not the phase's exact start. |
| Setup first observed | 21:48:27.954Z | Observed browser snapshot; neither setup duration nor native setup execution can be reconstructed from this label. |
| Native starts | 21:48:47.905Z | Observed host `startedAt`; 69.586 s after creation. |
| Native settles | 21:48:51.961Z | Observed host `settledAt`; failed / `project_command_step_failed`, 4.056 s native duration. |

Derived dominant intervals are the candidate daemon's 95.188 seconds and the Script's 69.586-second creation-to-native interval. They overlap by 8.127 seconds, so adding them would overcount. The 19.863-second pre-ingress interval is material but cannot explain the much larger observed post-ingress delay. This evidence does not justify declaring UI-side dominance or handing the whole defect to FX88c. It also does not distinguish slow Home IO, repeated work, CPU contention or waiting within either daemon interval.

The decision trace's 97.057-second relay span must not be confused with the original Script request's **pre-approval** 107.016-second summed forwarding spans. The latter end by 21:43:46.401Z. Similarly, ten post-ingress Script authorization-verification HTTP requests are visible before native start, but their endpoint names carry no original-request binding; counts or summed response durations are not exclusive Script critical-path attribution.

## Read-only log inspection and falsifiers

Authorized `dev-targets status nl1` returned ready. Read-only `dev-targets exec nl1 -- node -e …` inspected log filenames/metadata and projected only timings, bounded event identifiers, field names and counts from:

`/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/cli/logs/2026-10-16-21-10-43-pid-2592420-daemon.log`.

The top-level `logs/daemon.log` ends at startup and is not the runtime diagnostic file. The actual PID-2592420 file covers the sample. No raw log lines, credential files, native arguments, Account/Session contents or environment values were printed or saved. The read-only command handles were 32024, 92738, 59623, 81601, 48037, 31284 and 14195, all terminal exit 0; status handle 84371 also exited 0.

Alternative-cause check: adjacent daemon external-dispatch completions align with server relay ends too: local 23:43:27.787 versus 21:43:27.795Z, and local 23:43:46.393 versus 21:43:46.401Z. This supports the clock/transport association rather than a multi-minute clock-offset explanation, while preserving the missing root-to-transport identity caveat. The candidate approval's daemon duration is about 98% of its server forwarding span; ordinary server routing alone does not explain that span.

Neighboring-case check: the only `PluginExec` spawn in the post-ingress window occurs at local 23:46:55.446, with authorization duration 0 ms and spawn duration 26 ms, **before** this Script operation is created. It cannot be substituted for the Script native launch. There are hundreds of requester-Session currentness phase records in the window, but no root binding to this Script. Treating their overlapping totals as the Script cause would be hypothesis lock, not attribution.

Observed evidence loss: controller `~/.happier/stacks/agent-qa-l12-b/logs/server.log` and `.1` had already rotated to after 22:53Z at inspection; neither contains `req-79tg` or `da91192c…`. The brief's historical whole-window server-log availability no longer holds. The saved `requests-scripts-resume.jsonl` preserves the HTTP window and candidate server spans, but its observer retains neither Artifact identity nor the server-to-daemon transport UUID. Existing daemon Script/approval tracing was not enabled for this run. No lifecycle operation was performed to change that.

## Canonical owners, open fix and next boundary

Current source establishes the corridor, not the historical inner durations:

- Server HTTP admission/dispatch: `apps/server/sources/app/api/routes/actions/registerExternalActionRoutes.ts`; relay/currentness: `apps/server/sources/app/api/socket/externalActionDispatcher.ts`. Its forwarding span explicitly wraps guards and `forwardRpc`.
- Receiving RPC admission and completion: `apps/cli/src/api/rpc/RpcHandlerManager.ts`; registered Action ingress: `apps/cli/src/rpc/handlers/externalAction.ts`; requester reconstruction and executor admission: `apps/cli/src/daemon/externalActions/executeExternalAction.ts` and `daemon/sessionEncryption/requesterAccountActionProjection.ts`.
- Generic approval decision/replay: `packages/protocol/src/actions/actionExecutor.ts`; contributed-Action approvals have the distinct existing adapter `apps/cli/src/daemon/externalActions/createDaemonExternalActionContributedInvoker.ts`. The evidence does not establish that the Script used the contributed adapter, so it was not patched as a presumed duplicate.
- Project preparation/choice/revalidation: `apps/cli/src/workspaces/projectSetup/projectFiniteAction.ts`; operation creation/acceptance: `daemon/actionOperations/createHostActionOperationRuntime.ts` and `actionOperationRunner.ts`; final native execution: `workspaces/projectSetup/projectSetupExecution.ts`. The `preparing`/`setup` labels are published by this corridor and do not measure its inner calls.

Inspected current bytes include FX93's shared finite path and its current report; its Protocol worker-choice and startup/runner hunks, ACT-UNIFY's settlement seam, FX88c UI changes and all other concurrent work were left intact. No competing owner or bypass was introduced. Exact inner ownership remains [blocked], so no same-concept consolidation is claimed.

The next authorized stack owner must retain one fresh normal app-approved Script with server **and daemon** tracing enabled, retaining a content-free link among HTTP request, decision root, original Script request, transport UUID and operation. Existing `externalActionPhase.ts`/registered-ingress stages can separate requester preparation from executor work; the Project creation-to-native interval also needs its actual owner spans, not sampled UI progress labels. Then reproduce the dominant inner phase at its canonical owner, prove RED → GREEN through the existing real registered/finite wiring, remove that wiring once to prove sensitivity, run the touched package lane, reload through its lifecycle owner and repeat the original journey. Preserve current native failure separately from latency; no first-output or under-five-second success is established here.

Validation transport: the orchestrator explicitly authorized remote computation/workspace transfer under the user's standing 2026-10-10 grant. Repository searches used `./apps/stack/bin/hstack-exec`, with explicit nl3 or initial AUTO-selected mac2-linux; wrappers flushed continuously moving mirrors. Required ignored review artifacts were read locally because they are absent from the mirror. Live nl1 log inspection used the brief's separate exact-target read-only allowance. No `--local`, local whole-package compilation, Git mutation, source generator, database write, stack lifecycle or browser interaction occurred. Several shell reads initially failed before execution with `bwrap: setting up uid map: Permission denied` and succeeded on retry. Some bounded searches returned exit 2 for mirror-absent review artifacts or guessed directories/globs; corrected retrieval located the actual artifacts and socket owner. No failed retrieval is counted as absence evidence.

Residual risk: the complete requested per-phase attribution and owner-level fix are unavailable without a new correlated capture; existing spans do not establish which work may safely be removed. Tests, typecheck/build, wiring sensitivity, current-source live replay and platform certification were not run, and no improvement is claimed. This lane delivers an evidence-backed partial attribution, not an implemented latency correction.

RELOAD NEEDED: none from FX89b (report only). The stack owner must enable the existing daemon latency trace on the intended loaded daemon and retain fresh correlated evidence; this lane performed no reload.
STATUS: BLOCKED
