# MFIX40 — Claude goal control runtime availability

## Outcome

The Session-bound Happier MCP now routes goal get/set/clear through the exact live Session RPC owner already held by the runner. It no longer relies on the server Session row's lagging `active` projection and therefore cannot fall into the inactive-plugin adapter while that runner is executing the tool. The same generic bridge serves Claude and Codex; the UI/daemon route remains unchanged.

## Canonical owner and cause

- Canonical decision owner: `routeSessionGoalControl`; canonical live RPC owner: the bound Session's `RpcHandlerManager`.
- Escaped cause: `createHappierMcpServer` held the live client but `createCliActionDeps` discarded that proof, re-resolved the Session through Home, and selected active versus inactive from `rawSession.active`. A running Claude runner could therefore be classified inactive and return `inactive_agent_runtime_unavailable`.
- The prior MFIX37 test constructed only the inactive adapter path, so it passed without proving the runner's real live-RPC wiring. It was rewritten around the production MCP server entry and both exposed goal forms.

## Decision input classes

- Bound current Session with a live RPC owner: route directly to its registered goal RPC even when the replicated Session row is inactive/stale.
- Another active Session: retain Home transport resolution and live Session RPC routing.
- Inactive Session without a bound live RPC owner: retain the canonical inactive adapter and durable work-state custody path.
- Missing credentials or missing live/inactive owner: retain existing typed refusal behavior.

## Changes

- Added one private `invokeBoundSessionRpc` composition port to the CLI Action dependencies and bound it only from `createHappierMcpServer`.
- Reused `routeSessionGoalControl` for the bound path; no second goal decision-maker, provider-id branch, new state, fallback, timeout, or gate was added.
- Replaced the MFIX37 fixture with a composed MCP Action test covering both `session_goal_set` and `action_execute session.goal.set`, asserting that the registered live Session RPC receives both calls.

## Evidence

- Wiring-sensitivity RED: removing the `createHappierMcpServer` binding made the composed test fail before the live RPC was called (`action_failed` / Account currentness unavailable), proving the test depends on the production binding.
- GREEN: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn exec vitest run --config vitest.config.ts src/mcp/createHappierMcpServer.goalParity.test.ts src/session/goalControls/sessionGoalControlRouter.test.ts` — 2 files, 9 tests passed. The same 9 tests passed again in the final three-file invocation.
- Infrastructure retries: two earlier final invocations were rejected before test discovery by the shared `cli-dist-build.lock` (`EWORKSPACEBUNDLELOCKBUSY`). After the lock cleared, the focused tests passed; the adjacent pre-existing `happierMcpCodex.composed.test.ts` timed out at its own 30-second limit before assertions, both in the combined invocation and one warmed isolated rerun. No timeout was changed.
- `git diff --check` passed for the scoped files.

## Adversarial check

- Alternative cause (stale bundle) was already falsified by MQA2 loaded-runner evidence. The new test directly falsifies a missing live binding by removing it.
- Neighbor cases: dedicated and generic MCP tools both reach the same live owner; existing router coverage keeps active transport and inactive adapter behavior green.
- Blast radius: the new port has exactly one producer and one consumer branch, is scoped to `sessionId === params.sessionId`, and cannot affect UI/daemon or cross-Session routing.
- Residual risk: live replay belongs to Main and requires its no-restart loaded-stack procedure; no stack lifecycle action was taken here. The unrelated Codex bridge-catalog test remains unverified because its source-child startup exceeded its existing 30-second test budget twice on nl3; the provider-agnostic goal bridge itself is covered by the composed goal test.

STATUS: DONE
