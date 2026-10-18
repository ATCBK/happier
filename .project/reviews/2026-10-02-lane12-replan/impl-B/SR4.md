| ID | Severity | Finding / decision | Disposition |
| --- | --- | --- | --- |
| SR4-2 | medium | The concurrent publisher restriction breaks cold CLI Service placement observation: valid running custody becomes unavailable. | CONFIRMED; current regression at the row-publication/observation seam. |
| SR4-1 | medium when reproduced | Session handoff published privately admitted requester rows into the daemon's global projection. | CLOSED by concurrent source changes, independently rerun; historical reproduction retained below. |
| SR3-1 | medium, previously reported | FX114 preserves private authorization at all four named Move/native-child reads. | CLOSED at the inspected source/composed-test boundary. |

Independent Lane 12 Fork B security finding-delta review: **SR3-1 is closed and no remaining requester-publication exposure was confirmed in the inspected current corridor; one medium availability regression prevents a clean no-regression verdict.** The current installed-child selection passes 29 tests, current row-owner/Session-handoff suites pass 37 tests, and the current native Move selection passes six tests. Three existing CLI Service-observation cases fail on current production code; reversing only the newly added publisher predicate in memory makes all three pass. Package and loaded-runtime clearance are not supplied.

## SR4-2 — cold CLI observation requires a global projection that the reader no longer establishes

**Locations:** `apps/cli/src/workspaces/projectAccountRows.ts:137`–`:143`; consumer `apps/cli/src/api/accountServerActionDeps.ts:676`, `:684`–`:691`.

**Observed mechanism:** the new `canPublish` predicate permits an ordinary credential read to publish only when its scope already matches `active`, unless the caller explicitly supplies `publication: 'installed'`. On a fresh CLI process, `active` starts null at `projectAccountRows.ts:55`. Service placement observation calls the real reader without that publication option. It receives valid private rows, but its currentness callback still requires a non-null global snapshot with matching scope and topology. The canonical observer consumes that callback at `packages/protocol/src/workspaces/projectServicePlacementV1.ts:114`; valid custody therefore becomes unavailable before it can be positively observed.

**Concrete misuse/failure scenario:** a user starts a normal CLI/MCP process and reads `projects.service.placement.get` for an already-running declared Service. Account rows, Machine inventory and native binding can all be valid, yet the first observation reports unavailable because no installed daemon projection exists in that process. The same failure affects ordinary endpoints and logical child SOURCE/worker mappings. This is an availability/correctness regression in the security fix's reached consumer, **not an authorization bypass**. It entered through the concurrently observed publisher restriction, not FX114's four authorization arguments.

**Independent reproduction:** handle `72008`, nl3, current production source, exit 1: `src/api/accountServerActionDeps.test.ts -t 'service|Service'` produced **three failed / one passed / 74 filtered**. All three `reads actual declared service custody through physical endpoints and logical namespaces` cases failed their first healthy observation at test line 624: expected `actual.status: 'present'`, received `'unavailable'`. The fixture exercises the real Account Action entry point, row reader, topology and strict native-binding observer; only Home HTTP and remote Machine RPC boundaries are substituted.

**Causal falsifier:** handle `57016`, nl3, exit 0: the same three cases passed when one Vite pre-transform changed only:

```ts
// Current predicate:
return !input.authorization && !input.sessionCustody
  && (input.publication === 'installed' || active?.scopeKey === scopeKey(input));
// Diagnostic in-memory reversal:
return !input.authorization && !input.sessionCustody;
```

The transform reported exactly one application; three passed, 75 filtered. No source file or test fixture was edited. This distinguishes the publication-contract regression from unavailable network fixtures, native identity mismatch or a changed Service declaration. The reversal is diagnostic evidence, **not a recommended security fix**.

**Minimal coherent fix at the owners:** reconcile the Account observation consumer with the row owner's private-read/publication contract. A fresh standalone read must be able to observe its own valid captured topology without depending on an unestablished daemon-global projection, while retaining the existing credential-lifetime and meaningful topology-withdrawal checks. Keep private requester reads private; do not grant a consumer general installed-publication authority merely to satisfy this currentness predicate. Preserve the existing healthy/reprojected/withdrawn topology tests and rerun the three cases above. No new cache, polling loop, retry or second availability owner is justified.

## SR3-1 closed: four-path proof and FX112 behavior

Read SR4-BRIEF.md, SR3.md, FX114.md and the relevant FX112 report completely. Reports supplied hypotheses; the conclusions here were re-derived from source and independent executions. This reviewer did not author FX112, FX114 or the concurrent corrections.

| Brief requirement | Current evidence / disposition |
| --- | --- |
| Worker status keeps private requester custody | `projectWorkerAction.ts:61`–`:68` retains currentness, requester credentials and `context.externalActionExecutionAuthorization`; final currentness remains at `:107`. PASS. |
| Native Start/Snapshot topology reads remain private | `externalActionExecutionAuthorization.ts:82`–`:104` checks the reviewed child, forwards `input.authorization` at `:89`, binds Snapshot to the incumbent root and Start to the resolved destination id/root, then rechecks requester currentness. PASS by current-source inspection; these two branches were not separately instrumented. |
| Relocation destination and remote incumbent reads remain private | `projectServiceRelocationRoute.ts:49`–`:57` and `:87`–`:91` both forward the existing authorization. PASS. |
| All four consume the canonical private row reader | `workspaceSyncPreparation.ts:39`–`:41` selects authorization plus its root effect id. Current `projectAccountRows.ts:137`–`:143`, `:295`, `:305`–`:307` exclude authorization/session-custody reads from publication, prompt migration and global withdrawal. PASS. |
| Reviewed SOURCE-bound child still accepted at nl3 | Current installed-child plain/protected cases reach real RPC admission, private opener, credentialed factory and worker status with finite execution disabled. Eligible output, zero publications, retained global snapshot/scope and real Sync relationship discovery pass. Missing-packet/changed-input refusals pass. |
| Requester Account material still owns topology | The protected fixture encrypts rows with requester material while installed credentials stay keyless (`filesystemApprovals.testkit.ts:789`–`:818`). The current reader uses the admitted Account mode/cipher (`projectAccountRows.ts:156`–`:172`); child Machine reads select `ApiClient.getRequesterMachine` for authorization (`workspaceSyncTargetAuthority.ts:307`–`:312`). PASS. |
| Retirement cannot leave a publication behind | Both plain/protected installed cases retire requester custody through the real loopback currentness channel while the row response is awaited. They return unavailable with zero publications and unchanged scope/relationships (`filesystemApprovals.test.ts:68`–`:100`). PASS. |
| Destination admission precedes old Stop | `projectServiceRelocation.ts:80`–`:90` checks admission before placement/Stop; incumbent reread remains at `:101`–`:123`, later checks at `:133`, `:146`. Current native unavailable case leaves the old Service running with no copy/progress; its available neighbor reaches moved output, one clean copy and a running destination binding (`projectDeclarations.test.ts:1746`–`:1759`). PASS. |

**Independent pre-FX114 sensitivity:** before the concurrent publisher restriction appeared, handle `67757` on windows1-linux removed exactly `authorization: context.externalActionExecutionAuthorization,` from the worker snapshot call using a Vite pre-transform. The other three FX114 corrections remained present. All four existing `SOURCE-bound Service Move` cases failed specifically at their zero-publication assertion, receiving 1. Successful cases had already passed eligibility/output-contract checks; retired cases had already passed unavailable/output-contract checks. Exactly one production-module transform was applied. This reproduces the original worker defect without altering on-disk source. It is a historical deciding result, not a claim that this one-argument reversal still defeats the later publisher guard or reconstructs every pre-FX114 file.

## Broader sweep and the corrected SR4-1

Routed production-source inventories covered `readProjectAccountRows`, `readWorkspaceSyncWorkerTargetSnapshot`, `refreshProjectRows`, imports/aliases and `readRequesterAccountActionContext` under `apps/cli/src`, excluding test/spec modules. Following `refreshProjectSnapshot = ... ?? readProjectAccountRows` found a real additional custody drop in Session handoff.

**Initially observed and reproduced:** `createTrackedSessionHandoffCoordinator.ts` selected `requesterSessionBootstrap.credentials` and passed them to the default row reader without `sessionCustody` for relationship/linked-workspace membership. Production construction at `api/apiMachine.ts:1628`–`:1647` retained that default; `api/machine/sessionHandoff/handlers.ts:560`–`:577` propagated the accepted context. Handle `2355`, nl3, extended only the existing cold-requester test in Vite memory: added plain-mode/empty-row HTTP responses, seeded the installed snapshot with a distinct synthetic credential, added linked-workspace input, and asserted isolation after the expected `workspace_ref_not_ready` refusal. The real Session custody opener, coordinator and row reader produced:

```text
SR4 handoff isolation { publications: 1, replaced: true, scopeChanged: true }
private Session handoff must preserve daemon projection: expected 1 to be +0
Tests 1 failed | 13 skipped (14)
SR4 test-only handoff probe applications=1
```

The production Sync subscriber consumes that global publication (`createDaemonWorkspaceSyncRuntime.ts:300`–`:313`, `:330`), and storage discovery rejects a foreign scope (`startDaemon.ts:2803`–`:2806`, at the initial observation). Those availability consequences were derived; no live storage request, arbitrary execution, external cross-Account disclosure or data loss was demonstrated.

**Final reconciliation:** while this review was running, another lane changed the coordinator and publisher. Current `createTrackedSessionHandoffCoordinator.ts:319`–`:325` now supplies Session custody with exact Account/Home/currentness, otherwise the admitted authorization, and only then the ordinary installed branch. Its dependency now uses `typeof readProjectAccountRows` (`:82`). The current full coordinator/row-owner run passes 37 tests, including the expanded cold continuation, linked-workspace, relationship and retirement cases. Those cases retain global snapshot/scope and real Sync relationship discovery, and verify that an ordinary installed refresh still changes subscriber discovery. **SR4-1 is closed on this current basis.** Its earlier reproduction remains evidence of the issue found, not an outstanding finding against corrected bytes.

Other inspected sweep dispositions: installed finite preparation already forwards requester authorization (`createInstalledProjectFiniteRuntime.ts:120`–`:124`); private SOURCE Sync supplies Session custody (`createProductionDaemonWorkspaceSyncRuntime.ts:886`–`:889`); generic Action/Open/terminal readers use `projectRowsAuthority`, `requester.rows` or `projectRuntimeAccountRowsInput`; native Session usage supplies `sessionCustody` (`createSessionClientUsageObservationPublisher.ts:60`–`:69`). Ordinary startup/refresh, local-service inventory, background workflows and worker-copy retirement use installed credentials. Account placement refuses external observation before its raw read (`accountServerActionDeps.ts:670`–`:676`). CLI relocation-source lookup belongs to original CLI/API-token dispatch; original CLI forwarding excludes existing external authorization (`createCliActionExecutorFromCredentials.ts:1181`–`:1184`). Session execution-run review reads its owning Session's credential port (`registerSessionClientRuntimeHandlers.ts:990`).

The current `publication: 'installed'` sweep found literals only at daemon startup, installed Account refresh, Sync's non-authorized installed branch and the handoff coordinator's non-requester/non-authorized branch. The four FX114 requester reads retain authorization and do not use that marker. No other requester raw-credential publisher was confirmed in this inspected current sweep. This is not an exhaustive security verdict for every listed feature.

## Independent executions and observed basis

All searches and validation used `./apps/stack/bin/hstack-exec` AUTO or authorized explicit targets and its synchronization barrier. Worker cwd was `/home/happier/happier-dev`; all targets used Linux, including names containing “windows”. Mirrors remained moving. Source/Git inspection and report creation stayed local.

Initial HEAD: `816ea5acbf3dc6f1995a8223786f1dd0d66085eb`. Final observed HEAD: `148be74e728cdc0c58c323fcfc9aecb0efc26ef1`, with shared dirty source/test changes. Initial handoff coordinator bytes had no scoped diff; final coordinator/publisher corrections are concurrent uncommitted work. The final check reopened all four authorization calls, the coordinator custody branch, publisher predicate and CLI observation callback. This report attributes no whole-file diff to a particular author.

Ordinary test command convention, after wrapper/target: `env NODE_OPTIONS=--conditions=happier-source yarn --cwd apps/cli vitest run --config vitest.config.ts <selection> --maxWorkers=1 --reporter=dot`. In-memory probes used the installed `vitest/node` `startVitest` API with the same config/root, run=true, maxWorkers=1 and the stated filter, plus one pre-transform.

| Handle / target | Selection / evidence | Terminal result |
| --- | --- | --- |
| 52439 / nl3, final source | Filesystem approvals file; filter below | Exit 0; 29 passed, 105 filtered; 73.29s. |
| 24070 / windows1-linux, final source | `src/workspaces/projectAccountRows.test.ts src/daemon/actionOperations/createTrackedSessionHandoffCoordinator.test.ts` | Exit 0; 37 passed / two files; 31.10s runner time after admission. |
| 18303 / nl3, final source | `src/daemon/local/services/launch/projectDeclarations.test.ts -t 'Move|moves a portable native Service'` | Exit 0; six passed, 75 filtered; 59.93s. |
| 72008 / nl3, final source | `src/api/accountServerActionDeps.test.ts -t 'service|Service'` | Exit 1; three genuine healthy-observation failures, one passed, 74 filtered; 38.48s. |
| 57016 / nl3, diagnostic memory-only reversal | Same Account adapter file; filter `reads actual declared service custody`; only publisher predicate reversed | Exit 0; three passed, 75 filtered; 45.71s; exactly one transform. |
| 67757 / windows1-linux, before concurrent publisher correction | Filesystem approvals file; filter `SOURCE-bound Service Move`; worker authorization argument removed in memory | Exit 1; four intended isolation failures, 129 filtered; 35.98s; exactly one transform. |
| 2355 / nl3, before concurrent handoff correction | Cold-requester handoff test with test-only isolation probe described above | Exit 1; one intended isolation failure, 13 filtered; 44.30s. |
| 30369 / nl3, initial FX114 source | Filesystem approvals file; same normal selection as final run | Exit 0; 29 passed, 104 filtered; 77.76s. Superseded for final-source claims by 52439. |
| 32337 / nl3, initial FX114 source | Same six-case native selection | Exit 0; six passed, 75 filtered; 58.52s. Superseded by 18303. |
| 82261 / AUTO → windows2-linux | Optional rows/worker/coordinator adjacent selection | Cancelled while queued; exit 130, no test-runner result. No clearance claimed. |

Filesystem approvals selection:
```text
src/daemon/externalActions/executeExternalAction.filesystemApprovals.test.ts
-t 'SOURCE-bound Service Move|reviewed child of a V2 Move|protected Service Move|reviewed Service Move|refuses portable worker execution|does not lend the installed Account relationship|signed plain worker Script|executes signed portable worker|preparation HTTP'
```

The cancelled optional run's exact controller process group was verified to contain only its wrapper and SSH child, interrupted, and confirmed gone; all review-owned handles are terminal. No product process was stopped. The later source changes justified the fresh final-source runs; no unchanged check was repeated merely for another review round. The wrapper recovered a transient synchronization scan problem before the final native run and completed its fresh flush. Existing connected-services/root-overlap fixture warnings remain unattributed; no clean-console claim is made. An initial broad inventory included tests and was truncated; corrected production-only symbol/import/alias inventories supplied the sweep evidence.

## Adversarial closeout, remaining gates and residual risk

The alternative of harmless snapshot churn was tested with distinct scopes and retained real Sync relationship discovery. Successful/refused/retired and plain/protected neighbors were exercised. The alias sweep falsified the initial family-complete assumption, and final reconciliation prevented reporting a concurrently fixed issue as open. The publisher's downstream consumer was then tested, exposing SR4-2; the one-predicate reversal independently isolated its cause. No new publication owner, cache, replay ledger or reliability machinery is recommended. Separate Session SOURCE relay and root-settlement replay semantics were not changed or recertified.

No package compiler/build, new real-Home SQLite integration, corrected loaded SOURCE/worker journey, native Windows/macOS, browser/device or release certification was run. FX114 reports failed public CLI compilation and a server integration batch timeout with a later exact-case pass; those reports are not adopted as fresh package/integration clearance. The integration owner must reconcile current compiler evidence and load/identify corrected daemons before claiming a successful live Move with preserved global projection and storage availability.

Residual risk: composed regressions replace external Home/OS boundaries, and the initial Session finding was reproduced with real admitted custody at the coordinator rather than through a new real Home ingress. The concurrent publisher change affects more consumers than this bounded corridor review certifies. Repair SR4-2 at the publication/observation seam, preserve the proven private-custody corrections, rerun the three cold CLI observation cases and the existing topology-withdrawal neighbors, then complete the separately owned package/live gates. No source, configuration, on-disk test, Git index, database or product-runtime lifecycle was changed by this reviewer; only this requested report was written.
STATUS: DONE
