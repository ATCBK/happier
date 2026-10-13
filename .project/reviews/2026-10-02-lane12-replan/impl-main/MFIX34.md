# MFIX34 — moved daemon Home descriptor adoption

## Outcome

The moved daemon hit a real client lifecycle defect, not only the shared-DB Home-descriptor time-share rule. The daemon started from its explicit Stack URL before Stack materialized the stable `stack_agent-qa-l12-main__id_default` profile. `startDaemon` captured that target as `authority: 'manual_url', profileId: null`; every later authenticated feature refresh reused the captured target, so `applyDaemonHomeDescriptorRefresh` returned `ignored` forever even after the exact profile existed. Project Open consequently continued to fail closed with `target_mismatch`.

Fixed at the daemon descriptor-refresh owner. A refresh still keeps an already-bound profile pinned, but a captured manual target now re-resolves the current daemon selection. If the configured profile has since materialized, the existing exact descriptor-adoption owner persists the binding and the existing reconnect hook runs. If no profile exists, the refresh remains ignored. No timer, retry loop, Project consumer workaround, or second descriptor owner was added.

## Runtime evidence and trigger trace

- Read-only nl3 evidence: Machine `58f6` started at 02:37:37 in `/home/happier/.happier/dev-targets/nl3/stack-state/agent-qa-l12-main/cli/logs/2026-10-13-02-37-34-pid-346634-daemon.log`; the loaded daemon logged `Home transport prepared` with the standard carrier and unknown observed path.
- The stable profile was created later (05:02:14 local; updated 05:07:31), so it could not have been selected at daemon startup. It remained URL-only, with neither `homeConnectionDescriptor` nor exact authority, although authenticated features published identity `srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN` and its descriptor.
- The loaded bundle was `/home/happier/.happier/dev-targets/nl3/stack-state/source-bundles/runtime-9f446.../apps/cli/src/index.ts`. The brief forbids restarting or stopping this stack, so the old loaded daemon was not mutated.
- Pairing/authentication can adopt a descriptor when a saved profile already exists. During daemon runtime, `createServerUrlServerFeaturesSnapshotStore(...).onAuthenticatedReady` is the normal feature-fetch trigger; it calls `applyDaemonHomeDescriptorRefresh`, which owns persistence through `adoptServerProfileHomeConnectionDescriptor` and requests the existing machine transport reconnect when updated. The defect was the stale captured `profileId: null`, not absence of a normal trigger.
- The shared database still has one descriptor publisher, and Fork D currently holds that time-share slot. That can change which route is published, but it does not explain a daemon permanently ignoring an exact descriptor served by its authenticated Home after its configured profile appears.

## Decision-function input classes

1. Saved invocation profile exists at startup: retain the captured profile and adopt/refresh there; existing coverage remains green.
2. Manual/env-only invocation and no saved profile ever appears: remain `ignored`; do not manufacture a profile or mutate a focused Home.
3. Manual startup target followed by materialization of the configured stable profile: re-resolve on the next normal authenticated feature refresh, adopt the exact descriptor, and request reconnect. This was the missing class and is now covered by the composed Project Open seam.
4. Already-bound daemon profile while user focus changes: remain pinned to the captured invocation profile; existing coverage remains green.
5. Descriptor/observed Home identity mismatch: the existing identity assertion still fails closed before persistence.

## RED → GREEN and validation

- RED: `./apps/stack/bin/hstack-exec --target=nl3 --cwd=apps/cli -- yarn exec vitest run --config vitest.config.ts src/rpc/handlers/projects/registerProjectOpenRpcHandlers.test.ts -t "establishes a credential-seeded profile identity before Project Open while refusing wrong targets"` — failed at the new late-profile assertion (`expected updated, received ignored`); 1 failed / 25 passed.
- GREEN: the same focused command on nl1 — 26/26 passed. The test starts credential-seeded and profile-less, captures the manual startup target, materializes the stable profile after authenticated verification, exercises the real feature-refresh adoption, then consumes the installed `ApiMachineClient` Project Open RPC. Its missing-runtime counterfactual remains refused.
- Corridor: `./apps/stack/bin/hstack-exec --target=nl1 --cwd=apps/cli -- yarn exec vitest run --config vitest.config.ts src/daemon/peer/iroh/daemonHomeIrohTransport.test.ts src/daemon/peer/iroh/daemonHomeIrohTransport.startup.test.ts src/rpc/handlers/projects/registerProjectOpenRpcHandlers.test.ts` — 3 files, 66/66 tests passed.
- CLI typecheck: `./apps/stack/bin/hstack-exec --target=nl1 -- yarn workspace @happier-dev/cli typecheck` — exit 1 before this lane was checked. The moving workspace's bundled OpenAI plugin source manifest differed from its statically projected canonical manifest (`happier.voice.openai`); earlier prerequisite diagnostics also came from unrelated current-work files. This is an external validation gap, not a passing typecheck claim.

## Ownership, split-brain audit, and residual risk

Canonical refresh/adoption ownership remains `daemonHomeIrohTransport.ts#applyDaemonHomeDescriptorRefresh` plus `serverProfiles` persistence. `startDaemon.ts` supplies the authenticated feature trigger and reconnect callback; Project Open remains only a consumer of the established exact Home identity. No competing adopter, Project-side bypass, compatibility path, timer, or retry was introduced. Existing auth/pairing adoption is intentionally retained as another trigger into the same profile persistence owner.

The implementation is complete in current source, but live verification is deferred because this lane was explicitly forbidden from restarting/stopping the old loaded daemon. After the orchestrator next reloads the stack from this commit, the next normal authenticated feature refresh should adopt the descriptor and request reconnect; retry Project Open then. Residual risk is limited to that unperformed loaded-runtime replay and the externally blocked package typecheck.

STATUS: DONE
