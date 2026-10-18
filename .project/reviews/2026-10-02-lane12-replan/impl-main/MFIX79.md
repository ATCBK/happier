# MFIX79 — composed daemon replay regression

## Outcome

Added a test-only composed regression to the existing public daemon finite-wake/approval-replay harness. The deciding reviewer may retire after recording approval while the immutable original Account remains current, and replay still executes exactly one native power effect. If the original Account profile switches before replay, the artifact instead settles `approval_stale` with `effectAttempted: false`, no native effect, and no managed-policy admission.

No production behavior changed and no stack lifecycle command was issued.

## Ownership and scope

The exercised composition owner is `startDaemonSessionControlRuntime`, using its installed requester ingress, public machine RPC, durable approval supervisor, and original execution-origin currentness. Only HTTP/Socket.IO transport boundaries are mocked; approval coordination, requester-context admission, replay, native policy execution, artifact settlement, and currentness logic remain real.

The existing `runPrivateManagedRequesterFixture` was the nearest composed harness and now owns both cases. No second replay/currentness decision path was added. The test distinguishes transient reviewer authorization currentness from immutable originating Account currentness, and verifies both terminal artifact state and effect absence/presence.

## Sensitivity and validation

- Mutation RED: temporarily reinstating the removed `isRequesterCurrent` guard at the production checker/call site made `reviewer-retired-after-ask` fail at the native-effect assertion (`expected [] to have a length of 1`, 1 failed / 176 skipped). The mutation was removed immediately and is not part of the deliverable.
- Combined GREEN: focused source Vitest run through `./apps/stack/bin/hstack-exec --local` passed both required scenarios (2 passed / 175 skipped, 64.10s).
- Each scenario also passed independently before the combined run.
- `git diff --check` passed after removing the temporary mutation.
- The canonical CLI integration command was attempted earlier but did not reach Vitest because shared package-publication/dependency leases remained occupied; only the waiting validation process was cancelled. The focused source run used the repository integration config with global publication setup disabled and current workspace dependencies.

## Adversarial closeout

The neighboring outcomes are deliberately opposite at the same replay seam: reviewer retirement executes, whereas originating Account switch refuses before effect. The mutation check establishes that the new positive case would catch restoration of the removed guard. The negative case observes both durable failure metadata and absence of the native/policy effects, avoiding a green result based only on RPC wording.

Residual risk: the full CLI integration lane and package typecheck did not complete because of shared executor/publication contention. The focused source composition is green, but no broader package verdict is claimed.

STATUS: DONE
