# FX86c — Session-hosted Run setup custody and Machine integration

Implementation is in progress. The retained Session-hosted setup producer and the Machine decision/disposal corrections are present; final composed validation is pending. No loaded-runtime, package-gate, visual, or release verdict is claimed.

## Deliverables and canonical owners

- `agent/runtime/bridges/executionRun/executionRunProjectSetup.ts` shares the existing retained review/context and exact Account/workspace/phase decision routing between real Run-controller projections and pending native-startup projections. The original Run map and terminal state remain controller-owned; no fake Run, second Run registry, preparation Action, or continuation runner was introduced.
- `daemon/agentRuntime/runnerAgentProjectLaunch.ts` binds a Session-hosted Run's existing native invocation to that shared projection. Its id is the existing host-authored `invocationId`/Run id, and scope comes from the resolved requester runtime. The existing native-launch request remains pending under its original reservation. Account `projects.prepare` with `heldOperationId` resumes that same producer. Invocation closure aborts review and withdraws its projection; native authorization is not projected as Run success. Original Run Stop remains the cancellation owner.
- `daemon/startup/startDaemonSessionControlRuntime.ts` supplies that existing invocation id only for the retained Run-snapshot branch. There is no new endpoint, relay, wire field, body-supplied Account, credential fallback, persistent state, deadline or limit.
- `api/apiMachine.ts` and `api/machine/rpcHandlers.ts` preserve the existing host runtime's composite `decideSetupReview` and `attachOwner` ports into the installed Project runtime. The previous port construction silently discarded the composite decision function.
- `rpc/handlers/executionRuns/registerExecutionRunRpcHandlers.ts` returns the attachment cleanup, and Machine disposal releases it in `finally`, including when another cleanup rejects. The existing manager still owns Run disposal.
- Existing native-launch and startup-constructor composed harnesses cover retained choices and strict producer/consumer schemas. The installed Project fixture's optional Account-Action setup uses canonical persisted/read credentials and a test-scoped matching Home. Account decisions do not use Session-write identity.
- `docs/runtime-core.md` and `docs/cli-architecture.md` replace the obsolete Session-hosted limitation with the current development-source route. Published documentation is unchanged because this is unreleased 0.3 behavior.

## Evidence observed so far

All validation uses `./apps/stack/bin/hstack-exec`, AUTO or the brief's authorized named targets. Remote computation/workspace transfer is authorized by the Lane 12 Fork B orchestrator under the standing 2026-10-10 grant. Ordinary wrapper synchronization uses a continuously moving source mirror, not a frozen release representation.

- Session setup RED25582, windows1-linux, exit 1: five owner cases failed because native launch immediately returned `project_setup_consent_required` instead of retaining the original Run review. The constructor file in that batch had a duplicate test variable; that portion is not wiring RED evidence.
- Session owner GREEN58065: all five retained choices/changed/cancel cases and two existing real Run-owner routing cases passed. The constructor's Account fixture still failed and is not counted green.
- Machine decision RED52625 → GREEN69238, exit 0: actual installed ApiMachine/Project runtime initially lacked `decideSetupReview`; the real composite owner executes after forwarding is repaired.
- Machine disposal RED69622: actual Machine disposal left its original owner attached, proven by the incumbent `attachOwner` rejecting reattachment. GREEN96731 passed three focused constructor/decision/transport cases; GREEN41681 passed normal and failing-cleanup lifetime cases.
- The original Machine native attempt76659 timed out before settlement. Diagnostic42327 established `execution_run_protocol_unsupported` before any native effect: the authored fixture omitted the public SDK's detached Run facet. Its manifest/factory fixture is being corrected, without relaxing production admission.
- Current final source/startup batch40049 and Machine native/resume batch57861 are pending; their terminal results must replace this paragraph before handoff.

FX86d follow-up, 2026-10-16 (historical observations above retained): handles 40049 and 57861 both returned `Unknown process id` when resumed; no original terminal result is inferred. Their scopes were rerun through hstack-exec on the moving mirror. Final replacement source union 81670 terminated exit 1 with 280 passed / 1 foreign Mini-literal fixture failure in 12 files (`/tmp/fx86d-source-final.log`). Final actual startup plus Machine native/resume batch 28062 terminated exit 0 with 6/6 in 2 files (`/tmp/fx86d-account-custody-final.log`): startup binding, retained choices/changed/cancel/reservation observations, native Machine Run, original-identity cold ensure/send, separately admitted Account setup decision, continued native input and disposal. The inherited missing detached SDK facet is present and exercised without relaxing admission. Additional current-source/native/Workflow/UI/Protocol counts, fixture corrections, the foreign-owner handoff and deferred package/live gates are recorded in `impl-B/FX86d.md`. These terminal replacement results supersede the pending state above, not its history.

## Failed fixture and environment attempts

- Early Session RED attempts84785/57654 used `includeSetupReview` without its required wait owner; those schema failures are not product RED. The test now requests the existing fresh-review read. The initial parameterized constructor fixture also reused a shut-down global plugin controller; its related choices now share one genuine admitted lifetime.
- Synthetic credentials without token provenance were correctly refused by canonical persistence. The Account fixture now uses supported terminal provenance and consumes credentials returned by the canonical reader; `sameStoredCredentials` includes reader-owned credential provenance. A Home mismatch was corrected in the test fixture, not bypassed in production.
- Source helper decision fixtures initially claimed a foreign Machine admission without the required authenticated Account carrier and were correctly refused. The owner-Account decision cases now use separately admitted Account identity. No Session RPC or payload field supplies human authority.
- The previous foreign ACP import did not prevent current test collection. A transient foreign `sessionRegistry.ts` mini-schema fluent-call failure also cleared through its owning work; FX86c did not edit it.

## Remaining validation and handoff

The final gate must include the actual daemon constructor's wiring omission, the complete touched native-launch/Run-owner source corridor, and actual Machine start plus cold ensure/send resume with original Run identity. Final package typecheck/build remain Main's D50 integrated gate; none is claimed from focused tests.

Visual: not seen — Session-hosted Run setup review in the existing Action Operations presentation. Existing shared This time / Until it changes / Skip controls are reused; no component, style, layout, copy or translation changed. The design lane owns the loaded light/dark/phone check after reload.

Loaded recipe for the orchestrator: reload daemon and runner together; start an associated Session-hosted Run needing setup at capacity one; decide through Account `projects.prepare`, observe the same Run/id/reservation reaching native input and terminal state; repeat Skip, remembered approval, changed effect and Run Stop during review. Then exercise Machine cold ensure/send resume. No stack lifecycle action is authorized to this lane.

Residual risk is pending final composed evidence, the Main package gate, loaded runtime/visual validation, and native macOS/Windows qualification. No Git mutation, secret access, migration, stack reload or new ad-hoc report was performed.

RELOAD NEEDED: api/apiMachine.ts; api/machine/rpcHandlers.ts; rpc/handlers/executionRuns/registerExecutionRunRpcHandlers.ts; daemon/startup/startDaemonSessionControlRuntime.ts; daemon/agentRuntime/runnerAgentProjectLaunch.ts; agent/runtime/bridges/executionRun/executionRunProjectSetup.ts; workspaces/projectSetup/projectFiniteAction.ts. Reload daemon and Session runner together.
