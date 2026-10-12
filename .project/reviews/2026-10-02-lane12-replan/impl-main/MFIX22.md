# MFIX22 — retry observed Machine capability failures

## Outcome

Implemented the missing retry lifecycle at the canonical Machine-capabilities cache owner, `apps/ui/sources/hooks/server/useMachineCapabilitiesCache.ts`. A mounted reader that observes a transient `capabilities.detect` error now retries after the owner's existing 60-second error backoff. The retry remains tied to the exact cache generation and Account lifetime, is superseded by any newer state, and is cancelled when the final reader unmounts.

No component, copy, layout, token, or style changed. The existing New Session status and Start admission continue to consume the same Machine-agent inventory; the logic change lets that inventory leave a transient error without requiring navigation, remount, or another external refresh trigger.

## Live diagnosis

- Reproduced on the requested `mfx22` browser against the no-HMR URL, using the recovery key only through stdin into the restore field. The selected Machine was `NLDW6-3-11-20` (`44bd0886-673f-40ef-913d-8fc280e93c82`), folder `~/qa-l12/mqa5-project`, Claude profile `ai1@happier.dev`, and Haiku 4.5.
- The daemon does receive `capabilities.detect`: its log repeatedly records `Calling handler`, `Handler returned`, and `Sending encrypted response`; sampled handler-to-response time was about 0.7–1.4 seconds.
- Temporary client-side instrumentation, removed before validation, identified the terminal result as `Machine RPC timed out after 30000ms while using scoped scope for capabilities.detect`. The browser also showed the expected failed remote-browser attempts against daemon loopback peer routes before server fallback.
- The implemented timer caused later probes to reach the daemon, proving the mounted-reader retry now runs. The loaded stack still did not recover because every server-scoped Socket.IO acknowledgement timed out even though the daemon generated its response. The same daemon log independently records outbound server-feature ACK timeouts, so this is a broader loaded-runtime acknowledgement failure rather than a Claude-native-login decision or a probe that was never dispatched.
- MFIX16B's reachability policy is not the retry owner. With the current loaded transport, request failure continues to be refreshed by later failed requests; this is not one historical failure permanently outranking successful traffic. Pre-existing moving-worktree edits in `machineReachability.ts` and `serverScopedMachineRpc.ts` were inspected and deliberately neither changed nor committed here.

## Connected profile decision

A healthy selected connected Claude profile already bypasses the native Claude sign-in requirement at the Machine-agent owner; the focused `useMachineAgents` coverage for a native-signed-out Machine passed during this lane. It must not bypass capability detection entirely: installation, runtime availability, and supported launch facts remain Machine-owned and are required for truthful Start admission. No second profile-specific admission path was added.

## RED → GREEN and validation

- RED: the new mounted-reader contract failed with one `machineCapabilitiesDetect` call where two were required after the existing backoff.
- GREEN: retry and final-reader-unmount cancellation tests passed.
- Final focused suite through `hstack-exec`: `useMachineCapabilitiesCache.hook.test.ts`, `.latest.test.ts`, and `.race.test.ts` — 28/28 passed.
- Earlier adjacent run: `useMachineAgents.test.tsx` and `machineReachability.test.ts` passed. `useNewSessionScreenModel.credentials.test.tsx` had five unrelated moving-fixture failures; 47 tests passed in that four-file batch.
- `git diff --check` passed for the owned source and test.
- UI public typecheck was attempted twice. Both attempts stopped before TypeScript at remote workspace preparation because concurrently changing package inputs exhausted the canonical trailing build pass (`@happier-dev/plugin-sdk`, then `@happier-dev/channels-protocol`). No typecheck verdict is claimed.

## Adversarial closeout and residual risk

Alternative causes were tested against the live daemon and client: native Claude sign-out does not explain the selected connected profile path, and missing dispatch does not explain the daemon's successful handler logs. Neighboring account-lifetime races, freshness generations, success recovery, and unmount cleanup passed. The change adds no cache, RPC, reachability, or admission decision-maker; it completes the existing error-backoff contract at its owner.

Residual: the requested loaded stack remains unable to complete server-scoped Socket.IO acknowledgements, so live Start stays disabled despite successful daemon-side computation. Restarting the stack or Metro was forbidden and was not done. A live transport re-check is still required after the stack-wide acknowledgement fault is repaired or the existing runtime is replaced by its owner.

STATUS: DONE
