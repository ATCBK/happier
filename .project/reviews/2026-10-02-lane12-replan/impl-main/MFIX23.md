# MFIX23 — stop idle session-activity storms

## Outcome

Fixed the idle storm at its two canonical CLI runtime owners. A Session Follow observation timeout no longer republishes the same process-local wake signal that invoked it, and an empty pending-input reconciliation no longer pretends to hold accepted input custody. Real queue, dispatch, pending, runtime, Agent, and attention transitions still use the existing live-work owner and notifier.

The loaded QA daemons were not restarted, so both stacks continue running the old bundles. **NEEDS-MAIN:** restart `agent-qa-l12-main` and any other affected source-runtime stack, including `agent-qa-unified-work-dev`, then verify the idle request rate and CPU fall.

The CLI package typecheck was attempted and failed on extensive unrelated moving-worktree errors; no typecheck pass is claimed. Focused current-source tests are green.

## Root cause and event path

- Observed: the three `agent-qa-l12-main` session runners are idle; the two oldest repeatedly log `MessageQueue2 Waiting for messages`, and their cached Pending state had already reached `pendingCount: 0`. The current daemon log contains no `fileFollow.follow path is not granted`, so the earlier denial was not the continuing trigger.
- Observed: `createSessionFollowContextReconciler` caught a 30-second Socket.IO ACK timeout and invoked `publishSessionFollowWakeInvalidation`. The host loop waits on that same signal, so the failure immediately woke and retried itself. Server logs corroborate the loop: `agent-qa-l12-main` has 54 Session Follow observation failures (51 `LockAdmissionDeadlineExceeded`); `agent-qa-unified-work-dev` has 219 (214 lock-admission deadlines).
- Observed: every wake passed through `runPendingMaterializationExclusive`. Its operation counter was also treated as accepted-input custody, so even a known-empty pass notified `active` on entry and `settled` on exit. RED observed exactly two notifications for one empty drain. The only production sender of `/session-activity-changed` is the host live-work subscription at `runHostSessionRuntime.ts:2386-2390`.
- Observed: the daemon route at `controlServer.ts:1818-1833` performs no server write or broadcast. It invalidates `sessionLiveWorkProducer`; `managedActivity.ts:153-200` then starts a fresh read of all producers, including runner RPC reads for every tracked session, clears the idle anchor, and republishes the decision edge to guard/storage subscribers.
- Derived: server CPU is primarily the other half of the same loop, not the local daemon POST. Each Follow observation enters a five-second publisher transaction and performs authority, Machine, Session, follow-edge/reports-to, source-Session, and access reads (`sessionUpdateHandler.ts:603-641`, `sessionFollowEdgeService.ts:667-714`). Immediate self-retry across idle runners creates lock contention and transaction deadline failures; the false activity edges add daemon RPC/inventory work.

## Cross-stack measurements

- `agent-qa-l12-main`: 20,742 received activity POSTs from 04:21:33–06:03:50 (~3.4/s); server PID 3972948 at 172% CPU and daemon PID 3982807 at 53.8% CPU in the sample.
- `agent-qa-unified-work-dev`: 253,341 received activity POSTs from 2026-10-11 14:28:44–2026-10-12 06:03:51 (~4.5/s); server PID 2590858 at 249% CPU and daemon PID 2605001 at 63.7% CPU. This independently reproduces the same storm.

## Change

- `sessionFollowContextReconciler.ts:103-160` removes the retry callback and treats an optional Follow transport failure as a completed unsuccessful observation. Legitimate Account change/reconnect, source-material, runtime-usage, workflow, and worker invalidations remain the wake owners.
- `sessionProviderInputConsumer.ts:227-241,295-320` separates serialized materialization operations from actual pending-input custody. A known-empty cached queue does not create an activity edge; positive or unknown Pending state retains the conservative custody behavior.
- `sessionProviderInputConsumer.activity.test.ts:172-185` proves a known-empty drain sends no live-work notification. The Follow regression test proves one timeout performs one observation and returns without self-rearming.

## RED → GREEN and validation

- RED through `hstack-exec --local`: Follow timeout callback was called once; empty drain emitted 2 notifications. Result: 2 failed, 33 passed.
- GREEN through the same wrapper: 2 files, 35/35 tests passed.
- Automatic placement was tried first but stopped before assertions on a busy remote workspace publication lease and stale dirty-file view; the authoritative local escape hatch was then used.
- CLI public `typecheck` ran through automatic `hstack-exec` and failed with broad unrelated diagnostics in ACP, settings, fork, Actions, plugins, protocol, server/UI aliases, and other concurrent files. No diagnostic named an MFIX23-owned line. `git diff --check` passed for the source/test paths.
- No stack or daemon was restarted, as required; loaded-runtime improvement is not claimed.

## Adversarial closeout and residual risk

The alternative heartbeat hypothesis was falsified by the single sender search and the two-notification empty-drain RED. The earlier file-follow denial is absent from the current daemon log. The neighboring unknown-Pending case remains conservatively active, real accepted input retains custody, and legitimate external Follow invalidations remain. No timer, throttle, retry budget, cache, or second activity owner was added; one self-rearming failure edge was removed and one existing counter was split by its actual domain meaning.

Residual risk: current loaded bundles still storm until restarted, and the dirty package-wide typecheck is not green. After Main restarts, sample `/session-activity-changed` for at least five idle minutes and recheck both daemon/server CPU; any continuing rate would falsify completeness and should be correlated by runner session ID at the control client boundary.

STATUS: DONE
