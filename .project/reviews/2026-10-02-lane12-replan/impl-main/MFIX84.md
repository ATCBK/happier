# MFIX84 — pending requester Session activation

## Outcome

`BLOCKED`: this is a product defect triggered by a real transient Home outage, not an identity, URL, or credential mismatch. The canonical correction belongs to the CLI pending-activation owner, but the exact reconnect-scan hunk and its composition root have active foreign edits. The lane brief requires routing that collision instead of creating another retry owner.

## Root cause and evidence

Observed runtime identity: QA stack `agent-qa-l12-main`, nl3 daemon PID `1407096`, active server id `stack_agent-qa-l12-main__id_default`, Home HTTP base `http://127.0.0.1:43487`, Machine `58f6e63a-cd69-4302-83f1-325d10da7ec3`, Session `cmvdop1e0001vmcfu7pdub68l`, pending local/request id `f5ecf3d1-2fff-4b1e-a40b-fca5e16ced73`.

Observed daemon evidence in `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-l12-main/cli/logs/2026-10-19-02-44-25-pid-1407096-daemon.log`:

- line 3188: requester `machine_after` currentness failed after 10,009 ms;
- line 3189: `Pending session activation listener failed; Pending custody retained` with `Requester Home is temporarily unavailable` for the exact request id;
- lines 3208–3210: Codex connected-account materialization received HTTP 503 and preflight failed as `connected_service_credential_refresh_unavailable`;
- lines 3212–3213: spawn returned `SPAWN_VALIDATION_FAILED`, and Session resume recorded `resume_failed`.

Observed server evidence in `/home/leeroy.guest/.happier/stacks/agent-qa-l12-main/logs/remote-nl3.log` lines 116182–116235: at 03:02:56 the same Home returned Prisma `P2024`, `Timed out fetching a new connection from the connection pool`, with connection limit 10 and timeout 10 seconds. This also caused Machine state and Home authentication-policy requests to fail.

Derived: the requester identity and URL were correct. The daemon reached the configured Home, earlier currentness phases completed, and the final signed Machine check failed at the same 10-second window as the server-side pool exhaustion. A stale URL/port or credential would not explain successful adjacent profile/encryption/currentness reads plus server-recorded P2024 failures.

The product defect is the transition from retryable transport unavailability to terminal activation failure. `apps/cli/src/daemon/sessions/activatePendingInactiveSession.ts:249` sends every non-success spawn result through `rejectTerminal`, while `apps/cli/src/daemon/sessions/pendingSessionActivationRecovery.ts:82` scans only `status === "waiting"`. After the server stores `status:"failed"`, reconnect cannot retry the retained pending message. The existing test at `activatePendingInactiveSession.test.ts:82` currently codifies the wrong behavior by expecting `transport_unavailable` to be reported as terminal `runtime_start_failed`.

The UI `Loading…` symptom is a separate environmental consequence of the same saturated Home: the server log shows broad 503/P2024 failures for Session/Home reads during the window. No evidence points to a UI hydration owner defect, so no UI change is justified.

## Required owner correction and collision

The canonical correction is one CLI activation policy: retain/retry the exact authorization for `SPAWN_VALIDATION_FAILED` with retryable `runtimeFailureReason` (the reproduced value is `transport_unavailable`), while keeping definitive directory/identity/takeover failures terminal. Reconnect must also recover the already-failed exact request when its stored bounded failure details prove this retryable case, so request `f5ecf3d1-…` does not require a new send.

Collision pointers:

- `apps/cli/src/daemon/sessions/pendingSessionActivationRecovery.ts:75-82` has a foreign working-tree edit in the exact reconnect scan loop that must admit the bounded failed/retryable case.
- `apps/cli/src/daemon/machine/bootstrapMachineSyncRuntime.ts:1871-1971` has a foreign working-tree edit in the same requester activation/reconnect composition.
- `apps/cli/src/daemon/sessions/pendingSessionActivationRecovery.test.ts:16-35` and `.requester.test.ts:9-96` carry corresponding foreign test/harness edits.

No production or test source was changed, and no competing retry path was added.

## RED/GREEN and validation

RED/GREEN was not run because the exact owner hunk is concurrently edited and the brief requires routing the collision. The deciding RED should change the `transport_unavailable` case at `activatePendingInactiveSession.test.ts:82-94` to prove no terminal failure report, plus extend `pendingSessionActivationRecovery.test.ts` so a bounded retryable failed authorization is activated while other failed authorizations remain skipped. GREEN must run those focused CLI tests and `yarn workspace @happier-dev/cli typecheck`, all through `./apps/stack/bin/hstack-exec`.

No server reload is required for the owner-local correction. A daemon reload/reconnect is required after the corrected CLI source is loaded. This lane did not restart, stop, reload, send, approve, or mutate the QA stack.

## Exact live recheck (no new send)

1. Confirm Home health first: the QA server no longer emits P2024/503 for Session, profile, Machine-admission, or connected-account reads.
2. Load the corrected CLI daemon on nl3 and reconnect it; do not send another prompt and do not alter the pending row manually.
3. Observe the reconnect scan select Session `cmvdop1e0001vmcfu7pdub68l` and exact request `f5ecf3d1-2fff-4b1e-a40b-fca5e16ced73` from retained custody, including its bounded retryable failure details.
4. Verify spawn succeeds for the same Session/Machine, pending local id `f5ecf3d1-…` is delivered/removed, `pendingCount` becomes 0, and transcript sequence advances beyond 97.
5. Open the existing Session route and verify it hydrates without `Loading…`; no new message may be sent during this check.

Residual risk: the correction and live replay remain unimplemented until the active owner integrates the collision. The server connection-pool saturation itself is an environmental incident outside this lane; recurrence can still delay activation, but it must no longer terminalize retryable custody.

STATUS: BLOCKED
