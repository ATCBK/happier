# MFIX87 — contributed approval replay origin outage classification

## Outcome

The contributed replay now checks origin currentness before claiming execution custody. A typed `project_requester_home_unavailable` result leaves the durable request `approved`, invokes no plugin effect, and permits the same approval to execute after Home recovery. An observed negative currentness result remains terminal `approval_stale`.

## Root cause and canonical fix

`createDaemonExternalActionContributedApprovalReplay` independently caught every currentness exception as `currentness_read_failed`, then converted that result to terminal `approval_stale` after first persisting `executing`. That second classifier disagreed with the built-in Action replay owner.

The canonical owner is now `packages/protocol/src/actions/actionExecutor.ts#classifyApprovalExecutionOriginCurrentness`. Both built-in replay and the contributed adapter consume it. The contributed adapter's post-claim currentness catch was deleted; its check runs pre-claim, typed Home unavailability returns retryably, and only the classifier's observed stale outcome is persisted as a definitive pre-effect failure. The later requester-entitlement check remains intentionally separate because it revalidates a shared requester's authority immediately before a sensitive handler invocation rather than deciding origin-read availability.

## RED / GREEN and validation

- RED: the composed contributed-Action recovery case returned `approval_stale` instead of `project_requester_home_unavailable` at `createDaemonExternalActionContributedInvoker.composed.test.ts:2748`; 1 failed, 74 skipped.
- GREEN: the recovery case, definitive-stale neighbor, and existing independent-executor/lost-claim-ack case passed together; 3 passed, 73 skipped.
- Protocol typecheck passed.
- CLI typecheck was attempted through AUTO, then through the authorized local compiler path after prolonged pool admission contention. Compilation failed only on unrelated current UI/plugin-ui export drift: missing `HAPPIER_REVIEW_SEVERITY_RANK`, `HAPPIER_REVIEW_SEVERITY_TONE`, and `resolveHappierReviewSeverityColor` exports. No MFIX87 diagnostic was emitted.

## Commits and runtime

Concurrent commits swept the already-tested moving source while this lane was running: CLI implementation/test `591ebfb309b4f5ced108defb3090ce7a8d4a73a5`; Protocol classifier/export `64d2cdadd36245b8469e783a8b025bb94a755e59`. The required lane artifact is committed separately through a private index so no foreign worktree hunks are included.

A daemon reload is required before a running daemon consumes the changed source/bundle. No stack or daemon was restarted in this lane.

Residual risk: the aggregate CLI typecheck remains red for the unrelated UI/plugin-ui export mismatch above; the changed runtime seam itself has composed RED/GREEN coverage and Protocol compilation evidence.

STATUS: DONE
