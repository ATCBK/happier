# FX94b — preserve the Sync carrier refusal through native .11

Implemented and behavior-verified: `machine_carrier_unavailable` and its original reason survive the broker, installed native `.11`, registered relationship-create RPC, and public create Action. **Integration remains blocked:** the public CLI typecheck fails in current UI dependencies before proving the CLI partitions clean. The new post-addon live refusal remains unknown: the inspected controller log retains only the outer `engine_unavailable`, not its broker/carrier reason. Loaded QA replay requires the authorized owner's reload; this lane performed no stack or worker lifecycle action.

## Post-addon live evidence — updated after the orchestrator's 04:36 follow-up

Read the requested LV14 rows W/2 and all four `qa-shots/LV14/{copyW-addon-result,copyS-addon-result,worker-carrier-after-addon,worker-bootstrap-after-addon}.json` artifacts. Observed: worker daemon `3910409`, owner `3910346`, started `2026-10-17T02:03:02.487Z`, has the lifecycle addon mapped, zero `native_unavailable` lines, and selected/loaded graph `fefe751188d46b9a`. The original qaW request `1aedfa8a-3395-4246-a93b-6e2e28a62e79` still returns `engine_unavailable` at `02:07:05.102Z`; original qaS request `a8a8e267-7c61-45a3-a53f-4597b8411174` does so at `02:08:05.550Z`. Worker bootstrap prepares return `ok` at worker-local `19:06:59.534` and `19:07:58.946` (UTC−7). Thus the old missing-addon observation does not establish the post-addon failed predicate.

Read-only controller inspection used the newly authorized canonical `dev-targets status nl1` (ready, exit 0) and `dev-targets exec nl1`; handles 44129, 9501, 47115 and 99295 all exited 0. Controller log `/home/happier/.happier/dev-targets/nl1/stack-state/agent-qa-l12-b/cli/logs/2026-10-17-02-44-38-pid-2972824-daemon.log` contains the time-corresponding create completions:

| Log line | Controller time (UTC+2) | RPC request ID | Exact recorded result |
| --- | --- | --- | --- |
| 51506 | 04:07:05.010 | `f8d4db27138cedf3917a692d6101f508` | `daemon.workspaceSync.relationship.create.v1`, `engine_unavailable` |
| 52518 | 04:08:05.526 | `f2b35a909bda12dac4323de53def4c56` | Same method and code |

These are transport RPC IDs, not the original Action request IDs; correspondence here is by method and time. Both completion records say `failedPhase: handler`, with no error message or original refusal field. The bounded scan of controller-local `04:06:40`–`04:08:20` covers 1,580 lines and contains zero broker/carrier diagnostic lines. Nearby `Workspace sync target root overlaps an active operation` errors are observed but not joined to either create; they are not assigned as the cause. **Exact current broker/carrier code and reason: unavailable in the inspected historical evidence.** The source tests prove preservation for known refusals; they do not identify which refusal these live requests encountered. No synthetic request, Account write, worker start or reload was used to manufacture that missing evidence. The worker namespace remains stopped as instructed.

## Cause and delivered correction

Observed source basis: read-only `../happier-mutagen` HEAD `0139d6755f7281c84899b207de3179235afe9b9e`, with no scoped changes in `pkg/externalbroker/broker_client.go` or `engine.go`, rechecked at handoff. `brokerResponseErrorValue` implements `BrokerCode()`, and `SendResult` recognizes that interface through `errors.As`. However, `brokerResponseError` constructs an ordinary `fmt.Errorf` from an incoming broker refusal, losing the interface. Existing uses of `newBrokerResponseError` for engine-owned errors do not repair this incoming carrier path. The real installed `.11` regression independently returned `engine_unavailable` before the operation correlation was wired.

The canonical corrections are:

- `apps/cli/src/workspaces/sync/transport/workspaceSyncBrokerProtocol.ts`: admit the existing machine-carrier, authenticated transport identity, handshake, grant and proof refusal codes in the broker terminal union. These names come from the current carrier/verifier owners; no second error vocabulary was created.
- `apps/cli/src/workspaces/sync/transport/workspaceSyncBroker.ts`: retain a refusal on the already-pending command only when its endpoint matches that operation's canonical derived alpha/beta endpoint IDs. Recover that recorded code/message only when the native response is the generic `engine_unavailable`. A genuinely typed native error wins; unrelated operations and a later same-operation retry do not inherit the refusal. Settlement, cancellation and disconnect remove the pending record through the existing lifecycle.
- `apps/cli/src/workspaces/sync/workspaceSyncMutagenAdapter.ts`, `workspaceSyncSidecarLifecycle.ts`, `apps/cli/src/daemon/startup/createDaemonWorkspaceSyncRuntime.ts`, and `createDaemonWorkspaceSyncBroker.ts`: carry the existing operation/relationship ID through the local command path, including persistent relationship resume, lifecycle commands and finite-copy resume. This metadata is not serialized to native commands.

The composed regression reaches the real registered create, Account row admission, source/target bootstrap, controller, Mutagen adapter, lifecycle, daemon broker wrapper, authenticated OS broker and `createWorkspaceMachineCarrierTunnelOpen`. The target boundary supplies a Machine without accepted endpoint authority, so the real opener produces the carrier refusal. Only genuine HTTP/socket/native-process/native-endpoint/OS-observation boundaries are substituted. The native-process fixture reproduces `.11` wrapping, and a separate test runs the actual installed `.11` manager, real rooted agent and broker. The public Action assertion checks both `errorCode` and the original reason.

Future native release: `broker_client.go#brokerResponseError` should return `newBrokerResponseError(response.Code, response.Message)` for an admitted error frame, preserving `BrokerCode()` through wrapping into `SendResult`. This lane changed neither the sibling nor an engine artifact/pin. Remove the host recovery when supported engines preserve broker refusal codes.

## Deliverables

Production files are the six owners above. Regression/harness changes are:

- `apps/cli/src/workspaces/sync/transport/workspaceSyncBroker.test.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.test.ts`
- `apps/cli/src/daemon/startup/createProductionDaemonWorkspaceSyncRuntime.testkit.ts`
- `apps/cli/src/daemon/startup/createDaemonWorkspaceSyncRuntime.real.integration.test.ts`
- `apps/cli/src/daemon/startup/createDaemonWorkspaceSyncRuntime.test.ts`

This requested report is the only new review document. Compatible pre-existing/concurrent hunks remain in place. No Git mutation, engine install, relationship write, database mutation, secret inspection or live worker modification was performed.

UI craft/design-round delta: the existing failure surface receives the carrier cause instead of an engine-acquisition failure. `apps/ui/sources/sync/domains/sessionHandoff/workspaceSyncPresentation.ts` already maps `machine_carrier_unavailable` to the localized `workspaceSync.error.machineOffline`; its existing test covers that distinction. No UI source, copy, component, style, control or layout was added. Live rendering/replay belongs to the QA owner after reload.

## Executed validation

All validation entered through `./apps/stack/bin/hstack-exec`, pinned to authorized `linux1`, `nl3` or `windows1-linux`, with the normal synchronization barrier against the moving mirror. Remote computation/workspace transfer used the orchestrator's standing **2026-10-10 authorization**, explicitly delegated by the FX94b brief. No `--local`, direct implementation script or controller-local compiler was used.

| Check | Terminal evidence |
| --- | --- |
| Broker RED | Handle 41463, linux1, exit 1: four behavioral failures reproduce carrier-to-`peer_unavailable` normalization and native-to-`engine_unavailable` loss. |
| Broker initial GREEN | Handle 77593, linux1, exit 0: 52 tests pass across broker and protocol. The later integrated run includes the additional handshake/grant/proof and typed-native precedence cases. |
| Composed create RED / omission sensitivity | Handle 39228, nl3, exit 1: with broker preservation present but operation correlation absent, registered create returns `engine_unavailable` instead of the carrier refusal. The run also exposed a separate fixture shutdown-ACK race, corrected at the simulated process boundary. |
| Actual native `.11` RED | Handle 60040, windows1-linux, exit 1: real manager copy/resume returns `engine_unavailable` before local operation correlation. |
| Actual native `.11` GREEN and neighboring transfer | Handle 4573, windows1-linux, exit 0: 2 passed / 14 skipped, covering the carrier refusal and the existing non-empty bidirectional byte transfer. |
| Final composed/owner integration | Handle 63956, nl3, exit 0: **104 passed / zero failed / zero pending** across production composition (42), registered RPCs (7), broker (43), and broker protocol (12). Worker JSON `/tmp/happier-fx94b-integrated.json`, independently reopened by handle 61503. Includes exact public Action code and reason, successful create neighbors, refusal families, unrelated-operation isolation, typed-native precedence and same-operation retry isolation. |
| Final adjacent corridor | Handle 19297, nl3, exit 0: **90 passed / zero failed / zero pending** across adapter (42), lifecycle (22), daemon broker (5), and daemon runtime (21). Worker JSON `/tmp/happier-fx94b-adjacent-current.json`, independently reopened by handle 29213. |
| Existing UI presentation | Handle 61767, linux1, exit 0: all 5 tests in `workspaceSyncPresentation.test.ts` pass. |
| Public CLI typecheck | Handle 47016, linux1, exit 2: `corepack yarn workspace @happier-dev/cli typecheck`. Fails in `../ui/sources/components/plugins/surfaces/pluginUiThemeProjection.ts:49` (`dataAccent` missing from token type) and `../ui/sources/components/ui/motion/reanimatedAgentCursorMotion.tsx:32,45–48` (fade signature and implicit-any/indexing errors). These files were not changed by this lane. No clean CLI source/test compiler gate is claimed. |
| Scoped whitespace / sibling checks | Final scoped `git diff --check` passes. Native sibling HEAD and scoped status remain unchanged. |

Native invocation used the installed binaries read-only at `/home/happier/.happier/stacks/l12b-fixt2-worker/cli/mutagen/versions/0.18.1-happier.11/bin/{happier-mutagen,happier-mutagen-agent}` and the existing process-custody helper. The existing real integration harness owns its disposable directories and native processes; it does not operate the worker's live namespace. It used `startVitest` with `vitest.integration.config.ts` and source-only `src/test-setup.unit.ts`, selecting `preserves a carrier refusal|moves non-empty bytes`. Source suites used `node ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts` from `apps/cli` through the wrapper.

Setbacks are not concealed or counted as product RED: adjacent handles 11507 and 9742 failed stale positional call assertions after adding local metadata. The final test checks observable stopped/resumed state and retains the existing restart readiness/order assertion. Handle 17039 caught an attempted extra GET assertion unsupported by that restart fixture; that redundant assertion was removed instead of extending a fake native implementation. Handle 92576 passed an intermediate 90-test basis; handle 19297 supersedes it for current assertions. A pinned composed run, 41031, was canceled through its own handle before payload execution (exit 130) when Windows1-Linux admission was occupied by a long-lived owner; the composed batch then ran on authorized nl3. Shared dependency/publication/memory admission waits were left to their owners. All launched commands are terminal.

An initial report-format probe received an empty stdin through remote command transport and failed its input check. The corrected probe supplies the non-sensitive report as an encoded argument and checks its single status line at EOF.

## Compatibility, self-review and remaining gates

Observed compatibility: native command/descriptor envelopes, stored data, native pin and wire epoch are unchanged. The `.11` incoming broker error reader already admits a string code, while local recovery compensates for its lossy response wrapping. Existing UI code already understands the restored code. The moving `../0.2` predecessor remains `f18aba940c5c56e5b24454e176c836c171098a2d`; scoped status is empty and the inspected Sync broker/adapter paths are absent. Neither sibling was modified. This corrects an existing failure contract; no canonical product documentation or new compatibility format is required.

The split-brain audit leaves one terminal-code owner, one broker refusal record attached to the existing pending command, and the existing adapter/controller operation identity. No log parser, message parser, second registry, persistent refusal history, new identity, timeout, retry or competing carrier path was added. The native `.11` seam remains intentionally retained under the exact provenance/removal condition above. The subtraction check removed an unnecessary production branch that existed only to preserve mock call arity; tests now observe behavior. Neighboring tests verify typed native errors win, unrelated operations stay isolated, settlement clears old refusals and normal native byte transfer still succeeds.

[blocked] Integration/compiler owner must fix the current UI dependency errors and rerun the public CLI typecheck. Its early failure does not prove this lane's CLI partitions clean.

[blocked] Loaded QA evidence and the exact post-addon refusal belong to the authorized controller/worker reload and QA owners. When separately authorized to restart the stopped namespace, load this correction and replay the original admitted create requests to observe their actual typed refusal/reason or success. The missing-target-authority failure is separately proven by the source regression and must not be assumed to be the post-addon live cause. This lane's actual `.11` integration and composed source tests do not claim that the live worker has recovered. No stack/worker lifecycle was taken over.

Residual risk: package compilation and loaded UI/create replay remain unverified; native Windows and macOS were not exercised. Successful disposable Linux `.11` transfer does not establish live worker transport availability.

RELOAD NEEDED: controller/worker daemon consumers of `apps/cli/src/workspaces/sync/transport/workspaceSyncBrokerProtocol.ts`, `apps/cli/src/workspaces/sync/transport/workspaceSyncBroker.ts`, `apps/cli/src/workspaces/sync/workspaceSyncMutagenAdapter.ts`, `apps/cli/src/workspaces/sync/workspaceSyncSidecarLifecycle.ts`, `apps/cli/src/daemon/startup/createDaemonWorkspaceSyncRuntime.ts`, and `apps/cli/src/daemon/startup/createDaemonWorkspaceSyncBroker.ts`. No reload performed; no native engine release required.
STATUS: BLOCKED
