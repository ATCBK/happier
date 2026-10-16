# FX86b — original cold-launch custody (Lane 12 Fork B)

Partial implementation; not ready to reload or merge. Session startup and the shared Project owner have focused GREEN evidence, as do Run-controller review projection and the authorized limit removal. Session-hosted Run setup continuation requires an authenticated Account decision seam that the current Session RPC does not provide. Actual Machine Run/resume validation is also blocked by a concurrent foreign import; Machine owner-detachment and process-owner/witness wiring are unfinished. Package checks are not clean.

## Required outcome coverage

| Requirement | Current result |
| --- | --- |
| Shared Project/final-tuple owner for Session and detached/Session-hosted Runs | Source carries admitted requester/bootstrap through existing Run backend parameters and uses `projectAgentNativeLaunch.ts`; daemon-global Saved Secret fallback removed. Original Session paths are tested. Actual Machine and cold-resume composed gates remain blocked. |
| Original Session startup setup lifecycle | Implemented: original operation survives physical spawn acknowledgement until native open; fork/replay preserve that custody. Shared retained review, original worker reservation, This time/Skip/Until changed, changed-effect refusal, cancellation and no late revival are tested. |
| Existing Run controller owns setup | Implemented controller-lifetime `projectSetup`, using the original Run id and shared retained-review helper; Action Operations is a projection, not another Run runner. Owner routing RED→GREEN is recorded below. Machine integration still needs its disposal cleanup and composed gate. |
| Session-hosted Run setup continuation | AMENDMENT_REQUIRED. Generic Session-write admission authenticates the Session, not the approving Account. No body-supplied Account or unverified decision endpoint was added. Sole proposed private-relay producer was withheld; the unused relay/helper/schema/test-only path was removed. Existing typed no-effect setup refusal remains; zero-step/already-completed final native preparation remains. |
| Workflow Session/Run original lifecycle | Original Session creator/native-open custody and Workflow observation changes implemented. Run setup observations keep the existing step/Run correspondence; recovery does not create a replacement prepare Action. Final Workflow validation is recorded below. |
| Actual startup-constructor wiring test | Implemented in `startDaemonSessionControlRuntime.projectLaunch.composed.test.ts`, using the actual registration constructor. Removing `prepareAgentNativeLaunch` registration produced `plugin_exec_native_launch_unavailable`; restoring it passed the adjacent composed batch. |
| Remove FX86-invented private resolved transport limits | Implemented and verified. Only resolved command/cwd/args string/count bounds introduced by FX86 were removed. Existing generic Exec and other limits remain. |
| SDK generation refusal attribution | The named closure defects are outside FX86 native launch. Exact basis and remaining check are below. |

## Canonical owners and surviving deliverables

- Project preparation/final launch: `apps/cli/src/workspaces/projectSetup/projectAgentNativeLaunch.ts`, reached through `daemon/agentRuntime/runnerAgentProjectLaunch.ts`. Passive association/current-effect checks precede effects. Known passive reassignment failures release the reservation; only explicit native uncertainty retains it.
- Retained review: `daemon/actionOperations/actionOperationSetupReview.ts` extracts FX83's existing continuation; `actionOperationRunner.ts` and the Run controller consume it. No replacement `projects.prepare` execution or second continuation runner was introduced. The existing held-operation decision route only resumes the original producer.
- Session lifecycle: `session/actions/lifecycle/sessionStartupProjectOperation.ts`, spawn/fork entry points, lifecycle Action/RPC context forwarding, tracked-session preparation and native-open attestation. Temporary respawn state does not retain original operation callbacks.
- Run custody: existing backend/registry parameter seams carry `projectLaunchContext`; `executionRunProjectSetup.ts` projects controller-owned facts. `createHostActionOperationRuntime.ts` composes incumbent domain projections and routes get/refresh/decision/wait to their exact owner.
- Workflow lifecycle: `daemon/workflows/workflowSessionStartup.ts`, Session/Run step executors, coordinator observation/recovery and the existing production startup injection in `daemon/startDaemon.ts`. Startup preserves its exact existing creation recipe, rather than widening the public Session-spawn schema.
- Tests: actual startup constructor and authored native Agent fixture; actual Machine registrar/Run tests; original Project setup decisions; real Run review adapter; Workflow original-operation startup, cancellation and recovery; transport boundary regressions.
- Documentation: existing canonical `docs/cli-architecture.md` and `docs/runtime-core.md` describe development-source custody and the explicit Session-hosted decision limitation. No rendered UI, styles or new approval component changed; existing setup review presentation is reused.

## Observed validation

All commands used `./apps/stack/bin/hstack-exec`, AUTO or authorized named remote targets; no `--local` and no controller-local whole-package compiler invocation. Remote computation/workspace transfer used the brief's standing 2026-10-10 authorization.

| Evidence | Terminal result |
| --- | --- |
| Project setup owner RED75498 | Five intended missing-setup failures before implementation. |
| Passive reassignment RED77436 | Original slot remained held after known no-effect reassignment failure; corrected at Project owner. |
| Project owner final GREEN16402, windows1-linux | 14 passed, 3 intentionally filtered Run tests skipped. Covers zero-step/completed/trusted setup, all local review choices, changed/reassigned Project, cancellation, unavailable native and absent requester. |
| Concurrent native preparation RED48539 → GREEN64236, windows1-linux | Two qualified calls under one original operation stranded a caller after setup. Invocation-local preparation serialization fixes the lazy-owner/review/reservation race; 15 selected tests passed, 8 skipped. Each caller retains its own final tuple; no new operation id, budget or execution owner was added. |
| Final Project owner GREEN17644, windows1-linux | 16 passed, 8 explicitly filtered tests skipped; adds cancellation of both concurrent qualified callers without setup effects or a retained slot. Supersedes the earlier owner GREEN counts for current lane-owned source. |
| Session lifecycle RED70749 / RED81892 → GREEN94445 | Early physical acknowledgement and lost fork custody reproduced; five files, 52 tests passed. |
| Actual startup registration RED33888 → GREEN93621 | Registration omission failed as intended; three files, 22 passed after restoration. Extracted fixture also passed48680. |
| Shared Action-operation review GREEN15264, nl3 | 27/27 passed after removing an extra async wrapper introduced by extraction; the intermediate22329 failure is not counted as GREEN. |
| Real Run-domain adapter RED55544 → GREEN54475, nl3 | Stale digest and single-owner attachment failures reproduced; three files, 26/26 passed. |
| Transport RED15677 → final GREEN45489, nl3 | Four beyond-invented-bound cases failed before removal. Final protocol/private-runner/native-host batch passed 71/71 after unused relay removal. Intermediate72-test evidence is superseded. |
| Protocol cold setup-review schema RED43424 → GREEN30532 | Strict schema initially refused original cold operation review; six tests passed after canonical refinement. |
| Workflow Session original startup RED95686 → GREEN26359 | Original creator bypass reproduced; strengthened real original-operation/native-open/cancel tests passed6 selected. |
| Workflow cancellation RED13254 → full GREEN88317 | Already-aborted cancellation/interruption incorrectly admitted startup; owner entry guard corrected it. Five Workflow files passed202/202, including Session/Run executors, observation, Project setup coordinator and recovery. |
| Final Workflow composed GREEN67965, windows1-linux | Six files,275/275 passed, including the full existing composed harness. The real coordinator/durable-storage journey retains one original setup operation, commits needs_attention on the same row, admits no input before review/native open, then succeeds on that row with one native-process-boundary launch. Interruption/rejoin helper GREEN51684 also passed5 selected. |
| Protocol public typecheck2210, AUTO remote | Terminal exit0; `yarn workspace @happier-dev/protocol typecheck` completed successfully. |

Representative final commands:

```sh
./apps/stack/bin/hstack-exec --target=windows1-linux -- env NODE_OPTIONS=--conditions=happier-source yarn --cwd apps/cli vitest run src/daemon/agentRuntime/runnerAgentProjectLaunch.composed.test.ts -t 'fresh zero-step|original cold setup|trusted cold setup|completed setup|refuses|rechecks|serializes concurrent qualified' --maxWorkers=1 --reporter=dot
./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn vitest run src/daemon/actionOperations/createHostActionOperationRuntime.runSetup.test.ts src/daemon/actionOperations/createHostActionOperationRuntime.test.ts src/daemon/actionOperations/actionOperationRpcHandlers.test.ts --maxWorkers=1
./apps/stack/bin/hstack-exec -- env NODE_OPTIONS=--conditions=happier-source yarn --cwd apps/cli vitest run --config vitest.config.ts src/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol.test.ts src/daemon/agentRuntime/runnerDaemonPluginServicesHost.nativeLaunch.test.ts src/agent/runtime/session/process/runnerDaemonPluginServices.test.ts --maxWorkers=1
./apps/stack/bin/hstack-exec --target=windows1-linux --cwd=apps/cli -- yarn vitest run src/daemon/workflows/sessionStepExecutor.test.ts src/daemon/workflows/executionRunStepExecutor.test.ts src/daemon/workflows/invocationRecoveryObserver.test.ts src/daemon/workflows/coordinator.projectSetup.test.ts src/daemon/workflows/recovery.test.ts src/daemon/workflows/composedWorkflowHarness.test.ts --maxWorkers=1 --reporter=dot
```

## Failed, skipped and pending gates

- Actual Machine Run tests and ensure/send cold-resume tests failed before collection on the foreign `createPublicAcpSession.ts` import of `@happier-dev/protocol/plugins/contributionIdentity`; the published canonical export is `plugins/contribution-identity`. Automatic review rejected the exact one-line correction because the brief prohibits editing other lanes' hunks. The import was left untouched, and exact authorization was requested. No alias/mock workaround was added. Resume production changes were withheld without valid RED.
- New Machine Run owner attachment currently discards its detach callback in `registerExecutionRunRpcHandlers.ts`; the existing Machine registration disposal must retain/release it. The actual constructor/lifecycle RED is part of the blocked Machine gate, not complete evidence. The direct invocation-services seed also still drops existing process-owner/witness inputs; its actual OS-owner regression is authored but collection-blocked. These are not claimed complete.
- CLI public typecheck41721 exited2 in dependency UI compilation: missing plugin Action-admission export/API, Session owner metadata projection typing and new npm/account-admin translation keys. It did not establish a clean CLI type boundary.
- SDK public typecheck18146 exited1; observed failures include unrelated setting-title descriptor shape and a userText test event missing required fields. No current SDK typecheck success is claimed.
- CLI public build63252 was last observed waiting on dependency package-dist admission; no terminal success is claimed. Protocol public typecheck2210 completed successfully. Keep the original build handle rather than starting another build. Redundant observer-only41486 was also last observed queued; its entire scope is now covered by successful67965.
- Adjacent Run batch67604 had64/65 passing; one native Agent diagnostic test expected an echoed event that was absent after terminal send. It is unattributed, not silently corrected or counted green.
- Several early composed attempts collected no tests because concurrent Protocol mini-schema migration left classic fluent calls. Mechanical combinator repairs were confined to the reached import corridor (diagnostics/types, generationStore, spawnSessionOptionsContract, daemon-service/snapshot/plugin-service protocols, service-turn witness and Session-started/registry schemas). Existing source schemas were preserved. The missing hook-catalog package export was also restored as a mechanical dependency closure. Later failures and the foreign ACP blocker remain visible above.
- Moving-work observation: five additional Session-hosted Run decision tests and a Run-id fixture extension appeared concurrently in `runnerAgentProjectLaunch.composed.test.ts`. They were preserved, not authored or certified by this lane, and were among GREEN64236's eight skipped tests. Their presence is not proof that actual Session authority/wiring is resolved.
- No stack lifecycle command, database mutation, commit/staging, branch operation or live runtime reload ran. Browser/device/live native qualification was not performed under the brief's no-lifecycle boundary. Required later composed recipe: reload the changed daemon/runner source, launch a cold associated Session with setup review, continue it once, then launch a detached Workflow Run/Session step and prove the same operation/Run id through review, native input acceptance and terminal state. Session-hosted Run continuation first needs the Account-authority amendment.

## SDK attribution and compatibility basis

Observed source basis: HEAD `e57584db2ef0883d8709018fc39766b2d5dc51a2`. That tree has neither the new npm-registry/account-administration Protocol families nor their four current untracked generated DTO files. Foreign Action-spec changes consume those families and the generated maps; their initial author export closure omitted the maps. Moving source has since added both export pairs. `ActionConfirmationWhen` was a foreign private alias and is now exported by its author owner. `ContributionRow` is unchanged/private in that immutable HEAD and is not caused by native launch. No foreign author-export repair or generated SDK edit was made by FX86b. Read-only closure harness23868 remains pending before payload admission; this is attribution evidence, not a current generator PASS.

Predecessor inspection was read-only: `../0.2` HEAD `f18aba940c5c56e5b24454e176c836c171098a2d`; scoped status/diff for the operation/private-runner/SDK-Agent paths was empty. The current operation schema path and corresponding export are absent there. New controller review is in-memory, and the private relay was removed; no new persisted credential format or mixed-version shim was introduced. The SDK native qualifier port is additive and optional, consumed by existing native Agent adapters.

Authorization applied verbatim: “The Lane 12 Fork B orchestrator authorizes removing the resolved private-transport command/cwd/args size limits that lane FX86 itself introduced in this change: they are new, not derived from any owning transport/resource boundary, and AGENTS.md forbids invented limits. Pre-existing limits are not touched.”

## Adversarial review and residual risk

The compact self-attack tested neighboring cancellation, stale effect, reassignment, missing requester and completed setup. It exposed and corrected a known-no-effect slot leak and extraction timing regression. The unused IPC producer/helper/schema/observer was removed because it had no authorized reachable decision consumer. Independent review then led to a real surviving concurrency reproduction: qualified callers shared an original operation and could overwrite its reservation/review. RED48539→GREEN64236 fixes that at the invocation preparation owner. No competing preparation owner or replacement Action survives.

The review's post-hold witness-revalidation candidate was withdrawn as a mandatory finding: source checks authority at admission, but no supported contract was established requiring already-admitted native startup to revoke on a later turn witness. Original startup is before an active turn. No speculative freshness mechanism was added.

The Workflow neighboring-case attack also reproduced startup admission after an already-aborted claim/cancellation signal. The original helper now checks that signal before admission; a retained original operation is not cancelled merely because its observing claim was interrupted.

Residual risk: this is a blocked partial source change, not a release or loaded-runtime certification. Do not reload/ship until Machine attachment disposal/process ownership, blocked actual Run/resume/Workflow composed gates and package checks close. Session-hosted Run setup requires an approved verified-Account admission amendment, not a body field or daemon-global fallback. Native macOS/Windows tool qualification remains outside the demonstrated Linux-native contract.

RELOAD NEEDED: daemon/startDaemon.ts; daemon/startup/startDaemonSessionControlRuntime.ts; api/machine/rpcHandlers.ts; rpc/handlers/executionRuns/**; agent/runtime/registry/**; agent/runtime/bridges/executionRun/**; session/actions/**; daemon/actionOperations/**; daemon/workflows/**; workspaces/projectSetup/**; affected Agent plugin native adapters and SDK source. Reload only after the blocked gates above are resolved.

STATUS: BLOCKED
